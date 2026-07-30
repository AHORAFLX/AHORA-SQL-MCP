# AHORA-SQL-MCP — Technical Reference

Reference for the MCP server itself: environment model, tool catalog, resources, prompts,
architecture and security model. For installation and the `.mcp.json` used in AHORA projects,
see the [README](../README.md).

A Node.js Model Context Protocol server for Microsoft SQL Server. Exposes a configured database
(or set of databases) to an MCP client via 12 introspection and query tools, table resources and
guided prompts, over stdio.

Read-only by default. `MSSQL_ENABLE_WRITES=true` opts into `execute_write_query` and
`execute_sql_file`.

> In AHORA projects you never set these variables by hand: `bin/start-mssql-mcp.js` derives them
> from the project's `Web.config` / `appsettings.json` and always exports `MSSQL_ENABLE_WRITES`
> explicitly. This document describes the contract the wrapper produces.

### Where the wrapper gets the connection from

Exactly one source, chosen by flags — mixing them is a startup error, because there is no
precedence order anyone could guess from reading a `.mcp.json`:

| Source | Flags | Notes |
| --- | --- | --- |
| `Web.config` (.NET Framework) | `--config-file` + `--connection-name` | Section-scoped parsing of `<connectionStrings>`; follows `configSource` to an external file; `<clear/>`, `<remove/>` and non-self-closing `<add></add>` all handled. |
| `appsettings.json` (.NET Core) | `--config-file` + `--connection-name` | ASP.NET Core overlay: `appsettings.<env>.json` wins over `appsettings.json`. **An empty string counts as absent**, which is exactly how Flexygo Core declares them. Env from `--environment`, else `ASPNETCORE_ENVIRONMENT`, else `Development`. Section and connection names are matched case-insensitively; a BOM is tolerated. `--config-file` also accepts the containing folder. |
| Loose ADO string | `--connection-string` (repeatable, `--alias` each when >1) | No config file needed. Password ends up in argv. |
| Loose values | `--server --database --user --password` (+ `--encrypt`, `--trust-server-certificate`) | Same caveat. |
| Client environment | `--from-env` | Takes the inherited `MSSQL_*` connection variables instead of argv, so credentials live in the client's `env` block. The only exception to env sanitizing — and `MSSQL_ENABLE_WRITES` / `MSSQL_SQL_DIRS` are still overwritten, so the environment can never enable writes. |
| Credentials file | `--credentials-file <ruta>` | A JSON **outside the repository** (the installer writes it under `%APPDATA%\ahora-sql-mcp\`). For projects with no config file: `.mcp.json` gets committed, so credentials must not live there — only the path does. Flat shape for one DB, or `{"connections": {"<dbKey>": {...}}}` for several. |

### The installer's connection probe

Both installer front-ends **actually connect** before writing anything, via
`installer/probe.js`, which runs the values through the same pipeline the server will use
(`applyConnection` → `MSSQL_*` → `loadConfigsFromEnv` → `ConnectionPool`) and then issues
`SELECT DB_NAME()`. If it connects there, it connects at runtime.

This matters most with no config file: the values were typed by a human, so the usual failure is a
typo, and field-presence checks catch none of them. A failed probe is a *result*, not an exception —
the DB may legitimately be unreachable (VPN, stopped SQL Browser), so the installer reports it and
requires an explicit confirmation to continue. Timeout is bounded (8 s) so a wrong host cannot stall
a training session, and the password is stripped from any error message.

### Production guardrail

`--production` marks the connection and is **incompatible with `--allow-writes`**: passing both aborts
at startup. The point is that the decision is taken once, when configuring, and then enforced —
someone adding `--allow-writes` to a production `.mcp.json` later gets a hard failure rather than a
warning they can ignore. The banner shows `· PRODUCCION`.

ADO keywords are normalized by lowercasing **and removing spaces**, so
`Trust Server Certificate` (the form Core writes) and `TrustServerCertificate` (the form Framework
writes) are the same key. Without that, the Core spelling was silently dropped and the setting
never reached tedious.

## Configuration model

Two modes; the server auto-detects from the environment:

1. **Single-database** — `MSSQL_*` variables, exposed as `dbKey="maindb"`
2. **Multi-database** — `MSSQL_<NAME>_*` variables, one config per `<NAME>` (lowercased)

### Single-database mode

```ini
MSSQL_SERVER=your_sql_server_address
MSSQL_PORT=1433
MSSQL_USER=your_username
MSSQL_PASSWORD=your_password
MSSQL_DATABASE=your_database_name
MSSQL_ENCRYPT=true
MSSQL_TRUST_SERVER_CERTIFICATE=false
```

### Multi-database mode

```ini
MSSQL_CONFIG_SERVER=...
MSSQL_CONFIG_USER=...
MSSQL_CONFIG_PASSWORD=...
MSSQL_CONFIG_DATABASE=flexygo_config_db
MSSQL_CONFIG_ENCRYPT=true
MSSQL_CONFIG_TRUST_SERVER_CERTIFICATE=false

MSSQL_DATA_SERVER=...
MSSQL_DATA_USER=...
MSSQL_DATA_PASSWORD=...
MSSQL_DATA_DATABASE=flexygo_data_db
MSSQL_DATA_ENCRYPT=true
MSSQL_DATA_TRUST_SERVER_CERTIFICATE=false
```

Any name works the same way — `MSSQL_ANALYTICS_*` exposes `dbKey="analytics"`. Per-database
credentials fall back to the global `MSSQL_USER` / `MSSQL_PASSWORD` / `MSSQL_SERVER` if omitted.

> Configure **either** single-database **or** multi-database variables, not both. If any
> `MSSQL_<NAME>_DATABASE` is present, multi-db wins.

### Write opt-in

```ini
MSSQL_ENABLE_WRITES=true   # enables execute_write_query and execute_sql_file; defaults to false
```

When disabled, `execute_write_query` returns an error before any connection attempt, and
`execute_sql_file` only accepts `dryRun:true`. `execute_read_query` always runs inside a
transaction that is rolled back regardless of outcome, so accidental writes inside a "read" query
are non-durable.

For real safety, also give the configured DB user only the grants you intend it to have — least
privilege is the source of truth, not the tool split.

### SQL file access opt-in

```ini
MSSQL_SQL_DIRS=C:\Codigo GIT\skills;D:\scripts   # extra roots for execute_sql_file
```

`execute_sql_file` always accepts files under the **project folder** — the server's working
directory, which is the project root when Claude Code launches it from `.mcp.json`. Nothing needs
configuring for that case. `MSSQL_SQL_DIRS` (a `path.delimiter`-separated list, set by
`--allow-sql-dir`) adds roots outside it. Every path is compared after `realpath`, so symlinks and
`..` cannot walk out of an allowed root.

## Environment variables

There is no `.env` support: the process reads its configuration from the environment it is
launched with, and nothing else. See the [README](../README.md) for the reasoning.

### Database connection (used by the MCP server)

| Variable                                | Mode   | Required     | Default       | Notes                                                                                                         |
| --------------------------------------- | ------ | ------------ | ------------- | ------------------------------------------------------------------------------------------------------------- |
| `MSSQL_SERVER`                          | single | yes          | `localhost`   | Hostname or IP.                                                                                               |
| `MSSQL_PORT`                            | single | no           | mssql default | Coerced to integer.                                                                                           |
| `MSSQL_USER`                            | single | yes          | -             | Login name.                                                                                                   |
| `MSSQL_PASSWORD`                        | single | yes          | -             | -                                                                                                             |
| `MSSQL_DATABASE`                        | single | yes          | -             | Exposed as `dbKey="maindb"`.                                                                                  |
| `MSSQL_ENCRYPT`                         | single | no           | `false`       | Set `true` to encrypt the connection.                                                                         |
| `MSSQL_TRUST_SERVER_CERTIFICATE`        | single | no           | `true`        | Set `false` to enforce certificate validation.                                                                |
| `MSSQL_<NAME>_SERVER`                   | multi  | no           | global        | Falls back to `MSSQL_SERVER` if omitted.                                                                      |
| `MSSQL_<NAME>_PORT`                     | multi  | no           | mssql default | -                                                                                                             |
| `MSSQL_<NAME>_USER`                     | multi  | no           | global        | Falls back to `MSSQL_USER`.                                                                                   |
| `MSSQL_<NAME>_PASSWORD`                 | multi  | no           | global        | Falls back to `MSSQL_PASSWORD`.                                                                               |
| `MSSQL_<NAME>_DATABASE`                 | multi  | yes (per DB) | -             | Presence of any `_DATABASE` switches the server into multi-db mode. Exposed as `dbKey="<name>"` (lowercased). |
| `MSSQL_<NAME>_ENCRYPT`                  | multi  | no           | `false`       | -                                                                                                             |
| `MSSQL_<NAME>_TRUST_SERVER_CERTIFICATE` | multi  | no           | `true`        | -                                                                                                             |

### Server behavior

| Variable              | Required | Default | Effect                                                                                                                                            |
| --------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MSSQL_ENABLE_WRITES` | no       | `false` | When `true`, `execute_write_query` and `execute_sql_file` are allowed to run. With it unset/false, both error out before any connection attempt.   |
| `MSSQL_SQL_DIRS`      | no       | -       | Extra roots `execute_sql_file` may read from, separated by `path.delimiter`. The project folder (the server's cwd) is always allowed on top of it. |

### Integration script (`scripts/integration.js`, never read by the server)

| Variable              | Required | Default     | Notes                                          |
| --------------------- | -------- | ----------- | ---------------------------------------------- |
| `MSSQL_TEST_SERVER`   | no       | `localhost` | Target SQL Server (Docker, LocalDB, anywhere). |
| `MSSQL_TEST_PORT`     | no       | `1433`      | -                                              |
| `MSSQL_TEST_USER`     | no       | `sa`        | -                                              |
| `MSSQL_TEST_PASSWORD` | yes      | -           | The script exits 2 without it.                 |

## Transport

stdio only: `npm start` runs `src/index.js` and the MCP client spawns it as a subprocess. There is
no HTTP transport — see the [README](../README.md) for the reasoning.

## Tool catalog

All tools accept an optional `dbKey`. In single-database mode the default is `maindb`; in
multi-database mode it's the first key loaded.

Every tool returns both human-readable `content` (JSON text) and parsed `structuredContent` (the
same payload as a typed object).

### Query tools

| Tool                  | Annotations          | Notes                                                                                                                                                                          |
| --------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `execute_read_query`  | readOnly, idempotent | Streamed, rollback-only. Server cancels after `offset + limit` rows. Inputs: `query`, optional `dbKey`, `limit` (≤1000, default 100), `offset`.                                |
| `execute_write_query` | destructive          | Requires `MSSQL_ENABLE_WRITES=true`. Inputs: `query`, optional `dbKey`.                                                                                                        |
| `execute_sql_file`    | destructive          | `sqlcmd -i` equivalent: splits a .sql file on `GO` and runs it. Requires `MSSQL_ENABLE_WRITES=true` unless `dryRun:true`. Inputs: `path`, optional `dbKey`, `dryRun`, `maxRowsPerBatch`. |

#### `execute_sql_file`

The way to deploy a script: no 10k character cap, `GO` separators handled, and the file is read
from disk instead of being retyped into a tool argument.

- **Path policy** — the file must sit under the project folder (the server's cwd) or under a root
  in `MSSQL_SQL_DIRS`. Relative paths resolve against the project folder. Only `.sql`; max 2 MB and
  500 batches.
- **Encoding** — BOM-driven: UTF-8, UTF-8 BOM, UTF-16LE BOM (the SSMS default) and UTF-16BE BOM.
  BOM-less UTF-16 is rejected rather than sent to the server as NUL-riddled text.
- **Splitting** — `GO` is recognized only when it is the whole line (a trailing `--` comment and a
  `GO n` repeat count are allowed). A `GO` inside a string literal, a bracketed identifier or a
  line/block comment is not a separator.
- **One transaction, one connection** — all batches run in a single `mssql.Transaction`. This is a
  correctness requirement, not just atomicity: a `Request` built on the pool acquires and releases a
  connection per `.batch()`, so batches would otherwise land on different connections and `GO`
  semantics would break (`SET ANSI_NULLS ON` would not apply to the following `CREATE PROCEDURE`, a
  `#temp` from batch 1 would be gone in batch 2). Consequence: statements that cannot run inside a
  transaction (`CREATE`/`ALTER DATABASE`, `BACKUP`, `CREATE FULLTEXT INDEX`) are unsupported.
- **Errors name a file line** — tedious reports `lineNumber` relative to the batch it sent; the tool
  adds the batch's start line back, so the message points at `file:line`. The transaction is rolled
  back, so a failed script applies nothing.
- **`USE` is rejected** at the start of a batch: it would retarget a pooled connection and leak into
  later calls. Use `dbKey`.
- **Session options are scrubbed** before commit (`ANSI_NULLS`, `ANSI_PADDING`, `ANSI_WARNINGS`,
  `ANSI_NULL_DFLT_ON`, `ARITHABORT`, `CONCAT_NULL_YIELDS_NULL`, `QUOTED_IDENTIFIER`,
  `NUMERIC_ROUNDABORT`) because a script's `SET` survives on the pooled connection. It is a
  pragmatic scrub of what scripts actually touch, not a real connection reset.
- **`dryRun:true`** parses and reports the batches (`index`, `startLine`, `endLine`, `repeat`,
  `preview`) without opening a pool. It is the only mode available on a read-only server.

### Catalog (paginated)

| Tool                     | Inputs                              |
| ------------------------ | ----------------------------------- |
| `list_databases`         | -                                   |
| `describe_database`      | optional `dbKey`                    |
| `list_tables`            | optional `dbKey`, `limit`, `offset` |
| `list_views`             | optional `dbKey`, `limit`, `offset` |
| `list_stored_procedures` | optional `dbKey`, `limit`, `offset` |

### Per-object inspection

| Tool                 | Inputs                                             |
| -------------------- | -------------------------------------------------- |
| `describe_table`     | `table` (bare or `schema.table`), optional `dbKey` |
| `describe_procedure` | `procedure`, optional `dbKey`                      |
| `list_indexes`       | `table`, optional `dbKey`                          |
| `list_foreign_keys`  | optional `table` (whole-DB if omitted), `dbKey`    |

### Example: `execute_read_query`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "execute_read_query",
    "arguments": {
      "query": "SELECT TOP 5 * FROM dbo.Users",
      "dbKey": "maindb",
      "limit": 5
    }
  }
}
```

Result `structuredContent`:

```json
{
  "db": "your_database",
  "dbKey": "maindb",
  "rowCount": 5,
  "totalRowsReturnedByQuery": 5,
  "truncated": false,
  "recordset": [{ "id": 1, "name": "Item1", "created_at": "2025-01-01" }]
}
```

## Resources

The server exposes one resource template:

```
mssql://<dbKey>@<schema>.<table>/data
```

Reading the resource returns the first 100 rows as CSV with a leading `# Database: <name>`
comment. `resources/list` enumerates every base table across every configured `dbKey` (capped at
500 tables per DB to bound the response).

## Prompts

| Prompt             | Args                      | Purpose                                                      |
| ------------------ | ------------------------- | ------------------------------------------------------------ |
| `explore_database` | optional `dbKey`          | Step-by-step instructions for surveying an unknown database. |
| `summarize_table`  | `table`, optional `dbKey` | Produces a column/index/FK/sample-rows brief on one table.   |

## Running it without the wrapper

The wrapper exists so credentials stay in the project's config file instead of in `.mcp.json`.
For a one-off outside an AHORA project you can point a client at `src/index.js` directly and pass
the variables in `env`:

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": ["<PATH>/AHORA-SQL-MCP/src/index.js"],
      "env": {
        "MSSQL_SERVER": "your_server_name",
        "MSSQL_PORT": "1433",
        "MSSQL_USER": "your_username",
        "MSSQL_PASSWORD": "your_password",
        "MSSQL_DATABASE": "your_database",
        "MSSQL_ENCRYPT": "true",
        "MSSQL_TRUST_SERVER_CERTIFICATE": "false",
        "MSSQL_ENABLE_WRITES": "false"
      }
    }
  }
}
```

This puts credentials in a file that tends to get committed. Prefer the wrapper.

## Architecture

```
bin/
└── start-mssql-mcp.js    # AHORA policy layer: config file -> env, read/write mode
installer/
├── setup.js              # guided installer (MCP config only): terminal wizard + entry point
├── gui.js                # same logic behind a local self-contained HTML form
├── probe.js              # real connection test, through the server's own pipeline
├── credentials.js        # credentials file outside the repo (%APPDATA%)
├── exe-entry.js          # entry for the packaged exe (no require.main there)
├── build-exe.js          # Node SEA build -> dist/ahora-setup.exe
└── INSTALAR-AHORA.cmd    # double-click launcher, no binary
src/
├── index.js              # stdio entry
├── server.js             # McpServer factory
├── config.js             # env -> validated connection configs
├── validation.js         # shared Zod shapes
├── resources.js          # ResourceTemplate registration
├── prompts.js            # MCP prompts
├── db/
│   ├── pools.js          # per-dbKey ConnectionPool cache
│   ├── safety.js         # runRead (rollback-only) + runWrite (gated)
│   └── introspection.js  # parameterized INFORMATION_SCHEMA / sys.* queries
├── sql/
│   ├── batches.js        # BOM decoding + GO splitting (pure, no I/O)
│   └── files.js          # allowed-roots policy for execute_sql_file
└── tools/
    ├── index.js          # tool barrel
    ├── execute-read-query.js
    ├── execute-write-query.js
    ├── execute-sql-file.js
    ├── list-databases.js
    ├── describe-database.js
    ├── list-tables.js
    ├── list-views.js
    ├── list-indexes.js
    ├── list-foreign-keys.js
    ├── list-stored-procedures.js
    ├── describe-table.js
    └── describe-procedure.js
