/**
 * Decoding and GO-splitting for .sql files.
 *
 * Pure module: no filesystem, no database, no env. Everything here is a function
 * from text to text so the batch splitter can be tested exhaustively without a
 * server - which matters, because a wrong split silently deploys the wrong SQL.
 */

const MAX_PREVIEW_LEN = 120;

/**
 * A line is a batch separator only if the WHOLE line is `GO`, optionally followed
 * by a repeat count and a line comment. `GOTO label` and `GO2` are not separators.
 */
const GO_LINE = /^[ \t]*GO(?:[ \t]+(\d+))?[ \t]*(?:--.*)?$/i;

/**
 * Decode a .sql file buffer, honoring the BOM.
 *
 * SSMS saves .sql as UTF-16LE with BOM by default, so reading everything as UTF-8
 * is not an edge case - it is the common case, and it produces text riddled with
 * NUL characters that SQL Server rejects with a baffling syntax error. We detect
 * the BOM instead of guessing, and refuse BOM-less UTF-16 rather than sending
 * garbage to the server.
 */
function decodeSqlBuffer(buffer) {
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return { text: buffer.subarray(3).toString("utf8"), encoding: "utf8-bom" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return {
      text: buffer.subarray(2).toString("utf16le"),
      encoding: "utf16le-bom",
    };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const body = Buffer.from(buffer.subarray(2));
    if (body.length % 2 !== 0) {
      throw new Error(
        "UTF-16BE file has an odd byte length - the file looks truncated."
      );
    }
    body.swap16();
    return { text: body.toString("utf16le"), encoding: "utf16be-bom" };
  }

  const text = buffer.toString("utf8");
  if (text.indexOf(String.fromCharCode(0)) !== -1) {
    throw new Error(
      "File contains NUL characters after decoding as UTF-8. It is probably " +
        "UTF-16 without a BOM - re-save it as UTF-8, or as UTF-16 with BOM."
    );
  }
  return { text, encoding: "utf8" };
}

/**
 * Advance the scanner state across one line of T-SQL.
 *
 * `state` is mutated. `block` is a nesting depth because T-SQL allows nested
 * block comments; `quote` is the character that will close the current literal
 * or quoted identifier (`'`, `"` or `]`).
 */
function scanLine(line, state) {
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    const next = line[i + 1];

    if (state.block > 0) {
      if (c === "/" && next === "*") {
        state.block++;
        i += 2;
        continue;
      }
      if (c === "*" && next === "/") {
        state.block--;
        i += 2;
        continue;
      }
      i++;
      continue;
    }

    if (state.quote) {
      if (c === state.quote) {
        // Doubled delimiter is an escape, not a terminator: '' "" ]]
        if (next === state.quote) {
          i += 2;
          continue;
        }
        state.quote = null;
        i++;
        continue;
      }
      i++;
      continue;
    }

    if (c === "-" && next === "-") return state; // rest of the line is a comment
    if (c === "/" && next === "*") {
      state.block = 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      state.quote = c;
      i++;
      continue;
    }
    if (c === "[") {
      state.quote = "]";
      i++;
      continue;
    }
    i++;
  }
  return state;
}

/**
 * Split a script into batches on `GO`, the way sqlcmd does.
 *
 * Lines are kept verbatim - including leading blank lines - so that
 * `startLine + <line reported by SQL Server> - 1` is the real line in the file.
 * That mapping is the whole point: it turns "Incorrect syntax near ')'" into a
 * line the user can jump to.
 *
 * Returns `[{ index, sql, startLine, endLine, lineCount, repeat }]`, with
 * whitespace-only batches dropped.
 */
function splitBatches(text) {
  const lines = text.split(/\r\n|\n|\r/);
  const state = { block: 0, quote: null };
  const batches = [];
  let current = [];
  let currentStart = 1;

  const flush = (repeat) => {
    const sql = current.join("\n");
    if (sql.trim() === "") return;
    batches.push({
      index: batches.length,
      sql,
      startLine: currentStart,
      endLine: currentStart + current.length - 1,
      lineCount: current.length,
      repeat,
    });
  };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    // A GO inside a string literal or a block comment is not a separator, so the
    // separator check only runs when the scanner is in plain code.
    if (state.block === 0 && !state.quote) {
      const match = GO_LINE.exec(line);
      if (match) {
        flush(match[1] === undefined ? 1 : Number.parseInt(match[1], 10));
        current = [];
        currentStart = n + 2;
        continue;
      }
    }
    current.push(line);
    scanLine(line, state);
  }
  flush(1);

  return batches;
}

/** Skip leading whitespace and comments to reach the first real token. */
function stripLeadingNoise(sql) {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") {
      i++;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      if (nl === -1) return "";
      i = nl + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") {
          depth++;
          j += 2;
          continue;
        }
        if (sql[j] === "*" && sql[j + 1] === "/") {
          depth--;
          j += 2;
          continue;
        }
        j++;
      }
      i = j;
      continue;
    }
    break;
  }
  return sql.slice(i);
}

/** First meaningful line of a batch, trimmed, for the tool output. */
function previewOf(sql) {
  const body = stripLeadingNoise(sql);
  const line = (body.split(/\r\n|\n|\r/, 1)[0] || "").trim();
  return line.length > MAX_PREVIEW_LEN
    ? `${line.slice(0, MAX_PREVIEW_LEN - 3)}...`
    : line;
}

/**
 * True if the batch starts with a `USE` statement.
 *
 * Rejected by the tool: `USE` changes the database of a connection that later goes
 * back into the pool, so it would silently retarget unrelated calls. `dbKey` is
 * the supported way to choose a database.
 */
function startsWithUse(sql) {
  return /^USE\b/i.test(stripLeadingNoise(sql));
}

module.exports = {
  decodeSqlBuffer,
  splitBatches,
  previewOf,
  startsWithUse,
  stripLeadingNoise,
  MAX_PREVIEW_LEN,
};
