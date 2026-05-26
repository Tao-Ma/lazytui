/**
 * file-loader unit tests — hex format, binary detection, async cap.
 *
 * Each test uses an os.tmpdir() scratch dir and cleans up after itself.
 *
 * Run: node js/test/test-file-loader.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadFile, hexdump, _isBinary } = require('../file-loader');
const { describe, it, eq, assert, section, report } = require('./test-runner');

function tmpFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-fl-'));
  const fp = path.join(dir, 'file.bin');
  fs.writeFileSync(fp, contents);
  return { dir, fp };
}
function cleanup({ dir }) { fs.rmSync(dir, { recursive: true, force: true }); }

describe('[1] _isBinary', () => {
  it('null byte → binary', () => {
    eq(_isBinary(Buffer.from([0x4d, 0x5a, 0x00, 0x90])), true);
  });
  it('all printable → not binary', () => {
    eq(_isBinary(Buffer.from('hello world')), false);
  });
  it('UTF-8 multi-byte text is not binary (no nulls)', () => {
    eq(_isBinary(Buffer.from('héllo 你好 世界', 'utf8')), false);
  });
});

describe('[2] hexdump format', () => {
  it('16 bytes per line; mid-row spacer at byte 8', () => {
    const buf = Buffer.from('Hello World!1234', 'utf8');  // 16 bytes
    const lines = hexdump(buf);
    eq(lines.length, 1);
    const m = lines[0].match(/^([0-9a-f]+)  ([^|]+) \|(.+)\|$/);
    assert(m, `format: ${lines[0]}`);
    eq(m[1], '00000000', 'offset 0 padded to 8');
    assert(m[2].includes('  '), 'mid-row double-space spacer present');
    eq(m[3], 'Hello World!1234', 'ASCII column');
  });
  it('partial last row pads hex but not ASCII', () => {
    const buf = Buffer.from('Hi');
    const lines = hexdump(buf);
    eq(lines.length, 1);
    const m = lines[0].match(/^[0-9a-f]+  (.+) \|(.+)\|$/);
    assert(m[1].includes('   '), 'unused hex slots padded with spaces');
    eq(m[2], 'Hi', 'ASCII has only the present bytes');
  });
  it('non-printable bytes → dot in ASCII column', () => {
    const buf = Buffer.from([0x00, 0x41, 0xff, 0x42]);
    const lines = hexdump(buf);
    assert(lines[0].endsWith('|.A.B|'), `ascii: ${lines[0]}`);
  });
});

section('[3] loadFile — async text + cap');
(async () => {
  const big = 'a'.repeat(2048);
  const t = tmpFile(big);
  try {
    const r = await loadFile(t.fp, { maxBytes: 100 });
    eq(r.kind, 'text');
    eq(r.totalSize, 2048);
    eq(r.truncated, true);
    // First line is the truncated content; trailing dim row is added.
    assert(r.lines.some(L => /truncated at/.test(L)), 'truncation note present');
  } finally { cleanup(t); }
})()
.then(() => section('[4] loadFile — binary → hex'))
.then(async () => {
  const buf = Buffer.from([0x4d, 0x5a, 0x00, 0x90, 0x03]);
  const t = tmpFile(buf);
  try {
    const r = await loadFile(t.fp);
    eq(r.kind, 'hex');
    eq(r.totalSize, 5);
    assert(r.lines.some(L => /4d 5a/.test(L)), `hex line present: ${r.lines.join('\n')}`);
  } finally { cleanup(t); }
})
.then(() => section('[5] loadFile — non-existent → error'))
.then(async () => {
  const r = await loadFile('/definitely/does/not/exist/zzz');
  eq(r.kind, 'error');
  assert(r.lines.some(L => /Failed to read/.test(L)), 'error message in lines');
})
.then(() => section('[6] loadFile — text within cap is not truncated'))
.then(async () => {
  const t = tmpFile('small file\nwith two lines');
  try {
    const r = await loadFile(t.fp, { maxBytes: 10 * 1024 });
    eq(r.kind, 'text');
    eq(r.truncated, false);
    assert(!r.lines.some(L => /truncated/.test(L)), 'no truncation note');
  } finally { cleanup(t); }
})
.then(() => section('[7] loadFile — forceHex bypasses binary detection'))
.then(async () => {
  const t = tmpFile('plain text');
  try {
    const r = await loadFile(t.fp, { forceHex: true });
    eq(r.kind, 'hex');
    assert(r.lines.some(L => /70 6c 61 69 6e/.test(L)), 'hex of "plain"');
  } finally { cleanup(t); }
})
.then(() => section('[8] _trimToUtf8Boundary — multi-byte alignment'))
.then(async () => {
  const { _trimToUtf8Boundary } = require('../file-loader');
  // "你好" in UTF-8 = E4 BD A0 E5 A5 BD (6 bytes for 2 codepoints).
  const cjk = Buffer.from('你好', 'utf8');
  eq(cjk.length, 6, 'sanity: utf-8 length of 你好');
  // Cap at 5 bytes → mid-second-codepoint. Should trim back to 3 (end of 你).
  eq(_trimToUtf8Boundary(cjk, 5), 3, 'mid-codepoint trimmed back');
  eq(_trimToUtf8Boundary(cjk, 6), 6, 'aligned cap unchanged');
  eq(_trimToUtf8Boundary(cjk, 3), 3, 'at codepoint boundary unchanged');
  // ASCII bytes are always single-byte; no trimming.
  const ascii = Buffer.from('hello');
  eq(_trimToUtf8Boundary(ascii, 5), 5);
  eq(_trimToUtf8Boundary(ascii, 3), 3);
})
.then(() => section('[9] _detectBOM'))
.then(async () => {
  const { _detectBOM } = require('../file-loader');
  eq(_detectBOM(Buffer.from([0xEF, 0xBB, 0xBF, 0x41])), 'utf8');
  eq(_detectBOM(Buffer.from([0xFF, 0xFE, 0x41, 0x00])), 'utf16le');
  eq(_detectBOM(Buffer.from([0xFE, 0xFF, 0x00, 0x41])), 'utf16be');
  eq(_detectBOM(Buffer.from('hello')), null);
  eq(_detectBOM(Buffer.from([])), null);
})
.then(() => section('[10] loadFile — UTF-16-LE BOM decoded as text'))
.then(async () => {
  // "hi" in UTF-16-LE with BOM = FF FE 68 00 69 00
  const t = tmpFile(Buffer.from([0xFF, 0xFE, 0x68, 0x00, 0x69, 0x00]));
  try {
    const r = await loadFile(t.fp);
    eq(r.kind, 'text', 'utf16le → text path');
    assert(r.lines.some(L => L.includes('hi')), `decoded: ${JSON.stringify(r.lines)}`);
    assert(r.lines.some(L => /utf16le/.test(L)), 'header notes encoding');
  } finally { cleanup(t); }
})
.then(() => section('[11] loadFile — UTF-16-BE BOM → hex view'))
.then(async () => {
  const t = tmpFile(Buffer.from([0xFE, 0xFF, 0x00, 0x41, 0x00, 0x42]));
  try {
    const r = await loadFile(t.fp);
    eq(r.kind, 'hex', 'utf16be routed to hex');
    assert(r.lines.some(L => /utf-16-be/.test(L)), 'header notes utf-16-be');
  } finally { cleanup(t); }
})
.then(() => section('[12] loadFile — UTF-8 BOM stripped, decoded clean'))
.then(async () => {
  const t = tmpFile(Buffer.from([0xEF, 0xBB, 0xBF, 0x68, 0x69]));  // "hi"
  try {
    const r = await loadFile(t.fp);
    eq(r.kind, 'text');
    eq(r.lines[0], 'hi', 'BOM not in output');
  } finally { cleanup(t); }
})
.then(() => section('[13] loadFile — utf8 cap mid-codepoint is aligned back'))
.then(async () => {
  // 5 copies of 你 = 15 bytes. maxBytes=4 should produce 0 chars (mid-first).
  const t = tmpFile(Buffer.from('你你你你你', 'utf8'));
  try {
    const r = await loadFile(t.fp, { maxBytes: 4 });
    eq(r.kind, 'text');
    eq(r.truncated, true);
    // 4 bytes covers byte index 0..3. First 你 is 3 bytes (E4 BD A0).
    // _trimToUtf8Boundary at 4 → 3 (clean after first 你).
    assert(r.lines[0].startsWith('你'), `first char survived: ${r.lines[0]}`);
    // The trailing partial bytes did NOT decode to U+FFFD.
    assert(!r.lines[0].includes('�'), 'no replacement char leaked');
  } finally { cleanup(t); }
})
.then(() => report())
.catch(err => { console.error('test failure:', err); process.exit(1); });
