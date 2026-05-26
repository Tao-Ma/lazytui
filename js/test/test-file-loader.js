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
.then(() => report())
.catch(err => { console.error('test failure:', err); process.exit(1); });
