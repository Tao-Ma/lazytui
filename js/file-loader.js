/**
 * Async file reader with size cap, binary detection, and canonical
 * hexdump formatting. Used by the file-browser plugin to populate
 * content tabs without blocking the event loop on huge files.
 *
 * Path: open → stat → bounded read → close. No streaming today — the
 * cap is small enough (default 1MB text / 256KB hex) that a single
 * read into a pre-allocated Buffer is fine. Streaming becomes worth
 * the complexity if caps move into the tens-of-megabytes range.
 *
 * Binary detection: scan first 8KB for a null byte. Cheap, works for
 * the common cases (ELF / PE / Mach-O / images / archives all carry
 * `\0` early); UTF-16-LE / UCS-2 also tripwire (Western text in
 * UCS-2 has `\0` every other byte). False positives on novelty
 * formats are acceptable — hex view still shows the user something
 * useful.
 *
 * The output `{ kind, lines, ... }` is what addContentTab consumes:
 * `lines` is array<string> ready to setDetail.join('\n') against.
 */
'use strict';

const fsp = require('fs').promises;
const { esc } = require('./ansi');

const DEFAULT_MAX_BYTES = 1024 * 1024;        // 1MB for text
const DEFAULT_HEX_AFTER  = 256 * 1024;        // 256KB for hex
const BINARY_SCAN_BYTES  = 8 * 1024;

/**
 * Read up to `maxBytes` bytes from `path`. Returns the buffer (which
 * may be shorter than `maxBytes`) plus a `truncated` flag and the
 * file's full size.
 */
