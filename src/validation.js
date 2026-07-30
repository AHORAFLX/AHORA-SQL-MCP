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
  queryString,
  sqlFilePath,
  resourceUri,
  MAX_LIMIT,
  DEFAULT_LIMIT,
  MAX_QUERY_LEN,
  MAX_SQL_FILE_BYTES,
  MAX_BATCHES,
  MAX_BATCH_REPEAT,
};
