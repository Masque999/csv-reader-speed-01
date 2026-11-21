// Fast drop-in for csv-reader 1.0.0 (make.fun's own reference): run(input) returns
// exactly readCsv's answer for every input, but scans with bulk operations
// (regex to the next special character, slice() for field contents) instead of
// one character at a time.
//
// Semantics (mirroring the reference exactly):
// - String(input.text); header is input.header === true.
// - U+FEFF at position 0 is dropped.
// - A record ends at LF or CRLF; a line with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with " runs to the next " that is not doubled; "" inside is
//   one "; each CRLF or lone CR inside is read as LF. What follows its closing
//   quote, up to the next comma or line break, is appended as-is (quote_junk
//   when the field ends, only if at least one junk char was appended). A quote
//   that never closes is a literal character and the text after it is re-read
//   as unquoted (unterminated_quote); the line counter resets to the quote's
//   line before the re-read.
// - A " inside an unquoted field is a literal character. Fields stay strings.
// - columns = first record when header is true, else null; rows = records after
//   the header (every record when header false), each padded with "" (short_row,
//   with fields: its field count) or cut (long_row, with extra: the cut fields)
//   to the first record's width. Width is set by the first non-skipped record.
// - Each error is {code, line, row} (+ fields / + extra), in the order met.
//   line = 1-based line the record STARTS on; row = the record's index in
//   rows, null for the header. A record that is a single empty UNQUOTED field
//   is skipped entirely (its stray_cr errors stay); a single empty QUOTED
//   field ("") is a real one-field record.

/** csv-reader 1.0.0's answer for one case's input, faster. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;

  // How the field being read ended: 0 comma, 1 line break, 2 end of text.
  let ended = 0;
  // Characters appended by the last readUnquoted (junk count for quote_junk).
  let added = 0;

  // Unquoted field terminators; quoted field specials.
  const RE_U = /[,\r\n]/g;
  const RE_Q = /["\r\n]/g;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads unquoted characters onto `value` up to the next comma or line break.
  // A CR not followed by LF is dropped (stray_cr). Returns the field; `ended`
  // says how it ended and `added` counts the characters kept. When the regex
  // stops at a comma or LF, the slice before it holds no CR (the regex would
  // have stopped there first), so the common case returns the slice itself
  // with no concatenation; `prefix` only accumulates on a stray CR or junk.
  function readUnquoted(value) {
    added = 0;
    let prefix = value;
    let seg = pos;
    for (;;) {
      RE_U.lastIndex = pos;
      const m = RE_U.exec(text);
      const idx = m ? m.index : len;
      if (idx >= len) {
        const tail = text.slice(seg, len);
        added += len - seg;
        pos = len;
        ended = 2;
        return prefix === '' ? tail : prefix + tail;
      }
      const ch = text[idx];
      if (ch === ',') {
        const tail = text.slice(seg, idx);
        added += idx - seg;
        pos = idx + 1;
        ended = 0;
        return prefix === '' ? tail : prefix + tail;
      }
      if (ch === '\n') {
        const tail = text.slice(seg, idx);
        added += idx - seg;
        pos = idx + 1;
        line += 1;
        ended = 1;
        return prefix === '' ? tail : prefix + tail;
      }
      // ch === '\r'
      if (text[idx + 1] === '\n') {
        const tail = text.slice(seg, idx);
        added += idx - seg;
        pos = idx + 2;
        line += 1;
        ended = 1;
        return prefix === '' ? tail : prefix + tail;
      }
      // Stray CR: drop it, record it, keep reading the same field.
      prefix += text.slice(seg, idx);
      added += idx - seg;
      err('stray_cr');
      pos = idx + 1;
      seg = pos;
    }
  }

  // Reads a quoted field whose opening quote is at pos. A quoted field with
  // no "" and no line break inside is a single slice, returned directly.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let prefix = '';
    let seg = pos + 1;
    pos = pos + 1;
    let value;
    for (;;) {
      RE_Q.lastIndex = pos;
      const m = RE_Q.exec(text);
      const idx = m ? m.index : len;
      if (idx >= len) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        err('unterminated_quote');
        return readUnquoted('"');
      }
      const ch = text[idx];
      if (ch === '"') {
        if (text[idx + 1] === '"') {
          prefix += text.slice(seg, idx) + '"';
          pos = idx + 2;
          seg = pos;
          continue;
        }
        // Closing quote.
        value = prefix === '' ? text.slice(seg, idx) : prefix + text.slice(seg, idx);
        pos = idx + 1;
        break;
      }
      if (ch === '\r') {
        // CRLF and a lone CR inside quotes are each one LF.
        prefix += text.slice(seg, idx) + '\n';
        line += 1;
        pos = idx + (text[idx + 1] === '\n' ? 2 : 1);
        seg = pos;
        continue;
      }
      // '\n'
      prefix += text.slice(seg, idx) + '\n';
      line += 1;
      pos = idx + 1;
      seg = pos;
    }
    // What follows the closing quote.
    if (pos >= len) {
      ended = 2;
      return value;
    }
    const c = text[pos];
    if (c === ',') {
      pos += 1;
      ended = 0;
      return value;
    }
    if (c === '\n') {
      pos += 1;
      line += 1;
      ended = 1;
      return value;
    }
    if (c === '\r' && text[pos + 1] === '\n') {
      pos += 2;
      line += 1;
      ended = 1;
      return value;
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const v = readUnquoted(value);
    if (added > 0) err('quote_junk');
    return v;
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted;
    do {
      if (text[pos] === '"') {
        quoted = true;
        fields.push(readQuoted());
      } else {
        // Unquoted field, inlined (the hot path): the regex stops at the
        // next comma, LF or CR, and the slice before a comma or LF holds no
        // CR, so the common case returns the slice itself.
        quoted = false;
        let prefix = '';
        let seg = pos;
        let field;
        for (;;) {
          RE_U.lastIndex = pos;
          const m = RE_U.exec(text);
          const idx = m ? m.index : len;
          if (idx >= len) {
            const tail = text.slice(seg, len);
            pos = len;
            ended = 2;
            field = prefix === '' ? tail : prefix + tail;
            break;
          }
          const ch = text[idx];
          if (ch === ',') {
            const tail = text.slice(seg, idx);
            pos = idx + 1;
            ended = 0;
            field = prefix === '' ? tail : prefix + tail;
            break;
          }
          if (ch === '\n') {
            const tail = text.slice(seg, idx);
            pos = idx + 1;
            line += 1;
            ended = 1;
            field = prefix === '' ? tail : prefix + tail;
            break;
          }
          if (text[idx + 1] === '\n') {
            const tail = text.slice(seg, idx);
            pos = idx + 2;
            line += 1;
            ended = 1;
            field = prefix === '' ? tail : prefix + tail;
            break;
          }
          // Stray CR: drop it, record it, keep reading the same field.
          prefix += text.slice(seg, idx);
          err('stray_cr');
          pos = idx + 1;
          seg = pos;
        }
        fields.push(field);
      }
    } while (ended === 0);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
