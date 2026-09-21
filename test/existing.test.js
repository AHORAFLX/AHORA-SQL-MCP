/**
 * El camino de vuelta del instalador: leer lo que YA hay configurado.
 *
 * Lo que se prueba aqui no es un detalle de formato. `parseServerArgs` tiene que ser
 * la inversa EXACTA de `buildFlags`, porque de eso depende que reconfigurar un
 * proyecto conserve lo que no se ha tocado; y tiene que tragar con un `.mcp.json`
 * roto o escrito a mano sin tumbar el instalador antes de la primera pantalla.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  readExisting,
  parseServerArgs,
  parseProductArgs,
  parseConnectionName,
  readCredentials,
  samePath,
} = require("../installer/existing");
const { buildFlags } = require("../installer/setup");
const { writeCredentialsFile, readExistingSecrets, credentialsPathFor } =
  require("../installer/credentials");
const { isProtected, reveal } = require("../src/secrets");

function tempDir(prefix = "existing-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Proyecto con una entrada `ahora-sql` ya escrita, como la deja el instalador. */
function projectWith(args, { extra = {}, clientKey = "mcpServers", file = ".mcp.json" } = {}) {
  const root = tempDir();
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify({
      [clientKey]: {
        "ahora-sql": { command: "node", args: ["C:/x/bundle/start-mssql-mcp.cjs", ...args] },
        ...extra,
      },
    }),
    "utf8"
  );
  return root;
}

// ── parseServerArgs, la inversa de buildFlags ────────────────────────────────

test("parseServerArgs deshace exactamente lo que escribe buildFlags", () => {
  const opciones = {
    configFile: "C:/proyecto/Web.config",
    connections: [
      { name: "ConfConnectionString", alias: "config" },
      { name: "DataConnectionString", alias: "data" },
    ],
    environment: "Development",
    allowWrites: true,
    production: false,
    sqlDirs: ["C:/scripts"],
  };
  const vuelta = parseServerArgs(["C:/x/start-mssql-mcp.cjs", ...buildFlags(opciones)]);

  assert.equal(vuelta.configFile, "C:/proyecto/Web.config");
  assert.deepEqual(vuelta.connections, opciones.connections);
  assert.equal(vuelta.environment, "Development");
  assert.deepEqual(vuelta.sqlDirs, ["C:/scripts"]);
  assert.equal(vuelta.allowWrites, true);
  assert.equal(vuelta.production, false);
  assert.deepEqual(vuelta.unknown, []);
});

test("parseServerArgs recupera la forma con fichero de credenciales", () => {
  const flags = buildFlags({
    credentialsFile: "C:/Users/x/AppData/Roaming/ahora-sql-mcp/proy.json",
    connections: [],
    allowWrites: false,
    production: true,
    sqlDirs: [],
  });
  const vuelta = parseServerArgs(["C:/x/start-mssql-mcp.cjs", ...flags]);

  assert.equal(vuelta.credentialsFile, "C:/Users/x/AppData/Roaming/ahora-sql-mcp/proy.json");
  assert.equal(vuelta.configFile, null);
  assert.equal(vuelta.production, true);
  assert.equal(vuelta.allowWrites, false);
});

test("una sola conexion no lleva alias, y la clave la pone el servidor", () => {
  const flags = buildFlags({
    configFile: "C:/p/Web.config",
    connections: [{ name: "MiCadena", alias: undefined }],
    allowWrites: false,
    production: false,
    sqlDirs: [],
  });
  assert.deepEqual(parseServerArgs(flags).connections, [{ name: "MiCadena", alias: "" }]);
});

test("parseServerArgs ignora los argumentos del lanzador npx", () => {
  const vuelta = parseServerArgs([
    "--yes",
    "--prefer-offline",
    "--package=github:AHORAFLX/AHORA-SQL-MCP#v1.0.0",
    "start-mssql-mcp",
    "--config-file",
    "C:/p/Web.config",
  ]);
  assert.equal(vuelta.configFile, "C:/p/Web.config");
  assert.deepEqual(vuelta.unknown, []);
});

/**
 * Lo que no se sabe editar NO se descarta en silencio: precargar y volver a guardar
 * reemplaza la entrada entera, asi que un flag puesto a mano desapareceria sin que
 * nadie se entere. Quien llama lo enseña antes de escribir.
 */
test("parseServerArgs devuelve los flags que no sabe editar, con su valor", () => {
  const vuelta = parseServerArgs([
    "C:/x/start-mssql-mcp.cjs",
    "--config-file",
    "C:/p/Web.config",
    "--allow-writes-for",
    "data",
    "--port",
    "1433",
  ]);
  assert.equal(vuelta.configFile, "C:/p/Web.config");
  assert.deepEqual(vuelta.unknown, ["--allow-writes-for", "data", "--port", "1433"]);
});