async function _readCapped(path, maxBytes) {
  let fh;
  try {
    fh = await fsp.open(path, 'r');
    const stat = await fh.stat();
    const totalSize = stat.size;
    const cap = Math.min(totalSize, maxBytes);
    const buf = Buffer.alloc(cap);
    let read = 0;
    while (read < cap) {
      const { bytesRead } = await fh.read(buf, read, cap - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return { buf: buf.slice(0, read), totalSize, truncated: totalSize > maxBytes };
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function _isBinary(buf) {
  const end = Math.min(buf.length, BINARY_SCAN_BYTES);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Detect a leading byte-order mark (BOM) and return one of:
 *   'utf8'     — EF BB BF (drop 3 bytes, decode as utf8)
 *   'utf16le'  — FF FE   (drop 2 bytes, decode as utf16le)
 *   'utf16be'  — FE FF   (route to hex; Node Buffer has no native
 *                          utf16be decoder and a byte-swap path adds
 *                          complexity for a rare format)
 *   null       — no BOM detected
 */
function _detectBOM(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf8';
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'utf16le';
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'utf16be';
  return null;
}

/**
 * Trim a length to the last complete UTF-8 codepoint boundary at or
 * before `len`. Prevents decoding garbage bytes (U+FFFD replacement
 * chars) when the cap lands mid-multibyte-sequence.
 *
 * UTF-8 byte classification:
 *   0xxxxxxx — single-byte ASCII (complete)
 *   110xxxxx — leading byte of 2-byte sequence
 *   1110xxxx — leading byte of 3-byte sequence
 *   11110xxx — leading byte of 4-byte sequence
 *   10xxxxxx — continuation byte
 */
function _trimToUtf8Boundary(buf, len) {
  if (len <= 0) return 0;
  let end = len;
  // Walk back over continuation bytes.
  while (end > 0 && (buf[end - 1] & 0xC0) === 0x80) end--;
  if (end === 0) return 0;
  const lead = buf[end - 1];
  let needed;
  if      ((lead & 0x80) === 0x00) needed = 1;
  else if ((lead & 0xE0) === 0xC0) needed = 2;
  else if ((lead & 0xF0) === 0xE0) needed = 3;
  else if ((lead & 0xF8) === 0xF0) needed = 4;
  else                              return end;  // malformed; nothing to align
  const have = len - (end - 1);
  return have >= needed ? len : end - 1;
}

/**
 * Canonical hexdump-style format:
 *
 *   00000000  4d 5a 90 00 03 00 00 00  04 00 00 00 ff ff 00 00  |MZ..............|
 *
 * 16 bytes per row, split at byte 8 with a double-space for
 * readability. Offsets are 8-digit hex (file offset, not row index).
 * ASCII column shows printable bytes (0x20–0x7E); everything else
 * renders as `.`.
 */
function hexdump(buf, baseOffset = 0) {
  const lines = [];
  const BYTES_PER_LINE = 16;
  for (let off = 0; off < buf.length; off += BYTES_PER_LINE) {
    const slice = buf.slice(off, off + BYTES_PER_LINE);
    const offStr = (baseOffset + off).toString(16).padStart(8, '0');
    const hexParts = [];
    for (let i = 0; i < BYTES_PER_LINE; i++) {
      if (i === 8) hexParts.push(' ');  // mid-row separator
      hexParts.push(i < slice.length ? slice[i].toString(16).padStart(2, '0') : '  ');
    }
    let asc = '';
    for (let i = 0; i < slice.length; i++) {
      const b = slice[i];
      asc += (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '.';
    }
    // esc() the ASCII column — file bytes containing 0x5B (`[`) or 0x5D
    // (`]`) would otherwise be re-parsed by richToAnsi as markup tags
    // (e.g. `[bold]` inside an ELF section name or any source code).
    lines.push(`${offStr}  ${hexParts.join(' ')}  |${esc(asc)}|`);
  }
  return lines;
}

/**
 * Load a file into content-tab-ready lines.
 *
 * Options:
 *   maxBytes  text cap (default 1MB)
 *   hexAfter  hex cap (default 256KB)
 *   forceHex  bypass binary detection, always render as hex
 *   readBytes (path, maxBytes) → Promise<{ buf, totalSize, truncated }>
 *             pluggable byte source. Defaults to local FS via
 *             _readCapped; the docker source passes a closure that
 *             routes through `docker exec`. The contract is the
 *             same for both: a bounded read returning a Buffer plus
 *             totalSize so the truncation footer is accurate.
 *
 * Return shape:
 *   { kind: 'text'|'hex'|'error', lines, totalSize, truncated, path,
 *     error? }
 */
async function loadFile(path, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const hexAfter = opts.hexAfter || DEFAULT_HEX_AFTER;
  const forceHex = !!opts.forceHex;
  const readBytes = opts.readBytes || _readCapped;

  let info;
  try {
    // Read up to the larger cap so we can detect binary first and
    // decide whether to apply the smaller hex cap on a re-slice.
    info = await readBytes(path, Math.max(maxBytes, hexAfter));
  } catch (err) {
    return {
      kind: 'error',
      lines: [`[red]Failed to read ${path}[/]`, '', `[dim]${err.message}[/]`],
      totalSize: 0, truncated: false, path,
      error: err.message,
    };
  }

  const { buf, totalSize } = info;
  const bom = _detectBOM(buf);

  // Treat UTF-16-LE as text — strip BOM and decode. UTF-16-BE has no
  // native Node decoder and is rare enough to route through hex view.
  // UTF-8 BOM (rare in modern files but harmless) gets stripped so it
  // doesn't render as a stray U+FEFF.
  if (bom === 'utf16le' && !forceHex) {
    const sliceEnd = Math.min(buf.length, maxBytes);
    // Round to even byte count (UTF-16 codepoints are 2 bytes each,
    // surrogate pairs are 4). Truncating mid-pair would still be a
    // minor U+FFFD risk; even-only is a cheap approximation.
    const evenEnd = sliceEnd - ((sliceEnd - 2) % 2);
    const text = buf.slice(2, evenEnd).toString('utf16le');
    return _wrapTextResult(text, totalSize, evenEnd, path, 'utf16le');
  }

  const binary = forceHex || (bom === 'utf16be') || _isBinary(buf);

  if (binary) {
    const slice = buf.slice(0, Math.min(buf.length, hexAfter));
    const lines = hexdump(slice);
    const truncated = totalSize > slice.length;
    // Header on every hex view; truncation footer appended when capped.
    const headerSuffix = bom === 'utf16be' ? ' · utf-16-be detected' : '';
    lines.unshift(`[dim]hex view · ${totalSize} bytes${headerSuffix}[/]`, '');
    if (truncated) {
      lines.push('', `[dim]… truncated at ${slice.length} of ${totalSize} bytes (hex_after cap)[/]`);
    }
    return { kind: 'hex', lines, totalSize, truncated, path };
  }

  // Text path: decode the (possibly smaller) text-capped slice.
  // _trimToUtf8Boundary prevents the cap from chopping mid-codepoint
  // (which would otherwise render as U+FFFD replacement chars).
  const rawEnd = Math.min(buf.length, maxBytes);
  const skipBom = bom === 'utf8' ? 3 : 0;
  const alignedEnd = _trimToUtf8Boundary(buf, rawEnd);
  const text = buf.slice(skipBom, alignedEnd).toString('utf8');
  return _wrapTextResult(text, totalSize, alignedEnd, path, 'utf8');
}

function _wrapTextResult(text, totalSize, consumed, path, encoding) {
  // esc() every line — file content is plain text data, not Rich
  // markup. Without escape, a source file containing `[bold]` or
  // `arr[0]` would be re-parsed as markup tags and corrupt styling.
  const lines = text.split('\n').map(esc);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const truncated = totalSize > consumed;
  if (encoding && encoding !== 'utf8') {
    lines.unshift(`[dim]text view · ${encoding} · ${totalSize} bytes[/]`, '');
  }
  if (truncated) {
    lines.push('');
    lines.push(`[dim]… truncated at ${consumed} of ${totalSize} bytes (max_bytes cap)[/]`);
  }
  return { kind: 'text', lines, totalSize, truncated, path };
}

module.exports = {
  loadFile,
  // Exposed for tests / advanced callers
  hexdump, _isBinary, _readCapped, _detectBOM, _trimToUtf8Boundary,
  DEFAULT_MAX_BYTES, DEFAULT_HEX_AFTER,
};
