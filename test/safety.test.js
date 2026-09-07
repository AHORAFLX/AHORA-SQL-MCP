const test = require("node:test");
const assert = require("node:assert/strict");
const {
  escapeIdentifier,
  splitTableIdentifier,
  quoteTable,
  attachAbort,
  applyRequestTimeout,
  waitForRequestToSettle,
  runRead,
  runWrite,
  streamRead,
  writesEnabled,
} = require("../src/db/safety");

test("escapeIdentifier quotes brackets safely", () => {
  assert.equal(escapeIdentifier("Users"), "[Users]");
  assert.equal(escapeIdentifier("Weird]Name"), "[Weird]]Name]");
});

test("splitTableIdentifier handles schema.table and bare table", () => {
  assert.deepEqual(splitTableIdentifier("dbo.Users"), {
    schema: "dbo",
    table: "Users",
  });
  assert.deepEqual(splitTableIdentifier("Users"), {
    schema: null,
    table: "Users",
  });
  assert.throws(() => splitTableIdentifier("a.b.c"));
  assert.throws(() => splitTableIdentifier(".x"));
  assert.throws(() => splitTableIdentifier("x."));
});

test("quoteTable produces bracketed schema.table", () => {
  assert.equal(quoteTable("dbo.Users"), "[dbo].[Users]");
  assert.equal(quoteTable("Users"), "[Users]");
  assert.equal(quoteTable("dbo.We]ird"), "[dbo].[We]]ird]");
});

test("writesEnabled reads MSSQL_ENABLE_WRITES", () => {
  assert.equal(writesEnabled({ MSSQL_ENABLE_WRITES: "true" }), true);
  assert.equal(writesEnabled({ MSSQL_ENABLE_WRITES: "TRUE" }), true);
  assert.equal(writesEnabled({ MSSQL_ENABLE_WRITES: "false" }), false);
  assert.equal(writesEnabled({}), false);
});

test("writesEnabled: an explicit MSSQL_<DBKEY>_ENABLE_WRITES wins over the global flag", () => {
  const env = { MSSQL_ENABLE_WRITES: "false", MSSQL_DATA_ENABLE_WRITES: "true" };
  assert.equal(writesEnabled(env, "data"), true, "per-db override enables it");
  assert.equal(writesEnabled(env, "DATA"), true, "the dbKey lookup is case-insensitive");
  assert.equal(writesEnabled(env, "config"), false, "an alias without an override falls back to global");
  assert.equal(writesEnabled(env), false, "no dbKey at all falls back to global");
});

test("writesEnabled: a per-db override can also lock a database to read-only under a global true", () => {
  const env = { MSSQL_ENABLE_WRITES: "true", MSSQL_CONFIG_ENABLE_WRITES: "false" };
  assert.equal(writesEnabled(env, "config"), false);
  assert.equal(writesEnabled(env, "data"), true);
});

function fakeMssqlFactory(events) {
  return {
    ISOLATION_LEVEL: { READ_COMMITTED: 4 },
    Transaction: function Transaction(pool) {
      this.pool = pool;
      this.on = () => this;
      this.begin = async (lvl) => {
        events.push(["begin", lvl]);
      };
      this.commit = async () => {
        events.push(["commit"]);
      };
      this.rollback = async () => {
        events.push(["rollback"]);
      };
    },
    Request: function Request(target) {
      this.target = target;
      this.canceled = false;
      this.input = () => this;
      this.cancel = () => {
        this.canceled = true;
        events.push(["cancel"]);
      };
      this.query = async (sql) => {
        events.push(["query", sql]);
        return { recordset: [{ x: 1 }], rowsAffected: [1] };
      };
      this.batch = async (sql) => {
        events.push(["batch", sql]);
        return { recordset: [{ x: 1 }], rowsAffected: [1] };
      };
    },
  };
}

