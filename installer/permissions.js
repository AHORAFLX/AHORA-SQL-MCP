/**
 * Reglas de permisos para las herramientas del MCP.
 *
 * En modo auto, Claude Code pasa cada llamada por un clasificador de seguridad, y
 * puede denegarla — incluso una consulta de solo lectura. Sin una regla previa, eso
 * aparece en mitad de una demo como un "Blocked by classifier" que nadie relaciona
 * con el MCP.
 *
 * `permissions.allow` es la via documentada y soportada para esto, al contrario que
 * intentar pre-aprobar el servidor del `.mcp.json`, que no funciona.
 *
 * Los comodines en las reglas de allow solo valen DESPUES del prefijo
 * `mcp__<servidor>__`: un `mcp__*` suelto se ignora con un aviso.
 */
const fs = require("fs");
const path = require("path");
const { SERVER_NAME, LEGACY_SERVER_NAME } = require("./server-name");

/** Solo introspeccion y consulta. Las escrituras se dejan preguntando a proposito. */
function readRules(serverName = SERVER_NAME) {
  return [
    `mcp__${serverName}__list_*`,
    `mcp__${serverName}__describe_*`,
    `mcp__${serverName}__execute_read_query`,
  ];
}

/** Lo que modifica la base de datos. Nunca se anade sin pedirlo expresamente. */
function writeRules(serverName = SERVER_NAME) {
  return [
    `mcp__${serverName}__execute_write_query`,
    `mcp__${serverName}__execute_sql_file`,
  ];
}

/**
 * Raiz del repositorio git que contiene `dir`, o `dir` si no esta en uno.
 *
 * Importa: Claude Code carga `.claude/settings.local.json` desde la RAIZ del
 * repositorio, aunque la sesion arranque en un subdirectorio. Escribirlo en el
 * subdirectorio dejaria un fichero que nadie lee.
 */
function gitRootOf(dir) {
  let current = path.resolve(dir);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(dir);
    current = parent;
  }
}

function permissionsPath(projectDir) {
  return path.join(gitRootOf(projectDir), ".claude", "settings.local.json");
}

/**
 * Anade las reglas al `permissions.allow` del proyecto, fusionando.
 *
 * Un `settings.local.json` puede tener permisos de Bash y otros ajustes que no se
 * pueden perder, asi que nunca se sobrescribe: se lee, se fusiona y se deduplica.
 */
function allowMcpTools(projectDir, { includeWrites = false, serverName = SERVER_NAME } = {}) {
  const target = permissionsPath(projectDir);
  const wanted = [
    ...readRules(serverName),
    ...(includeWrites ? writeRules(serverName) : []),
  ];
  // Reglas del nombre anterior. Se retiran SOLO las que escribimos nosotros, nunca
  // un `mcp__mssql__*` cualquiera: puede ser de otra herramienta del equipo. Si no
  // se retiran, quedan autorizando un servidor que ya no existe.
  const stale =
    serverName === SERVER_NAME
      ? new Set([...readRules(LEGACY_SERVER_NAME), ...writeRules(LEGACY_SERVER_NAME)])
      : new Set();

  let doc = {};
  let backup;
  if (fs.existsSync(target)) {
    const raw = fs.readFileSync(target, "utf8");
    try {
      const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed;
    } catch {
      backup = `${target}.bak`;
      fs.copyFileSync(target, backup);
    }
  }

  const permissions =
    doc.permissions && typeof doc.permissions === "object" ? doc.permissions : {};
  const previous = Array.isArray(permissions.allow) ? permissions.allow : [];
  const removed = previous.filter((rule) => stale.has(rule));
  const allow = previous.filter((rule) => !stale.has(rule));
  const added = wanted.filter((rule) => !allow.includes(rule));

  doc.permissions = { ...permissions, allow: [...allow, ...added] };

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`, "utf8");

  return { target, added, removed, backup, alreadyHadAll: added.length === 0 };
}

module.exports = {
  allowMcpTools,
  permissionsPath,
  gitRootOf,
  readRules,
  writeRules,
  SERVER_NAME,
  LEGACY_SERVER_NAME,
};
