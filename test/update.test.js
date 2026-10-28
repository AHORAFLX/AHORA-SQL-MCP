const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  registerProject,
  readRegistry,
  collectProjects,
  splitLauncher,
  repairClientFile,
  runUpdate,
} = require("../installer/update");
const { entryPath } = require("../installer/runtime");

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

const slash = (p) => p.replace(/\\/g, "/");

/** Una instalacion de mentira con el package.json y el bundle, como la deja npm. */
function fakeRuntime(version = "1.17.0") {
  const dir = tempDir("upd-runtime-");
  const pkg = path.join(dir, "node_modules", "@ahoraflx", "sql-mcp");
  fs.mkdirSync(path.join(pkg, "bundle"), { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ version }));
  fs.writeFileSync(entryPath(dir), "");
  return dir;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

test("splitLauncher: la forma npx fijada a una version suelta solo el lanzador", () => {
  const r = splitLauncher(
    {
      command: "npx",
      args: [
        "--yes",
        "--prefer-offline",
        "--package=github:AHORAFLX/AHORA-SQL-MCP#v1.10.0",
        "start-mssql-mcp",
        "--config-file",
        "C:/p/Web.config",
      ],
    },
    "start-mssql-mcp",
    "C:/x"
  );
  assert.deepEqual(r, {
    flags: ["--config-file", "C:/p/Web.config"],
    form: "npx",
  });
});

test("splitLauncher: un node contra un clon de desarrollo no se toca", () => {
  const runtime = fakeRuntime();
  const r = splitLauncher(
    {
      command: "node",
      args: [
        "C:/gitcode/AHORA-SQL-MCP/bin/start-mssql-mcp.js",
        "--allow-writes",
      ],
    },
    "start-mssql-mcp",
    runtime
  );
  assert.equal(r, null);
});

test("repairClientFile: bin/*.js de la instalacion pasa a bundle/*.cjs y conserva flags y otros servidores", () => {
  const runtime = fakeRuntime();
  const root = tempDir("upd-proj-");
  const file = path.join(root, ".mcp.json");
  const viejo = `${slash(runtime)}/node_modules/@ahoraflx/sql-mcp/bin/start-mssql-mcp.js`;
  writeJson(file, {
    mcpServers: {
      "ahora-sql": {
        command: "node",
        args: [viejo, "--credentials-file", "C:/c.json", "--allow-writes"],
      },
      "ahora-erp": {
        command: "node",
        args: [
          `${slash(runtime)}/node_modules/@ahoraflx/sql-mcp/bin/start-ahora-mcp.js`,
          "--db",
          "data",
        ],
      },
      otro: { command: "foo", args: ["bar"] },
    },
  });

  const r = repairClientFile(file, "mcpServers", { runtime });
  assert.equal(r.changes.length, 2);

  const doc = readJson(file);
  assert.deepEqual(doc.mcpServers["ahora-sql"].args, [
    slash(entryPath(runtime)),
    "--credentials-file",
    "C:/c.json",
    "--allow-writes",
  ]);
  assert.match(
    doc.mcpServers["ahora-erp"].args[0],
    /bundle\/start-ahora-mcp\.cjs$/
  );
  assert.deepEqual(doc.mcpServers["ahora-erp"].args.slice(1), ["--db", "data"]);
  assert.deepEqual(doc.mcpServers.otro, { command: "foo", args: ["bar"] });
});

test("repairClientFile: lo que ya esta al dia no se reescribe", () => {
  const runtime = fakeRuntime();
  const root = tempDir("upd-proj-");
  const file = path.join(root, ".mcp.json");
  const texto = JSON.stringify({
    mcpServers: {
      "ahora-sql": {
        command: "node",
        args: [slash(entryPath(runtime)), "--production"],
      },
    },
  });
  fs.writeFileSync(file, texto);
  const r = repairClientFile(file, "mcpServers", { runtime });
  assert.equal(r.changes.length, 0);
  assert.equal(fs.readFileSync(file, "utf8"), texto);
});

test("repairClientFile: un JSON roto se informa y no se toca", () => {
  const root = tempDir("upd-proj-");
  const file = path.join(root, ".mcp.json");
  fs.writeFileSync(file, "{ roto");
  const r = repairClientFile(file, "mcpServers", { runtime: fakeRuntime() });
  assert.ok(r.error);
  assert.equal(fs.readFileSync(file, "utf8"), "{ roto");
});

