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
    assert.ok(mcp.mcpServers.mssql);
    const vs = JSON.parse(fs.readFileSync(path.join(root, ".vscode", "mcp.json"), "utf8"));
    assert.ok(vs.servers.mssql, "VS Code usa la clave servers");
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
      JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers.mssql.args
    );
    assert.ok(!args.includes("contrasena-secreta"), "la contrasena no puede estar en el .mcp.json");
    assert.ok(args.includes("--credentials-file"));

    const creds = JSON.parse(fs.readFileSync(r.json.credentialsFile, "utf8"));
    assert.equal(creds.password, "contrasena-secreta");
    fs.rmSync(r.json.credentialsFile, { force: true });
  });
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