```

### Security model

- **Read isolation** — `execute_read_query` and every `list_*`/`describe_*` tool runs inside a
  transaction that is always rolled back. This is a **guardrail against accidental writes** (a
  `SELECT ... INTO new_table`, an INSERT smuggled past a comment), not a sandbox against an
  adversarial query: an explicit `COMMIT TRANSACTION` inside the user's SQL ends the outer
  transaction, and following statements run in autocommit mode. Use a least-privilege SQL login if
  you need real isolation against intentional misuse.
- **Write opt-in** — `execute_write_query` is gated by `MSSQL_ENABLE_WRITES=true`. When disabled it
  errors out _before_ a connection is acquired, so no resources are spent and no probing is
  possible. `execute_sql_file` checks the same gate before it even opens the file, so on a read-only
  server it cannot be used to probe the filesystem either.
- **File access is scoped** — `execute_sql_file` is the only tool that touches the filesystem, and it
  only reads `.sql` files under the project folder or under a root explicitly passed to
  `--allow-sql-dir`. Containment is checked after `realpath` on both sides, with `path.relative`, so
  a symlink, a `..` or a sibling sharing a prefix (`C:\proy` vs `C:\proyecto-ajeno`) cannot escape.
  The roots are resolved once and memoized, so a later `process.chdir` cannot move the boundary.
  Note this is a scoping guardrail, not a confidentiality boundary: the MCP server runs as the same
  user as the MCP client, which can already read those files.
- **No `.env` loading** — configuration comes only from the environment the process is launched
  with, so a stray `.env` in the working directory cannot set `MSSQL_ENABLE_WRITES`.
- **Env sanitizing, with one explicit exception** — the wrapper strips every inherited `MSSQL_*`
  variable so a leftover from another tool cannot inject a connection or flip the single/multi-db
  mode. `--from-env` opts into passing the connection variables through, but `MSSQL_ENABLE_WRITES`
  and `MSSQL_SQL_DIRS` are overwritten unconditionally in both paths, so the environment can never
  enable writes or authorize a folder.
- **Parameterized introspection** — every `list_*`/`describe_*` SQL uses `@param` placeholders
  rather than string concatenation; table identifiers are restricted by Zod to
  `/^[a-zA-Z0-9_#$@]+(?:\.[a-zA-Z0-9_#$@]+)?$/` (bare `Users` or two-part `dbo.Users` — no spaces,
  brackets, or three-part names) and bracket-quoted (`[schema].[table]`) for the CSV resource path.
  Identifiers with spaces or non-ASCII characters aren't supported by the introspection tools; use
  `execute_read_query` with raw SQL for those.
