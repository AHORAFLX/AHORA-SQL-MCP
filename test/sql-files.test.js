const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  resolveSqlFile,
  allowedSqlDirs,
  isInside,
  parseDirList,
} = require("../src/sql/files");
const { MAX_SQL_FILE_BYTES } = require("../src/validation");

/** Temp dir, realpath'd: on Windows os.tmpdir() can be an 8.3-shortened path. */
function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function writeSql(dir, name, body = "SELECT 1") {
  const p = path.join(dir, name);
  fs.writeFileSync(p, body, "utf8");
  return p;
}

test("resolveSqlFile: accepts a file inside the project folder with no extra config", () => {
  const project = tempDir("sqlmcp-proj-");
  const file = writeSql(project, "deploy.sql");
  const result = resolveSqlFile(file, { cwd: project, env: {} });
  assert.equal(result.realPath, fs.realpathSync(file));
  assert.equal(result.sizeBytes, Buffer.byteLength("SELECT 1"));
});

test("resolveSqlFile: accepts a file in a subfolder of the project", () => {
  const project = tempDir("sqlmcp-proj-");
  fs.mkdirSync(path.join(project, "sql", "deploy"), { recursive: true });
  const file = writeSql(path.join(project, "sql", "deploy"), "sp.sql");
  const result = resolveSqlFile(file, { cwd: project, env: {} });
  assert.equal(result.realPath, fs.realpathSync(file));
});

test("resolveSqlFile: resolves a relative path against the project folder", () => {
  const project = tempDir("sqlmcp-proj-");
  fs.mkdirSync(path.join(project, "scripts"));
  const file = writeSql(path.join(project, "scripts"), "a.sql");
  const result = resolveSqlFile("scripts/a.sql", { cwd: project, env: {} });
  assert.equal(result.realPath, fs.realpathSync(file));
});

test("resolveSqlFile: rejects a file outside the project folder, naming the roots and the flag", () => {
  const project = tempDir("sqlmcp-proj-");
  const outside = tempDir("sqlmcp-out-");
  const file = writeSql(outside, "skill.sql");
  try {
    resolveSqlFile(file, { cwd: project, env: {} });
    assert.fail("should have thrown");
  } catch (err) {
    assert.match(err.message, /outside the allowed folders/);
    assert.match(err.message, /--allow-sql-dir/);
    assert.ok(
      err.message.includes(project),
      "the message must list the allowed roots"
    );
  }
});

test("resolveSqlFile: accepts an outside file once MSSQL_SQL_DIRS opts into its folder", () => {
  const project = tempDir("sqlmcp-proj-");
  const skills = tempDir("sqlmcp-skills-");
  const file = writeSql(skills, "sp_FlxHelper.sql");
  const result = resolveSqlFile(file, {
    cwd: project,
    env: { MSSQL_SQL_DIRS: skills },
  });
  assert.equal(result.realPath, fs.realpathSync(file));
});

test("resolveSqlFile: escapes via .. are rejected", () => {
  const parent = tempDir("sqlmcp-parent-");
  const project = path.join(parent, "project");
  fs.mkdirSync(project);
  const file = writeSql(parent, "outside.sql");
  assert.throws(
    () => resolveSqlFile(path.join("..", "outside.sql"), { cwd: project, env: {} }),
    /outside the allowed folders/
  );
  assert.ok(fs.existsSync(file));
});

test("resolveSqlFile: a root does not authorize a sibling sharing its prefix", () => {
  const parent = tempDir("sqlmcp-prefix-");
  const project = path.join(parent, "proy");
  const sibling = path.join(parent, "proyecto-ajeno");
  fs.mkdirSync(project);
  fs.mkdirSync(sibling);
  const file = writeSql(sibling, "a.sql");
  assert.throws(
    () => resolveSqlFile(file, { cwd: project, env: {} }),
    /outside the allowed folders/
  );
});

