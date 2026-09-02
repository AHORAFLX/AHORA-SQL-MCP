const sqlLib = require("mssql");
const {
  resolveEndpoint,
  invalidateEndpoint,
  _resetForTests: resetEndpoints,
} = require("./endpoint");

/** dbKey -> { promise: Promise<pool>, broken: boolean } */
const pools = new Map();
const status = new Map();

/**
 * Errores que hacen sospechar del ENDPOINT y no de las credenciales.
 *
 * Con cualquiera de estos, el puerto que se resolvio al primer uso es el primer
 * sospechoso: una instancia con puerto dinamico estrena puerto cada vez que arranca su
 * servicio, y a partir de ese momento el que teniamos apuntado no lleva a ninguna parte.
 * Se marca la resolucion como sospechosa para que el siguiente intento vuelva a preguntar
 * al sistema en lugar de repetir el mismo error hasta que alguien reinicie.
 *
 * ELOGIN queda fuera a proposito: ahi el endpoint es correcto y volver a sondearlo solo
 * gastaria cuatro segundos por intento.
 */
const STALE_ENDPOINT_CODES = new Set([
  "ECONNRESET",
  "ECONNCLOSED",
  "ESOCKET",
  "ETIMEOUT",
]);

/**
 * What to tell the caller for a connection error code.
 *
 * Keyed on `error.code` only - never on `error.message`, which is exactly what
 * `sanitizeError` refuses to pass along. A bare "ECONNRESET" gives the caller nothing to
 * act on, so the useful part is knowing that the endpoint itself is the suspect - and
 * that the server has already thrown away the port it was using, so a plain retry is the
 * first thing to try rather than a restart.
 */
const CONNECTION_HINTS = {
  ECONNRESET:
    "The server accepted the connection and then dropped it. The port in use may belong " +
    "to a listener that is not this instance. That port has been discarded, so running " +
    "the tool again discovers it afresh; if it keeps happening, pin the right one with " +
    "--port <alias>:<port>.",
  ESOCKET:
    "The connection could not be established. A port from a dynamic range changes " +
    "whenever the SQL Server service restarts: the stale one has been discarded, so " +
    "running the tool again picks up the new one. Pin it with --port <alias>:<port> to " +
    "stop it moving.",
  ETIMEOUT:
    "The server did not answer in time. A REMOTE named instance needs the SQL Browser " +
    "service running, or TCP/IP enabled on that instance; otherwise pass " +
    "--port <alias>:<port>.",
  ELOGIN: "The server is reachable but rejected the credentials.",
};

function sanitizeError(error) {
  if (!error) return null;
  // Avoid leaking raw error.message - it can include connection-string fragments
  // or principal names. Keep only the well-known fields callers actually need.
  const out = {
    name: error.name || "Error",
    code: error.code || null,
  };
  const hint = CONNECTION_HINTS[out.code];
  if (hint) out.hint = hint;
  return out;
}

function setStatus(dbKey, state, error) {
  const prev = status.get(dbKey) || {
    status: "initialized",
    lastConnected: null,
    lastError: null,
  };
  status.set(dbKey, {
    status: state,
    lastConnected:
      state === "connected" ? new Date().toISOString() : prev.lastConnected,
    lastError: error ? sanitizeError(error) : prev.lastError,
  });
}

/**
 * Tira un pool que ya no sirve.
 *
 * Se saca del mapa ANTES de cerrarlo, para que la siguiente llamada construya uno nuevo
 * sin esperar a que el cierre termine. El cierre va suelto y con los errores ignorados:
 * un pool roto tampoco se cierra siempre limpiamente, y lo que no se puede permitir es
 * que el fallo del cierre impida reemplazarlo.
 */
function discard(dbKey, entry) {
  pools.delete(dbKey);
  invalidateEndpoint(dbKey);
  entry.promise.then((pool) => pool.close()).catch(() => {});
}

/**
 * El pool de esta conexion, creandolo si hace falta.
 *
 * Un pool que ya habia conectado y luego se rompe -el servicio SQL se reinicia, el
 * portatil suspende, la VPN se cae- se quedaba cacheado para siempre: `pool.on("error")`
 * solo apuntaba el estado, y el unico `pools.delete` estaba en el fallo del PRIMER
 * connect. A partir de ahi TODAS las tools fallaban hasta reiniciar el servidor, que es
 * el sintoma que se venia reportando. Ahora el pool se marca como roto y aqui se
 * reemplaza, con el puerto vuelto a averiguar.
 *
 * La marca vive en la entrada (`entry.broken`) y no en el mapa `status`, que es
 * compartido: `status` puede seguir diciendo "error" por el intento ANTERIOR mientras el
 * pool nuevo todavia esta conectando, y mirarlo ahi haria que dos llamadas concurrentes
 * se tirasen la una a la otra el pool que acaba de crear.
 */
async function getPool(dbKey, config, driver = sqlLib) {
  const existing = pools.get(dbKey);
  if (existing && !existing.broken) return existing.promise;
  if (existing) discard(dbKey, existing);

  const entry = { promise: null, broken: false };
  // El cuerpo va en un microtask (`Promise.resolve().then`) para que corra DESPUES del
  // `pools.set` de abajo. Con un async IIFE, un throw sincrono del constructor del pool
  // ejecutaba su `catch` -y su `pools.delete`- antes de que la entrada existiera: el
  // delete no borraba nada y la promesa rechazada se quedaba cacheada para siempre.
  entry.promise = Promise.resolve().then(async () => {
    try {
      const pool = new driver.ConnectionPool(await resolveEndpoint(dbKey, config));
      if (typeof pool.on === "function") {
        pool.on("error", (err) => {
          entry.broken = true;
          setStatus(dbKey, "error", err);
        });
      }
      await pool.connect();
      setStatus(dbKey, "connected");
      return pool;
    } catch (err) {
      // Solo si sigue siendo la entrada en vigor: una llamada posterior puede haberla
      // reemplazado mientras esta conectaba.
      if (pools.get(dbKey) === entry) pools.delete(dbKey);
      if (STALE_ENDPOINT_CODES.has(err?.code)) invalidateEndpoint(dbKey);
      setStatus(dbKey, "error", err);
      throw err;
    }
  });

  pools.set(dbKey, entry);
  return entry.promise;
}

async function closeAllPools() {
  const entries = Array.from(pools.values());
  pools.clear();
  await Promise.allSettled(
    entries.map(async (entry) => {
      try {
        const pool = await entry.promise;
        await pool.close();
      } catch {
        // ignore close errors
      }
    })
  );
}

function getConnectionStatus() {
  return Object.fromEntries(status.entries());
}

function _resetForTests() {
  pools.clear();
  status.clear();
  resetEndpoints();
}

module.exports = {
  getPool,
  STALE_ENDPOINT_CODES,
  closeAllPools,
  getConnectionStatus,
  _resetForTests,
};
