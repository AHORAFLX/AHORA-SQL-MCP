const test = require("node:test");
const assert = require("node:assert/strict");

const tools = require("../src/tools");

test("registerAll registers every tool module exactly once", () => {
  const seen = [];
  const fakeServer = {
    registerTool(name, config, handler) {
      seen.push({
        name,
        hasConfig: typeof config === "object",
        hasHandler: typeof handler === "function",
      });
      assert.ok(config.description, `${name} should have a description`);
      assert.ok(config.annotations, `${name} should have annotations`);
      assert.ok(
        ["boolean"].includes(typeof config.annotations.readOnlyHint),
        `${name} annotations should include readOnlyHint`
      );
    },
  };
  tools.registerAll(fakeServer);
  assert.equal(seen.length, 12);
  const names = seen.map((s) => s.name).sort();
  assert.deepEqual(names, [
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
  ]);
});

test("execute_write_query rejects before connecting when writes disabled", async () => {
  const prev = process.env.MSSQL_ENABLE_WRITES;
  delete process.env.MSSQL_ENABLE_WRITES;
  try {
    const { handler } = require("../src/tools/execute-write-query");
    await assert.rejects(
      () => handler({ query: "INSERT INTO x VALUES (1)" }, {}),
      /writes are disabled/i
    );
  } finally {
    if (prev !== undefined) process.env.MSSQL_ENABLE_WRITES = prev;
  }
});

test("execute_sql_file rejects before touching disk or DB when writes disabled", async () => {
  const prev = process.env.MSSQL_ENABLE_WRITES;
  delete process.env.MSSQL_ENABLE_WRITES;
  try {
    const { handler } = require("../src/tools/execute-sql-file");
    // The path does not exist: the writes gate has to fire before any file access,
    // so the error must be about writes and not about a missing file.
    await assert.rejects(
      () => handler({ path: "does-not-exist.sql", dryRun: false }, {}),
      /needs writes enabled/i
    );
  } finally {
    if (prev !== undefined) process.env.MSSQL_ENABLE_WRITES = prev;
  }
});

test("execute_sql_file allows dryRun when writes are disabled", async () => {
  const prev = process.env.MSSQL_ENABLE_WRITES;
  delete process.env.MSSQL_ENABLE_WRITES;
  try {
    const { handler } = require("../src/tools/execute-sql-file");
    // dryRun gets past the writes gate, so this fails on the path instead.
    await assert.rejects(
      () => handler({ path: "does-not-exist.sql", dryRun: true }, {}),
      /not found/i
    );
  } finally {
    if (prev !== undefined) process.env.MSSQL_ENABLE_WRITES = prev;
  }
});

test("execute_write_query: a per-dbKey MSSQL_<DBKEY>_ENABLE_WRITES enables just that database", async () => {
  const prevGlobal = process.env.MSSQL_ENABLE_WRITES;
  const prevPerDb = process.env.MSSQL_DATA_ENABLE_WRITES;
  delete process.env.MSSQL_ENABLE_WRITES;
  process.env.MSSQL_DATA_ENABLE_WRITES = "true";
  try {
    const { handler } = require("../src/tools/execute-write-query");
    // The 'config' dbKey has no override and the global flag is off: rejected
    // before ever resolving the connection, same as the global-off case.
    await assert.rejects(
      () => handler({ query: "INSERT INTO x VALUES (1)", dbKey: "config" }, {}),
      /writes are disabled for 'config'/i
    );
  } finally {
    if (prevGlobal !== undefined) process.env.MSSQL_ENABLE_WRITES = prevGlobal;
    else delete process.env.MSSQL_ENABLE_WRITES;
    if (prevPerDb !== undefined) process.env.MSSQL_DATA_ENABLE_WRITES = prevPerDb;
    else delete process.env.MSSQL_DATA_ENABLE_WRITES;
  }
});

test("execute_sql_file: a per-dbKey override is reported in the rejection message", async () => {
  const prevGlobal = process.env.MSSQL_ENABLE_WRITES;
  delete process.env.MSSQL_ENABLE_WRITES;
  try {
    const { handler } = require("../src/tools/execute-sql-file");
    await assert.rejects(
      () => handler({ path: "does-not-exist.sql", dryRun: false, dbKey: "config" }, {}),
      /needs writes enabled for 'config'/i
    );
  } finally {
    if (prevGlobal !== undefined) process.env.MSSQL_ENABLE_WRITES = prevGlobal;
    else delete process.env.MSSQL_ENABLE_WRITES;
  }
});

test("every tool module exports { name, config, handler }", () => {
  for (const mod of tools.modules) {
    assert.equal(typeof mod.name, "string");
    assert.equal(typeof mod.config, "object");
    assert.equal(typeof mod.handler, "function");
    assert.match(
      mod.name,
      /^[a-z][a-z0-9_]*$/,
      "tool names must be snake_case"
    );
  }
});
