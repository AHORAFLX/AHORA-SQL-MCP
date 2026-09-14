const { loadDriver } = require("./driver");
const {
  acquiredConnection,
  destroyConnection,
  withTimeout,
} = require("./connections");
const { splitBatches, previewOf } = require("../sql/batches");

/**
 * How long we wait for a cancellation to actually land before giving up on the
 * connection.
 *
 * `request.cancel()` is not a synchronous kill: tedious sends an ATTENTION packet and
 * waits for the server to acknowledge it. Until that ack arrives the request is still in
 * flight, and tedious serialises requests per connection - so a ROLLBACK issued in the
 * meantime cannot even be sent. That is the whole bug: the old code fired the cancel and
 * went straight to `transaction.rollback()`, which failed with EREQINPROG into an empty
 * `catch`, leaving the connection in the pool with an open transaction.
 */
const CANCEL_GRACE_MS = 5000;

/**
 * How long we wait for mssql's `done` once the server has already reported an error.
 *
 * In stream mode mssql emits `error` the instant the server's error token arrives, which
 * is BEFORE tedious has finished the request and before mssql hands the connection back to
 * the transaction. `done` is what marks the real end: it is emitted from the very callback
 * that calls `Transaction#release()`, so only once it has fired can a ROLLBACK be sent at
 * all. This bound exists solely so that a `done` that never arrives cannot hang the call.
 */
const DONE_GRACE_MS = 2000;

/** How long we wait for the `SELECT @@TRANCOUNT` probe on a suspect connection. */
const TRANCOUNT_PROBE_MS = 5000;

/** How often we re-check whether the cancelled request has settled. */
const SETTLE_POLL_MS = 25;

const TRANCOUNT_SQL = "SELECT @@TRANCOUNT AS trancount";

/**
 * Statements SQL Server refuses to run inside an explicit transaction.
 *
 * Listed in the error we raise so the caller knows `transactional:false` exists and what
 * it is for, instead of being told "cannot be used inside a transaction" by the server
 * with no way out.
 */
const NON_TRANSACTIONAL_STATEMENTS =
  "CREATE/ALTER DATABASE, BACKUP, RESTORE, CREATE FULLTEXT INDEX, ALTER FULLTEXT CATALOG";

function escapeIdentifier(name) {
  return `[${String(name).replace(/]/g, "]]")}]`;
}

function splitTableIdentifier(identifier) {
  if (!identifier.includes(".")) return { schema: null, table: identifier };
  const parts = identifier.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `Invalid table identifier '${identifier}'. Expected 'schema.table'.`
    );
  }
  return { schema: parts[0], table: parts[1] };
}

function quoteTable(identifier) {
  const { schema, table } = splitTableIdentifier(identifier);
  return schema
    ? `${escapeIdentifier(schema)}.${escapeIdentifier(table)}`
    : escapeIdentifier(table);
}

/**
 * Si se pasa `dbKey`, una `MSSQL_<DBKEY>_ENABLE_WRITES` explicita gana sobre el
 * flag global `MSSQL_ENABLE_WRITES` - es lo que permite que una base de datos
 * concreta tenga escritura y el resto se quede en solo lectura.
 */
function writesEnabled(env = process.env, dbKey) {
  if (dbKey) {
    const perDb = env[`MSSQL_${String(dbKey).toUpperCase()}_ENABLE_WRITES`];
    if (perDb !== undefined) return String(perDb).toLowerCase() === "true";
  }
  return String(env.MSSQL_ENABLE_WRITES || "").toLowerCase() === "true";
}

/**
 * Cancel `request` when `signal` fires, and REMEMBER that we did.
 *
 * Returns the cancellation state rather than throwing it away. The cleanup path needs to
 * know a cancel was fired - that is what tells it to wait for the request to settle
 * before attempting the ROLLBACK, and to check the connection afterwards instead of
 * trusting it. `request.cancel()` itself throwing is also kept: it means the cancel never
 * even reached the driver.
 */
function attachAbort(request, signal) {
  const state = { aborted: false, cancelError: null, detach: () => {} };
  if (!signal) return state;
  const cancel = () => {
    state.aborted = true;
    try {
      request.cancel();
    } catch (err) {
      state.cancelError = err;
    }
  };
  if (signal.aborted) {
    cancel();
    return state;
  }
  signal.addEventListener("abort", cancel, { once: true });
  state.detach = () => signal.removeEventListener("abort", cancel);
  return state;
}

