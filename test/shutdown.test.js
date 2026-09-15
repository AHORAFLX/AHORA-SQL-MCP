/*
 * El servidor tiene que morir cuando el cliente se va.
 *
 * Lo que se comprueba es una propiedad del proceso, no una funcion: al cerrarse stdin
 * -que es lo unico que ve el servidor cuando Claude Code se reinicia o lo mata en
 * Windows, donde no llegan senales- el proceso termina solo y con codigo 0. Antes se
 * quedaba vivo indefinidamente: el transporte del SDK no escucha el fin de stdin, y el
 * reaper del pool deja un temporizador que sostiene el bucle de eventos.
 *
 * Se prueba contra src/index.js con una conexion inalcanzable de la RFC 5737: no hace
 * falta ninguna base de datos, porque el apagado no depende de haber conectado.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");

const ENTRY = path.join(__dirname, "..", "src", "index.js");
const ENV = {
  ...process.env,
  MSSQL_SERVER: "192.0.2.1",
  MSSQL_DATABASE: "shutdowndb",
  MSSQL_USER: "u",
  MSSQL_PASSWORD: "p",
  MSSQL_ENABLE_WRITES: "false",
  MSSQL_SQL_DIRS: "",
};

function waitForLine(proc, predicate, ms) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(
      () => reject(new Error(`sin respuesta en ${ms} ms; stdout: ${buf}`)),
      ms
    );
    proc.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      if (predicate(buf)) {
        clearTimeout(timer);
        resolve(buf);
      }
    });
  });
}

function waitForExit(proc, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`el servidor sigue vivo ${ms} ms despues de cerrar stdin`)
        ),
      ms
    );
    proc.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test("el servidor termina solo cuando el cliente cierra stdin", async () => {
  const proc = spawn(process.execPath, [ENTRY], {
    env: ENV,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  proc.stderr.on("data", (c) => (stderr += c.toString("utf8")));

  try {
    const exited = waitForExit(proc, 10000);
    proc.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "shutdown-test", version: "1.0.0" },
        },
      })}\n`
    );
    await waitForLine(proc, (s) => s.includes('"id":1'), 10000);

    // Esto es todo lo que hace el cliente al irse.
    proc.stdin.end();

    const { code, signal } = await exited;
    assert.equal(signal, null, `terminado por senal; stderr: ${stderr}`);
    assert.equal(code, 0, `codigo de salida distinto de 0; stderr: ${stderr}`);
  } finally {
    if (proc.exitCode === null) proc.kill();
  }
});
