const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  npmCommand,
  runtimeDir,
  entryPath,
  installedVersion,
  installRuntime,
} = require("../installer/runtime");
// Ademas del desestructurado, el modulo entero: lo usan las pruebas de que un
// instalador viejo no puede degradar la instalacion.
const runtime = require("../installer/runtime");
const {
  resolveServerEntry,
  writeClientConfig,
  pruneLegacyServer,
  buildFlags,
  CLIENTS,
  PKG_SPEC,
} = require("../installer/setup");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Deja en su sitio el paquete instalado, como lo dejaria npm. */
function fakeNpmInstall(dir, version = "9.9.9") {
  const pkgDir = path.join(dir, "node_modules", "@ahoraflx", "sql-mcp");
  // bundle/ y no bin/: es lo unico que lleva el paquete publicado.
  fs.mkdirSync(path.join(pkgDir, "bundle"), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version }), "utf8");
  fs.writeFileSync(path.join(pkgDir, "bundle", "start-mssql-mcp.cjs"), "// noop", "utf8");
}

// ── donde se instala ──

test("npmCommand: en Windows npm es un .cmd, no un ejecutable", () => {
  assert.equal(npmCommand("win32"), "npm.cmd");
  assert.equal(npmCommand("linux"), "npm");
});

test("runtimeDir: en Windows va a LOCALAPPDATA, no a APPDATA", () => {
  // APPDATA se sincroniza con el perfil de dominio, y mover node_modules por la red
  // no interesa a nadie.
  const dir = runtimeDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" } });
  assert.equal(dir, path.join("C:\\Users\\x\\AppData\\Local", "AHORA-SQL-MCP"));
});

test("runtimeDir: sin LOCALAPPDATA se deduce del perfil del usuario", () => {
  const dir = runtimeDir({ platform: "win32", env: {}, home: "C:\\Users\\x" });
  assert.equal(dir, path.join("C:\\Users\\x", "AppData", "Local", "AHORA-SQL-MCP"));
});

test("runtimeDir: fuera de Windows sigue el estandar XDG", () => {
  assert.equal(
    runtimeDir({ platform: "linux", env: { XDG_DATA_HOME: "/home/x/.data" } }),
    path.join("/home/x/.data", "ahora-sql-mcp")
  );
  assert.equal(
    runtimeDir({ platform: "linux", env: {}, home: "/home/x" }),
    path.join("/home/x", ".local", "share", "ahora-sql-mcp")
  );
});

test("entryPath apunta al wrapper EMPAQUETADO del paquete instalado", () => {
  // Tiene que ser bundle/: el paquete publicado no lleva bin/ ni src/, porque asi su
  // instalacion no resuelve dependencias. Apuntar a bin/ escribiria un .mcp.json que
  // no arranca, y el fallo aparecería en la maquina de quien instala, no aqui.
  assert.equal(
    entryPath("C:\\base"),
    path.join(
      "C:\\base",
      "node_modules",
      "@ahoraflx",
      "sql-mcp",
      "bundle",
      "start-mssql-mcp.cjs"
    )
  );
});

// ── instalar una sola vez ──

test("installedVersion lee la version instalada, y null si no hay nada", () => {
  const dir = tempDir("rt-ver-");
  assert.equal(installedVersion(dir), null, "sin instalar");
  fakeNpmInstall(dir, "1.8.1");
  assert.equal(installedVersion(dir), "1.8.1");
});

test("installRuntime instala con --prefix y sin dependencias de desarrollo", () => {
  // Sin --omit=dev npm se trae eslint, prettier y nodemon, que no hacen falta para
  // ejecutar y multiplican el tiempo de instalacion.
  const dir = tempDir("rt-inst-");
  let argv;
  const { entry, reused } = installRuntime({
    spec: PKG_SPEC,
    version: "9.9.9",
    dir,
    platform: "win32",
    exec: (cmd, args, options) => {
      argv = { cmd, args, options };
      fakeNpmInstall(dir, "9.9.9");
      return "";
    },
  });

  assert.equal(argv.cmd, "npm.cmd");
  assert.deepEqual(argv.args, [
    "install",
    "--omit=dev",
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    PKG_SPEC,
  ]);
  // La carpeta va por cwd: en Windows hay que lanzar npm con shell, y con shell los
  // argumentos se pegan sin entrecomillar, asi que una ruta con espacios se partiria.
  assert.equal(argv.options.cwd, dir);
  assert.equal(argv.options.shell, true, "npm.cmd necesita shell en Windows");
  assert.ok(!argv.args.some((a) => a.includes(dir)), "ninguna ruta en la linea de comandos");
  assert.equal(entry, entryPath(dir));
  assert.equal(reused, false);
  // npm necesita un package.json en el prefix, o sube buscando uno y puede instalar
  // en una carpeta padre que no es la nuestra.
  assert.ok(fs.existsSync(path.join(dir, "package.json")), "hace falta el package.json del prefix");
});