test("parseServerArgs aguanta argumentos sueltos o a medias", () => {
  assert.deepEqual(parseServerArgs([]).connections, []);
  assert.deepEqual(parseServerArgs(null).unknown, []);
  // Un flag con valor al que le falta el valor no puede consumir el final del array.
  assert.deepEqual(parseServerArgs(["--config-file"]).unknown, ["--config-file"]);
});

test("parseConnectionName parte por el primer dos puntos", () => {
  assert.deepEqual(parseConnectionName("Conf:config"), { name: "Conf", alias: "config" });
  assert.deepEqual(parseConnectionName("Conf"), { name: "Conf", alias: "" });
});

test("parseProductArgs saca la base de datos del MCP de producto", () => {
  assert.deepEqual(
    parseProductArgs(["--server-dll", "x.dll", "--credentials-file", "c.json", "--db", "data"]),
    { connectionName: null, db: "data" }
  );
  assert.deepEqual(
    parseProductArgs(["--config-file", "w.config", "--connection-name", "DataConnectionString"]),
    { connectionName: "DataConnectionString", db: null }
  );
});

// ── readExisting sobre un proyecto de verdad ─────────────────────────────────

test("readExisting reconstruye la configuracion de un proyecto", () => {
  const root = projectWith([
    "--config-file",
    "C:/p/Web.config",
    "--connection-name",
    "Conf:config",
    "--connection-name",
    "Datos:data",
    "--environment",
    "Development",
    "--allow-writes",
  ]);
  const previo = readExisting(root);

  assert.equal(previo.found, true);
  assert.deepEqual(previo.clients, ["claude"]);
  assert.equal(previo.configFile, "C:/p/Web.config");
  assert.deepEqual(previo.connections.map((c) => c.alias), ["config", "data"]);
  assert.equal(previo.allowWrites, true);
  assert.equal(previo.profileKey, "local");
});

test("readExisting recuerda que la configuracion era de PRODUCCION", () => {
  const root = projectWith(["--config-file", "C:/p/Web.config", "--production"]);
  const previo = readExisting(root);
  assert.equal(previo.production, true);
  assert.equal(previo.profileKey, "produccion");
});

test("readExisting dice en que clientes esta nuestra entrada", () => {
  const root = projectWith(["--config-file", "C:/p/Web.config"]);
  fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".vscode", "mcp.json"),
    JSON.stringify({
      servers: {
        "ahora-sql": { command: "node", args: ["C:/x/start-mssql-mcp.cjs", "--config-file", "C:/p/Web.config"] },
      },
    }),
    "utf8"
  );
  assert.deepEqual(readExisting(root).clients.sort(), ["claude", "vscode"]);
});

test("readExisting ve el MCP de producto y el de navegador", () => {
  const root = projectWith(["--credentials-file", "C:/c.json"], {
    extra: {
      "ahora-erp": {
        command: "node",
        args: ["C:/x/start-ahora-mcp.cjs", "--credentials-file", "C:/c.json", "--db", "data"],
      },
      playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
    },
  });
  const previo = readExisting(root);
  assert.deepEqual(previo.product, { connectionName: null, db: "data" });
  assert.equal(previo.playwright, true);
});

test("un proyecto sin configurar devuelve la forma vacia, no undefined", () => {
  const previo = readExisting(tempDir());
  assert.equal(previo.found, false);
  // Quien precarga lee estos campos sin comprobar antes si habia algo.
  assert.deepEqual(previo.sqlDirs, []);
  assert.deepEqual(previo.connections, []);
  assert.deepEqual(previo.clients, []);
  assert.equal(previo.permissions.write, false);
  assert.equal(previo.profileKey, "local");
});

test("un .mcp.json roto no tumba el instalador: solo no hay nada que precargar", () => {
  const root = tempDir();
  fs.writeFileSync(path.join(root, ".mcp.json"), "{ esto no es json", "utf8");
  assert.equal(readExisting(root).found, false);
});

test("una entrada 'ahora-sql' que no es nuestra se deja en paz", () => {
  const root = tempDir();
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { "ahora-sql": { command: "otra-cosa.exe", args: [] } } }),
    "utf8"
  );
  assert.equal(readExisting(root).found, false);
});

// ── credenciales ─────────────────────────────────────────────────────────────