/**
 * Per-call request timeout, applied where tedious actually reads it.
 *
 * The pool-wide `requestTimeout` (30 s by default) is the only knob mssql exposes, and it
 * is not enough: a legitimate DELETE on a hub table with 41 `ON DELETE CASCADE` foreign
 * keys does not fit in 30 s, and there was no way to run it at all. tedious honours a
 * per-request `timeout` (`createRequestTimer` reads `request.timeout` and only falls back
 * to the connection option when it is undefined), but mssql never sets it. So we stamp it
 * on the tedious request at the one moment mssql hands it to us - `_setCurrentRequest`,
 * which runs after the request is built and before it is sent.
 */
function applyRequestTimeout(request, timeoutMs) {
  if (!request || !timeoutMs) return request;
  const base =
    typeof request._setCurrentRequest === "function"
      ? request._setCurrentRequest.bind(request)
      : null;
  request._setCurrentRequest = (tdsRequest) => {
    if (tdsRequest) tdsRequest.timeout = timeoutMs;
    return base ? base(tdsRequest) : request;
  };
  return request;
}

/**
 * Wait until the transaction has no request in flight, bounded.
 *
 * `_activeRequest` is mssql's own bookkeeping: it is set when a request borrows the
 * transaction's connection and cleared when that request finishes, cancelled or not. So
 * this is exactly "has the cancellation landed yet?", and the bound is what keeps a cancel
 * that never lands from turning into a hang.
 */
async function waitForRequestToSettle(transaction, graceMs = CANCEL_GRACE_MS) {
  if (!transaction) return true;
  const deadline = Date.now() + graceMs;
  while (transaction._activeRequest) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
  }
  return true;
}

/**
 * Ask the connection that ran the query what its @@TRANCOUNT is.
 *
 * Not `SELECT @@TRANCOUNT` on the pool - that would land on some other connection and
 * answer about the wrong session. The probe goes through the transaction, which is what
 * pins one connection, so the answer is about the connection we are deciding on.
 *
 * `trancount: null` means "could not be established", which is treated exactly like a
 * non-zero count: a connection whose state we cannot confirm is not one to hand out.
 */
async function probeTrancount(
  transaction,
  connection,
  { mssql, timeoutMs = TRANCOUNT_PROBE_MS } = {}
) {
  // El socket cerrado no es un problema pendiente: la sesion ya no existe y el servidor
  // ha deshecho la transaccion por su cuenta. No hay nada que sanear ni a quien preguntar.
  if (connection?.closed) return { trancount: 0, closed: true };

  if (!acquiredConnection(transaction)) {
    // La transaccion ya ha soltado la conexion al pool - mssql la devuelve incluso cuando
    // el ROLLBACK falla con un error del driver. A partir de ahi ya no es nuestra: otra
    // llamada puede tenerla, asi que ni se le manda un request ni se lee su estado, y
    // desde luego no se destruye. De esta situacion se encarga el saneado al adquirir, que
    // es justo para lo que existe: quien la coja despues la recibe reseteada o no la
    // recibe. El hueco del pool no se ha perdido, que es lo unico irrecuperable.
    return { trancount: 0, releasedToPool: true };
  }

  try {
    const request = applyRequestTimeout(new mssql.Request(transaction), timeoutMs);
    const result = await withTimeout(
      request.query(TRANCOUNT_SQL),
      timeoutMs,
      "@@TRANCOUNT probe"
    );
    const value = Number(result?.recordset?.[0]?.trancount);
    if (Number.isFinite(value)) return { trancount: value };
    return {
      trancount: null,
      error: new Error("the @@TRANCOUNT probe returned no value"),
    };
  } catch (err) {
    return { trancount: null, error: err };
  }
}

/**
 * Roll the transaction back and decide whether its connection may go back into the pool.
 *
 * The order is the fix, not an implementation detail:
 *
 *  1. Wait (bounded) for the request to let go of the connection - always, not only after
 *     a cancel. Skipping this is what made the ROLLBACK fail with EREQINPROG.
 *  2. ROLLBACK, keeping the error instead of swallowing it.
 *  3. If anything went wrong - the cancel never landed, the ROLLBACK failed, or the
 *     server still reports a transaction - ask THAT connection for its @@TRANCOUNT. Zero
 *     means we are fine: that is the legitimate case where the caller's SQL contained a
 *     COMMIT and closed the outer transaction itself, which is why the old code could get
 *     away with ignoring the ROLLBACK error most of the time.
 *  4. Anything else, or an unanswerable probe, and the connection is destroyed rather
 *     than reused.
 *
 * Returns `{ ok }` plus everything the caller needs to explain itself.
 */
