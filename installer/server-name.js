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

module.exports = { SERVER_NAME, LEGACY_SERVER_NAME, isOurServerEntry };