test("runRead always rolls back, never commits", async () => {
  const events = [];
  const mssql = fakeMssqlFactory(events);
  const result = await runRead(
    {},
    async (request) => request.query("SELECT 1"),
    { mssql }
  );
  assert.deepEqual(result.recordset, [{ x: 1 }]);
  assert.ok(
    events.some((e) => e[0] === "rollback"),
    "must rollback"
  );
  assert.ok(!events.some((e) => e[0] === "commit"), "must not commit");
});

test("runRead rolls back even on callback error", async () => {
  const events = [];
  const mssql = fakeMssqlFactory(events);
  await assert.rejects(
    () =>
      runRead(
        {},
        async () => {
          throw new Error("oops");
        },
        { mssql }
      ),
    /oops/
  );
  assert.ok(events.some((e) => e[0] === "rollback"));
});

test("runRead cancels request when AbortSignal fires", async () => {
  const events = [];
  const mssql = fakeMssqlFactory(events);
  const controller = new AbortController();
  const promise = runRead(
    {},
    async (request) => {
      controller.abort();
      // simulate cancel-driven failure path
      return request.query("SELECT 1");
    },
    { mssql, signal: controller.signal }
  );
  await promise;
  assert.ok(events.some((e) => e[0] === "cancel"));
});

test("runWrite throws when writes disabled", async () => {
  await assert.rejects(
    () =>
      runWrite({}, "INSERT INTO x VALUES (1)", {
        mssql: fakeMssqlFactory([]),
        writesEnabled: false,
      }),
    /writes are disabled/i
  );
});

test("runWrite executes the query when writes enabled", async () => {
  const events = [];
  const mssql = fakeMssqlFactory(events);
  const result = await runWrite({}, "INSERT INTO x VALUES (1)", {
    mssql,
    writesEnabled: true,
  });
  assert.deepEqual(result.rowsAffected, [1]);
  assert.equal(result.committed, true);
  assert.equal(result.statements.length, 1);
});

test("runRead rejects pre-aborted signal without beginning a transaction", async () => {
  const events = [];
  const mssql = fakeMssqlFactory(events);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      runRead({}, async () => "should not run", {
        mssql,
        signal: controller.signal,
      }),
    /Request aborted/
  );
  assert.equal(
    events.some((e) => e[0] === "begin"),
    false,
    "transaction must not begin if signal already aborted"
  );
});

test("runWrite rejects pre-aborted signal", async () => {
  const events = [];
  const mssql = fakeMssqlFactory(events);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      runWrite({}, "INSERT INTO x VALUES (1)", {
        mssql,
        signal: controller.signal,
        writesEnabled: true,
      }),
    /Request aborted/
  );
});

function streamingMssqlFactory({ rows, errorOnRowIndex = null }) {
  let listeners = {};
  let canceled = false;
  return {
    ISOLATION_LEVEL: { READ_COMMITTED: 4 },
    Transaction: function Transaction() {
      this.on = () => this;
      this.begin = async () => {};
      this.commit = async () => {};
      this.rollback = async () => {};
    },
    Request: function Request() {
      this.stream = false;
      this.input = () => this;
      this.cancel = () => {
        canceled = true;
      };
      this.on = (event, fn) => {
        listeners[event] = fn;
      };
      this.query = () => {
        process.nextTick(async () => {
          try {
            for (let i = 0; i < rows.length; i++) {
              if (canceled) break;
              if (errorOnRowIndex !== null && i === errorOnRowIndex) {
                listeners.error?.(new Error("simulated stream error"));
                return;
              }
              listeners.row?.(rows[i]);
            }
            if (canceled) {
              listeners.error?.(
                Object.assign(new Error("cancelled"), { code: "ECANCEL" })
              );
            } else {
              listeners.done?.({});
            }
          } catch (err) {
            listeners.error?.(err);
          }
        });
      };
    },
  };
}

