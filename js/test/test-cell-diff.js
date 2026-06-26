/**
 * v0.6.6 replay arc — change-highlight cell diff (leaves/render/cell-diff) and
 * its painter integration. Glyph-only cell diff + whole-row line diff, gray bg.
 *
 * Run: node js/test/test-cell-diff.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { highlightRow, HL_ON, HL_OFF } = require('../leaves/render/cell-diff');
const { paintFrame } = require('../leaves/render/painter');
const { richToAnsi } = require('../leaves/text/ansi');

// Strip our highlight codes; what remains must equal the plain rendered row.
const unhl = (s) => s.split(HL_ON).join('').split(HL_OFF).join('');

describe('[1] off / unknown mode is plain richToAnsi', () => {
  it('off → plain', () => eq(highlightRow('aaa', 'bbb', 'off'), richToAnsi('bbb')));
  it('no highlight codes present', () => assert(!highlightRow('aaa', 'bbb', 'off').includes(HL_ON), 'no HL_ON'));
});

describe('[2] cell mode wraps only the changed columns', () => {
  it('a single changed glyph is wrapped, neighbors are not', () => {
    const out = highlightRow('abc', 'aXc', 'cell');
    eq(out, `a${HL_ON}X${HL_OFF}c`);
  });
  it('identical rows produce NO highlight', () => {
    const out = highlightRow('abc', 'abc', 'cell');
    eq(out, 'abc');
    assert(!out.includes(HL_ON), 'no HL_ON for an unchanged row');
  });
  it('a changed run is wrapped once, not per-cell', () => {
    const out = highlightRow('abcd', 'aXYd', 'cell');
    eq(out, `a${HL_ON}XY${HL_OFF}d`);
  });
});

describe('[3] line mode wraps the whole row', () => {
  it('every cell is in one run', () => {
    const out = highlightRow('zzz', 'abc', 'line');
    eq(out, `${HL_ON}abc${HL_OFF}`);
  });
  it('closes the run before end-of-row (no trailing bg to bleed)', () => {
    const out = highlightRow('zz', 'ab', 'line');
    assert(out.endsWith(HL_OFF), `ends with HL_OFF: ${JSON.stringify(out)}`);
  });
});

describe('[4] faithful reproduction — stripping the highlight == plain row', () => {
  const cases = [
    ['abc', 'aXc'],
    ['hello world', 'hello WORLD'],
    ['a\x1b[31mY\x1b[0mc', 'a\x1b[31mX\x1b[0mc'],   // raw SGR + interior reset
    ['[red]ab[/]c', '[red]aZ[/]c'],                  // markup tags
  ];
  for (const [p, c] of cases) {
    it(`cell: ${JSON.stringify(c)} round-trips`, () => eq(unhl(highlightRow(p, c, 'cell')), richToAnsi(c)));
    it(`line: ${JSON.stringify(c)} round-trips`, () => eq(unhl(highlightRow(p, c, 'line')), richToAnsi(c)));
  }
});

describe('[5] interior reset re-asserts the background mid-run', () => {
  it('a passed-through reset inside a changed run is followed by HL_ON', () => {
    // both cols changed → one run spanning the reset; the reset must be re-armed.
    const out = highlightRow('Y\x1b[0mY', 'X\x1b[0mZ', 'cell');
    assert(out.includes(`\x1b[0m${HL_ON}`), `reset re-asserts bg: ${JSON.stringify(out)}`);
  });
});

describe('[6] CJK double-width', () => {
  it('a changed wide glyph tints, an unchanged wide glyph does not', () => {
    // prev "中b" → cur "中X": wide unchanged, narrow changed.
    const out1 = highlightRow('中b', '中X', 'cell');
    eq(out1, `中${HL_ON}X${HL_OFF}`);
    // prev "ab" → cur "中": the wide glyph replaces both columns → tinted.
    const out2 = highlightRow('ab', '中', 'cell');
    eq(out2, `${HL_ON}中${HL_OFF}`);
  });
});

describe('[7] painter integration — highlight is emit-only, never pollutes the diff', () => {
  it('paintFrame with cell opts highlights the changed row', () => {
    const r = paintFrame(['aaa'], ['aXa'], false, { mode: 'cell' });
    assert(r.ansi.includes(HL_ON), 'changed cell highlighted');
    assert(!r.didFull, 'incremental, not full');
  });
  it('repainting the SAME rows emits nothing (baseline not polluted by highlight)', () => {
    const r = paintFrame(['aXa'], ['aXa'], false, { mode: 'cell' });
    eq(r.ansi, '');
  });
  it('a FULL repaint never highlights (every row would tint)', () => {
    const r = paintFrame([], ['aXa'], true, { mode: 'cell' });
    assert(r.didFull, 'full');
    assert(!r.ansi.includes(HL_ON), 'no highlight on full repaint');
  });
  it('no opts → identical to the legacy plain path', () => {
    const plain = paintFrame(['aaa'], ['aXa'], false);
    const off = paintFrame(['aaa'], ['aXa'], false, { mode: 'off' });
    eq(plain.ansi, off.ansi);
    assert(!plain.ansi.includes(HL_ON), 'plain path has no highlight');
  });
});

report();
