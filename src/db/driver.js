/**
 * Carga del driver `mssql`, en el PRIMER USO y no al arrancar.
 *
 * `mssql` arrastra `tedious` y su arbol entero: 432 de los 666 modulos que cargaba el
 * servidor, y 313-545 ms medidos, se los llevaba el solo. Todo eso se pagaba antes de
 * contestar al `initialize`, con el reloj del cliente MCP ya corriendo, y para nada: el
 * saludo se contesta con la lista de tools, y ninguna tool necesita el driver hasta que
 * alguien la invoca. Se pagan en la primera consulta, donde ya no hay ningun presupuesto
 * que agotar.
 *
 * Es un `require` perezoso y no un `import()` a proposito. El proyecto es CommonJS, y en
 * CommonJS `require` dentro de la funcion difiere la carga exactamente igual que un
 * `import()` dinamico, pero SIN volver asincrono al que llama. Eso importa porque
 * `db/safety.js` lo usa como valor por defecto de un parametro (`{ mssql = loadDriver() }`),
 * que es un contexto sincrono: con `import()` habria que propagar `await` por toda la
 * cadena de llamadas para no ganar nada, ya que la carga es igual de perezosa en los dos
 * casos.
 *
 * El resultado se cachea aqui y no en `require.cache` por claridad: asi se ve de un
 * vistazo que la primera llamada es la caraX y las siguientes son gratis.
 */
let cached = null;

/** El driver `mssql`, cargandolo la primera vez que alguien lo pide. */
function loadDriver() {
  if (!cached) cached = require("mssql");
  return cached;
}

/** ¿Se ha cargado ya? Solo para diagnostico y para los tests del arranque perezoso. */
function driverLoaded() {
  return cached !== null;
}

function _resetForTests() {
  cached = null;
}

module.exports = { loadDriver, driverLoaded, _resetForTests };
