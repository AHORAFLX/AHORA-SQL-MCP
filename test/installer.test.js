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
  pickManyFromList,
  aliasFromName,
  suggestAliases,
  aliasError,
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
  // El .exe lleva su propio Node embebido: mirar process.versions.node daria âœ“ en
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
  assert.ok(!/âœ“ Node/.test(out), "no puede dar por bueno el runtime embebido");
});

test("writeClientConfig: Claude Code usa .mcp.json y la clave mcpServers", () => {
  const root = tempDir("inst-claude-");
  const { target } = writeClientConfig(CLIENTS.claude, root, { command: "npx", args: ["--yes", "x"] });
  assert.equal(target, path.join(root, ".mcp.json"));
  const doc = JSON.parse(fs.readFileSync(target, "utf8"));
  assert.deepEqual(Object.keys(doc), ["mcpServers"]);
  assert.equal(doc.mcpServers["ahora-sql"].command, "npx");
});

test("writeClientConfig: VS Code usa .vscode/mcp.json y la clave servers", () => {
  const root = tempDir("inst-vscode-");
  const { target } = writeClientConfig(CLIENTS.vscode, root, { command: "npx", args: ["--yes", "x"] });
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
  const { replaced, others } = writeClientConfig(CLIENTS.claude, root, { command: "npx", args: ["--yes"] });
  assert.equal(replaced, false);
  assert.deepEqual(others, ["otro"]);
  const doc = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.equal(doc.mcpServers.otro.command, "node", "no se puede perder el otro servidor");
  assert.equal(doc.algoMio, true, "ni las claves ajenas del fichero");
  assert.ok(doc.mcpServers["ahora-sql"]);
});

test("writeClientConfig informa de que reemplaza un ahora-sql anterior", () => {
  const root = tempDir("inst-replace-");
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { "ahora-sql": { command: "viejo" } } }),
    "utf8"
  );
  const { replaced } = writeClientConfig(CLIENTS.claude, root, { command: "npx", args: ["--yes"] });
  assert.equal(replaced, true);
  const doc = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"));
  assert.equal(doc.mcpServers["ahora-sql"].command, "npx");
});

test("writeClientConfig retira el servidor 'mssql' anterior si era nuestro", () => {
  // Dejarlo mantiene el choque con la extension nativa de SQL Server de VS Code,
  // que es justo lo que el renombrado viene a quitar.
  const root = tempDir("inst-migra-");
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        mssql: { command: "npx", args: ["--yes", "--package=github:AHORAFLX/AHORA-SQL-MCP#v1.7.0", "start-mssql-mcp"] },
      },
    }),
    "utf8"
  );
  const { migrated, replaced } = writeClientConfig(CLIENTS.claude, root, { command: "npx", args: ["--yes"] });
  assert.equal(migrated, true);
  assert.equal(replaced, false, "no reemplaza: la clave nueva no existia");
  const servers = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers;
  assert.deepEqual(Object.keys(servers), ["ahora-sql"]);
});

test("writeClientConfig NO toca un 'mssql' que no es nuestro", () => {
  const root = tempDir("inst-ajeno-");
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { mssql: { command: "node", args: ["otra-cosa.js"] } } }),
    "utf8"
  );
  const { migrated, others } = writeClientConfig(CLIENTS.claude, root, { command: "npx", args: ["--yes"] });
  assert.equal(migrated, false);
  assert.deepEqual(others, ["mssql"], "el servidor ajeno se conserva y se reporta");
  const servers = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers;
  assert.equal(servers.mssql.args[0], "otra-cosa.js");
});

test("writeClientConfig migra tambien en el fichero de VS Code", () => {
  // Es donde mas duele: la extension nativa vive en el mismo editor.
  const root = tempDir("inst-migra-vs-");
  fs.mkdirSync(path.join(root, ".vscode"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".vscode", "mcp.json"),
    JSON.stringify({ servers: { mssql: { command: "npx", args: ["start-mssql-mcp"] } } }),
    "utf8"
  );
  const { migrated } = writeClientConfig(CLIENTS.vscode, root, { command: "npx", args: ["--yes"] });
  assert.equal(migrated, true);
  const servers = JSON.parse(
    fs.readFileSync(path.join(root, ".vscode", "mcp.json"), "utf8")
  ).servers;
  assert.deepEqual(Object.keys(servers), ["ahora-sql"]);
});

test("writeClientConfig hace copia de seguridad si el JSON previo estaba roto", () => {
  const root = tempDir("inst-roto-");
  const file = path.join(root, ".mcp.json");
  fs.writeFileSync(file, "{ esto no es json", "utf8");
  writeClientConfig(CLIENTS.claude, root, { command: "npx", args: ["--yes"] });
  assert.ok(fs.existsSync(`${file}.bak`), "el fichero ilegible debe respaldarse");
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers["ahora-sql"]);
});

test("pickManyFromList coge tantas cadenas como se le pidan, no dos", async () => {
  // Regresion: el asistente solo sabia coger la de configuracion y la de datos de
  // Flexygo, y a partir de la tercera las descartaba en silencio.
  const names = ["Conf", "Data", "Historico", "Almacen"];
  const log = console.log;
  console.log = () => {};
  try {
    const cases = [
      ["1,2,3,4\n", names],
      ["todas\n", names],
      ["3 4\n", ["Historico", "Almacen"]],
      ["\n", ["Conf", "Data"]], // el valor por defecto que se le pasa
      ["2,2,2\n", ["Data"]], // repetidos, una sola vez
      ["9\nx\n1,3\n", ["Conf", "Historico"]], // reintenta hasta que sea valido
    ];
    for (const [input, expected] of cases) {
      const rl = new Prompter(Readable.from([input]), sink);
      assert.deepEqual(await pickManyFromList(rl, names, "Cuales", "1,2"), expected, input);
      rl.close();
    }
  } finally {
    console.log = log;
  }
});

test("aliasFromName mantiene config y data, y deriva el resto del nombre", () => {
  assert.equal(aliasFromName("ConfConnectionString"), "config");
  assert.equal(aliasFromName("DataConnectionString"), "data");
  assert.equal(aliasFromName("DatosConnectionString"), "data");
  assert.equal(aliasFromName("DefaultConnection"), "default");
  assert.equal(aliasFromName("Almacen Central"), "almacen_central");
});

test("suggestAliases desambigua cuando dos nombres sugieren lo mismo", () => {
  // Sin esto, la segunda pisaria a la primera: las dos exportarian
  // MSSQL_DATA_DATABASE y una de las dos bases de datos desapareceria.
  assert.deepEqual(
    suggestAliases(["ConfConnectionString", "DataConnectionString", "DatosHistoricos"]),
    ["config", "data", "data_2"]
  );
});

test("aliasError rechaza lo que no cabe en un nombre de variable de entorno", () => {
  // El alias se convierte en MSSQL_<ALIAS>_DATABASE y el servidor descubre las bases
  // de datos escaneando ese patron: un alias invalido las hace desaparecer sin error.
  assert.equal(aliasError("config"), null);
  assert.ok(aliasError(""));
  assert.ok(aliasError("mi-bd"), "el guion no vale en una variable de entorno");
  assert.ok(aliasError("mi bd"));
  assert.ok(aliasError("2bd"), "no puede empezar por digito");
  assert.ok(aliasError("almacÃ©n"));
  assert.ok(aliasError("DATA", ["data"]), "duplicado, sin distinguir mayusculas");
  assert.equal(aliasError("data_2", ["data"]), null);
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
