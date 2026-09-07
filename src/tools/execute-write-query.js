const { z } = require("zod");
const { getConfig } = require("../config");
const { getPool } = require("../db/pools");
const {
  runWrite,
  writesEnabled,
  NON_TRANSACTIONAL_STATEMENTS,
} = require("../db/safety");
const {
  dbKeyShape,
  timeoutMsShape,
  queryString,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
} = require("../validation");

const inputShape = {
  query: queryString.describe(
    "Mutating SQL (INSERT/UPDATE/DELETE/MERGE/DDL). Disabled unless MSSQL_ENABLE_WRITES=true. " +
      "Runs in ONE explicit transaction by default, so a multi-statement batch is all-or-nothing. " +
      "`GO` separators are honoured, as in a .sql file."
  ),
  ...dbKeyShape,
  ...timeoutMsShape,
  transactional: z
    .boolean()
    .default(true)
    .describe(
      "Keep true unless the statement is one SQL Server refuses to run inside a transaction " +
        `(${NON_TRANSACTIONAL_STATEMENTS}). false gives up all-or-nothing: a failure halfway ` +
        "through leaves the earlier statements committed, and the error lists which ones."
    ),
};

const statementShape = z.object({
  index: z.number().int().nonnegative(),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  preview: z.string(),
  rowsAffected: z.array(z.number().int().nonnegative()).optional(),
  recordsetCount: z.number().int().nonnegative().optional(),
});

const outputShape = {
  db: z.string(),
  dbKey: z.string(),
  rowsAffected: z.array(z.number().int().nonnegative()),
  transactional: z.boolean(),
  committed: z.boolean(),
  statementCount: z.number().int().nonnegative(),
  statements: z.array(statementShape),
  message: z.string(),
};

async function handler({ query, dbKey, timeoutMs, transactional = true }, extra) {
  if (!writesEnabled(process.env, dbKey)) {
    throw new Error(
      dbKey
        ? `writes are disabled for '${dbKey}'. Set MSSQL_${String(dbKey).toUpperCase()}_ENABLE_WRITES=true ` +
          "to enable them for this database, or MSSQL_ENABLE_WRITES=true for every database."
        : "writes are disabled. Set MSSQL_ENABLE_WRITES=true to enable execute_write_query."
    );
  }
  const { dbKey: actualKey, config } = getConfig(dbKey);
  const pool = await getPool(actualKey, config);
  const result = await runWrite(pool, query, {
    signal: extra?.signal,
    writesEnabled: true,
    transactional,
    timeoutMs,
  });
  const count = result.statements.length;
  const structured = {
    db: config.database,
    dbKey: actualKey,
    rowsAffected: result.rowsAffected,
    transactional: result.transactional,
    committed: result.committed,
    statementCount: count,
    statements: result.statements,
    message: result.transactional
      ? `Executed ${count} statement(s) in one transaction and committed.`
      : `Executed ${count} statement(s) in autocommit (transactional:false).`,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

module.exports = {
  name: "execute_write_query",
  config: {
    title: "Execute Write Query",
    description:
      "Run a mutating SQL statement. DISABLED unless MSSQL_ENABLE_WRITES=true (all databases) or " +
      "MSSQL_<DBKEY>_ENABLE_WRITES=true (just that `dbKey`). " +
      "There is no keyword denylist - the database user's grants are the source of truth. " +
      "Use a least-privilege account for the relevant `dbKey`. " +
      "The whole query runs in ONE explicit transaction and is all-or-nothing, like `execute_sql_file`: " +
      "if any part fails, nothing is applied and the error says so per statement. " +
      `Set \`transactional:false\` for the statements that cannot run inside a transaction (${NON_TRANSACTIONAL_STATEMENTS}); ` +
      "that gives up atomicity, and the error then lists exactly which statements were already committed. " +
      `\`timeoutMs\` (${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}) overrides the 30 s default - needed for a ` +
      "legitimately slow statement such as a DELETE that cascades over dozens of foreign keys.",
    inputSchema: inputShape,
    outputSchema: outputShape,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  handler,
};
