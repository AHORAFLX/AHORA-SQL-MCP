# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

An MCP (stdio) server exposing SQL Server to Claude Code for the Flexygo / AHORA_ERP projects.
It ships as a **committed, dependency-free bundle** rather than as a normal npm package, and most
of the non-obvious design in the repo exists to serve that constraint. Docs: `README.md` (user
guide, Spanish), `INSTALAR.md` (install guide, Spanish), `docs/REFERENCE.md` (technical
reference, English).

## Commands

```bash
npm test                          # unit tests (node --test), no database needed
node --test test/safety.test.js   # one file
node --test --test-name-pattern "pool"   # one test by name
npx eslint .                      # lint (no npm script for it)
npx prettier --write .            # format

npm run build            # esbuild -> bundle/*.cjs   (REQUIRED after touching src/, bin/ or installer/)
npm run verify:bundle    # runs the built bundle outside the repo and speaks MCP to it
npm run build:exe        # Node SEA -> dist/ahora-setup.exe (wipes dist/, not bundle/)

npm start                # run the server directly from src/ (needs MSSQL_* in the env)
npm run dev              # same, under nodemon
npx @modelcontextprotocol/inspector node src/index.js   # interactive end-to-end

npm run integration      # real DB required; creates and drops a throwaway database
npm run repro:pool       # real DB required; reproduces the pool-poisoning bug
```

`integration` and `repro:pool` read `MSSQL_TEST_SERVER` / `MSSQL_TEST_PORT` / `MSSQL_TEST_INSTANCE` /
`MSSQL_TEST_USER` / `MSSQL_TEST_PASSWORD` (password mandatory). The Docker one-liner is in
`docs/REFERENCE.md`.

## Architecture

### Two processes, not one

`bin/start-mssql-mcp.js` (the wrapper) is a **policy layer**: it resolves the connection from a
`Web.config` / `appsettings.json` / connection string / encrypted credentials file, exports the
`MSSQL_*` variables, and `spawn`s `src/index.js` with a clean environment. The server itself
**never reads `.env` files and never parses connection sources** — a stray `MSSQL_ENABLE_WRITES`
in the ambient environment must not be able to turn on writes. The wrapper always exports
`MSSQL_ENABLE_WRITES` and `MSSQL_SQL_DIRS` explicitly (even as `false` / empty) for the same
reason. `bin/start-ahora-mcp.js` is a separate launcher for a third-party product MCP that reuses
only the wrapper's config-reading helpers.

`src/index.js` → `src/server.js` (McpServer factory) → `src/tools/index.js` (barrel of 12 tool
modules, each exporting `{ name, config, handler }`), plus `resources.js` and `prompts.js`.

### Everything expensive is deferred past `initialize`

MCP clients abort a server that does not answer `initialize` within ~30 s, and a server they
abort loses all its tools until restart — this was the recurring "sometimes you have to restart
the MCP" symptom. Three deliberate consequences, all load-bearing:

- `src/db/driver.js` — lazy `require("mssql")` (432 of 666 modules, ~300-550 ms), paid on the
  first query. It is a lazy `require`, not `import()`, because `db/safety.js` uses it as a
  synchronous default parameter value.
- `src/db/endpoint.js` — local named-instance port discovery (~4 s of PowerShell via
  `bin/discover-instance.js`) happens on first use per connection, not at startup, and is
  **invalidatable**: a dynamic port changes whenever the SQL service restarts, so
  `invalidateEndpoint(dbKey)` makes the next connection re-probe.
- `bundle/` exists so `npm install` of the published package resolves **zero** packages (166
  packages / ~90 s cold otherwise).

Do not move work into the startup path.

### Connection config: `dbKey`

`src/config.js` builds validated configs from env. Two modes: **single** (`MSSQL_SERVER`,
`MSSQL_DATABASE`, …) yielding the key `maindb`, and **multi** (`MSSQL_<NAME>_DATABASE` + per-name
overrides falling back to the unprefixed ones) yielding one lowercased `dbKey` per name — Flexygo
typically uses `config` and `data`. Every tool takes an optional `dbKey`. Port and `instanceName`
are mutually exclusive (tedious rejects both).

### Pool hygiene (`src/db/pools.js` + `src/db/connections.js`)

