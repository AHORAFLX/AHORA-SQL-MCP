const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  allowMcpTools,
  permissionsPath,
  gitRootOf,
  readRules,
  writeRules,
} = require("../installer/permissions");

function tempDir() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "perms-")));
}

function read(target) {
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

test("las reglas de lectura llevan el prefijo del servidor y comodines anclados", () => {
  // Un comodin sin el prefijo `mcp__<servidor>__` se ignora con un aviso y no
  // autoriza nada, asi que el anclaje no es cosmetico.
  for (const rule of readRules("ahora-sql")) {
    assert.match(rule, /^mcp__ahora-sql__/);
  }
  assert.deepEqual(readRules("ahora-sql"), [
    "mcp__ahora-sql__list_*",
    "mcp__ahora-sql__describe_*",
    "mcp__ahora-sql__execute_read_query",
  ]);
});

test("las reglas de escritura son exactamente las dos que modifican la BD", () => {
  assert.deepEqual(writeRules("ahora-sql"), [
    "mcp__ahora-sql__execute_write_query",
    "mcp__ahora-sql__execute_sql_file",
  ]);
});

test("por defecto NO se permiten las escrituras", () => {
  const root = tempDir();
  const { target } = allowMcpTools(root);
  const allow = read(target).permissions.allow;
  assert.ok(allow.includes("mcp__ahora-sql__execute_read_query"));
  assert.ok(
    !allow.some((r) => r.includes("execute_write_query") || r.includes("execute_sql_file")),
    `no puede colarse una escritura: ${allow.join(", ")}`
  );
});

test("con includeWrites se anaden tambien las de escritura", () => {
  const root = tempDir();
  const { target } = allowMcpTools(root, { includeWrites: true });
  const allow = read(target).permissions.allow;
  assert.ok(allow.includes("mcp__ahora-sql__execute_write_query"));
  assert.ok(allow.includes("mcp__ahora-sql__execute_sql_file"));
});

test("las reglas del nombre anterior se retiran, y solo las nuestras", () => {
  // Quedarian autorizando un servidor que ya no existe. Pero un `mcp__mssql__*`
  // cualquiera puede ser de otra herramienta del equipo, y ese no se toca.
  const root = tempDir();
  const target = permissionsPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify({
      permissions: {
        allow: [
          "mcp__mssql__list_*",
          "mcp__mssql__describe_*",
          "mcp__mssql__execute_read_query",
          "mcp__mssql__algo_de_otra_herramienta",
          "Bash(npm test)",
        ],
      },
    }),
    "utf8"
  );

  const { removed } = allowMcpTools(root);
  const allow = read(target).permissions.allow;
  assert.deepEqual(removed, [
    "mcp__mssql__list_*",
    "mcp__mssql__describe_*",
    "mcp__mssql__execute_read_query",
  ]);
  assert.ok(!allow.some((r) => r.startsWith("mcp__mssql__e") || r === "mcp__mssql__list_*"));
  assert.ok(allow.includes("mcp__mssql__algo_de_otra_herramienta"), "lo ajeno se conserva");
  assert.ok(allow.includes("Bash(npm test)"));
  assert.ok(allow.includes("mcp__ahora-sql__execute_read_query"));
});

test("se fusiona sin perder los permisos que ya habia", () => {
  const root = tempDir();
  const target = permissionsPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify({
      permissions: { allow: ["Bash(npm test)"], deny: ["Bash(rm *)"] },
      otraCosa: 1,
    }),
    "utf8"
  );

  allowMcpTools(root);
  const doc = read(target);
  assert.ok(doc.permissions.allow.includes("Bash(npm test)"), "no se pierde lo que habia");
  assert.deepEqual(doc.permissions.deny, ["Bash(rm *)"], "ni las reglas de deny");
  assert.equal(doc.otraCosa, 1, "ni otras claves del fichero");
  assert.ok(doc.permissions.allow.includes("mcp__ahora-sql__execute_read_query"));
});

test("es idempotente: no duplica reglas", () => {
  const root = tempDir();
  allowMcpTools(root);
  const { added, alreadyHadAll, target } = allowMcpTools(root);
  assert.deepEqual(added, []);
  assert.equal(alreadyHadAll, true);
  const allow = read(target).permissions.allow;
  assert.equal(new Set(allow).size, allow.length, "sin duplicados");
});

test("un settings.local.json ilegible se respalda antes de reescribirlo", () => {
  const root = tempDir();
  const target = permissionsPath(root);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "{ no soy json", "utf8");

  const { backup } = allowMcpTools(root);
  assert.ok(backup && fs.existsSync(backup), "hay que poder recuperar lo que habia");
  assert.ok(read(target).permissions.allow.length > 0);
});

test("el fichero se escribe en la RAIZ del repositorio, no en el subdirectorio", () => {
  // Claude Code carga .claude/settings.local.json desde la raiz del repo aunque la
  // sesion arranque mas abajo: escribirlo en el subdirectorio no lo leeria nadie.
  const repo = tempDir();
  fs.mkdirSync(path.join(repo, ".git"));
  const sub = path.join(repo, "src", "modulo");
  fs.mkdirSync(sub, { recursive: true });

  assert.equal(gitRootOf(sub), repo);
  const { target } = allowMcpTools(sub);
  assert.equal(target, path.join(repo, ".claude", "settings.local.json"));
  assert.ok(!fs.existsSync(path.join(sub, ".claude", "settings.local.json")));
});

test("fuera de un repositorio git, el fichero va en la propia carpeta", () => {
  const root = tempDir();
  assert.equal(gitRootOf(root), root);
  assert.equal(permissionsPath(root), path.join(root, ".claude", "settings.local.json"));
});
