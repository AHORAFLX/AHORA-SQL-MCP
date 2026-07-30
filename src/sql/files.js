/**
 * Path policy for `execute_sql_file`.
 *
 * The rule is: a .sql file may only be executed if it lives inside the project
 * folder, or inside a folder the operator opted into explicitly with
 * `--allow-sql-dir` (exported as MSSQL_SQL_DIRS).
 *
 * This is the first filesystem access in the server, so the containment check is
 * deliberately paranoid: everything is compared after `realpath`, so a symlink or
 * a `..\..` cannot walk out of an allowed root.
 */
const nodeFs = require("fs");
const path = require("path");

const { MAX_SQL_FILE_BYTES } = require("../validation");

let cachedRoots = null;

function parseDirList(value) {
  return String(value || "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Resolve the allowed roots. The first entry is always the project folder.
 *
 * The project folder is `process.cwd()`: Claude Code starts the MCP servers
 * declared in `.mcp.json` with the project root as cwd, and the wrapper's `spawn`
 * inherits it. So "the project folder" needs no configuration - but it does depend
 * on where the server was started from, which is why the wrapper prints it.
 */
function computeRoots({ env = process.env, cwd = process.cwd(), fs = nodeFs } = {}) {
  const roots = [];
  const seen = new Set();

  const add = (dir, label) => {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      console.warn(`[sql-files] ignoring ${label} (not found): ${dir}`);
      return;
    }
    const dedupeKey = process.platform === "win32" ? real.toLowerCase() : real;
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    roots.push(real);
  };

  add(cwd, "project folder");
  for (const dir of parseDirList(env.MSSQL_SQL_DIRS)) {
    add(dir, "--allow-sql-dir folder");
  }

  if (roots.length === 0) {
    throw new Error(
      "[sql-files] Could not resolve any allowed folder, not even the project folder."
    );
  }
  return roots;
}

/**
 * Memoized allowed roots.
 *
 * Cached so the set cannot shift between calls (a later `process.chdir` must not
 * move the boundary). Passing explicit `env`/`cwd`/`fs` bypasses the cache, which
 * is how the tests drive this.
 */
function allowedSqlDirs(options) {
  if (options && (options.env || options.cwd || options.fs)) {
    return computeRoots(options);
  }
  if (!cachedRoots) cachedRoots = computeRoots();
  return cachedRoots;
}

/**
 * True if `child` is `root` or below it.
 *
 * `path.relative` gives us both Windows case-insensitivity and a separator-aligned
 * boundary for free, so `C:\proy` does not authorize `C:\proyecto-ajeno`.
 */
function isInside(child, root) {
  const rel = path.relative(root, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Validate a caller-supplied path and return the real file to execute.
 *
 * Throws with an actionable message: the model has to be able to tell the user
 * exactly what is missing (usually `--allow-sql-dir`).
 */
function resolveSqlFile(inputPath, options = {}) {
  const { fs = nodeFs } = options;
  const roots = options.roots || allowedSqlDirs(options);
  const projectRoot = roots[0];

  if (typeof inputPath !== "string" || inputPath.trim() === "") {
    throw new Error("path is required.");
  }
  const ext = path.extname(inputPath).toLowerCase();
  if (ext !== ".sql") {
    throw new Error(
      `Only .sql files can be executed (got '${ext || "no extension"}').`
    );
  }

  // Relative paths resolve against the project folder, not against whatever cwd
  // the MCP client happens to have.
  const absolute = path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(projectRoot, inputPath);

  let realPath;
  try {
    realPath = fs.realpathSync(absolute);
  } catch {
    throw new Error(`SQL file not found: ${absolute}`);
  }

  if (!roots.some((root) => isInside(realPath, root))) {
    throw new Error(
      `SQL file is outside the allowed folders.\n` +
        `  file: ${realPath}\n` +
        `  allowed: ${roots.join(path.delimiter)}\n` +
        `Move the file into the project folder, or restart the MCP server with ` +
        `--allow-sql-dir "<folder>".`
    );
  }

  const stat = fs.statSync(realPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${realPath}`);
  }
  if (stat.size === 0) {
    throw new Error(`SQL file is empty: ${realPath}`);
  }
  if (stat.size > MAX_SQL_FILE_BYTES) {
    throw new Error(
      `SQL file is too large: ${stat.size} bytes (max ${MAX_SQL_FILE_BYTES}).`
    );
  }

  return { realPath, sizeBytes: stat.size };
}

function readSqlFile(realPath, { fs = nodeFs } = {}) {
  return fs.readFileSync(realPath);
}

function _resetForTests() {
  cachedRoots = null;
}

module.exports = {
  allowedSqlDirs,
  resolveSqlFile,
  readSqlFile,
  isInside,
  parseDirList,
  _resetForTests,
};