async function rollbackAndCheck(
  pool,
  transaction,
  {
    aborted = false,
    mssql = loadDriver(),
    cancelGraceMs = CANCEL_GRACE_MS,
    probeTimeoutMs = TRANCOUNT_PROBE_MS,
  } = {}
) {
  const connection = acquiredConnection(transaction);
  // Se espera siempre, no solo cuando ha habido un cancel. Un request puede seguir en vuelo
  // sin que nadie lo haya cancelado: en modo stream mssql avisa del error en cuanto llega el
  // token del servidor, bastante antes de soltar la conexion, y por eso un simple "Invalid
  // column name" bastaba para que el ROLLBACK saliera con EREQINPROG y la conexion acabara
  // destruida sin necesidad. Cuando el request ya ha terminado -el caso normal- esto no
  // cuesta nada: waitForRequestToSettle vuelve en el acto.
  const requestSettled = await waitForRequestToSettle(transaction, cancelGraceMs);

  let rollbackError = null;
  try {
    await transaction.rollback();
  } catch (err) {
    rollbackError = err;
  }

  // Un ROLLBACK que el servidor confirma deja @@TRANCOUNT en 0 por definicion - `ROLLBACK
  // TRANSACTION` sin savepoint deshace hasta el BEGIN mas externo-, asi que no hay nada
  // que comprobar. Y comprobarlo seria ademas incorrecto: el rollback ya ha devuelto la
  // conexion al pool, asi que mirarle el estado es mirar una conexion que puede ser ya de
  // otra llamada.
  if (requestSettled && !rollbackError) {
    return { ok: true, requestSettled, aborted, rollbackError: null };
  }

  const probe = await probeTrancount(transaction, connection, {
    mssql,
    timeoutMs: probeTimeoutMs,
  });
  if (probe.trancount === 0) {
    return { ok: true, requestSettled, aborted, rollbackError, trancount: 0 };
  }

  await destroyConnection(pool, connection);
  return {
    ok: false,
    requestSettled,
    aborted,
    rollbackError,
    trancount: probe.trancount ?? null,
    probeError: probe.error || null,
  };
}

/**
 * The error that replaces the generic timeout when a connection was left dirty.
 *
 * A bare "Timeout: Request failed to complete in 30000ms" points at the server and at
 * nothing that can be acted on. What the caller needs to know is that the transaction on
 * that connection could not be closed, that the connection has been discarded so a retry
 * gets a clean one, and what the original failure was.
 */
function abandonedTransactionError(cleanup, cause) {
  const parts = [
    "The transaction on the connection that ran this statement could not be closed.",
  ];
  if (!cleanup.requestSettled) {
    parts.push(
      cleanup.aborted
        ? `The cancellation did not complete within ${CANCEL_GRACE_MS}ms, so the request was still in flight and the ROLLBACK could not even be sent.`
        : `The request still had not released the connection ${CANCEL_GRACE_MS}ms after it reported failure, so the ROLLBACK could not even be sent.`
    );
  }
  if (cleanup.rollbackError) {
    parts.push(`ROLLBACK failed: ${cleanup.rollbackError.message}`);
  }
  if (cleanup.trancount === null) {
    parts.push(
      `@@TRANCOUNT could not be read on that connection${
        cleanup.probeError ? `: ${cleanup.probeError.message}` : "."
      }`
    );
  } else {
    parts.push(
      `That connection was left with @@TRANCOUNT=${cleanup.trancount}, i.e. inside an open transaction.`
    );
  }
  parts.push(
    "The connection has been closed and dropped from the pool, so it cannot leak that " +
      "transaction into an unrelated call - but this call needs to be retried on a fresh " +
      "connection. Run it again."
  );
  if (cause) parts.push(`Original failure: ${cause.message}`);
  const err = new Error(parts.join(" "));
  err.code = "ETXNABANDONED";
  if (cause) err.cause = cause;
  return err;
}

