const { z } = require("zod");

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;
const MAX_QUERY_LEN = 10000;

// Limits for `execute_sql_file`. A .sql file is not bound by MAX_QUERY_LEN: that
// 10 KB cap on inline SQL is exactly what passing a path is meant to sidestep.
// 2 MB covers any hand-written script, including SSMS's UTF-16 (2 bytes/char).
const MAX_SQL_FILE_BYTES = 2_000_000;
const MAX_BATCHES = 500;
const MAX_BATCH_REPEAT = 100;

const tableIdentifier = z
  .string()
  .min(1)
  .max(260)
  .regex(/^[a-zA-Z0-9_#$@]+(?:\.[a-zA-Z0-9_#$@]+)?$/, {
    message:
      "Use bare or `schema.table` identifiers - only alphanumerics, underscore, #, $, @",
  });

const dbKeyShape = {
  dbKey: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-zA-Z0-9_]+$/, {
      message: "dbKey must be alphanumeric/underscore",
    })
    .optional()
    .describe(
      "Database key (lowercased). Optional in single-database mode. Call `list_databases` to discover valid keys."
    ),
};

// Bounds for the per-call `timeoutMs`. The pool-wide `requestTimeout` is 30 s, which is
// not always enough: a legitimate DELETE on a hub table with 41 `ON DELETE CASCADE`
// foreign keys does not fit, and with no per-call override there was no way to run it at
// all. Bounded on both ends on purpose - below a second nothing real completes, and ten
// minutes is already far past what a client will wait for.
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;

const timeoutMsShape = {
  timeoutMs: z
    .number()
    .int()
    .min(MIN_TIMEOUT_MS)
    .max(MAX_TIMEOUT_MS)
    .optional()
    .describe(
      `Per-call request timeout in milliseconds (${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}). ` +
        "Omit to use the server-wide default of 30000. Raise it for a statement that is " +
        "legitimately slow (a cascading DELETE, a large index rebuild) rather than " +
        "letting it be cancelled halfway."
    ),
};

// Default for `execute_sql_file`, which does NOT inherit the 30 s above.
//
// That 30 s is a per-BATCH budget, and a deployment script is a pile of batches: the
// one that runs out is never the CREATE PROCEDURE (milliseconds) but the CREATE INDEX
// or the data MERGE behind it, which land squarely in the 30-70 s band. The script
// then dies halfway and the whole transaction rolls back, so the cost of being too
// tight here is the entire deployment, not one slow statement. 90 s clears that band
// with room to spare and is still far below what an MCP client waits for a tool call.
const SQL_FILE_TIMEOUT_MS = 90000;

const sqlFileTimeoutMsShape = {
  timeoutMs: z
    .number()
    .int()
    .min(MIN_TIMEOUT_MS)
    .max(MAX_TIMEOUT_MS)
    .default(SQL_FILE_TIMEOUT_MS)
    .describe(
      `Per-batch request timeout in milliseconds (${MIN_TIMEOUT_MS}..${MAX_TIMEOUT_MS}). ` +
        `Default ${SQL_FILE_TIMEOUT_MS}. It applies to EACH batch, not to the script as a ` +
        "whole, so a long script is not penalised for being long - only a single slow " +
        "batch is. Raise it for a script with a heavy index rebuild or data migration."
    ),
};

const paginationShape = {
  limit: z
    .number()
    .int()
    .positive()
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(`Max rows to return (1..${MAX_LIMIT}).`),
  offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Row offset for pagination."),
};

const queryString = z.string().min(1).max(MAX_QUERY_LEN);

const sqlFilePath = z
  .string()
  .min(1)
  .max(500)
  .refine((s) => s.indexOf(String.fromCharCode(0)) === -1, {
    message: "path must not contain NUL characters",
  });

const resourceUri = z
  .string()
  .regex(
    /^mssql:\/\/[a-zA-Z0-9_]+@[a-zA-Z0-9_#$@]+(?:\.[a-zA-Z0-9_#$@]+)?\/data$/,
    {
      message:
        "URI must match mssql://<dbKey>@<table>/data or mssql://<dbKey>@<schema>.<table>/data",
    }
  );

module.exports = {
  tableIdentifier,
  dbKeyShape,
  paginationShape,
  timeoutMsShape,
  sqlFileTimeoutMsShape,
  queryString,
  sqlFilePath,
  resourceUri,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  SQL_FILE_TIMEOUT_MS,
  MAX_QUERY_LEN,
  MAX_SQL_FILE_BYTES,
  MAX_BATCHES,
  MAX_BATCH_REPEAT,
};
