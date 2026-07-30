const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decodeSqlBuffer,
  splitBatches,
  previewOf,
  startsWithUse,
} = require("../src/sql/batches");

const NUL = String.fromCharCode(0);

function utf16le(text, { bom = true } = {}) {
  const body = Buffer.from(text, "utf16le");
  return bom ? Buffer.concat([Buffer.from([0xff, 0xfe]), body]) : body;
}

function utf16be(text) {
  const body = Buffer.from(text, "utf16le");
  body.swap16();
  return Buffer.concat([Buffer.from([0xfe, 0xff]), body]);
}

test("decodeSqlBuffer: plain UTF-8", () => {
  const { text, encoding } = decodeSqlBuffer(Buffer.from("SELECT 1", "utf8"));
  assert.equal(text, "SELECT 1");
  assert.equal(encoding, "utf8");
});

test("decodeSqlBuffer: strips UTF-8 BOM", () => {
  const buf = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from("SELECT 'ñ'", "utf8"),
  ]);
  const { text, encoding } = decodeSqlBuffer(buf);
  assert.equal(text, "SELECT 'ñ'");
  assert.equal(encoding, "utf8-bom");
});

test("decodeSqlBuffer: UTF-16LE with BOM (the SSMS default)", () => {
  const { text, encoding } = decodeSqlBuffer(utf16le("CREATE PROC [dbo].[añ]"));
  assert.equal(text, "CREATE PROC [dbo].[añ]");
  assert.equal(encoding, "utf16le-bom");
});

test("decodeSqlBuffer: UTF-16BE with BOM", () => {
  const { text, encoding } = decodeSqlBuffer(utf16be("SELECT 'añ'"));
  assert.equal(text, "SELECT 'añ'");
  assert.equal(encoding, "utf16be-bom");
});

test("decodeSqlBuffer: rejects BOM-less UTF-16 instead of sending NUL-riddled text", () => {
  assert.throws(
    () => decodeSqlBuffer(utf16le("SELECT 1", { bom: false })),
    /NUL characters/
  );
});

test("decodeSqlBuffer: rejects truncated UTF-16BE", () => {
  const buf = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from([0x00])]);
  assert.throws(() => decodeSqlBuffer(buf), /odd byte length/);
});

test("splitBatches: splits on GO and drops the trailing empty batch", () => {
  const batches = splitBatches("SELECT 1\nGO\nSELECT 2\nGO\n");
  assert.equal(batches.length, 2);
  assert.deepEqual(
    batches.map((b) => b.sql),
    ["SELECT 1", "SELECT 2"]
  );
});

test("splitBatches: GO is case-insensitive and tolerates surrounding whitespace", () => {
  const batches = splitBatches("SELECT 1\n  go \t\nSELECT 2");
  assert.equal(batches.length, 2);
});

test("splitBatches: GO followed by a line comment is still a separator", () => {
  const batches = splitBatches("SELECT 1\nGO -- deploy\nSELECT 2");
  assert.equal(batches.length, 2);
});

test("splitBatches: GO n sets the repeat count", () => {
  const batches = splitBatches("INSERT INTO t VALUES (1)\nGO 3\nSELECT 1");
  assert.equal(batches[0].repeat, 3);
  assert.equal(batches[1].repeat, 1);
});

test("splitBatches: GOTO and GO2 are not separators", () => {
  assert.equal(splitBatches("GOTO fin\nSELECT 1").length, 1);
  assert.equal(splitBatches("SELECT 1\nGO2\nSELECT 2").length, 1);
});

test("splitBatches: GO inside a line comment is not a separator", () => {
  const batches = splitBatches("SELECT 1\n-- GO\nSELECT 2");
  assert.equal(batches.length, 1);
});

test("splitBatches: GO inside a block comment is not a separator", () => {
  const batches = splitBatches("SELECT 1\n/*\nGO\n*/\nSELECT 2");
  assert.equal(batches.length, 1);
});

test("splitBatches: GO inside a nested block comment is not a separator", () => {
  const batches = splitBatches("SELECT 1\n/* a /* b\nGO\n*/ c */\nSELECT 2");
  assert.equal(batches.length, 1);
});

test("splitBatches: GO inside a multi-line string literal is not a separator", () => {
  const batches = splitBatches("PRINT '\nGO\n'\nSELECT 2");
  assert.equal(batches.length, 1);
});

test("splitBatches: doubled quote is an escape, not a terminator", () => {
  // The '' keeps the literal open, so the GO on the next line stays inside it.
  const batches = splitBatches("PRINT 'a''b\nGO\n'\nSELECT 2");
  assert.equal(batches.length, 1);
});

test("splitBatches: GO inside a bracketed identifier is not a separator", () => {
  const batches = splitBatches("SELECT * FROM [weird\nGO\nname]\nSELECT 2");
  assert.equal(batches.length, 1);
});

test("splitBatches: startLine maps to the real file line with CRLF endings", () => {
  const script = [
    "SET ANSI_NULLS ON",
    "GO",
    "SET QUOTED_IDENTIFIER ON",
    "GO",
    "CREATE PROCEDURE dbo.p AS",
    "  SELECT 1",
  ].join("\r\n");
  const batches = splitBatches(script);
  assert.equal(batches.length, 3);
  assert.deepEqual(
    batches.map((b) => [b.startLine, b.endLine, b.lineCount]),
    [
      [1, 1, 1],
      [3, 3, 1],
      [5, 6, 2],
    ]
  );
});

test("splitBatches: blank lines are kept so line numbers stay aligned", () => {
  const batches = splitBatches("GO\n\n\nSELECT 1");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].startLine, 2);
  assert.equal(batches[0].sql, "\n\nSELECT 1");
});

test("splitBatches: whitespace-only batches are dropped", () => {
  const batches = splitBatches("SELECT 1\nGO\n   \nGO\nSELECT 2");
  assert.equal(batches.length, 2);
});

test("splitBatches: a script without GO is a single batch", () => {
  const batches = splitBatches("SELECT 1\nSELECT 2");
  assert.equal(batches.length, 1);
  assert.equal(batches[0].startLine, 1);
});

test("splitBatches: indexes are contiguous after dropped batches", () => {
  const batches = splitBatches("GO\nSELECT 1\nGO\n\nGO\nSELECT 2");
  assert.deepEqual(
    batches.map((b) => b.index),
    [0, 1]
  );
});

test("previewOf: skips leading comments and truncates", () => {
  assert.equal(
    previewOf("-- header\n/* more */\nCREATE PROCEDURE dbo.p AS\nSELECT 1"),
    "CREATE PROCEDURE dbo.p AS"
  );
  const long = `SELECT ${"x".repeat(200)}`;
  assert.equal(previewOf(long).length, 120);
  assert.ok(previewOf(long).endsWith("..."));
});

test("startsWithUse: detects USE past comments, ignores lookalikes", () => {
  assert.equal(startsWithUse("USE [MyDb]"), true);
  assert.equal(startsWithUse("use MyDb"), true);
  assert.equal(startsWithUse("-- switch\nUSE MyDb"), true);
  assert.equal(startsWithUse("/* switch */ USE MyDb"), true);
  assert.equal(startsWithUse("SELECT * FROM Users"), false);
  assert.equal(startsWithUse("USED = 1"), false);
});

test("decodeSqlBuffer keeps NUL detection independent of literal source bytes", () => {
  assert.throws(() => decodeSqlBuffer(Buffer.from(`SELECT${NUL}1`, "utf8")), /NUL/);
});