/**
 * Run a read inside a transaction that is ALWAYS rolled back, even on success.
 *
 * This is a guardrail against accidental writes (a SELECT INTO, an INSERT smuggled
 * after a comment, etc.) - NOT a sandbox against an adversarial query. A user-supplied
 * `COMMIT TRANSACTION` mid-query will close the outer transaction, and any following
 * statements will run in autocommit mode and persist. Defense-in-depth requires a
 * least-privilege SQL login.
 *
 * The rollback is no longer best-effort-and-forget: if it cannot be done, the connection
 * is destroyed and the caller is told, because a read transaction left open on a pooled
 * connection is inherited by whoever gets that connection next.
 */
async function runRead(
  pool,
  fn,
  { mssql = loadDriver(), signal, timeoutMs, ...cleanupOptions } = {}
) {
  if (signal?.aborted) throw new Error("Request aborted");
  const transaction = new mssql.Transaction(pool);
  await transaction.begin(mssql.ISOLATION_LEVEL.READ_COMMITTED);

  const request = applyRequestTimeout(new mssql.Request(transaction), timeoutMs);
  const abort = attachAbort(request, signal);

  let result;
  let failure = null;
  try {
    result = await fn(request);
  } catch (err) {
    failure = err;
  } finally {
    abort.detach();
  }

  const cleanup = await rollbackAndCheck(pool, transaction, {
    ...cleanupOptions,
    aborted: abort.aborted,
    mssql,
  });
  if (!cleanup.ok) throw abandonedTransactionError(cleanup, failure);
  if (failure) throw failure;
  return result;
}

/**
 * Streaming read with a hard server-side row cutoff.
 *
 * Wraps the query in the same rollback-only transaction as `runRead`, but uses
 * mssql's stream mode and cancels the underlying request once we've seen
 * `offset + limit + 1` rows. This means a naive `SELECT * FROM Orders` against
 * a huge table cannot OOM the Node process - only `limit` rows are kept and the
 * request is cancelled as soon as we know more rows exist.
 *
 * Returns `{ rows, totalSeen, truncated }`. `truncated` is true iff there was at
 * least one row beyond `offset + limit` (which we cancelled before fetching the rest).
 *
 * The row cutoff cancels a request just like an abort does, so it goes through the same
 * wait-then-check cleanup: on the happy path the request has already settled by the time
 * we get here and the wait costs nothing, and on the bad path the connection is not
 * handed back dirty.
 *
 * What ends the read is `done`, never `error`. mssql emits `error` in stream mode as soon
 * as the server's error token arrives - the request is still in flight and the connection
 * is still borrowed from the transaction - while `done` comes from the same callback that
 * releases it. Settling on `error` is what turned every plain SQL error into a failed
 * ROLLBACK ("There is a request in progress"), an abandoned-transaction error and a
 * needlessly destroyed connection.
 */
async function streamRead(
  pool,
  query,
  {
    offset = 0,
    limit = 100,
    mssql = loadDriver(),
    signal,
    timeoutMs,
    doneGraceMs = DONE_GRACE_MS,
    ...cleanupOptions
  } = {}
) {
  if (signal?.aborted) throw new Error("Request aborted");
  const transaction = new mssql.Transaction(pool);
  await transaction.begin(mssql.ISOLATION_LEVEL.READ_COMMITTED);

  const request = applyRequestTimeout(new mssql.Request(transaction), timeoutMs);
  request.stream = true;
  const abort = attachAbort(request, signal);
  let cutoff = false;

  let result;
  let failure = null;
  try {
    result = await new Promise((resolve, reject) => {
      const rows = [];
      let totalSeen = 0;
      let truncated = false;
      let canceled = false;
      let settled = false;
      let streamError = null;
      let doneTimer = null;

      const settle = (fn, value) => {
        if (settled) return;
        settled = true;
        if (doneTimer) clearTimeout(doneTimer);
        fn(value);
      };

      // El unico cierre legitimo. Si el corte por filas fue nuestro, la lectura es un exito
      // truncado aunque el servidor haya mandado un ECANCEL detras; si no, manda el error.
      const finish = () => {
        if (streamError && !canceled) settle(reject, streamError);
        else settle(resolve, { rows, totalSeen, truncated });
      };

      request.on("row", (row) => {
        totalSeen++;
        if (totalSeen > offset && rows.length < limit) {
          rows.push(row);
        }
        if (totalSeen > offset + limit && !canceled) {
          truncated = true;
          canceled = true;
          cutoff = true;
          try {
            request.cancel();
          } catch {
            // ignore
          }
        }
      });
      // Un `error` anota, pero NO cierra: llega con el request todavia en vuelo y la
      // conexion aun sin devolver, asi que cerrar aqui condenaba al ROLLBACK a fallar con
      // EREQINPROG. Se espera a `done`, que es lo que mssql emite ya con la conexion suelta.
      request.on("error", (err) => {
        if (!streamError) streamError = err;
        if (doneTimer) return;
        // Red de seguridad por si ese `done` no llegara nunca: no nos quedamos colgados.
        // Sin unref() a proposito: el timer vive solo mientras ya estamos esperando a la
        // query, y unref'ado no llegaria a disparar si no queda nada mas en el loop, que es
        // exactamente el caso en el que hace falta.
        doneTimer = setTimeout(finish, doneGraceMs);
      });
      request.on("done", finish);

      try {
        request.query(query);
      } catch (err) {
        settle(reject, err);
      }
    });
  } catch (err) {
    failure = err;
  } finally {
    abort.detach();
  }

  const cleanup = await rollbackAndCheck(pool, transaction, {
    ...cleanupOptions,
    aborted: abort.aborted || cutoff,
    mssql,
  });
  if (!cleanup.ok) throw abandonedTransactionError(cleanup, failure);
  if (failure) throw failure;
  return result;
}