test("streamRead returns first `limit` rows and reports truncated=true when more exist", async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: i + 1 }));
  const mssql = streamingMssqlFactory({ rows });
  const result = await streamRead({}, "SELECT * FROM t", {
    offset: 0,
    limit: 10,
    mssql,
  });
  assert.equal(result.rows.length, 10);
  assert.deepEqual(result.rows[0], { id: 1 });
  assert.deepEqual(result.rows[9], { id: 10 });
  assert.equal(result.truncated, true);
  assert.ok(
    result.totalSeen >= 11,
    "must have seen at least one row past the cap to know more exist"
  );
});

test("streamRead reports truncated=false when result fits within limit", async () => {
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: i + 1 }));
  const mssql = streamingMssqlFactory({ rows });
  const result = await streamRead({}, "SELECT * FROM t", {
    offset: 0,
    limit: 10,
    mssql,
  });
  assert.equal(result.rows.length, 5);
  assert.equal(result.truncated, false);
  assert.equal(result.totalSeen, 5);
});

test("streamRead honors offset", async () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
  const mssql = streamingMssqlFactory({ rows });
  const result = await streamRead({}, "SELECT * FROM t", {
    offset: 3,
    limit: 4,
    mssql,
  });
  assert.deepEqual(
    result.rows.map((r) => r.id),
    [4, 5, 6, 7]
  );
});

// ---------------------------------------------------------------------------
// Connection hygiene: la clase de fallo que envenenaba el pool
// ---------------------------------------------------------------------------

/**
 * Doble de la conexion CRUDA que la transaccion pincha, con lo que mira la limpieza.
 */
function fakeConnection(overrides = {}) {
  const conn = {
    closed: false,
    hasError: false,
    inTransaction: true,
    once(event, fn) {
      if (event === "end") conn._end = fn;
    },
    close() {
      conn.closed = true;
      conn._end?.();
    },
    reset(cb) {
      cb(null);
    },
  };
  return Object.assign(conn, overrides);
}

/**
 * Un driver falso con las averias del escenario real, montable una a una.
 *
 *   connection             la conexion cruda que `begin` pincha en la transaccion
 *   rollbackError          el ROLLBACK falla (EREQINPROG, EINVALIDSTATE...)
 *   stuckRequest           el request cancelado NO se suelta: la cancelacion no aterriza
 *   trancount / probeError lo que contesta -o no- el sondeo `SELECT @@TRANCOUNT`
 *   batchFailsAt           indice de la sentencia que revienta, para las escrituras
 */
function poolAwareMssql(spec = {}) {
  const events = spec.events || [];
  const released = [];
  const pool = { release: (c) => released.push(c), released };

  function Transaction() {
    this._acquiredConnection = spec.connection || null;
    this._activeRequest = spec.stuckRequest ? {} : null;
    this._handlers = {};
    this.on = (name, fn) => {
      (this._handlers[name] = this._handlers[name] || []).push(fn);
      return this;
    };
    this.emit = (name, ...args) =>
      (this._handlers[name] || []).forEach((fn) => fn(...args));
    this.begin = async () => {
      events.push(["begin"]);
    };
    this.commit = async () => {
      events.push(["commit"]);
      if (spec.commitError) throw spec.commitError;
      this._acquiredConnection = null;
    };
    this.rollback = async () => {
      events.push(["rollback"]);
      if (spec.rollbackError) throw spec.rollbackError;
      if (spec.connection) spec.connection.inTransaction = false;
      this._acquiredConnection = null;
    };
  }

  let batchIndex = 0;
  function Request(target) {
    this.target = target;
    this.stream = false;
    this.input = () => this;
    this.cancel = () => events.push(["cancel"]);
    this.on = () => this;
    this._setCurrentRequest = () => this;
    this.query = async (sql) => {
      events.push(["query", sql]);
      if (/@@TRANCOUNT/i.test(sql)) {
        if (spec.probeError) throw spec.probeError;
        if (spec.probeHangs) return new Promise(() => {});
        return { recordset: [{ trancount: spec.trancount ?? 0 }] };
      }
      return { recordset: [{ x: 1 }], rowsAffected: [1] };
    };
    this.batch = async (sql) => {
      const index = batchIndex++;
      events.push(["batch", index, sql.trim().slice(0, 30)]);
      if (spec.batchFailsAt === index) {
        // Con XACT_ABORT el servidor deshace la transaccion como parte del fallo, antes
        // de que el cliente se entere.
        if (spec.serverRollsBackOnFailure) this.target?.emit?.("rollback", true);
        throw Object.assign(new Error("Timeout: Request failed to complete in 30000ms"), {
          code: "ETIMEOUT",
        });
      }
      return { recordset: [], rowsAffected: [1], recordsets: [] };
    };
  }

  return {
    ISOLATION_LEVEL: { READ_COMMITTED: 4 },
    Transaction,
    Request,
    pool,
    events,
    released,
  };
}

