const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const gui = require("../installer/gui");

const HOST = "PC_158\\SQL2022";

/** Proyecto de mentira con la forma real de Flexygo Core. */
function coreProject() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gui-")));
  const conf = path.join(root, "Backend", "conf");
  fs.mkdirSync(conf, { recursive: true });
  fs.writeFileSync(
    path.join(conf, "appsettings.json"),
    JSON.stringify({
      ConnectionStrings: { ConfConnectionString: "", DataConnectionString: "" },
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(conf, "appsettings.Development.json"),
    JSON.stringify({
      ConnectionStrings: {
        ConfConnectionString: `Data Source=${HOST};Initial Catalog=DEMO_IC;User ID=sa;Password=x`,
        DataConnectionString: `Data Source=${HOST};Initial Catalog=DEMO;User ID=sa;Password=x`,
      },
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { otro: { command: "node", args: ["a.js"] } } }),
    "utf8"
  );
  return root;
}

/** Arranca el formulario y devuelve un cliente ya autenticado. */
async function withGui(fn) {
  let info;
  const closed = gui.startGui({
    open: false,
    quiet: true,
    onReady: (i) => {
      info = i;
    },
  });
  // onReady se invoca de forma sincrona dentro del callback de listen.
  await new Promise((resolve) => setImmediate(resolve));
  while (!info) await new Promise((resolve) => setImmediate(resolve));

  const call = (pathname, { body, token = info.token, origin, method = "POST" } = {}) =>
    new Promise((resolve) => {
      const headers = { "content-type": "application/json" };
      if (token) headers[gui.TOKEN_HEADER] = token;
      if (origin) headers.origin = origin;
      const req = http.request(
        { host: "127.0.0.1", port: info.port, path: pathname, method, headers },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            const raw = Buffer.concat(chunks).toString("utf8");
            let json = null;
            try {
              json = JSON.parse(raw);
            } catch {
              // la pagina HTML no es JSON
            }
            resolve({ status: res.statusCode, raw, json });
          });
        }
      );
      req.on("error", () => resolve({ status: 0, raw: "", json: null }));
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });

  try {
    await fn({ info, call, origin: `http://127.0.0.1:${info.port}` });
  } finally {
    await call("/api/quit").catch(() => {});
    await closed;
  }
}

test("el formulario rechaza las peticiones sin token", async () => {
  await withGui(async ({ call }) => {
    const r = await call("/api/detect", { body: { projectDir: "." }, token: null });
    assert.equal(r.status, 403);
  });
});

test("el formulario rechaza un token incorrecto", async () => {
  await withGui(async ({ call }) => {
    const r = await call("/api/detect", { body: { projectDir: "." }, token: "0".repeat(48) });
    assert.equal(r.status, 403);
  });
});

test("el formulario rechaza un Origin ajeno, aunque el token sea bueno", async () => {
  // Sin esto, cualquier pagina abierta en el navegador podria escribir ficheros.
  await withGui(async ({ call }) => {
    const r = await call("/api/detect", {
      body: { projectDir: "." },
      origin: "https://evil.example.com",
    });
    assert.equal(r.status, 403);
  });
});

test("la pagina no se sirve sin el token en la URL", async () => {
  await withGui(async ({ call }) => {
    assert.equal((await call("/?t=malo", { method: "GET", token: null })).status, 403);
  });
});

test("detect encuentra el appsettings de Core y sus cadenas", async () => {
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const r = await call("/api/detect", { body: { projectDir: root }, origin });
    assert.equal(r.status, 200);
    const core = r.json.files.find((f) => f.type === "core");
    assert.ok(core, "debe detectar el appsettings.json");
    assert.deepEqual(core.names, ["ConfConnectionString", "DataConnectionString"]);
  });
});

test("validate resuelve las cadenas vacias de Core desde el fichero de entorno", async () => {
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const det = (await call("/api/detect", { body: { projectDir: root }, origin })).json;
    const core = det.files.find((f) => f.type === "core");
    const r = await call("/api/validate", {
      origin,
      body: {
        configFile: core.path,
        environment: det.defaultEnvironment,
        names: [
          { name: "ConfConnectionString", alias: "config" },
          { name: "DataConnectionString", alias: "data" },
        ],
      },
    });
    assert.ok(r.json.results.every((x) => x.ok), JSON.stringify(r.json.results));
    assert.equal(r.json.results[0].source, "appsettings.Development.json");
    assert.equal(r.json.results[0].database, "DEMO_IC");
  });
});