/** One entry of the per-statement report a write returns (or fails with). */
function describeStatement(statement, result) {
  const out = {
    index: statement.index,
    startLine: statement.startLine,
    endLine: statement.endLine,
    preview: previewOf(statement.sql),
  };
  if (result) {
    out.rowsAffected = (result.rowsAffected || []).map(Number);
    out.recordsetCount = (result.recordsets || []).length;
  }
  return out;
}

function listStatements(applied) {
  return applied
    .map(
      (s) =>
        `#${s.index} (lines ${s.startLine}-${s.endLine}): ${s.preview}` +
        (s.rowsAffected ? ` [rowsAffected ${s.rowsAffected.join(", ")}]` : "")
    )
    .join("; ");
}

/**
 * The error a failed write raises, saying what was and was not applied.
 *
 * This is the whole point of the transaction: a three-DELETE batch used to run in
 * autocommit, the first two committed, the third timed out, and the caller was handed the
 * timeout and nothing else - the two rows were gone and only a follow-up SELECT revealed
 * it. Now the answer is always stated, and it is one of exactly three things: nothing was
 * applied (rolled back), a known prefix was applied (autocommit, by explicit opt-out), or
 * the state is unknown because the rollback itself could not be done.
 */
function writeFailureError(cause, { applied, total, transactional, cleanup }) {
  const position = applied.length + 1;
  const parts = [
    total > 1
      ? `Statement ${position} of ${total} failed.`
      : "The statement failed.",
  ];

  if (transactional && cleanup?.ok) {
    parts.push(
      total > 1
        ? `All ${total} statements ran in ONE transaction, which was rolled back: nothing was applied.`
        : "It ran in a transaction, which was rolled back: nothing was applied."
    );
  } else if (transactional) {
    parts.push(
      "It ran in a transaction, but that transaction could NOT be rolled back, so " +
        (applied.length > 0
          ? `whether these statements persisted is UNKNOWN: ${listStatements(applied)}.`
          : "whether anything persisted is UNKNOWN.") +
        " Verify the data before retrying."
    );
  } else if (applied.length > 0) {
    parts.push(
      `transactional:false was requested, so there was nothing to roll back and these ` +
        `statements are already COMMITTED: ${listStatements(applied)}.`
    );
  } else {
    parts.push(
      "transactional:false was requested, and nothing had been applied before the failure."
    );
  }

  if (transactional) {
    parts.push(
      `If this statement is one SQL Server refuses to run inside a transaction (${NON_TRANSACTIONAL_STATEMENTS}), call again with transactional:false - which gives up all-or-nothing.`
    );
  }

  parts.push(cause.message);
  const err = new Error(parts.join(" "));
  err.code = "EWRITEFAILED";
  err.cause = cause;
  err.applied = applied;
  return err;
}

