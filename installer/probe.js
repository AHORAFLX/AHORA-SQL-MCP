/**
 * Prueba de conexion real.
 *
 * Es lo que justifica que el instalador exista. Comprobar que los campos no estan
 * vacios no vale de nada: cuando alguien teclea servidor, usuario y contrasena a
 * mano, el fallo tipico es una errata, y sin conectarse no se ve hasta que el
 * agente invoca una herramienta y devuelve un error que nadie relaciona.
 *
 * Se usa a proposito la MISMA tuberia que usara el servidor —applyConnection para
 * producir las MSSQL_*, y loadConfigsFromEnv para validarlas— de forma que si aqui
 * conecta, alli tambien.
 */
const sqlLib = require("mssql");

const { applyConnection } = require("../bin/start-mssql-mcp");
const { loadConfigsFromEnv } = require("../src/config");

const DEFAULT_TIMEOUT_MS = 8000;

/** Ni la contrasena ni la cadena entera pueden acabar en un mensaje de error. */
function sanitizeError(err, secret) {
  let message = err && err.message ? String(err.message) : String(err);
  if (secret) message = message.split(secret).join("***");
  const code = err && err.code ? ` (${err.code})` : "";
  return `${message}${code}`;
}

/**
 * Pista para el fallo mas comun, que de otro modo es un callejon sin salida.
 *
 * Un ETIMEOUT contra una instancia nombrada casi siempre es el servicio SQL
 * Browser parado: es quien traduce el nombre de instancia a su puerto, por UDP
 * 1434. Sin esa pista, el mensaje del driver ("Failed to connect ... ETIMEOUT") no
 * apunta a nada y parece que no hay acceso, cuando el acceso esta perfectamente.
 */
function hintFor({ viaInstance, error }) {
  if (!viaInstance) return null;
  if (!/ETIMEOUT|timeout/i.test(String(error))) return null;
  return (
    "Es una instancia nombrada y ha dado tiempo de espera: lo habitual es que el " +
    "servicio SQL Browser este parado (es quien traduce el nombre de instancia a " +
    "su puerto). Arrancalo, o indica el puerto con --port."
  );
}

/**
 * Intenta conectar con unas `parts` de conexion ya normalizadas.
 *
 * Devuelve `{ ok, target, database, ... }` y NUNCA lanza: un fallo de conexion es
 * un resultado, no una excepcion — el instalador tiene que poder ofrecer seguir
 * adelante (la BD puede estar apagada o hacer falta VPN, y aun asi los datos ser
 * correctos).
 */
async function probeConnection(parts, { timeoutMs = DEFAULT_TIMEOUT_MS, mssql = sqlLib } = {}) {
  const secret = parts.password || parts.pwd;
  let target = "";
  let database = "";
  let viaInstance = false;
  let pool;
  try {
    const env = {};
    const info = applyConnection(env, "MSSQL_", parts, "prueba");
    target = info.target;
    database = info.database;
    viaInstance = info.viaInstance;

    const { configs } = loadConfigsFromEnv(env);
    const config = configs.maindb;

    pool = new mssql.ConnectionPool({
      ...config,
      connectionTimeout: timeoutMs,
      requestTimeout: timeoutMs,
      pool: { max: 1, min: 0, idleTimeoutMillis: 500 },
    });
    await pool.connect();
    const result = await pool.request().query("SELECT DB_NAME() AS db, @@VERSION AS version");
    const row = (result.recordset && result.recordset[0]) || {};
    return {
      ok: true,
      target,
      database: row.db || database,
      version: String(row.version || "").split("\n")[0].trim(),
    };
  } catch (err) {
    const error = sanitizeError(err, secret);
    const hint = hintFor({ viaInstance, error });
    return { ok: false, target, database, error, ...(hint ? { hint } : {}) };
  } finally {
    if (pool) {
      try {
        await pool.close();
      } catch {
        // da igual: la prueba ya ha terminado
      }
    }
  }
}

module.exports = { probeConnection, sanitizeError, hintFor, DEFAULT_TIMEOUT_MS };
