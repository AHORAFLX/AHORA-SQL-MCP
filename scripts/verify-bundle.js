#!/usr/bin/env node
/**
 * Comprueba que el paquete de bundle/ sirve de verdad, sin node_modules al lado.
 *
 *   node scripts/verify-bundle.js
 *
 * Un paquete roto es peor que no tenerlo: al publicarse sin dependencias, `src/` ya no
 * puede arrancar como respaldo, asi que un fallo aqui deja el servidor inservible. Por
 * eso esto no mira si el fichero existe, sino que LO EJECUTA y le habla MCP.
 *
 * Se copian los dos ficheros a una carpeta temporal fuera del repositorio antes de
 * probarlos. Ejecutarlos en su sitio no probaria nada: node_modules estaria a un
 * directorio de distancia y cualquier dependencia que se hubiera quedado fuera del
 * paquete se resolveria igual, que es justo el fallo que hay que cazar.
 *
 * Lo que se verifica:
 *
 *   1. El servidor contesta al `initialize`. Rapido, y sin base de datos que exista.
 *   2. `tools/list` devuelve las 12 tools con SUS nombres. Es la superficie publica: hay
 *      proyectos que dependen de ella y no puede cambiar al empaquetar.
 *   3. Una tool que necesita conectar falla por la CONEXION y no por un modulo que no
 *      esta. Es la unica forma de demostrar que el `require("mssql")` perezoso sigue
 *      resolviendo dentro del paquete: si mssql se hubiera quedado fuera, el error seria
 *      "Cannot find module" en lugar de un codigo de red.
 *   4. El driver no se carga antes de esa llamada.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const BUNDLE = path.join(ROOT, "bundle");

const TOOLS_ESPERADAS = [
  "describe_database",
  "describe_procedure",
  "describe_table",
  "execute_read_query",
  "execute_sql_file",
  "execute_write_query",
  "list_databases",
  "list_foreign_keys",
  "list_indexes",
  "list_stored_procedures",
  "list_tables",
  "list_views",
];

// Servidor deliberadamente inalcanzable: una direccion del rango de documentacion de la
// RFC 5737. Aqui no interviene ninguna credencial ni ningun servidor real.
const ENV_PRUEBA = {
  MSSQL_SERVER: "192.0.2.1",
  MSSQL_DATABASE: "verifydb",
  MSSQL_USER: "verifyuser",
  MSSQL_PASSWORD: "verifypass",
  MSSQL_ENABLE_WRITES: "false",
  MSSQL_SQL_DIRS: "",
};

class Cliente {
  constructor(entry, env) {
    this.proc = spawn(process.execPath, [entry], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.buf = "";
    this.pendientes = new Map();
    this.stderr = "";
    this.proc.stdout.on("data", (c) => this.onData(c));
    this.proc.stderr.on("data", (c) => (this.stderr += c.toString("utf8")));
  }

  onData(chunk) {
    this.buf += chunk.toString("utf8");
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const pend = this.pendientes.get(msg.id);
      if (pend) {
        this.pendientes.delete(msg.id);
        pend(msg);
      }
    }
  }

  send(id, method, params) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`sin respuesta a '${method}' en 60 s`)),
        60000
      );
      this.pendientes.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg);
      });
      this.proc.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
      );
    });
  }

  notify(method, params) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  kill() {
    try {
      this.proc.kill();
    } catch {
      /* ya estaba muerto */
    }
  }
}

const fallos = [];
function check(ok, msg, detalle) {
  console.log(`  ${ok ? "OK  " : "FALLO"}  ${msg}`);
  if (!ok) {
    fallos.push(msg + (detalle ? `\n          ${detalle}` : ""));
  }
}

async function main() {
  for (const f of ["start-mssql-mcp.cjs", "ahora-sql-mcp.cjs"]) {
    if (!fs.existsSync(path.join(BUNDLE, f))) {
      console.error(`Falta bundle/${f}. Ejecuta primero: npm run build`);
      process.exit(1);
    }
  }

  // Fuera del repositorio: aqui no hay ningun node_modules que pueda rescatar una
  // dependencia que se haya quedado fuera del paquete.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ahora-verify-"));
  for (const f of ["start-mssql-mcp.cjs", "ahora-sql-mcp.cjs"]) {
    fs.copyFileSync(path.join(BUNDLE, f), path.join(tmp, f));
  }
  console.log(`\nProbando el paquete en ${tmp} (sin node_modules)\n`);

  const cli = new Cliente(path.join(tmp, "ahora-sql-mcp.cjs"), ENV_PRUEBA);
  try {
    const t0 = process.hrtime.bigint();
    const init = await cli.send(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "verify-bundle", version: "1.0.0" },
    });
    const initMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    cli.notify("notifications/initialized", {});

    check(Boolean(init.result), `el servidor contesta al initialize (${initMs} ms)`);
    check(
      initMs < 5000,
      `el initialize llega holgadamente antes del limite del cliente (${initMs} ms < 5000)`
    );

    const lista = await cli.send(2, "tools/list", {});
    const nombres = (lista.result?.tools || []).map((t) => t.name).sort();
    check(
      JSON.stringify(nombres) === JSON.stringify(TOOLS_ESPERADAS),
      `tools/list devuelve las ${TOOLS_ESPERADAS.length} tools con sus nombres`,
      `recibido: ${nombres.join(", ") || "(nada)"}`
    );

    // La prueba de fuego: esto obliga a cargar mssql desde DENTRO del paquete.
    const call = await cli.send(3, "tools/call", {
      name: "list_tables",
      arguments: { limit: 1 },
    });
    const texto = JSON.stringify(call.result ?? call.error ?? {});

    check(
      !/Cannot find module|MODULE_NOT_FOUND/i.test(texto),
      "el driver mssql se resuelve dentro del paquete",
      texto.slice(0, 300)
    );
    check(
      /ESOCKET|ETIMEOUT|ECONNREFUSED|ECONNRESET|ELOGIN|timeout|Failed to connect/i.test(
        texto
      ),
      "la tool falla por la CONEXION, que es lo esperado contra un servidor inexistente",
      texto.slice(0, 300)
    );
  } finally {
    cli.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (fallos.length > 0) {
    console.error(`\n${fallos.length} comprobacion(es) han fallado:\n`);
    for (const f of fallos) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("\nEl paquete de bundle/ funciona sin dependencias instaladas.\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