test("validate prueba la conexion de verdad y lo reporta aparte de resolver", async () => {
  // El servidor del fixture no existe: la cadena se resuelve pero no se conecta, y
  // eso tiene que distinguirse — son dos fallos distintos con soluciones distintas.
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const det = (await call("/api/detect", { body: { projectDir: root }, origin })).json;
    const core = det.files.find((f) => f.type === "core");
    const r = await call("/api/validate", {
      origin,
      body: {
        configFile: core.path,
        environment: det.defaultEnvironment,
        names: [{ name: "DataConnectionString", alias: "data" }],
      },
    });
    const [result] = r.json.results;
    assert.equal(result.ok, true, "la cadena se resuelve");
    assert.equal(typeof result.connected, "boolean", "y se informa de si conecta");
  });
});

test("validate sin fichero de configuracion intenta conectar con los datos tecleados", async () => {
  // Es el caso de la carpeta vacia: comprobar que los campos no estan vacios no
  // vale nada, porque el fallo tipico es una errata.
  await withGui(async ({ call, origin }) => {
    const r = await call("/api/validate", {
      origin,
      body: {
        configFile: null,
        manual: {
          server: "127.0.0.1,9999",
          database: "BD",
          user: "sa",
          password: "no-importa",
        },
      },
    });
    assert.equal(r.status, 200);
    const [result] = r.json.results;
    assert.equal(result.manual, true);
    assert.equal(result.ok, false, "no hay servidor en ese puerto");
    assert.ok(result.error, "y se dice por que");
    assert.ok(!result.error.includes("no-importa"), "sin filtrar la contrasena");
  });
});

test("validate sin fichero y con datos incompletos falla con mensaje", async () => {
  await withGui(async ({ call, origin }) => {
    const r = await call("/api/validate", {
      origin,
      body: { configFile: null, manual: { server: "PC", database: "BD" } },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Faltan datos/);
  });
});

test("validate informa del fallo sin reventar", async () => {
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const det = (await call("/api/detect", { body: { projectDir: root }, origin })).json;
    const core = det.files.find((f) => f.type === "core");
    const r = await call("/api/validate", {
      origin,
      body: { configFile: core.path, environment: "NoExiste", names: [{ name: "ConfConnectionString" }] },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.results[0].ok, false);
    assert.match(r.json.results[0].error, /esta vacia|No se encontro/);
  });
});

test("write en produccion ignora la peticion de escritura", async () => {
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const det = (await call("/api/detect", { body: { projectDir: root }, origin })).json;
    const core = det.files.find((f) => f.type === "core");
    const r = await call("/api/write", {
      origin,
      body: {
        projectDir: root,
        configFile: core.path,
        environment: det.defaultEnvironment,
        connections: [
          { name: "ConfConnectionString", alias: "config" },
          { name: "DataConnectionString", alias: "data" },
        ],
        profileKey: "produccion",
        allowWrites: true, // se pide, pero el perfil manda
        clients: ["claude", "vscode"],
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.production, true);
    assert.equal(r.json.allowWrites, false, "produccion no puede acabar con escritura");
    assert.ok(r.json.args.includes("--production"));
    assert.ok(!r.json.args.includes("--allow-writes"));
  });
});

test("write conserva los otros servidores y usa la clave correcta por cliente", async () => {
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const det = (await call("/api/detect", { body: { projectDir: root }, origin })).json;
    const core = det.files.find((f) => f.type === "core");
    await call("/api/write", {
      origin,
      body: {
        projectDir: root,
        configFile: core.path,
        environment: det.defaultEnvironment,
        connections: [{ name: "DataConnectionString", alias: "data" }],
        profileKey: "local",
        clients: ["claude", "vscode"],
      },
    });
    const mcp = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers.otro, "no puede perderse el servidor que ya existia");
    assert.ok(mcp.mcpServers["ahora-sql"]);
    const vs = JSON.parse(fs.readFileSync(path.join(root, ".vscode", "mcp.json"), "utf8"));
    assert.ok(vs.servers["ahora-sql"], "VS Code usa la clave servers");
  });
});

