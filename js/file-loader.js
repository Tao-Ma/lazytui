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
 *
 * Return shape:
 *   { kind: 'text'|'hex'|'error', lines, totalSize, truncated, path,
 *     error? }
 */
async function loadFile(path, opts = {}) {
  const maxBytes = opts.maxBytes || DEFAULT_MAX_BYTES;
  const hexAfter = opts.hexAfter || DEFAULT_HEX_AFTER;
  const forceHex = !!opts.forceHex;

  let info;
  try {
    // Read up to the larger cap so we can detect binary first and
    // decide whether to apply the smaller hex cap on a re-slice.
    info = await _readCapped(path, Math.max(maxBytes, hexAfter));
  } catch (err) {
    return {
      kind: 'error',
      lines: [`[red]Failed to read ${path}[/]`, '', `[dim]${err.message}[/]`],
      totalSize: 0, truncated: false, path,
      error: err.message,
    };
  }

  const { buf, totalSize } = info;
  const binary = forceHex || _isBinary(buf);

  if (binary) {
    const slice = buf.slice(0, Math.min(buf.length, hexAfter));
    const lines = hexdump(slice);
    const truncated = totalSize > slice.length;
    // Header on every hex view; truncation footer appended when capped.
    lines.unshift(`[dim]hex view · ${totalSize} bytes[/]`, '');
    if (truncated) {
      lines.push('', `[dim]… truncated at ${slice.length} of ${totalSize} bytes (hex_after cap)[/]`);
    }
    return { kind: 'hex', lines, totalSize, truncated, path };
  }

  // Text path: decode the (possibly smaller) text-capped slice.
  const textSlice = buf.slice(0, Math.min(buf.length, maxBytes));
  const text = textSlice.toString('utf8');
  // esc() every line — file content is plain text data, not Rich
  // markup. Without escape, a source file containing `[bold]` or
  // `arr[0]` would be re-parsed as markup tags and corrupt styling.
  const lines = text.split('\n').map(esc);
  // Strip a trailing empty line if the file ended in \n (common).
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const truncated = totalSize > textSlice.length;
  if (truncated) {
    lines.push('');
    lines.push(`[dim]… truncated at ${textSlice.length} of ${totalSize} bytes (max_bytes cap)[/]`);
  }
  return { kind: 'text', lines, totalSize, truncated, path };
}

module.exports = {
  loadFile,
  // Exposed for tests / advanced callers
  hexdump, _isBinary, _readCapped,
  DEFAULT_MAX_BYTES, DEFAULT_HEX_AFTER,
};
