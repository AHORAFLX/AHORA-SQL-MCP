const sqlLib = require("mssql");

const pools = new Map();
const status = new Map();

/**
 * What to tell the caller for a connection error code.
 *
 * Keyed on `error.code` only - never on `error.message`, which is exactly what
 * `sanitizeError` refuses to pass along. A bare "ECONNRESET" gives the caller nothing to
 * act on, and the port it was handed is frozen for the life of the process, so the useful
 * part is knowing that the endpoint itself is the suspect.
 */
const CONNECTION_HINTS = {
  ECONNRESET:
    "The server accepted the connection and then dropped it. The configured port may " +
    "belong to a listener that is not this instance. Restart the MCP server so the port " +
    "is discovered again, or pin the right one with --port <alias>:<port>.",
  ESOCKET:
    "The connection could not be established. If the port came from a dynamic range it " +
    "changes whenever the SQL Server service restarts: restart the MCP server to pick up " +
    "the new one, or pin it with --port <alias>:<port>.",
  ETIMEOUT:
    "The server did not answer in time. A named instance needs the SQL Browser service " +
    "running, or TCP/IP enabled on that instance; otherwise pass --port <alias>:<port>.",
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

async function getPool(dbKey, config, driver = sqlLib) {
  const existing = pools.get(dbKey);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const pool = new driver.ConnectionPool(config);
      if (typeof pool.on === "function") {
        pool.on("error", (err) => setStatus(dbKey, "error", err));
      }
      await pool.connect();
      setStatus(dbKey, "connected");
      return pool;
    } catch (err) {
      pools.delete(dbKey);
      setStatus(dbKey, "error", err);
      throw err;
    }
  })();

  pools.set(dbKey, promise);
  return promise;
}

async function closeAllPools() {
  const entries = Array.from(pools.values());
  pools.clear();
  await Promise.allSettled(
    entries.map(async (p) => {
      try {
        const pool = await p;
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
}

module.exports = {
  getPool,
  closeAllPools,
  getConnectionStatus,
  _resetForTests,
};