test("resolveSqlFile: rejects any extension other than .sql", () => {
  const project = tempDir("sqlmcp-proj-");
  const file = path.join(project, "run.cmd");
  fs.writeFileSync(file, "echo hi", "utf8");
  assert.throws(
    () => resolveSqlFile(file, { cwd: project, env: {} }),
    /Only \.sql files/
  );
  assert.throws(
    () => resolveSqlFile(path.join(project, "noext"), { cwd: project, env: {} }),
    /no extension/
  );
});

test("resolveSqlFile: rejects a missing file", () => {
  const project = tempDir("sqlmcp-proj-");
  assert.throws(
    () => resolveSqlFile(path.join(project, "nope.sql"), { cwd: project, env: {} }),
    /not found/
  );
});

test("resolveSqlFile: rejects a directory named like a script", () => {
  const project = tempDir("sqlmcp-proj-");
  const dir = path.join(project, "bundle.sql");
  fs.mkdirSync(dir);
  assert.throws(
    () => resolveSqlFile(dir, { cwd: project, env: {} }),
    /Not a file/
  );
});

test("resolveSqlFile: rejects an empty file", () => {
  const project = tempDir("sqlmcp-proj-");
  const file = writeSql(project, "empty.sql", "");
  assert.throws(
    () => resolveSqlFile(file, { cwd: project, env: {} }),
    /empty/
  );
});

test("resolveSqlFile: rejects a file over the size cap", () => {
  const project = "C:\\fake-project";
  const file = "C:\\fake-project\\huge.sql";
  const fakeFs = {
    realpathSync: (p) => p,
    statSync: () => ({
      isFile: () => true,
      size: MAX_SQL_FILE_BYTES + 1,
    }),
  };
  assert.throws(
    () => resolveSqlFile(file, { cwd: project, env: {}, fs: fakeFs }),
    /too large/
  );
});

test("resolveSqlFile: a symlink cannot walk out of the project folder", (t) => {
  const project = tempDir("sqlmcp-proj-");
  const outside = tempDir("sqlmcp-out-");
  const target = writeSql(outside, "real.sql");
  const link = path.join(project, "link.sql");
  try {
    fs.symlinkSync(target, link, "file");
  } catch {
    // Creating symlinks on Windows needs Developer Mode or elevation.
    t.skip("symlinks not permitted in this environment");
    return;
  }
  assert.throws(
    () => resolveSqlFile(link, { cwd: project, env: {} }),
    /outside the allowed folders/
  );
});

test("allowedSqlDirs: project folder first, then the extra roots, deduped", () => {
  const project = tempDir("sqlmcp-proj-");
  const extra = tempDir("sqlmcp-extra-");
  const roots = allowedSqlDirs({
    cwd: project,
    env: { MSSQL_SQL_DIRS: [extra, project].join(path.delimiter) },
  });
  assert.deepEqual(roots, [project, extra]);
});

test("allowedSqlDirs: an empty MSSQL_SQL_DIRS leaves only the project folder", () => {
  const project = tempDir("sqlmcp-proj-");
  assert.deepEqual(allowedSqlDirs({ cwd: project, env: { MSSQL_SQL_DIRS: "" } }), [
    project,
  ]);
});

test("parseDirList splits on the platform delimiter and ignores blanks", () => {
  assert.deepEqual(parseDirList(`a${path.delimiter}${path.delimiter} b `), ["a", "b"]);
  assert.deepEqual(parseDirList(undefined), []);
});

test("isInside: same path, descendant, sibling prefix, other drive", () => {
  assert.equal(isInside("C:\\proy", "C:\\proy"), true);
  assert.equal(isInside("C:\\proy\\a\\b.sql", "C:\\proy"), true);
  assert.equal(isInside("C:\\proyecto-ajeno\\b.sql", "C:\\proy"), false);
  assert.equal(isInside("C:\\PROY\\b.sql", "C:\\proy"), process.platform === "win32");
});