test("runRead: a ROLLBACK that fails on a connection left inside a transaction destroys it and says so", async () => {
  // El escenario medido: la cancelacion no llego a tiempo, el ROLLBACK no se pudo enviar
  // y la conexion se quedaba con @@TRANCOUNT=1. Antes esto se lo tragaba un catch vacio.
  const connection = fakeConnection({ inTransaction: true });
  const mssql = poolAwareMssql({
    connection,
    rollbackError: Object.assign(new Error("There is another request in progress."), {
      code: "EREQINPROG",
    }),
    trancount: 1,
  });

  await assert.rejects(
    () =>
      runRead(mssql.pool, async (request) => request.query("SELECT 1"), {
        mssql,
      }),
    (err) => {
      assert.equal(err.code, "ETXNABANDONED");
      assert.match(err.message, /could not be closed/i);
      assert.match(err.message, /ROLLBACK failed: There is another request in progress\./);
      assert.match(err.message, /@@TRANCOUNT=1/);
      assert.match(err.message, /inside an open transaction/i);
      assert.match(err.message, /Run it again/i);
      return true;
    }
  );

  assert.equal(connection.hasError, true, "marcada para que nadie la reutilice");
  assert.equal(connection.closed, true, "cerrada: el servidor deshace la transaccion");
  assert.deepEqual(mssql.released, [connection], "el hueco del pool vuelve libre");
});

test("runRead: no session is left with an open transaction after a read whose cancellation never lands", async () => {
  // Esto es el criterio de aceptacion en version unitaria: tras una lectura con timeout,
  // NINGUNA conexion se queda en el pool dentro de una transaccion.
  const connection = fakeConnection({ inTransaction: true });
  const mssql = poolAwareMssql({
    connection,
    stuckRequest: true, // `_activeRequest` no se suelta nunca
    rollbackError: Object.assign(new Error("There is another request in progress."), {
      code: "EREQINPROG",
    }),
    trancount: 1,
  });

  const controller = new AbortController();
  const started = Date.now();
  await assert.rejects(
    () =>
      runRead(
        mssql.pool,
        async (request) => {
          controller.abort();
          const err = new Error("Timeout: Request failed to complete in 30000ms");
          err.code = "ETIMEOUT";
          void request;
          throw err;
        },
        { mssql, signal: controller.signal, cancelGraceMs: 120 }
      ),
    (err) => {
      assert.match(
        err.message,
        /cancellation did not complete within/i,
        "el mensaje dice que la cancelacion no aterrizo, no un timeout generico"
      );
      assert.match(
        err.message,
        /Original failure: Timeout: Request failed to complete in 30000ms/,
        "y conserva el fallo original"
      );
      return true;
    }
  );

  assert.ok(
    Date.now() - started >= 100,
    "la cancelacion se espera con un limite acotado, no se ignora"
  );
  assert.equal(
    connection.closed && connection.hasError,
    true,
    "ninguna conexion con transaccion abierta vuelve al pool"
  );
  assert.deepEqual(mssql.released, [connection]);
});