test("write acepta mas de dos cadenas, cada una con su alias", async () => {
  // Regresion: config + data no es el tope. El wrapper acepta las que hagan falta
  // con --connection-name NOMBRE:alias, y el instalador tiene que dejarlas pasar.
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const det = (await call("/api/detect", { body: { projectDir: root }, origin })).json;
    const core = det.files.find((f) => f.type === "core");
    const r = await call("/api/write", {
      origin,
      body: {
        projectDir: root,
        configFile: core.path,
        environment: det.defaultEnvironment,
        connections: [
          { name: "ConfConnectionString", alias: "config" },
          { name: "DataConnectionString", alias: "data" },
          { name: "OtraConnectionString", alias: "historico" },
        ],
        profileKey: "local",
        clients: ["claude"],
      },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.dbKeys, ["config", "data", "historico"]);
    const args = r.json.args.join(" ");
    for (const expected of [
      "ConfConnectionString:config",
      "DataConnectionString:data",
      "OtraConnectionString:historico",
    ]) {
      assert.ok(args.includes(expected), `falta ${expected} en ${args}`);
    }
  });
});

test("write rechaza un alias que no cabe en un nombre de variable de entorno", async () => {
  // Sin esto la conexion desaparece sin ningun error: el servidor descubre las bases
  // de datos escaneando MSSQL_<ALIAS>_DATABASE.
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const det = (await call("/api/detect", { body: { projectDir: root }, origin })).json;
    const core = det.files.find((f) => f.type === "core");
    const base = {
      projectDir: root,
      configFile: core.path,
      environment: det.defaultEnvironment,
      profileKey: "local",
      clients: ["claude"],
    };
    const malo = await call("/api/write", {
      origin,
      body: {
        ...base,
        connections: [
          { name: "ConfConnectionString", alias: "config" },
          { name: "DataConnectionString", alias: "mi-bd" },
        ],
      },
    });
    assert.equal(malo.status, 400);
    assert.match(malo.json.error, /DataConnectionString/);

    const repetido = await call("/api/write", {
      origin,
      body: {
        ...base,
        connections: [
          { name: "ConfConnectionString", alias: "data" },
          { name: "DataConnectionString", alias: "data" },
        ],
      },
    });
    assert.equal(repetido.status, 400);
    assert.match(repetido.json.error, /ya esta usado/);
  });
});

test("detect sugiere un alias por cadena, ya desambiguado", async () => {
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const det = (await call("/api/detect", { body: { projectDir: root }, origin })).json;
    const core = det.files.find((f) => f.type === "core");
    assert.deepEqual(core.names, ["ConfConnectionString", "DataConnectionString"]);
    assert.deepEqual(core.aliases, ["config", "data"]);
  });
});

test("las credenciales manuales NO acaban en el .mcp.json", async () => {
  // Es la razon de ser de --credentials-file: el .mcp.json se commitea.
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const r = await call("/api/write", {
      origin,
      body: {
        projectDir: root,
        configFile: null,
        manualConnections: [
          { server: HOST, database: "BD", user: "sa", password: "contrasena-secreta" },
        ],
        profileKey: "local",
        clients: ["claude"],
      },
    });
    assert.equal(r.status, 200);
    assert.ok(r.json.credentialsFile, "debe escribir un fichero de credenciales");
    assert.ok(
      !path.resolve(r.json.credentialsFile).startsWith(path.resolve(root)),
      `el fichero debe quedar fuera del proyecto: ${r.json.credentialsFile}`
    );

    const args = JSON.stringify(
      JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers["ahora-sql"].args
    );
    assert.ok(!args.includes("contrasena-secreta"), "la contrasena no puede estar en el .mcp.json");
    assert.ok(args.includes("--credentials-file"));

    const creds = JSON.parse(fs.readFileSync(r.json.credentialsFile, "utf8"));
    assert.equal(creds.password, "contrasena-secreta");
    fs.rmSync(r.json.credentialsFile, { force: true });
  });
});

test("write anade las reglas de lectura y NO las de escritura", async () => {
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const det = (await call("/api/detect", { body: { projectDir: root }, origin })).json;
    const core = det.files.find((f) => f.type === "core");
    const r = await call("/api/write", {
      origin,
      body: {
        projectDir: root,
        configFile: core.path,
        environment: det.defaultEnvironment,
        connections: [{ name: "DataConnectionString", alias: "data" }],
        profileKey: "local",
        allowWrites: true,
        allowRules: true,
        allowWriteRules: false,
        clients: ["claude"],
      },
    });
    assert.ok(r.json.permissions, "debe reportar las reglas escritas");
    const allow = JSON.parse(fs.readFileSync(r.json.permissions.target, "utf8")).permissions.allow;
    assert.ok(allow.includes("mcp__ahora-sql__execute_read_query"));
    assert.ok(
      !allow.some((x) => x.includes("execute_write_query") || x.includes("execute_sql_file")),
      `sin reglas de escritura: ${allow.join(", ")}`
    );
  });
});