test("registerProject: no apunta temporales, si el resto, y sin repetir", () => {
  const runtime = tempDir("upd-reg-");
  registerProject("C:/no/temporal", runtime, { tmp: "C:/otra" });
  registerProject("c:\\no\\temporal", runtime, { tmp: "C:/otra" });
  registerProject(path.join(os.tmpdir(), "x"), runtime);
  assert.equal(readRegistry(runtime).length, 1);
});

test("collectProjects: junta registro, ~/.claude.json y --scan, sin repetir", () => {
  const runtime = tempDir("upd-reg-");
  const home = tempDir("upd-home-");
  const a = tempDir("upd-a-");
  const raiz = tempDir("upd-scan-");
  const b = path.join(raiz, "cliente", "proyecto");
  writeJson(path.join(b, ".mcp.json"), { mcpServers: {} });

  registerProject(a, runtime, { tmp: "Z:/nada" });
  writeJson(path.join(home, ".claude.json"), {
    projects: { [slash(a)]: {}, "C:/no/existe": {} },
  });

  const found = collectProjects({ scan: [raiz], runtime, home }).map(slash);
  assert.deepEqual(found.sort(), [slash(a), slash(b)].sort());
});

test("runUpdate: instala una vez y repara todos los proyectos", async () => {
  const runtime = fakeRuntime();
  const home = tempDir("upd-home-");
  const p1 = tempDir("upd-p1-");
  const p2 = tempDir("upd-p2-");
  const sinNada = tempDir("upd-p3-");
  writeJson(path.join(p1, ".mcp.json"), {
    mcpServers: {
      "ahora-sql": {
        command: "npx",
        args: [
          "--yes",
          "--package=github:AHORAFLX/AHORA-SQL-MCP#v1.9.0",
          "start-mssql-mcp",
          "--production",
        ],
      },
    },
  });
  writeJson(path.join(p2, ".vscode", "mcp.json"), {
    servers: {
      "ahora-sql": {
        command: "node",
        args: [slash(entryPath(runtime)), "--allow-writes"],
      },
    },
  });
  writeJson(path.join(home, ".claude.json"), {
    projects: { [p1]: {}, [p2]: {}, [sinNada]: {} },
  });

  const installs = [];
  const { code, result } = await runUpdate({
    spec: "github:AHORAFLX/AHORA-SQL-MCP#v1.17.0",
    version: "1.17.0",
    runtime,
    home,
    install: (o) => {
      installs.push(o);
      return { reused: false };
    },
    product: async () => ({ skipped: "no instalado" }),
  });

  assert.equal(code, 0);
  assert.equal(installs.length, 1);
  // Solo cuentan los que tienen nuestra entrada; el tercero no esta configurado.
  assert.equal(result.projects.length, 2);
  const r1 = result.projects.find((p) => slash(p.root) === slash(p1));
  assert.equal(r1.repaired.length, 1);
  assert.deepEqual(
    readJson(path.join(p1, ".mcp.json")).mcpServers["ahora-sql"],
    {
      command: "node",
      args: [slash(entryPath(runtime)), "--production"],
    }
  );
});

test("runUpdate: si el runtime no se instala, no se toca ningun proyecto", async () => {
  const runtime = fakeRuntime();
  const home = tempDir("upd-home-");
  const p1 = tempDir("upd-p1-");
  const file = path.join(p1, ".mcp.json");
  const texto = JSON.stringify({
    mcpServers: {
      "ahora-sql": {
        command: "npx",
        args: [
          "--package=github:AHORAFLX/AHORA-SQL-MCP#v1.9.0",
          "start-mssql-mcp",
        ],
      },
    },
  });
  fs.writeFileSync(file, texto);
  writeJson(path.join(home, ".claude.json"), { projects: { [p1]: {} } });

  const { code, result } = await runUpdate({
    runtime,
    home,
    install: () => {
      throw new Error("sin red");
    },
  });
  assert.equal(code, 1);
  assert.equal(result.phase, "runtime");
  assert.equal(fs.readFileSync(file, "utf8"), texto);
});