test("runRead: a failed ROLLBACK with @@TRANCOUNT already 0 is not an error - that is the user's own COMMIT", async () => {
  const connection = fakeConnection({ inTransaction: false });
  const mssql = poolAwareMssql({
    connection,
    rollbackError: Object.assign(new Error("Transaction has not begun."), {
      code: "ENOTBEGUN",
    }),
    trancount: 0,
  });
  const result = await runRead(
    mssql.pool,
    async (request) => request.query("SELECT 1 COMMIT"),
    { mssql }
  );
  assert.deepEqual(result.recordset, [{ x: 1 }]);
  assert.deepEqual(mssql.released, [], "nada que destruir: la conexion esta limpia");
  assert.equal(connection.closed, false);
});

test("runRead: a @@TRANCOUNT probe that cannot be answered is treated as poisoned", async () => {
  const connection = fakeConnection({ inTransaction: true });
  const mssql = poolAwareMssql({
    connection,
    rollbackError: new Error("rollback exploded"),
    probeError: new Error("connection is closed"),
  });
  await assert.rejects(
    () => runRead(mssql.pool, async (r) => r.query("SELECT 1"), { mssql }),
    (err) => {
      assert.match(err.message, /@@TRANCOUNT could not be read/i);
      assert.match(err.message, /connection is closed/);
      return true;
    }
  );
  assert.equal(connection.closed, true);
});

test("runRead: a ROLLBACK that fails AFTER the driver released the connection does not touch it", async () => {
  // mssql devuelve la conexion al pool incluso cuando el ROLLBACK falla con un error del
  // driver. A partir de ahi la conexion puede ser ya de otra llamada: ni se sondea ni se
  // destruye, porque destruir una conexion en uso rompe a un tercero. De este caso se
  // encarga el saneado al adquirir - el hueco del pool, que es lo irrecuperable, no se
  // ha perdido.
  const connection = fakeConnection({ inTransaction: true });
  const mssql = poolAwareMssql({ connection });
  const original = mssql.Transaction;
  mssql.Transaction = function Transaction(...args) {
    original.apply(this, args);
    this.rollback = async () => {
      mssql.events.push(["rollback"]);
      this._acquiredConnection = null; // mssql la suelta y LUEGO informa del error
      throw new Error("Requests can only be made in the LoggedIn state");
    };
  };

  const result = await runRead(mssql.pool, async (r) => r.query("SELECT 1"), {
    mssql,
  });
  assert.deepEqual(result.recordset, [{ x: 1 }]);
  assert.equal(
    mssql.events.some((e) => e[0] === "query" && /@@TRANCOUNT/i.test(e[1])),
    false,
    "no se le manda un request a una conexion que ya no es nuestra"
  );
  assert.equal(connection.closed, false, "y no se cierra por debajo a quien la tenga");
  assert.deepEqual(mssql.released, []);
});

test("runRead: a connection whose socket is already closed needs no probe and no error", async () => {
  // Sin sesion no hay transaccion huerfana: el servidor ya la deshizo al caerse el socket.
  const connection = fakeConnection({ inTransaction: true, closed: true });
  const mssql = poolAwareMssql({
    connection,
    rollbackError: new Error("Requests can only be made in the LoggedIn state"),
  });
  const result = await runRead(mssql.pool, async (r) => r.query("SELECT 1"), {
    mssql,
  });
  assert.deepEqual(result.recordset, [{ x: 1 }]);
  assert.equal(
    mssql.events.some((e) => e[0] === "query" && /@@TRANCOUNT/i.test(e[1])),
    false,
    "no se sondea una sesion que ya no existe"
  );
});

test("streamRead: the row cutoff still works, and cleans up through the same path", async () => {
  const connection = fakeConnection({ inTransaction: true });
  const mssql = poolAwareMssql({ connection, trancount: 0 });
  const listeners = {};
  mssql.Request = function Request() {
    this.stream = false;
    this.cancel = () => mssql.events.push(["cancel"]);
    this.on = (event, fn) => {
      listeners[event] = fn;
    };
    this._setCurrentRequest = () => this;
    this.query = () => {
      process.nextTick(() => {
        for (let i = 1; i <= 5; i++) listeners.row?.({ id: i });
        listeners.error?.(Object.assign(new Error("cancelled"), { code: "ECANCEL" }));
      });
    };
  };

  const result = await streamRead(mssql.pool, "SELECT * FROM t", {
    offset: 0,
    limit: 2,
    mssql,
  });
  assert.deepEqual(
    result.rows.map((r) => r.id),
    [1, 2],
    "el corte por filas se mantiene"
  );
  assert.equal(result.truncated, true);
  assert.ok(mssql.events.some((e) => e[0] === "cancel"));
  assert.ok(mssql.events.some((e) => e[0] === "rollback"));
  assert.deepEqual(mssql.released, [], "una lectura truncada normal no quema conexiones");
});

