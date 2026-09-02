#!/usr/bin/env node
// POLITICA: este proceso no carga ficheros .env, a proposito. Un .env suelto en el
// directorio de trabajo podria definir MSSQL_ENABLE_WRITES y habilitar escrituras sin
// que nadie lo hubiera pedido. La configuracion entra unicamente por el entorno que
// prepara bin/start-mssql-mcp.js.
const {
  StdioServerTransport,
} = require("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer } = require("./server");
const { closeAllPools } = require("./db/pools");

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();

  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } catch {
      // ignore
    }
    await closeAllPools();
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  installCrashGuards();

  try {
    await server.connect(transport);
  } catch (err) {
    console.error("Server error:", err);
    await shutdown(1);
  }
}

/**
 * Que un error suelto no se lleve por delante el servidor entero.
 *
 * Sin esto, cualquier error asincrono fuera de un handler de tool -un socket de tedious
 * que muere solo, una promesa que nadie espera- llegaba a `uncaughtException`, y el
 * comportamiento por defecto de Node es imprimir y salir. El proceso desaparecia en
 * silencio (su stderr va al log del cliente, que nadie mira) y desde el punto de vista de
 * quien lo usa las tools se habian esfumado hasta reiniciar.
 *
 * La decision es seguir vivo y dejar constancia. No es gratis: se sigue adelante con un
 * proceso que ha pasado por un estado que no estaba previsto. Pero el estado que de
 * verdad importa aqui -los pools- ya se sabe reconstruir solo (db/pools.js), y un
 * servidor que atiende la siguiente tool es mejor que uno que no esta. Lo que no se toca
 * es el fallo de ARRANQUE: ahi no hay nada que salvar y se sale con 1, para que el
 * cliente lo note en lugar de esperar un saludo que no va a llegar.
 */
function installCrashGuards() {
  process.on("uncaughtException", (err) => {
    console.error("[fatal-recuperado] excepcion no capturada:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[fatal-recuperado] promesa rechazada sin capturar:", reason);
  });
}

main().catch(async (err) => {
  console.error("No se ha podido arrancar el servidor:", err);
  await closeAllPools().catch(() => {});
  process.exit(1);
});