test("installRuntime no reinstala si ya esta esa version exacta", () => {
  const dir = tempDir("rt-reuse-");
  fakeNpmInstall(dir, "1.8.1");
  const { reused } = installRuntime({
    spec: PKG_SPEC,
    version: "1.8.1",
    dir,
    exec: () => assert.fail("no deberia invocar npm: ya esta instalada"),
  });
  assert.equal(reused, true);
});

test("installRuntime SI reinstala si lo instalado es de otra version", () => {
  const dir = tempDir("rt-bump-");
  fakeNpmInstall(dir, "1.7.0");
  let called = 0;
  const { reused } = installRuntime({
    spec: PKG_SPEC,
    version: "1.8.1",
    dir,
    exec: () => {
      called += 1;
      fakeNpmInstall(dir, "1.8.1");
      return "";
    },
  });
  assert.equal(called, 1);
  assert.equal(reused, false);
});

test("installRuntime falla si npm termina bien pero no deja el script", () => {
  // Un npm que "funciona" y no deja nada es peor que un error: la configuracion
  // apuntaria a una ruta que no existe y el MCP no arrancaria nunca.
  const dir = tempDir("rt-vacio-");
  assert.throws(
    () => installRuntime({ spec: PKG_SPEC, version: "1.8.1", dir, exec: () => "" }),
    /no aparece/
  );
});

// ── que forma se escribe en la configuracion ──

const FLAGS = buildFlags({
  configFile: "C:\\proy\\Web.config",
  connections: [{ name: "DataConnectionString" }],
  sqlDirs: [],
});

test("resolveServerEntry escribe la forma instalada: node contra una ruta fija", () => {
  const entry = resolveServerEntry(FLAGS, {
    install: () => ({ entry: "C:\\base\\bin\\start-mssql-mcp.js", dir: "C:\\base" }),
  });
  assert.equal(entry.command, "node");
  assert.equal(entry.args[0], "C:/base/bin/start-mssql-mcp.js", "barras normales en el JSON");
  assert.deepEqual(entry.args.slice(1), FLAGS);
  assert.ok(!entry.args.includes("--yes"), "npx no interviene");
});

test("resolveServerEntry cae a npx si no se ha podido instalar", () => {
  // Una configuracion lenta es mejor que ninguna: quien no alcance GitHub ahora
  // podra arrancar cuando vuelva la red.
  const logged = [];
  const entry = resolveServerEntry(FLAGS, {
    install: () => {
      throw new Error("sin red");
    },
    log: (r) => logged.push(r),
  });
  assert.equal(entry.command, "npx");
  assert.deepEqual(entry.args.slice(0, 4), [
    "--yes",
    // Paliativo: en los arranques siguientes npm se queda con lo que ya tiene en cache
    // en lugar de revalidar la referencia contra GitHub.
    "--prefer-offline",
    `--package=${PKG_SPEC}`,
    "start-mssql-mcp",
  ]);
  assert.equal(logged[0].ok, false);
  assert.match(logged[0].error.message, /sin red/);
});

test("el .mcp.json resultante arranca con node, sin npx por medio", () => {
  // Es el estado final que importa: lo que el cliente MCP va a ejecutar en cada
  // arranque. Si aqui aparece "npx", el arranque vuelve a costar segundos.
  const root = tempDir("final-");
  const entry = resolveServerEntry(FLAGS, {
    install: () => ({ entry: "C:\\base\\bin\\start-mssql-mcp.js", dir: "C:\\base" }),
  });
  writeClientConfig(CLIENTS.claude, root, entry);

  const server = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"), "utf8"))
    .mcpServers["ahora-sql"];
  assert.equal(server.command, "node");
  assert.equal(server.args[0], "C:/base/bin/start-mssql-mcp.js");
  assert.ok(!JSON.stringify(server).includes("npx"), "npx no puede aparecer");
  assert.ok(!JSON.stringify(server).includes("--package"), "ni la resolucion del paquete");
});

// ── la entrada vieja en el cliente que no se configura ──

function writeServers(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(doc), "utf8");
}

test("pruneLegacyServer retira el 'mssql' nuestro del cliente que no se configura", () => {
  // Quien tenia Claude Code y Copilot y reinstala marcando uno solo se quedaba la
  // entrada vieja en el otro: seguia registrada y podian correr dos servidores.
  const root = tempDir("prune-");
  const file = path.join(root, ".vscode", "mcp.json");
  writeServers(file, {
    servers: {
      mssql: { command: "npx", args: ["--yes", "--package=github:AHORAFLX/AHORA-SQL-MCP#v1.7.0", "start-mssql-mcp"] },
      otro: { command: "node", args: ["a.js"] },
    },
  });

  assert.equal(pruneLegacyServer(CLIENTS.vscode, root), file);
  const servers = JSON.parse(fs.readFileSync(file, "utf8")).servers;
  assert.deepEqual(Object.keys(servers), ["otro"], "solo se va la nuestra");
});