test("readCredentials devuelve los datos pero nunca la contrasena", () => {
  const dir = tempDir();
  const file = path.join(dir, "cred.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      connections: {
        config: { server: "PC\\SQL", database: "DEMO_IC", user: "sa", passwordEnc: "dpapi:xxx" },
        data: { server: "PC\\SQL", database: "DEMO", user: "sa", passwordEnc: "dpapi:yyy" },
      },
    }),
    "utf8"
  );
  const leidas = readCredentials(file);

  assert.deepEqual(leidas.map((c) => c.alias), ["config", "data"]);
  assert.equal(leidas[0].database, "DEMO_IC");
  assert.equal(leidas[0].hasPassword, true);
  const serializado = JSON.stringify(leidas);
  assert.ok(!serializado.includes("dpapi:"), "el token cifrado no puede salir de aqui");
  assert.ok(!serializado.includes("password\":"), "no se expone ningun campo de contrasena");
});

test("readCredentials entiende la forma de una sola conexion sin alias", () => {
  const dir = tempDir();
  const file = path.join(dir, "cred.json");
  fs.writeFileSync(
    file,
    JSON.stringify({ server: "PC\\SQL", database: "DEMO", user: "sa", passwordEnc: "dpapi:z" }),
    "utf8"
  );
  assert.deepEqual(readCredentials(file), [
    { alias: "", server: "PC\\SQL", database: "DEMO", user: "sa", port: "", hasPassword: true },
  ]);
});

test("readCredentials con un fichero que no existe no lanza", () => {
  assert.deepEqual(readCredentials(path.join(tempDir(), "no-esta.json")), []);
});

/**
 * El nucleo de "cambiar de base de datos sin volver a escribirlo todo": la
 * contrasena que no se reescribe se conserva, y se conserva CIFRADA —no se descifra
 * para volver a cifrarla, que costaria un arranque de PowerShell por conexion—.
 */
test("writeCredentialsFile reutiliza la contrasena cifrada que ya estaba", () => {
  const proyecto = tempDir("proyecto-");
  writeCredentialsFile(proyecto, [
    { server: "PC\\SQL", database: "DEMO_IC", user: "sa", password: "secreta", alias: "config" },
    { server: "PC\\SQL", database: "DEMO", user: "sa", password: "otra", alias: "data" },
  ]);
  const antes = readExistingSecrets(credentialsPathFor(proyecto));

  // Se cambia SOLO la base de datos de 'data', sin tocar ninguna contrasena.
  writeCredentialsFile(proyecto, [
    { server: "PC\\SQL", database: "DEMO_IC", user: "sa", password: "", alias: "config" },
    { server: "PC\\SQL", database: "OTRA_BD", user: "sa", password: "", alias: "data" },
  ]);

  const doc = JSON.parse(fs.readFileSync(credentialsPathFor(proyecto), "utf8"));
  assert.equal(doc.connections.data.database, "OTRA_BD");
  assert.equal(doc.connections.config.passwordEnc, antes.get("config"));
  assert.equal(doc.connections.data.passwordEnc, antes.get("data"));
  assert.ok(isProtected(doc.connections.data.passwordEnc));
  assert.equal(reveal(doc.connections.data.passwordEnc), "otra");
});

test("una contrasena nueva sustituye a la guardada", () => {
  const proyecto = tempDir("proyecto-");
  const uno = [{ server: "PC\\SQL", database: "DEMO", user: "sa", password: "vieja" }];
  writeCredentialsFile(proyecto, uno);
  writeCredentialsFile(proyecto, [{ ...uno[0], password: "nueva" }]);

  const doc = JSON.parse(fs.readFileSync(credentialsPathFor(proyecto), "utf8"));
  assert.equal(reveal(doc.passwordEnc), "nueva");
});

test("sin contrasena guardada ni tecleada se avisa en vez de escribir un fichero inservible", () => {
  const proyecto = tempDir("proyecto-");
  assert.throws(
    () => writeCredentialsFile(proyecto, [{ server: "PC", database: "D", user: "sa", password: "" }]),
    /Falta la contrasena/
  );
});

test("renombrar el alias de la unica conexion no obliga a reescribir la contrasena", () => {
  const proyecto = tempDir("proyecto-");
  writeCredentialsFile(proyecto, [
    { server: "PC\\SQL", database: "DEMO", user: "sa", password: "secreta" },
  ]);
  writeCredentialsFile(proyecto, [
    { server: "PC\\SQL", database: "DEMO", user: "sa", password: "", alias: "config" },
  ]);
  const doc = JSON.parse(fs.readFileSync(credentialsPathFor(proyecto), "utf8"));
  assert.equal(reveal(doc.connections.config.passwordEnc), "secreta");
});

// ── samePath ─────────────────────────────────────────────────────────────────

test("samePath no distingue barras ni mayusculas", () => {
  const conBarra = "C:" + String.fromCharCode(92) + "p" + String.fromCharCode(92) + "Web.config";
  assert.equal(samePath("C:/p/web.CONFIG", conBarra), true);
  assert.equal(samePath("C:/p/Web.config", "C:/otro/Web.config"), false);
  assert.equal(samePath(null, "C:/p/Web.config"), false);
});
