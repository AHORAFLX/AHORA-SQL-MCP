/*
 * El arranque no puede volver a ser caro.
 *
 * Estos tests no comprueban una funcion, comprueban una PROPIEDAD del arranque: que
 * levantar el servidor y registrar las tools no arrastre el driver de SQL ni abra
 * ninguna conexion. Es lo que hacia que un cliente MCP con 30 s de presupuesto
 * descartara el servidor entero antes de ver una sola tool.
 *
 * Van en su propio fichero a proposito: `node --test` da un proceso por fichero, y
 * `require` cachea. Si esto compartiera proceso con un test que ya usa `mssql`, la
 * comprobacion pasaria siempre y no vigilaria nada.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

test("registrar el servidor no carga el driver mssql", () => {
  const { driverLoaded } = require("../src/db/driver");
  assert.equal(driverLoaded(), false, "el driver no puede estar cargado de entrada");

  const { createServer } = require("../src/server");
  const server = createServer();
  assert.ok(server, "el servidor se construye");

  assert.equal(
    driverLoaded(),
    false,
    "createServer() ha cargado mssql: son ~300 ms y 432 modulos que el cliente MCP " +
      "espera antes de recibir la lista de tools"
  );
});

test("mssql no esta en la cache de modulos tras construir el servidor", () => {
  // La comprobacion de arriba mira la bandera de db/driver.js; esta mira la realidad,
  // por si alguien vuelve a poner un require("mssql") suelto en cualquier otro sitio.
  require("../src/server").createServer();
  const cargados = Object.keys(require.cache).filter((p) =>
    /[\\/]node_modules[\\/](mssql|tedious)[\\/]/.test(p)
  );
  assert.deepEqual(
    cargados,
    [],
    `mssql/tedious se han cargado al arrancar (${cargados.length} modulos)`
  );
});

test("el driver se carga cuando de verdad se pide, y se cachea", () => {
  const { loadDriver, driverLoaded, _resetForTests } = require("../src/db/driver");
  _resetForTests();
  assert.equal(driverLoaded(), false);

  const primera = loadDriver();
  assert.ok(primera, "devuelve el driver");
  assert.equal(driverLoaded(), true);
  assert.equal(loadDriver(), primera, "la segunda llamada reutiliza la misma carga");
});