A pool hands the *same* connection to unrelated calls, so leftover state is inherited. The fix is
a custom tarn `validate` (`makeAcquireReset`) installed via `withAcquireReset` that calls
tedious's `reset` at acquire time and refuses any connection still reporting `inTransaction` —
replacing mssql's own `SELECT 1` validate, so it costs no extra round trip. A pool that breaks
after having connected is marked `entry.broken` and replaced on the next call (the mark lives on
the entry, not in the shared `status` map, to avoid concurrent calls destroying each other's new
pool). Recycled-connection counts surface in `list_databases`.

### Read/write contract (`src/db/safety.js`)

- `runRead` / `streamRead` — always inside a transaction that is **always rolled back**. A
  guardrail, not a sandbox (an explicit `COMMIT` in the query string escapes it); real isolation
  is a least-privilege SQL login. `streamRead` cancels the underlying request once
  `offset + limit` rows have been seen, and closes on mssql's `done`, not `error`.
- `runWrite` — refuses unless `MSSQL_ENABLE_WRITES=true`, or `MSSQL_<DBKEY>_ENABLE_WRITES=true`
  for that one key (per-DB wins over global). One explicit transaction by default; honours `GO`.
  **No keyword denylist** — the SQL login's grants are the source of truth.
- Cancellation is asynchronous (tedious sends ATTENTION and waits for the ack, and serialises
  requests per connection), so the cleanup path waits for the request to settle before attempting
  ROLLBACK, probes `@@TRANCOUNT`, and `destroyConnection`s anything it cannot prove clean.

### `execute_sql_file`

`src/sql/batches.js` is pure (BOM decoding — SSMS writes UTF-16LE by default — and `GO`
splitting; no I/O, so the splitter is exhaustively testable). `src/sql/files.js` enforces the path
policy: a `.sql` file must resolve, after `realpath`, inside the project folder (`process.cwd()`)
or a folder opted into with `--allow-sql-dir` (`MSSQL_SQL_DIRS`). `USE` is rejected. The per-**batch**
timeout defaults to 90 s (not the 30 s pool-wide `requestTimeout`), because a deployment script is
one transaction over many batches.

`src/secrets.js` encrypts the credentials file at rest: DPAPI (CurrentUser, via PowerShell) on
Windows, AES-256-GCM with a `0600` key file elsewhere. Decryption happens in the server on first
connect, in one batch (each DPAPI call costs a PowerShell start, ~0.5 s).

## Rules that are easy to break

- **`dependencies` in `package.json` must stay empty.** Anything runtime-needed goes in
  `devDependencies` and reaches users through `npm run build`. `test/packaging.test.js` guards
  this, along with `bin` entries pointing at `bundle/`.
- **`bundle/*.cjs` is committed generated output.** It is marked `-diff linguist-generated` in
  `.gitattributes`. Rebuild it (`npm run build`) in the same commit as any change to `src/`,
  `bin/` or `installer/`, and run `npm run verify:bundle`.
- **Tool names are a public contract** consumed by the SC0 skills. `scripts/verify-bundle.js`
  asserts the exact list of 12. Changing one means updating those skills at the same time.
- **Releasing bumps five version pins.** The installer builds its download spec as
  `github:AHORAFLX/AHORA-SQL-MCP#v${package.json version}`, so `README.md` (×2, including the
  `git clone --branch`), `INSTALAR.md` (×2) and `installer/INSTALAR-AHORA.cmd` must all match —
  `test/version-pin.test.js` enforces it — and **the matching git tag must actually be pushed**,
  or every fresh install breaks.
- `bin/` and `src/db/safety.js` are the access-policy layer and are CODEOWNER-gated; changes
  there affect the guarantee that production is not written to.

## Conventions

CommonJS throughout, Prettier (2 spaces, double quotes, semicolons, es5 trailing commas), no
build step for `src/`. Comments carry the *why* — the measured numbers, the bug that motivated
the code — and are written in Spanish in the older modules and English in the newer ones; follow
whichever the file you are editing already uses. Tool descriptions are user-facing documentation
and are written in English. Commits are Conventional Commits in Spanish, with a body explaining
the reasoning; `chore(release): X.Y.Z` marks a version bump.