test("write en produccion nunca anade reglas de escritura, aunque se pidan", async () => {
  // El perfil manda sobre la casilla, igual que con --allow-writes.
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const det = (await call("/api/detect", { body: { projectDir: root }, origin })).json;
    const core = det.files.find((f) => f.type === "core");
    const r = await call("/api/write", {
      origin,
      body: {
        projectDir: root,
        configFile: core.path,
        environment: det.defaultEnvironment,
        connections: [{ name: "DataConnectionString", alias: "data" }],
        profileKey: "produccion",
        allowWrites: true,
        allowRules: true,
        allowWriteRules: true,
        clients: ["claude"],
      },
    });
    const allow = JSON.parse(fs.readFileSync(r.json.permissions.target, "utf8")).permissions.allow;
    assert.ok(
      !allow.some((x) => x.includes("execute_write_query") || x.includes("execute_sql_file")),
      `produccion no puede acabar con escrituras permitidas: ${allow.join(", ")}`
    );
  });
});

test("write no toca los permisos si no se piden las reglas", async () => {
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const det = (await call("/api/detect", { body: { projectDir: root }, origin })).json;
    const core = det.files.find((f) => f.type === "core");
    const r = await call("/api/write", {
      origin,
      body: {
        projectDir: root,
        configFile: core.path,
        environment: det.defaultEnvironment,
        connections: [{ name: "DataConnectionString", alias: "data" }],
        profileKey: "local",
        allowRules: false,
        clients: ["claude"],
      },
    });
    assert.equal(r.json.permissions, undefined);
    assert.ok(!fs.existsSync(path.join(root, ".claude", "settings.local.json")));
  });
});

test("la casilla de reglas de escritura llega oculta en la pagina", () => {
  // Solo debe aparecer cuando la escritura esta habilitada; el JS la muestra.
  const html = gui.renderPage("t0ken");
  assert.match(html, /id="wrapWriteRules" hidden/);
  assert.match(html, /id="cRules" checked/, "las de lectura si vienen marcadas");
});

test("write sin cliente ni conexion falla con mensaje, no con excepcion", async () => {
  const root = coreProject();
  await withGui(async ({ call, origin }) => {
    const r = await call("/api/write", {
      origin,
      body: { projectDir: root, configFile: null, profileKey: "local", clients: ["claude"] },
    });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /Falta el fichero de configuracion/);
  });
});

test("credentialsPathFor deja el fichero fuera del proyecto y con nombre saneado", () => {
  const p = gui.credentialsPathFor("C:\\proy\\Mi Proyecto (v2)");
  assert.match(path.basename(p), /^Mi_Proyecto__v2_\.json$/);
  assert.ok(!p.includes("Mi Proyecto (v2)" + path.sep), "no puede colgar del propio proyecto");
});

test("la pagina servida es autocontenida: sin recursos externos", () => {
  const html = gui.renderPage("t0ken");
  assert.ok(!/src\s*=\s*["']https?:/i.test(html), "sin scripts externos");
  assert.ok(!/href\s*=\s*["']https?:/i.test(html), "sin hojas de estilo externas");
  assert.ok(html.includes("t0ken"), "el token debe viajar en la pagina");
});

test("la pagina precarga la carpeta de trabajo, igual que el asistente de terminal", () => {
  // El exe no tiene que estar dentro del proyecto: la ruta se propone y se puede
  // editar. Antes el campo salia vacio y habia que teclearla siempre.
  const html = gui.renderPage("t0ken", "C:\\proy\\mio");
  assert.match(html, /id="dir" value="C:\\proy\\mio"/);
});

test("la carpeta precargada se escapa para no romper el atributo", () => {
  const html = gui.renderPage("t0ken", 'C:\\ra"ra&<x>');
  assert.ok(html.includes('value="C:\\ra&quot;ra&amp;&lt;x>"'), "comillas y & escapados");
});
