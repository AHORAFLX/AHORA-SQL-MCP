/**
 * Nombre con el que se registra el servidor en los clientes MCP.
 *
 * Antes era `mssql`, y ese nombre CHOCA con la extension nativa de SQL Server de
 * VS Code (`ms-mssql.mssql`), que registra sus propias herramientas de Copilot
 * llamadas `mssql_list_databases`, `mssql_list_tables`, `mssql_list_views`,
 * `mssql_run_query`... VS Code cualifica las herramientas de un servidor MCP con el
 * nombre del servidor, asi que nuestras `list_databases` / `list_tables` /
 * `list_views` acababan produciendo exactamente los mismos identificadores que las
 * de la extension. El resto caian en un grupo "mssql" indistinguible del suyo en el
 * selector de herramientas.
 *
 * `ahora-sql` no colisiona con nada. En Claude Code las herramientas pasan a
 * exponerse como `mcp__ahora-sql__*`.
 */
const SERVER_NAME = "ahora-sql";

/** El nombre anterior, que se migra al reinstalar. */
const LEGACY_SERVER_NAME = "mssql";

/**
 * El MCP de desarrollo de producto (el paquete `ahora-mcp` del feed de AHORA).
 *
 * Es un servidor DISTINTO, no una variante de este: lo publica el equipo de producto,
 * corre sobre .NET y trae 98 herramientas propias (`ahora_leer_*`, `ahora_crear_*`,
 * `ahora_ejecutar_dml`...) para personalizar el ERP. Se registra al lado de
 * `ahora-sql` en el mismo fichero de cliente, no en su lugar.
 *
 * `ahora-erp` y no `ahora-mcp`: el nombre del servidor es lo que el cliente antepone
 * a cada herramienta, y sus tools ya empiezan por `ahora_`, asi que `ahora-mcp`
 * dejaria `mcp__ahora-mcp__ahora_leer_objeto`, con el "mcp" repetido dos veces. Y
 * dice de que habla —el ERP— en lugar de repetir el protocolo.
 */
const PRODUCT_SERVER_NAME = "ahora-erp";

/**
 * ¿Esta entrada de servidor MCP la escribimos nosotros?
 *
 * Importa para la migracion: una entrada `mssql` puede ser la nuestra de una
 * version anterior — y entonces hay que borrarla, porque dejarla mantiene el
 * choque — o puede ser de otra herramienta cualquiera, y entonces no se toca.
 *
 * Se reconoce por los argumentos, que son los mismos escriba lo que escriba el
 * instalador: `npx ... start-mssql-mcp` o `node .../bin/start-mssql-mcp.js`, que es
 * la forma que documenta el README para las configuraciones a mano.
 */
function isOurServerEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return args.some(
    (a) =>
      typeof a === "string" &&
      (a.includes("start-mssql-mcp") ||
        a.includes("AHORA-SQL-MCP") ||
        a.includes("@ahoraflx/sql-mcp"))
  );
}

/**
 * ¿Esta entrada de servidor MCP es el `ahora-erp` que escribimos nosotros?
 *
 * Se reconoce por el lanzador, no por el nombre de la entrada: alguien puede tener
 * un `ahora-erp` propio apuntando al exe del MCP de producto a mano, y ese no se
 * toca. Lo nuestro siempre arranca por `start-ahora-mcp`.
 */
function isOurProductEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return args.some((a) => typeof a === "string" && a.includes("start-ahora-mcp"));
}

module.exports = {
  SERVER_NAME,
  LEGACY_SERVER_NAME,
  PRODUCT_SERVER_NAME,
  isOurServerEntry,
  isOurProductEntry,
};
