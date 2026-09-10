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
 * El MCP de automatizacion de navegador de Microsoft (el paquete npm
 * `@playwright/mcp`).
 *
 * Tampoco es una variante de este: no toca la base de datos ni el ERP, conduce un
 * navegador para poder comprobar en la pantalla lo que se acaba de cambiar en la
 * configuracion. Se registra al lado de los otros dos en el mismo fichero.
 *
 * `playwright` a secas, que es el nombre con el que lo documenta Microsoft y el que
 * ya tienen escrito quienes lo configuraron a mano: cambiarlo por uno nuestro dejaria
 * dos entradas con el mismo servidor detras y duplicaria sus herramientas en el
 * selector. Sus tools son `browser_*`, asi que no choca con nada de aqui.
 */
const PLAYWRIGHT_SERVER_NAME = "playwright";

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

/**
 * ¿Esta entrada es un Playwright MCP, lo haya escrito quien lo haya escrito?
 *
 * Se reconoce por el paquete, que es lo unico comun a las dos formas que hay por ahi:
 * la que documenta Microsoft (`npx @playwright/mcp@latest`) y la nuestra, que apunta
 * al `cli.js` ya instalado.
 */
function isPlaywrightEntry(entry) {
  if (!entry || typeof entry !== "object") return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const command = typeof entry.command === "string" ? entry.command : "";
  // Las barras se normalizan antes de comparar: la ruta del cli.js puede estar escrita
  // con las invertidas de Windows, y entonces el nombre del paquete aparece como
  // `@playwright\mcp`. Sin esto, esa entrada no se reconoceria como Playwright y
  // desmarcar la casilla no retiraria nada.
  const busca = (texto) => {
    const limpio = texto.replace(/\\/g, "/");
    // `playwright-mcp` es el nombre del ejecutable del paquete, que es la forma que
    // queda si alguien lo instalo global.
    return limpio.includes("@playwright/mcp") || limpio.includes("playwright-mcp");
  };
  return busca(command) || args.some((a) => typeof a === "string" && busca(a));
}

/**
 * ¿Es el Playwright MCP que dejo escrito ESTE instalador?
 *
 * La distincion importa al desmarcar la casilla. El paquete no es nuestro, asi que
 * aqui no vale el criterio del MCP de producto ("lo nuestro arranca por
 * start-ahora-mcp"): quien lo configuro a mano siguiendo la documentacion de
 * Microsoft tiene un `npx @playwright/mcp@latest` que funciona, y retirarselo porque
 * la casilla venga desmarcada seria romperle algo que el instalador no puso.
 *
 * Lo nuestro se reconoce por la instalacion a la que apunta: el `cli.js` de dentro de
 * la carpeta que crea `installer/playwright-mcp.js`. Cualquier otra forma se deja
 * donde esta.
 */
function isOurPlaywrightEntry(entry) {
  if (!isPlaywrightEntry(entry)) return false;
  const args = Array.isArray(entry.args) ? entry.args : [];
  return args.some(
    (a) =>
      typeof a === "string" &&
      a.replace(/\\/g, "/").includes("/playwright-mcp/node_modules/@playwright/mcp/cli.js")
  );
}

module.exports = {
  SERVER_NAME,
  LEGACY_SERVER_NAME,
  PRODUCT_SERVER_NAME,
  PLAYWRIGHT_SERVER_NAME,
  isOurServerEntry,
  isOurProductEntry,
  isPlaywrightEntry,
  isOurPlaywrightEntry,
};