/** Run every statement of a write, in order, reporting how far it got. */
async function executeStatements(target, statements, { mssql, timeoutMs, signal }) {
  const applied = [];
  for (const statement of statements) {
    if (signal?.aborted) {
      const err = new Error("Request aborted");
      err.applied = applied;
      throw err;
    }
    const request = applyRequestTimeout(new mssql.Request(target), timeoutMs);
    const abort = attachAbort(request, signal);
    try {
      const result = await request.batch(statement.sql);
      applied.push(describeStatement(statement, result));
    } catch (err) {
      err.applied = applied;
      err.aborted = abort.aborted;
      throw err;
    } finally {
      abort.detach();
    }
  }
  return applied;
}

/**
 * Run a mutating statement, all-or-nothing by default.
 *
 * Before, this built a Request straight on the pool: a multi-statement batch ran in
 * autocommit, so a failure halfway through left the earlier statements committed, and the
 * handler raised the exception without saying which ones. `execute_sql_file` had been
 * all-or-nothing all along; this is the same guarantee for inline SQL.
 *
 * The query is split on `GO` exactly like a .sql file, so an SSMS-style script pasted
 * inline behaves the same way here, and so that "what was applied" can be answered per
 * statement instead of per call.
 *
 * `transactional: false` is the opt-out for the statements SQL Server will not run inside
 * a transaction at all. It gives up atomicity - that is the trade, stated in the failure
 * message rather than discovered afterwards - and, because a Request built on the pool
 * borrows a connection per `.batch()`, it also gives up session state between statements.
 * That is fine for what the opt-out exists for (CREATE/ALTER DATABASE, BACKUP), which are
 * standalone statements; anything that needs one pinned connection belongs in
 * `execute_sql_file`.
 *
 * Returns `{ rowsAffected, statements, committed, transactional }`.
 */
async function runWrite(
  pool,
  query,
  {
    mssql = loadDriver(),
    signal,
    writesEnabled: enabled = writesEnabled(),
    transactional = true,
    timeoutMs,
    ...cleanupOptions
  } = {}
) {
  if (!enabled) {
    throw new Error(
      "writes are disabled. Set MSSQL_ENABLE_WRITES=true to enable execute_write_query."
    );
  }
  if (signal?.aborted) throw new Error("Request aborted");

  const statements = splitBatches(String(query));
  if (statements.length === 0) {
    throw new Error("No executable SQL found in the query.");
  }
  const total = statements.length;

  if (!transactional) {
    try {
      const applied = await executeStatements(pool, statements, {
        mssql,
        timeoutMs,
        signal,
      });
      return summarize(applied, { committed: true, transactional: false });
    } catch (err) {
      throw writeFailureError(err, {
        applied: err.applied || [],
        total,
        transactional: false,
      });
    }
  }

  const transaction = new mssql.Transaction(pool);
  // El servidor puede deshacer la transaccion por su cuenta (XACT_ABORT); si lo hace,
  // pedirle otro ROLLBACK es un error mas encima del que importa.
  let serverRolledBack = false;
  transaction.on("rollback", () => {
    serverRolledBack = true;
  });
  await transaction.begin(mssql.ISOLATION_LEVEL.READ_COMMITTED);

  let applied;
  try {
    applied = await executeStatements(transaction, statements, {
      mssql,
      timeoutMs,
      signal,
    });
    await transaction.commit();
  } catch (err) {
    const cleanup = serverRolledBack
      ? { ok: true, serverRolledBack: true }
      : await rollbackAndCheck(pool, transaction, {
          ...cleanupOptions,
          aborted: Boolean(err.aborted),
          mssql,
        });
    throw writeFailureError(err, {
      applied: err.applied || applied || [],
      total,
      transactional: true,
      cleanup,
    });
  }

  return summarize(applied, { committed: true, transactional: true });
}

function summarize(applied, { committed, transactional }) {
  const rowsAffected = applied.flatMap((s) => s.rowsAffected || []);
  return { rowsAffected, statements: applied, committed, transactional };
}

module.exports = {
  escapeIdentifier,
  splitTableIdentifier,
  quoteTable,
  writesEnabled,
  attachAbort,
  applyRequestTimeout,
  waitForRequestToSettle,
  probeTrancount,
  rollbackAndCheck,
  abandonedTransactionError,
  runRead,
  runWrite,
  streamRead,
  CANCEL_GRACE_MS,
  DONE_GRACE_MS,
  TRANCOUNT_PROBE_MS,
  NON_TRANSACTIONAL_STATEMENTS,
};