test("waitForRequestToSettle returns as soon as the request lets go of the connection", async () => {
  const transaction = { _activeRequest: {} };
  setTimeout(() => {
    transaction._activeRequest = null;
  }, 40);
  const started = Date.now();
  assert.equal(await waitForRequestToSettle(transaction, 2000), true);
  const waited = Date.now() - started;
  assert.ok(waited >= 30 && waited < 1000, `waited ${waited}ms`);
});

test("waitForRequestToSettle gives up on a request that never settles", async () => {
  assert.equal(await waitForRequestToSettle({ _activeRequest: {} }, 60), false);
});

test("attachAbort reports that a cancel was fired, and that it threw", async () => {
  const controller = new AbortController();
  const request = {
    cancel() {
      throw new Error("cancel unavailable");
    },
  };
  const state = attachAbort(request, controller.signal);
  assert.equal(state.aborted, false);
  controller.abort();
  assert.equal(state.aborted, true, "la cancelacion no se olvida");
  assert.match(state.cancelError.message, /cancel unavailable/);
});

test("attachAbort without a signal is inert but still answerable", () => {
  const state = attachAbort({ cancel: () => {} }, undefined);
  assert.equal(state.aborted, false);
  state.detach();
});

test("applyRequestTimeout stamps the timeout where tedious reads it", () => {
  const tdsRequest = {};
  const seen = [];
  const request = {
    _setCurrentRequest(req) {
      seen.push(req);
      return this;
    },
  };
  applyRequestTimeout(request, 120000);
  request._setCurrentRequest(tdsRequest);
  assert.equal(
    tdsRequest.timeout,
    120000,
    "tedious solo mira request.timeout; el de pool no vale para una llamada suelta"
  );
  assert.deepEqual(seen, [tdsRequest], "el comportamiento original se conserva");
});

test("applyRequestTimeout leaves the request alone when no timeout is asked for", () => {
  const tdsRequest = {};
  const request = { _setCurrentRequest: () => request };
  applyRequestTimeout(request, undefined);
  request._setCurrentRequest(tdsRequest);
  assert.equal(tdsRequest.timeout, undefined);
});

// ---------------------------------------------------------------------------
// Escrituras: todo-o-nada, y decir que se aplico cuando no
// ---------------------------------------------------------------------------

const THREE_DELETES = [
  "DELETE FROM A WHERE Id = 1",
  "GO",
  "DELETE FROM B WHERE Id = 2",
  "GO",
  "DELETE FROM C WHERE Id = 3",
].join("\n");

test("runWrite wraps a multi-statement write in ONE transaction and commits it", async () => {
  const mssql = poolAwareMssql({ connection: fakeConnection() });
  const result = await runWrite(mssql.pool, THREE_DELETES, {
    mssql,
    writesEnabled: true,
  });
  assert.equal(result.transactional, true);
  assert.equal(result.committed, true);
  assert.equal(result.statements.length, 3);
  assert.deepEqual(result.rowsAffected, [1, 1, 1]);
  assert.equal(
    mssql.events.filter((e) => e[0] === "begin").length,
    1,
    "una sola transaccion para todas las sentencias"
  );
  assert.ok(mssql.events.some((e) => e[0] === "commit"));
  assert.equal(mssql.events.some((e) => e[0] === "rollback"), false);
});

