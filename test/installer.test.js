const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const {
  Prompter,
  findConfigFiles,
  buildArgs,
  writeClientConfig,
  CLIENTS,
  PKG_SPEC,
} = require("../installer/setup");

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const sink = { write() {} };

test("Prompter encola las lineas que llegan antes de preguntar", async () => {
  // Regresion: readline/promises descartaba las lineas que llegaban sin una
  // pregunta esperando, y el instalador terminaba con codigo 0 sin instalar nada.
  const input = Readable.from(["uno\ndos\ntres\n"]);
  const p = new Prompter(input, sink);
  // Se da tiempo a que readline emita las tres lineas antes de la primera espera.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await p.next(), "uno");
  assert.equal(await p.next(), "dos");
  assert.equal(await p.next(), "tres");
});

test("Prompter devuelve null al agotarse la entrada", async () => {
  const p = new Prompter(Readable.from(["solo-una\n"]), sink);
  assert.equal(await p.next(), "solo-una");
  assert.equal(await p.next(), null, "el fin de entrada debe ser detectable");
});

test("Prompter sirve lineas que llegan despues de la espera", async () => {
  const input = new Readable({ read() {} });
  const p = new Prompter(input, sink);
  const pending = p.next();
  input.push("tardia\n");
  assert.equal(await pending, "tardia");
  input.push(null);
});

test("buildArgs: orden y forma de los argumentos", () => {
  const args = buildArgs({
    configFile: "C:\\proy\\conf\\appsettings.json",
    connections: [
      { name: "ConfConnectionString", alias: "config" },
      { name: "DataConnectionString", alias: "data" },
    ],
    environment: "Development",
    allowWrites: true,
    sqlDirs: ["C:\\scripts"],
  });
  assert.deepEqual(args, [
    "--yes",
    `--package=${PKG_SPEC}`,
    "start-mssql-mcp",
    "--config-file",
    "C:/proy/conf/appsettings.json",
    "--connection-name",
    "ConfConnectionString:config",
    "--connection-name",
    "DataConnectionString:data",
    "--environment",
    "Development",
    "--allow-sql-dir",
    "C:/scripts",
    "--allow-writes",
  ]);
});

test("buildArgs: sin alias, sin entorno, sin escritura y sin carpetas extra", () => {
  const args = buildArgs({
    configFile: "C:\\proy\\Web.config",
    connections: [{ name: "DataConnectionString", alias: undefined }],
    environment: undefined,
    allowWrites: false,
    sqlDirs: [],
  });
  assert.deepEqual(args.slice(3), [
    "--config-file",
    "C:/proy/Web.config",
    "--connection-name",
    "DataConnectionString",
  ]);
  assert.ok(!args.includes("--allow-writes"));
  assert.ok(!args.includes("--environment"));
});

test("buildArgs fija la version del paquete, nunca una rama", () => {
  assert.match(PKG_SPEC, /^github:AHORAFLX\/AHORA-SQL-MCP#v\d+\.\d+\.\d+$/);
});

test("el instalador comprueba el Node DE LA MAQUINA, no el que lo ejecuta", () => {
  // El .exe lleva su propio Node embebido: mirar process.versions.node daria ✓ en
  // un equipo sin Node, y la configuracion escrita arranca el servidor con npx.
  const { execFileSync } = require("node:child_process");
  const entry = path.join(__dirname, "..", "installer", "setup.js");
  let out = "";
  try {
    out = execFileSync(process.execPath, [entry, "--cli"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      // PATH sin node: es lo que se encontrara el .exe en una maquina limpia.
      env: { ...process.env, PATH: process.platform === "win32" ? "C:\\Windows\\System32" : "/nonexistent" },
    });
  } catch (err) {
    out = err.stdout || "";
  }
  assert.match(out, /No hay Node\.js instalado en este equipo/);
  assert.ok(!/✓ Node/.test(out), "no puede dar por bueno el runtime embebido");
});

test("writeClientConfig: Claude Code usa .mcp.json y la clave mcpServers", () => {
  const root = tempDir("inst-claude-");
  const { target } = writeClientConfig(CLIENTS.claude, root, ["--yes", "x"]);
  assert.equal(target, path.join(root, ".mcp.json"));
  const doc = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(Object.keys(doc), ["mcpServers"]);
  assert.equal(doc.mcpServers.mssql.command, "npx");
});

test("writeClientConfig: VS Code usa .vscode/mcp.json y la clave servers", () => {
  const root = tempDir("inst-vscode-");
  const { target } = writeClientConfig(CLIENTS.vscode, root, ["--yes", "x"]);
  assert.equal(target, path.join(root, ".vscode", "mcp.json"));
  const doc = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(Object.keys(doc), ["servers"]);
});

test("writeClientConfig conserva los otros servidores MCP del fichero", () => {
  const root = tempDir("inst-merge-");
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: { otro: { command: "node", args: ["a.js"] } },
      algoMio: true,
    }),
    "utf8"
  );
  const { replaced, others } = writeClientConfig(CLIENTS.claude, root, ["--yes"]);
  assert.equal(replaced, false);
  assert.deepEqual(others, ["otro"]);
  const doc = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.equal(doc.mcpServers.otro.command, "node", "no se puede perder el otro servidor");
  assert.equal(doc.algoMio, true, "ni las claves ajenas del fichero");
  assert.ok(doc.mcpServers.mssql);
});

