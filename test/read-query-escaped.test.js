/*
 * execute_read_query: what the caller sees when the batch closed the transaction itself.
 *
 * Own file for the same reason as sql-file-cleanup.test.js: the tool captures `getPool`,
 * `getConfig` and `streamRead` at require time, so the doubles have to be in
 * `require.cache` before the module is loaded, and `node --test` gives each file its own
 * process, which keeps them from leaking anywhere else.
 *
 * The contract being pinned down: an `ETXNESCAPED` read is a tool ERROR (the caller must
 * stop and look at the database), but the rows the batch returned travel with it - they
 * are usually the batch's own diagnostic log, and throwing them away was part of the
 * original damage.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

function install(modulePath, exports) {
  const resolved = require.resolve(modulePath);
  require(resolved);
  require.cache[resolved].exports = exports;
}

let streamReadImpl = async () => {
  throw new Error("streamReadImpl not set");
};

install("../src/db/pools", { getPool: async () => ({}) });
install("../src/config", {
  getConfig: () => ({
    dbKey: "produccion",
    config: { database: "AHORA_ERP" },
  }),
});
const safety = require("../src/db/safety");
install("../src/db/safety", {
  ...safety,
  streamRead: (...args) => streamReadImpl(...args),
});

const { handler } = require("../src/tools/execute-read-query");

test("an ETXNESCAPED read comes back as a tool error that still carries the rows", async () => {
  streamReadImpl = async () => {
    throw safety.escapedTransactionError(
      new Error(
        "Transaction count after EXECUTE indicates a mismatching number of BEGIN and COMMIT statements. Previous count = 1, current count = 0."
      ),
      {
        rows: [{ log: "factura 1: vencimientos generados" }],
        totalSeen: 1,
        truncated: false,
      }
    );
  };

  const out = await handler(
    { query: "EXEC dbo.PRepara", limit: 100, offset: 0 },
    {}
  );
  assert.equal(out.isError, true, "the caller has to stop and look");
  assert.equal(
    out.structuredContent,
    undefined,
    "an error result is not checked against the output schema, so it carries none"
  );
  assert.match(out.content[0].text, /closed from INSIDE the batch/);
  assert.match(out.content[0].text, /already COMMITTED/);
  assert.match(out.content[0].text, /Transaction count after EXECUTE/);
  assert.match(
    out.content[1].text,
    /^Rows the batch returned before this was detected: /
  );
  const rows = JSON.parse(out.content[1].text.replace(/^[^{]*/, ""));
  assert.deepEqual(rows.recordset, [
    { log: "factura 1: vencimientos generados" },
  ]);
  assert.equal(rows.rowCount, 1);
  assert.equal(rows.totalRowsSeen, 1);
  assert.equal(rows.db, "AHORA_ERP");
  assert.equal(rows.dbKey, "produccion");
});

test("an ETXNESCAPED read with no rows at all still reports an empty recordset", async () => {
  streamReadImpl = async () => {
    throw safety.escapedTransactionError(null, undefined);
  };
  const out = await handler(
    { query: "EXEC dbo.PRepara", limit: 100, offset: 0 },
    {}
  );
  assert.equal(out.isError, true);
  const rows = JSON.parse(out.content[1].text.replace(/^[^{]*/, ""));
  assert.deepEqual(rows.recordset, []);
  assert.equal(rows.rowCount, 0);
});

test("any other failure is thrown, as before", async () => {
  streamReadImpl = async () => {
    throw new Error("Invalid column name 'Enabled'.");
  };
  await assert.rejects(
    () =>
      handler({ query: "SELECT Enabled FROM t", limit: 100, offset: 0 }, {}),
    /Invalid column name 'Enabled'/
  );
});

test("a normal read is untouched", async () => {
  streamReadImpl = async () => ({
    rows: [{ x: 1 }],
    totalSeen: 1,
    truncated: false,
  });
  const out = await handler(
    { query: "SELECT 1 AS x", limit: 100, offset: 0 },
    {}
  );
  assert.equal(out.isError, undefined);
  assert.deepEqual(out.structuredContent.recordset, [{ x: 1 }]);
  assert.equal(out.structuredContent.dbKey, "produccion");
});
