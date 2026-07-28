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

  try {
    await server.connect(transport);
  } catch (err) {
    console.error("Server error:", err);
    await shutdown(1);
  }
}

main();
