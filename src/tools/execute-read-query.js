const { z } = require("zod");
const { getConfig } = require("../config");
const { getPool } = require("../db/pools");
const { streamRead } = require("../db/safety");
const {
  paginationShape,
  dbKeyShape,
  timeoutMsShape,
  queryString,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_QUERY_LEN,
} = require("../validation");

const inputShape = {
  query: queryString.describe(
    "Read-only SQL query. Wrapped in a rollback-only transaction, so any incidental writes are discarded. " +
      "Results are streamed and the underlying request is cancelled once `offset + limit` rows have been seen - " +
      "so even a naive `SELECT *` against a huge table will not load the full recordset into memory. " +
      `At most ${MAX_QUERY_LEN} characters: a longer script belongs in a .sql file run with execute_sql_file.`
  ),
  ...dbKeyShape,
  ...paginationShape,
  ...timeoutMsShape,
};

/**
 * The one failure that must NOT look like "nothing happened".
 *
 * `ETXNESCAPED` means a trigger or procedure inside the batch ran ROLLBACK TRANSACTION,
 * the rollback-only wrapper is gone and whatever ran after that point is committed. The
 * warning goes out as a tool error so the caller stops and looks, but the rows the batch
 * returned go with it: in a repair script they are the batch's own diagnostic log, and
 * discarding them (which is what surfacing only error 266 used to do) made the damage
 * harder to assess, not easier.
 */
function escapedTransactionResult(err, { db, dbKey }) {
  const result = err.result || { rows: [], totalSeen: 0, truncated: false };
  const structured = {
    db,
    dbKey,
    rowCount: result.rows.length,
    totalRowsSeen: result.totalSeen,
    truncated: result.truncated,
    recordset: result.rows,
  };
  return {
    content: [
      { type: "text", text: err.message },
      {
        type: "text",
        text:
          "Rows the batch returned before this was detected: " +
          JSON.stringify(structured, null, 2),
      },
    ],
    isError: true,
  };
}

const outputShape = {
  db: z.string(),
  dbKey: z.string(),
  rowCount: z.number().int().nonnegative(),
  totalRowsSeen: z.number().int().nonnegative(),
  truncated: z.boolean(),
  recordset: z.array(z.record(z.unknown())),
};

async function handler({ query, dbKey, limit, offset, timeoutMs }, extra) {
  const { dbKey: actualKey, config } = getConfig(dbKey);
  const pool = await getPool(actualKey, config);
  let read;
  try {
    read = await streamRead(pool, query, {
      offset,
      limit,
      timeoutMs,
      signal: extra?.signal,
    });
  } catch (err) {
    if (err.code === "ETXNESCAPED") {
      return escapedTransactionResult(err, {
        db: config.database,
        dbKey: actualKey,
      });
    }
    throw err;
  }
  const { rows, totalSeen, truncated } = read;
  const structured = {
    db: config.database,
    dbKey: actualKey,
    rowCount: rows.length,
    totalRowsSeen: totalSeen,
    truncated,
    recordset: rows,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

module.exports = {
  name: "execute_read_query",
  config: {
    title: "Execute Read Query",
    description:
      "Run a SELECT-style SQL query against a configured database. The query executes inside a transaction " +
      "that is ALWAYS rolled back, so accidental DML/DDL is non-durable (this is a guardrail, not a sandbox: " +
      "an explicit `COMMIT TRANSACTION` in the query string ends the wrapper and following writes will persist - " +
      "rely on a least-privilege SQL login for real isolation). The same happens when a stored procedure or a " +
      "trigger fired by the query runs `ROLLBACK TRANSACTION` on its own (the usual trigger `ROLLBACK TRAN`, or " +
      "`IF @@TRANCOUNT > 0 ROLLBACK` in a CATCH block): the wrapper is gone, and any statement the batch runs " +
      "after that point is autocommitted. The tool detects it and fails with an explicit warning (code " +
      'ETXNESCAPED) that still carries the rows returned so far - never treat that as "nothing happened". ' +
      "If your SQL calls procedures or can fire triggers, make it stop when the transaction disappears: " +
      "SET XACT_ABORT ON, TRY/CATCH, check @@TRANCOUNT after every EXEC and RETURN when it is 0, and do not " +
      "write from a CATCH block. Results are streamed; the server cancels the " +
      "underlying request once `offset + limit` rows have been seen, so `truncated:true` means more rows exist. " +
      `\`timeoutMs\` (${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}) overrides the 30 s default for a query that is ` +
      "legitimately slow. If the rollback cannot be completed the connection is closed and dropped from the " +
      "pool instead of leaking its open transaction into an unrelated call, and the error says so - retry, " +
      "and the next call gets a clean connection.",
    inputSchema: inputShape,
    outputSchema: outputShape,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  handler,
};