test("pruneLegacyServer NO toca un 'mssql' que no es nuestro", () => {
  const root = tempDir("prune-ajeno-");
  const file = path.join(root, ".mcp.json");
  writeServers(file, { mcpServers: { mssql: { command: "node", args: ["otra-cosa.js"] } } });

  assert.equal(pruneLegacyServer(CLIENTS.claude, root), null);
  assert.ok(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.mssql, "se conserva");
});

test("pruneLegacyServer no crea ficheros ni escribe si no hay nada que retirar", () => {
  const root = tempDir("prune-nada-");
  assert.equal(pruneLegacyServer(CLIENTS.vscode, root), null);
  assert.ok(!fs.existsSync(path.join(root, ".vscode", "mcp.json")), "no puede crear el fichero");

  const file = path.join(root, ".mcp.json");
  writeServers(file, { mcpServers: { "ahora-sql": { command: "node", args: ["x.js"] } } });
  const before = fs.statSync(file).mtimeMs;
  assert.equal(pruneLegacyServer(CLIENTS.claude, root), null);
  assert.equal(fs.statSync(file).mtimeMs, before, "no se reescribe sin motivo");
});

// ── Un instalador viejo no puede degradar la instalacion ─────────────────────
//
// Caso real, y costo una tarde de "he actualizado y me sigue saliendo la vieja":
// cada instalador se instala A SI MISMO (PKG_SPEC lleva su propia version). Se lanzo
// el instalador nuevo desde la extension con `npx --package=github:...#v1.15.0`,
// pero se guardo en un formulario de la v1.12.2 que se habia quedado abierto en otra
// ventana -su servidor local sigue vivo hasta que se cierra- y ese reinstalo la
// 1.12.2 encima de la 1.15.0, sin un solo mensaje. El log de npm lo dejo grabado:
//   npx exec --package github:AHORAFLX/AHORA-SQL-MCP#v1.15.0 -- ahora-setup
//   npm install --omit dev ... github:AHORAFLX/AHORA-SQL-MCP#v1.12.2

/** Deja en `dir` una instalacion de mentira de la version dada. */
function fakeInstalled(dir, version) {
  const pkgDir = path.join(dir, "node_modules", "@ahoraflx", "sql-mcp");
  fs.mkdirSync(path.join(pkgDir, "bundle"), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ version }), "utf8");
  fs.writeFileSync(path.join(pkgDir, "bundle", "start-mssql-mcp.cjs"), "", "utf8");
  return pkgDir;
}

test("compareVersions ordena por numero, no por texto", () => {
  assert.ok(runtime.compareVersions("1.15.0", "1.9.0") > 0, "1.15.0 es posterior a 1.9.0");
  assert.ok(runtime.compareVersions("1.12.2", "1.15.0") < 0);
  assert.equal(runtime.compareVersions("1.15.0", "1.15.0"), 0);
  // Una version ilegible no puede hacerse pasar por mas nueva.
  assert.ok(runtime.compareVersions("no-es-una-version", "1.0.0") < 0);
});

test("installRuntime conserva la instalacion si es MAS NUEVA que el instalador", () => {
  const dir = tempDir("runtime-");
  fakeInstalled(dir, "1.15.0");
  let llamado = false;

  const r = runtime.installRuntime({
    spec: "github:AHORAFLX/AHORA-SQL-MCP#v1.12.2",
    version: "1.12.2",
    dir,
    platform: "win32",
    exec: () => {
      llamado = true;
    },
  });

  assert.equal(llamado, false, "no puede lanzar npm para instalar una version anterior");
  assert.equal(r.reused, true);
  assert.equal(r.keptNewer, "1.15.0", "tiene que decir que version ha conservado");
  const instalada = JSON.parse(
    fs.readFileSync(path.join(dir, "node_modules", "@ahoraflx", "sql-mcp", "package.json"), "utf8")
  );
  assert.equal(instalada.version, "1.15.0", "la instalacion no se toca");
});

test("installRuntime si instala cuando el instalador es mas nuevo", () => {
  const dir = tempDir("runtime-");
  fakeInstalled(dir, "1.12.2");
  const specs = [];

  const r = runtime.installRuntime({
    spec: "github:AHORAFLX/AHORA-SQL-MCP#v1.15.0",
    version: "1.15.0",
    dir,
    platform: "win32",
    exec: (_cmd, args) => specs.push(args[args.length - 1]),
  });

  assert.deepEqual(specs, ["github:AHORAFLX/AHORA-SQL-MCP#v1.15.0"]);
  assert.equal(r.reused, false);
  assert.equal(r.keptNewer, undefined);
});

test("con force se puede volver a una version anterior a proposito", () => {
  const dir = tempDir("runtime-");
  fakeInstalled(dir, "1.15.0");
  const specs = [];

  runtime.installRuntime({
    spec: "github:AHORAFLX/AHORA-SQL-MCP#v1.12.2",
    version: "1.12.2",
    dir,
    platform: "win32",
    force: true,
    exec: (_cmd, args) => specs.push(args[args.length - 1]),
  });

  assert.deepEqual(specs, ["github:AHORAFLX/AHORA-SQL-MCP#v1.12.2"]);
});