test("runWrite: a write that fails half-way through reports that NOTHING was applied", async () => {
  // El caso medido: tres DELETE, las dos primeras COMMITEARON y la tercera dio timeout,
  // y el tool solo devolvia el timeout. Ahora las tres van juntas o no va ninguna, y el
  // error lo dice.
  const connection = fakeConnection({ inTransaction: true });
  const mssql = poolAwareMssql({ connection, batchFailsAt: 2, trancount: 0 });

  await assert.rejects(
    () => runWrite(mssql.pool, THREE_DELETES, { mssql, writesEnabled: true }),
    (err) => {
      assert.equal(err.code, "EWRITEFAILED");
      assert.match(err.message, /Statement 3 of 3 failed/);
      assert.match(
        err.message,
        /All 3 statements ran in ONE transaction, which was rolled back: nothing was applied/
      );
      assert.match(err.message, /Timeout: Request failed to complete in 30000ms/);
      assert.match(
        err.message,
        /transactional:false/,
        "y dice como salirse cuando la sentencia no cabe en una transaccion"
      );
      assert.deepEqual(
        err.applied.map((s) => s.index),
        [0, 1],
        "las sentencias que se habian ejecutado quedan enumeradas en el error"
      );
      return true;
    }
  );
  assert.ok(mssql.events.some((e) => e[0] === "rollback"));
});

test("runWrite: with transactional:false the error names the statements already committed", async () => {
  const mssql = poolAwareMssql({ batchFailsAt: 2 });
  await assert.rejects(
    () =>
      runWrite(mssql.pool, THREE_DELETES, {
        mssql,
        writesEnabled: true,
        transactional: false,
      }),
    (err) => {
      assert.match(err.message, /Statement 3 of 3 failed/);
      assert.match(err.message, /already COMMITTED/);
      assert.match(err.message, /#0 \(lines 1-1\): DELETE FROM A WHERE Id = 1/);
      assert.match(err.message, /#1 \(lines 3-3\): DELETE FROM B WHERE Id = 2/);
      assert.equal(
        /DELETE FROM C/.test(err.message.split("already COMMITTED")[1]),
        false,
        "la que fallo no se cuenta como aplicada"
      );
      return true;
    }
  );
  assert.equal(
    mssql.events.some((e) => e[0] === "begin"),
    false,
    "el opt-out no abre transaccion"
  );
});

test("runWrite: a rollback that fails turns the report into an explicit UNKNOWN", async () => {
  const connection = fakeConnection({ inTransaction: true });
  const mssql = poolAwareMssql({
    connection,
    batchFailsAt: 1,
    rollbackError: new Error("connection is closed"),
    trancount: 2,
  });
  await assert.rejects(
    () => runWrite(mssql.pool, THREE_DELETES, { mssql, writesEnabled: true }),
    (err) => {
      assert.match(err.message, /could NOT be rolled back/);
      assert.match(err.message, /UNKNOWN/);
      assert.match(err.message, /#0 \(lines 1-1\): DELETE FROM A WHERE Id = 1/);
      assert.match(err.message, /Verify the data before retrying/);
      return true;
    }
  );
  assert.equal(
    connection.closed,
    true,
    "y la conexion se saca del pool para que no arrastre la transaccion"
  );
});

test("runWrite: a server-side rollback (XACT_ABORT) is not rolled back twice", async () => {
  const mssql = poolAwareMssql({
    connection: fakeConnection(),
    batchFailsAt: 0,
    serverRollsBackOnFailure: true,
  });
  await assert.rejects(
    () => runWrite(mssql.pool, "DELETE FROM A", { mssql, writesEnabled: true }),
    /nothing was applied/
  );
  assert.equal(
    mssql.events.filter((e) => e[0] === "rollback").length,
    0,
    "no se pide un ROLLBACK que el servidor ya hizo"
  );
});

test("runWrite refuses a query with nothing executable in it", async () => {
  const mssql = poolAwareMssql({});
  await assert.rejects(
    () => runWrite(mssql.pool, "   \n\t\n  ", { mssql, writesEnabled: true }),
    /No executable SQL found/
  );
});