- **Cancellation** — tool handlers honor the MCP request `AbortSignal`; an aborted request fires
  `request.cancel()` on the underlying mssql request.
- **Least privilege** — the safest setup is a SQL login with only `SELECT` (and `EXECUTE` if
  needed) on the relevant schemas. The MCP layer reinforces that, it doesn't replace it.

## Testing

```bash
npm test
```

Runs unit tests with the built-in `node --test` runner. No external DB needed — the suite covers
config parsing, validation, identifier escaping, the rollback-only contract, pool caching/retry,
parameterized SQL placeholders, tool registration metadata, the wrapper's connection-string
parsing, BOM decoding and `GO` splitting, and the allowed-roots path policy.

The symlink-escape test is skipped when the environment does not permit creating symlinks (on
Windows that needs Developer Mode or elevation).

For interactive end-to-end testing against a real database, use the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector node src/index.js
```

### Real-DB integration test (disposable)

`npm run integration` spins up a throwaway database, exercises every tool against real SQL
Server, and drops it. The script also covers the streaming-cutoff and rollback-isolation paths
that the unit tests can only mock.

Easiest setup is a one-shot Docker container:

```bash
docker run -d --name mcp-mssql-test \
  -e "ACCEPT_EULA=Y" \
  -e "MSSQL_SA_PASSWORD=YourStr0ng!Passw0rd" \
  -p 1433:1433 \
  mcr.microsoft.com/mssql/server:2022-latest

# wait ~10s for SQL Server to initialize, then:
MSSQL_TEST_PASSWORD='YourStr0ng!Passw0rd' npm run integration

# full cleanup:
docker rm -f mcp-mssql-test
```

The script creates `mcp_test_<timestamp>` inside the server, seeds it (Users, Orders with FK +
index, a view, a stored procedure, 503 rows), runs ~30 tool-level assertions, and drops the
database in a `finally` block — even on failure.

The `execute_sql_file` assertions write scratch scripts to `.integration-tmp/` under the project
folder (the only place the tool reads from by default) and delete the folder in a `finally`. They
are what actually proves the claims a mocked test cannot: that `GO`-separated batches share one
connection (a `#temp` table survives across batches), that a mid-script failure names the right
file line, and that it rolls everything back.

Override targets via `MSSQL_TEST_SERVER`, `MSSQL_TEST_PORT`, `MSSQL_TEST_USER` if you'd rather
point it at an existing SQL Server, LocalDB, or Azure SQL.

## License

MIT — see [LICENSE](../LICENSE).
