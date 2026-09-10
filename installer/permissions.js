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
const {
  SERVER_NAME,
  LEGACY_SERVER_NAME,
  PRODUCT_SERVER_NAME,
  PLAYWRIGHT_SERVER_NAME,
} = require("./server-name");

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
 * Lectura del MCP de producto.
 *
 * Sus 98 herramientas no siguen el mismo vocabulario que las de aqui: el verbo va en
 * castellano y delante (`ahora_leer_objeto`, `ahora_listar_pantallas`), asi que las
 * reglas son otras, no las mismas con otro prefijo. Tomadas del `tools/list` real del
 * servidor, no de su documentacion, que las nombra en PascalCase.
 *
 * `ahora_connect` y `ahora_disconnect` entran en lectura aunque cambien el estado de
 * la sesion: no tocan datos, y sin ellas el agente no puede ni reconectar cuando el
 * servidor pierde la conexion.
 */
function productReadRules(serverName = PRODUCT_SERVER_NAME) {
  return [
    `mcp__${serverName}__ahora_leer_*`,
    `mcp__${serverName}__ahora_listar_*`,
    `mcp__${serverName}__ahora_buscar_*`,
    `mcp__${serverName}__ahora_obtener_*`,
    `mcp__${serverName}__ahora_describir_*`,
    `mcp__${serverName}__ahora_consulta_segura`,
    `mcp__${serverName}__ahora_diagnosticar_usuario`,
    `mcp__${serverName}__ahora_test_connection`,
    `mcp__${serverName}__ahora_connect`,
    `mcp__${serverName}__ahora_disconnect`,
  ];
}

/**
 * Escritura del MCP de producto.
 *
 * Aqui pesa mas que en el servidor de SQL: `ahora-mcp` no tiene modo de solo lectura
 * —ningun conmutador desactiva estas herramientas—, asi que estas reglas son el unico
 * freno que queda. Por eso solo se anaden pidiendolas a proposito.
 */
function productWriteRules(serverName = PRODUCT_SERVER_NAME) {
  return [
    `mcp__${serverName}__ahora_crear_*`,
    `mcp__${serverName}__ahora_modificar_*`,
    `mcp__${serverName}__ahora_borrar_*`,
    `mcp__${serverName}__ahora_eliminar_*`,
    `mcp__${serverName}__ahora_actualizar_*`,
    `mcp__${serverName}__ahora_activar_*`,
    `mcp__${serverName}__ahora_asignar_*`,
    `mcp__${serverName}__ahora_insertar_*`,
    `mcp__${serverName}__ahora_aplicar_*`,
    `mcp__${serverName}__ahora_importar_*`,
    `mcp__${serverName}__ahora_exportar_*`,
    `mcp__${serverName}__ahora_escribir_*`,
    `mcp__${serverName}__ahora_confirmar_*`,
    `mcp__${serverName}__ahora_cancelar_*`,
    `mcp__${serverName}__ahora_ejecutar_dml`,
  ];
}

/**
 * Mirar con el navegador: abrir una URL y leer lo que hay.
 *
 * Nombres tomados del `tools/list` real de `@playwright/mcp`, no de su documentacion.
 * Todos son enteros y no comodines a proposito: `browser_*` de golpe se llevaria por
 * delante la separacion que viene justo debajo, y la familia crece con cada version.
 *
 * `browser_navigate` entra aqui aunque abra lo que se le pida: es el equivalente a
 * mirar una pagina, algo que el agente ya puede hacer por otras vias, y sin ella cada
 * paso de una comprobacion de pantalla se detiene a preguntar.
 */
function playwrightReadRules(serverName = PLAYWRIGHT_SERVER_NAME) {
  return [
    `mcp__${serverName}__browser_navigate`,
    `mcp__${serverName}__browser_navigate_back`,
    `mcp__${serverName}__browser_snapshot`,
    `mcp__${serverName}__browser_take_screenshot`,
    `mcp__${serverName}__browser_console_messages`,
    `mcp__${serverName}__browser_network_requests`,
    `mcp__${serverName}__browser_network_request`,
    `mcp__${serverName}__browser_find`,
    `mcp__${serverName}__browser_wait_for`,
    `mcp__${serverName}__browser_resize`,
    `mcp__${serverName}__browser_tabs`,
    `mcp__${serverName}__browser_hover`,
    `mcp__${serverName}__browser_close`,
  ];
}

/**
 * Tocar con el navegador: clic, teclado, formularios.
 *
 * Van aparte de la lectura por el mismo motivo que las escrituras de SQL: un clic en
 * la pantalla del ERP ejecuta lo que haya detras del boton, y eso puede acabar en un
 * INSERT que no pasa por ninguna de las reglas de este fichero. Solo se anaden
 * pidiendolas a proposito.
 *
 * `browser_evaluate` y `browser_run_code_unsafe` NO estan, y no es un olvido: ejecutan
 * el codigo que les pasen dentro de la pagina, asi que una regla para ellas autoriza
 * cualquier cosa que se pueda escribir en JavaScript. Esas siguen preguntando siempre.
 */
function playwrightActionRules(serverName = PLAYWRIGHT_SERVER_NAME) {
  return [
    `mcp__${serverName}__browser_click`,
    `mcp__${serverName}__browser_type`,
    `mcp__${serverName}__browser_fill_form`,
    `mcp__${serverName}__browser_press_key`,
    `mcp__${serverName}__browser_select_option`,
    `mcp__${serverName}__browser_drag`,
    `mcp__${serverName}__browser_drop`,
    `mcp__${serverName}__browser_file_upload`,
    `mcp__${serverName}__browser_handle_dialog`,
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
function allowMcpTools(
  projectDir,
  {
    includeWrites = false,
    serverName = SERVER_NAME,
    product = false,
    productWrites = false,
    productServerName = PRODUCT_SERVER_NAME,
    playwright = false,
    playwrightActions = false,
    playwrightServerName = PLAYWRIGHT_SERVER_NAME,
  } = {}
) {
  const target = permissionsPath(projectDir);
  // Los dos servidores en la misma pasada, y SUMANDO: la entrada del MCP de producto
  // se anade al lado de la de SQL, nunca en su lugar. Quien resuelve tickets sigue
  // usando `mcp__ahora-sql__*` en la misma sesion en la que otro personaliza producto
  // con `mcp__ahora-erp__*`; los prefijos son distintos y las reglas no se pisan.
  const wanted = [
    ...readRules(serverName),
    ...(includeWrites ? writeRules(serverName) : []),
    ...(product ? productReadRules(productServerName) : []),
    ...(product && productWrites ? productWriteRules(productServerName) : []),
    ...(playwright ? playwrightReadRules(playwrightServerName) : []),
    ...(playwright && playwrightActions ? playwrightActionRules(playwrightServerName) : []),
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
  productReadRules,
  productWriteRules,
  playwrightReadRules,
  playwrightActionRules,
  SERVER_NAME,
  LEGACY_SERVER_NAME,
  PRODUCT_SERVER_NAME,
  PLAYWRIGHT_SERVER_NAME,
};
