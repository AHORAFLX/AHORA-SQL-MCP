/*
 * execute_sql_file: the cleanup after a failed batch.
 *
 * Own file on purpose: the tool module captures `loadDriver`, `getPool` and `getConfig`
 * at require time, so the doubles have to be in `require.cache` BEFORE the module is
 * loaded, and `node --test` gives each file its own process, which keeps those doubles
 * from leaking into any other test.
 *
 * What is being pinned down is the contract the tool broke until now: a failed script
 * must go through the same wait-then-rollback-then-check as every other statement, say
 * "nothing was applied" ONLY when that is established, and otherwise destroy the
 * connection and say so.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const events = [];
let batchPlan = [];
let rollbackError = null;
let trancountAfterFailedRollback = 0;
let fakeConnection;
const fakePool = {
  release(connection) {
    events.push(["pool.release", connection === fakeConnection]);
  },
};

function makeConnection() {
  const listeners = {};
  return {
    closed: false,
    hasError: false,
    inTransaction: false,
    once(event, fn) {
      listeners[event] = fn;
    },
    close() {
      events.push(["connection.close"]);
      this.closed = true;
      listeners.end?.();
    },
  };
}

const fakeMssql = {
  ISOLATION_LEVEL: { READ_COMMITTED: 4 },
  Transaction: function Transaction() {
    this._acquiredConnection = fakeConnection;
    this._activeRequest = null;
    this.on = () => this;
    this.begin = async () => {
      events.push(["begin"]);
    };
    this.commit = async () => {
      events.push(["commit"]);
    };
    this.rollback = async () => {
      events.push(["rollback"]);
      if (rollbackError) throw rollbackError;
      this._acquiredConnection = null;
    };
  },
  Request: function Request() {
    this.on = () => this;
    this.cancel = () => events.push(["cancel"]);
    this.batch = async (sql) => {
      events.push(["batch", sql.trim()]);
      const step = batchPlan.shift();
      if (step instanceof Error) throw step;
      return { rowsAffected: [1], recordsets: [] };
    };
    this.query = async (sql) => {
      events.push(["query", sql]);
      return { recordset: [{ trancount: trancountAfterFailedRollback }] };
    };
  },
};

function install(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require(resolved);
  require.cache[resolved].exports = exports;
}

install("../src/db/driver", {
  loadDriver: () => fakeMssql,
  driverLoaded: () => true,
  _resetForTests() {},
});
install("../src/db/pools", { getPool: async () => fakePool });
install("../src/config", {
  getConfig: () => ({ dbKey: "maindb", config: { database: "testdb" } }),
});

const { handler } = require("../src/tools/execute-sql-file");

const SCRIPT = "SELECT 1\nGO\nSELECT 2\nGO\nSELECT 3\n";
let scriptPath;

test.before(() => {
  process.env.MSSQL_ENABLE_WRITES = "true";
  scriptPath = path.join(
    process.cwd(),
    `tmp-sql-file-cleanup-${process.pid}.sql`
  );
  fs.writeFileSync(scriptPath, SCRIPT, "utf8");
});

test.after(() => {
  fs.rmSync(scriptPath, { force: true });
});

test.beforeEach(() => {
  events.length = 0;
  batchPlan = [];
  rollbackError = null;
  trancountAfterFailedRollback = 0;
  fakeConnection = makeConnection();
});

test("a script that runs through commits and never rolls back", async () => {
  const out = await handler({ path: scriptPath }, {});
  assert.equal(out.structuredContent.committed, true);
  assert.equal(out.structuredContent.batchCount, 3);
  assert.ok(events.some((e) => e[0] === "commit"));
  assert.ok(!events.some((e) => e[0] === "rollback"));
});

test("a failed batch rolls back, and only then claims nothing was applied", async () => {
  const sqlError = new Error("Invalid column name 'x'.");
  sqlError.lineNumber = 1;
  batchPlan = [null, sqlError];

  await assert.rejects(
    () => handler({ path: scriptPath }, {}),
    (err) => {
      assert.match(err.message, /Batch #1 failed \(file lines 3-3\)/);
      assert.match(err.message, /which was rolled back - nothing was applied/);
      assert.equal(err.code, undefined);
      return true;
    }
  );
  assert.ok(
    events.some((e) => e[0] === "rollback"),
    "the rollback is attempted"
  );
  assert.ok(!events.some((e) => e[0] === "commit"), "nothing is committed");
  assert.ok(
    !events.some((e) => e[0] === "connection.close"),
    "a clean connection stays"
  );
});

test("a rollback that fails on a still-open transaction destroys the connection and says so", async () => {
  batchPlan = [
    null,
    new Error("Timeout: Request failed to complete in 90000ms"),
  ];
  rollbackError = Object.assign(new Error("There is a request in progress."), {
    code: "EREQINPROG",
  });
  trancountAfterFailedRollback = 1;

  await assert.rejects(
    () => handler({ path: scriptPath }, {}),
    (err) => {
      assert.equal(err.code, "ETXNABANDONED");
      assert.match(err.message, /@@TRANCOUNT=1/);
      assert.match(err.message, /closed and dropped from the pool/);
      assert.match(err.message, /Original failure: Batch #1 failed/);
      assert.doesNotMatch(
        err.message,
        /nothing was applied/,
        "must not claim a rollback that did not happen"
      );
      return true;
    }
  );
  assert.ok(
    events.some((e) => e[0] === "connection.close"),
    "the connection is closed"
  );
  assert.ok(
    events.some((e) => e[0] === "pool.release" && e[1] === true),
    "its slot is handed back to the pool"
  );
  assert.equal(
    fakeConnection.hasError,
    true,
    "and it is marked not to be reused"
  );
});

test("a rollback error on a connection that is actually clean is tolerated", async () => {
  batchPlan = [null, new Error("boom")];
  rollbackError = new Error("The transaction has already been rolled back.");
  trancountAfterFailedRollback = 0;

  await assert.rejects(
    () => handler({ path: scriptPath }, {}),
    /which was rolled back - nothing was applied/
  );
  assert.ok(events.some((e) => e[0] === "query" && /@@TRANCOUNT/.test(e[1])));
  assert.ok(!events.some((e) => e[0] === "connection.close"));
});
