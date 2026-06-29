/**
 * Cell-granular render diff (A2, v0.6.7) — correctness battery.
 *
 * A cell-diff bug shows as visible corruption, so the safety net is exact
 * reproduction: for each (prev, cur) row pair, apply the emitted patch to a
 * simulated terminal row that starts as the PREV-rendered row, and assert the
 * result is byte-for-byte the CUR-rendered row (glyph + active style per column,
 * wide-char continuations included). Plus MoveTo economy (one MoveTo per run of
 * adjacent changes) and a byte-savings sanity check.
 *
 * Run: node js/test/test-cell-grid.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { rowToCells, diffRowToAnsi } = require('../leaves/render/cell-grid');
const { richToAnsi, charWidth } = require('../leaves/text/ansi');

// Simulate applying a single-row patch to a terminal row pre-loaded with the
// prev-rendered cells. Mirrors a real terminal: MoveTo sets the column, SGR
// updates the active style (full reset clears), a glyph writes {g,w,sgr} at the
// cursor (wide glyph claims a continuation cell) and advances.
function applyPatch(prevMarkup, patch) {
  const cells = rowToCells(richToAnsi(prevMarkup));
  let col = 0, active = '', i = 0;
  while (i < patch.length) {
    if (patch[i] === '\x1b') {
      const mv = patch.slice(i).match(/^\x1b\[(\d+);(\d+)H/);
      if (mv) { col = parseInt(mv[2], 10) - 1; i += mv[0].length; continue; }
      const m = patch.slice(i).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
      if (m) {
        const seq = m[0];
        if (/^\x1b\[[0-9;]*m$/.test(seq)) {
          const body = seq.slice(2, -1);
          if (body === '' || body === '0') active = '';
          else active += seq;
        }
        i += seq.length; continue;
      }
    }
    const cp = patch.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (w === 0) {
      // Zero-width: the cursor didn't advance — fold into the last written
      // glyph (skip a wide glyph's continuation cell), mirroring the terminal.
      let base = col - 1;
      while (base >= 0 && cells[base] && cells[base].cont) base--;
      if (base >= 0 && cells[base]) cells[base] = { ...cells[base], g: cells[base].g + ch };
      i += ch.length;
      continue;
    }
    cells[col] = { g: ch, w, sgr: active };
    if (w === 2) cells[col + 1] = { cont: true };
    col += w;
    i += ch.length;
  }
  return cells;
}

// Compare two cell arrays; return a mismatch description or null when equal.
function cellsDiff(a, b) {
  const n = Math.max(a.length, b.length);
  for (let c = 0; c < n; c++) {
    const x = a[c], y = b[c];
    const gx = x ? (x.cont ? '∎' : x.g) : '·';
    const gy = y ? (y.cont ? '∎' : y.g) : '·';
    const sx = (x && !x.cont) ? x.sgr : '';
    const sy = (y && !y.cont) ? y.sgr : '';
    if (gx !== gy || sx !== sy) {
      return `col ${c}: got {${JSON.stringify(gx)}|${JSON.stringify(sx)}} want {${JSON.stringify(gy)}|${JSON.stringify(sy)}}`;
    }
  }
  return null;
}

function reproduces(prev, cur) {
  const patch = diffRowToAnsi(prev, cur, 0);
  const got = applyPatch(prev, patch);
  const want = rowToCells(richToAnsi(cur));
  return cellsDiff(got, want);
}

const cases = [
  ['identical rows',        'abcde',                 'abcde'],
  ['single interior glyph', 'abcde',                 'abXde'],
  ['leading glyph',         'abcde',                 'Xbcde'],
  ['trailing glyph',        'abcde',                 'abcdX'],
  ['full row',              'abcde',                 'vwxyz'],
  ['style-only change',     'ab[green]c[/]de',       'ab[red]c[/]de'],
  ['gain style on a glyph', 'abcde',                 'ab[bold]c[/]de'],
  ['adjacent run',          'abcde',                 'aXYZe'],
  ['two runs with a gap',   'abcde',                 'aXcYe'],
  ['reverse selection bar', '[reverse] item one',    '[reverse] item two'],
  ['wide → narrow',         '世Y',                    'abY'],
  ['narrow → wide',         'abY',                    '世Y'],
  ['wide glyph swap',       'X世Y',                   'X界Y'],
  ['narrow → wide midrow',  'XabY',                   'X世Y'],
  // v0.6.7 — kana/hangul are wide too (the charWidth fix). Same two-sided
  // wide-invalidation path as CJK; pinned here so the diff exercises them.
  // (equal visible width per pair, as composeRows guarantees in production)
  ['katakana swap',         'XテY',                   'XスY'],
  ['katakana → narrow',     'テスト',                 'abcdef'],
  ['hangul swap',           'X가Y',                   'X나Y'],
  ['hangul → katakana',     '가나다',                 'テスト'],
  // v0.6.7 round 2 — ZERO-WIDTH codepoints fold into the preceding glyph (the
  // terminal advances 0). charWidth=1 here drifted every absolute MoveTo right
  // (NFD text, ZWJ/VS emoji). Explicit escapes — a bare 'e\u0301' typed as NFC
  // would be one codepoint and NOT exercise folding; these are decomposed.
  ['NFD trailing change',   'e\u0301X', 'e\u0301Y'],         // é·X → é·Y (combiner unchanged)
  ['combining mark change', 'e\u0301X', 'e\u0300X'],         // e+acute → e+grave (folded glyph changes)
  ['VS16 emoji trailing',   '\u2764\ufe0fX', '\u2764\ufe0fY'], // heart+VS16 X → heart+VS16 Y
  ['add a combining mark',  'eX',             'e\u0301X'],     // e → é (gain a zero-width mark)
];

describe('cell-grid — patch reproduces the target row exactly', () => {
  for (const [name, prev, cur] of cases) {
    it(name, () => {
      const d = reproduces(prev, cur);
      assert(d === null, d || 'reproduced');
    });
  }
});

describe('cell-grid — MoveTo economy', () => {
  const moveCount = (s) => (s.match(/\x1b\[\d+;\d+H/g) || []).length;
  it('one run of adjacent changes → one MoveTo', () => {
    eq(moveCount(diffRowToAnsi('abcde', 'aXYZe', 0)), 1, 'single MoveTo for the run');
  });
  it('two runs separated by a gap → two MoveTos', () => {
    eq(moveCount(diffRowToAnsi('abcde', 'aXcYe', 0)), 2, 'one MoveTo per run');
  });
  it('no change → empty patch', () => {
    eq(diffRowToAnsi('abcde', 'abcde', 0), '', 'identical rows emit nothing');
  });
});

describe('cell-grid — byte savings vs whole-row repaint', () => {
  it('a one-cell change in a wide row emits far less than the full row', () => {
    const row = 'the quick brown fox jumps over the lazy dog and runs away fast';
    const cur = row.slice(0, 30) + 'X' + row.slice(31);
    const patch = diffRowToAnsi(row, cur, 5);
    const wholeRow = `\x1b[6;1H${richToAnsi(cur)}\x1b[0m\x1b[K`;
    assert(patch.length < wholeRow.length / 2,
      `cell patch (${patch.length}B) should be < half the whole-row emit (${wholeRow.length}B)`);
  });
});

report();