test("writeClientConfig informa de que reemplaza un mssql anterior", () => {
  const root = tempDir("inst-replace-");
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { mssql: { command: "viejo" } } }),
    "utf8"
  );
  const { replaced } = writeClientConfig(CLIENTS.claude, root, ["--yes"]);
  assert.equal(replaced, true);
  const doc = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.equal(doc.mcpServers.mssql.command, "npx");
});

test("writeClientConfig hace copia de seguridad si el JSON previo estaba roto", () => {
  const root = tempDir("inst-roto-");
  const file = path.join(root, ".mcp.json");
  fs.writeFileSync(file, "{ esto no es json", "utf8");
  writeClientConfig(CLIENTS.claude, root, ["--yes"]);
  assert.ok(fs.existsSync(`${file}.bak`), "el fichero ilegible debe respaldarse");
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.mssql);
});

test("findConfigFiles encuentra los dos formatos y salta las carpetas de ruido", () => {
  const root = tempDir("inst-find-");
  fs.mkdirSync(path.join(root, "Backend", "conf"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "algo"), { recursive: true });
  fs.mkdirSync(path.join(root, "obj"), { recursive: true });

  fs.writeFileSync(path.join(root, "Web.config"), "<configuration/>", "utf8");
  fs.writeFileSync(
    path.join(root, "Backend", "conf", "appsettings.json"),
    JSON.stringify({ ConnectionStrings: { X: "Data Source=A;Initial Catalog=B" } }),
    "utf8"
  );
  fs.writeFileSync(path.join(root, "node_modules", "algo", "appsettings.json"), "{}", "utf8");
  fs.writeFileSync(path.join(root, "obj", "Web.config"), "<configuration/>", "utf8");

  const found = findConfigFiles(root).map((p) => path.relative(root, p));
  assert.ok(found.includes("Web.config"));
  assert.ok(found.includes(path.join("Backend", "conf", "appsettings.json")));
  assert.ok(
    !found.some((f) => f.includes("node_modules") || f.startsWith("obj")),
    `no debe mirar en carpetas de ruido: ${found.join(", ")}`
  );
});

test("findConfigFiles pone primero los ficheros que SI tienen cadenas de conexion", () => {
  const root = tempDir("inst-orden-");
  fs.mkdirSync(path.join(root, "Account"));
  // Como en Flexygo: el Web.config de la subcarpeta no lleva connectionStrings.
  fs.writeFileSync(path.join(root, "Account", "Web.config"), "<configuration/>", "utf8");
  fs.writeFileSync(
    path.join(root, "Web.config"),
    `<configuration><connectionStrings><clear />
       <add name="DataConnectionString" connectionString="Data Source=A;Initial Catalog=B" />
     </connectionStrings></configuration>`,
    "utf8"
  );
  const found = findConfigFiles(root).map((p) => path.relative(root, p));
  assert.equal(found[0], "Web.config");
});
