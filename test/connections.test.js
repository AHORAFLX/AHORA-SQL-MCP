const test = require("node:test");
const assert = require("node:assert/strict");
const {
  withTimeout,
  isReusable,
  hasOpenTransaction,
  resetConnection,
  makeAcquireReset,
  destroyConnection,
} = require("../src/db/connections");

/**
 * Un doble de la conexion CRUDA de tedious, con lo poco que este modulo mira de ella.
 *
 * `reset` deshace la transaccion como haria el bit de reset de TDS; `resetFails` y
 * `resetHangs` son los dos modos en los que una conexion quemada se niega a sanearse.
 */
function fakeConnection(overrides = {}) {
  const conn = {
    closed: false,
    hasError: false,
    inTransaction: false,
    resets: 0,
    closes: 0,
    once(event, fn) {
      if (event === "end") conn._end = fn;
    },
    close() {
      conn.closes++;
      conn.closed = true;
      conn._end?.();
    },
    reset(cb) {
      conn.resets++;
      if (overrides.resetHangs) return;
      if (overrides.resetFails) return cb(overrides.resetFails);
      if (!overrides.resetKeepsTransaction) conn.inTransaction = false;
      cb(null);
    },
  };
  return Object.assign(conn, overrides);
}

function fakePool() {
  const released = [];
  return { released, release: (c) => released.push(c) };
}

test("withTimeout rejects with ETIMEOUT instead of hanging forever", async () => {
  const never = new Promise(() => {});
  await assert.rejects(
    () => withTimeout(never, 20, "probe"),
    (err) => {
      assert.equal(err.code, "ETIMEOUT");
      assert.match(err.message, /probe did not complete in 20ms/);
      return true;
    }
  );
});

test("withTimeout passes a value straight through when it arrives in time", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000, "probe"), 7);
});

test("isReusable rejects closed and marked connections", () => {
  assert.equal(isReusable(fakeConnection()), true);
  assert.equal(isReusable(fakeConnection({ closed: true })), false);
  assert.equal(isReusable(fakeConnection({ hasError: true })), false);
  assert.equal(isReusable(null), false);
  assert.equal(isReusable(undefined), false);
});

test("hasOpenTransaction reads the flag the server drives, and tolerates non-connections", () => {
  assert.equal(
    hasOpenTransaction(fakeConnection({ inTransaction: true })),
    true
  );
  assert.equal(hasOpenTransaction(fakeConnection()), false);
  assert.equal(hasOpenTransaction(null), false);
  assert.equal(hasOpenTransaction({}), false);
});

test("resetConnection is a no-op on a connection that has no reset (other drivers, test doubles)", async () => {
  await resetConnection({ closed: false }, 100);
});

test("resetConnection surfaces a reset that never answers, bounded", async () => {
  const conn = fakeConnection({ resetHangs: true, inTransaction: true });
  await assert.rejects(
    () => resetConnection(conn, 30),
    /did not complete in 30ms/
  );
});

test("acquire validator resets the connection and accepts it", async () => {
  // Esto es la cura que hace que el fallo no se propague: la conexion llega con una
  // transaccion heredada y sale limpia, sin que quien la pide se entere.
  const conn = fakeConnection({ inTransaction: true });
  const validate = makeAcquireReset();
  assert.equal(await validate(conn), true);
  assert.equal(conn.resets, 1, "se sanea al cogerla, no al devolverla");
  assert.equal(conn.inTransaction, false, "la transaccion heredada ya no esta");
});

test("acquire validator rejects a connection whose transaction survives the reset", async () => {
  const discards = [];
  const conn = fakeConnection({
    inTransaction: true,
    resetKeepsTransaction: true,
  });
  const validate = makeAcquireReset({ onDiscard: (why) => discards.push(why) });
  assert.equal(
    await validate(conn),
    false,
    "una conexion con @@TRANCOUNT > 0 no se reparte"
  );
  assert.deepEqual(discards, ["open-transaction"]);
});

test("acquire validator rejects a connection that will not reset, and never hangs", async () => {
  const discards = [];
  const validate = makeAcquireReset({
    timeoutMs: 30,
    onDiscard: (why) => discards.push(why),
  });
  assert.equal(await validate(fakeConnection({ resetHangs: true })), false);
  assert.deepEqual(discards, ["ETIMEOUT"]);

  const failing = fakeConnection({
    resetFails: Object.assign(new Error("nope"), { code: "EINVALIDSTATE" }),
  });
  assert.equal(await validate(failing), false);
  assert.deepEqual(discards, ["ETIMEOUT", "EINVALIDSTATE"]);
});

test("acquire validator rejects an already-dead connection without talking to it", async () => {
  const conn = fakeConnection({ closed: true });
  assert.equal(await makeAcquireReset()(conn), false);
  assert.equal(conn.resets, 0);
});

test("destroyConnection marks, closes and gives the pool slot back", async () => {
  const pool = fakePool();
  const conn = fakeConnection({ inTransaction: true });
  assert.equal(await destroyConnection(pool, conn), true);
  assert.equal(
    conn.hasError,
    true,
    "marcada para que ningun validate la acepte"
  );
  assert.equal(
    conn.closed,
    true,
    "cerrada, para que el servidor deshaga la transaccion"
  );
  assert.deepEqual(
    pool.released,
    [conn],
    "el hueco vuelve al pool: si no, cada fallo quemaria una plaza para siempre"
  );
});

test("destroyConnection survives a pool that will not take the connection back", async () => {
  const conn = fakeConnection();
  const pool = {
    release() {
      throw new Error("already released");
    },
  };
  assert.equal(await destroyConnection(pool, conn), true);
  assert.equal(conn.closed, true);
});

test("destroyConnection is a no-op without a connection", async () => {
  assert.equal(await destroyConnection(fakePool(), null), false);
});
