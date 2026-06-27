/**
 * A3 (v0.6.7) — window-only decoration equivalence.
 *
 * The viewer now decorates only the visible window (search/selection highlight),
 * not the whole buffer, then renders it (renderPanel `windowed`). This must be
 * byte-identical to the old path (decorate the WHOLE buffer, then slice the
 * window) — each line is decorated from its own content + ABSOLUTE index, so
 * slice-then-decorate equals decorate-then-slice. This test pins that equivalence
 * across scroll offsets and the tricky cases (active match on/off window;
 * selection spanning, starting in, ending in, and straddling the window).
 *
 * The cost win itself is in bench-render-construction.js (270ms → 190µs at 50k
 * with an active search); this file guards correctness. Run:
 *   node js/test/test-window-decorate.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const search = require('../panel/viewer/search');
const select = require('../panel/viewer/select');
const { getInstanceSlice } = require('../panel/api');

const INNER_H = 38;

function doc(n) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    if (i % 7 === 0) out.push(`行 ${i} 宽字符 CJK 全角テスト fox ${i}`);  // wide chars + match
    else if (i % 13 === 0) out.push(`${i} 🚀 emoji ✓ ★ FOX mix ${i}`);   // emoji + uppercase match
    else if (i % 5 === 0) out.push(`line ${i}: no match here just text ${i}`);
    else out.push(`line ${i}: the quick brown fox jumps ${i}`);
  }
  return out;
}

// windowed == full-decorated-then-sliced, for every offset.
function assertSearchEquiv(label, lines, slice, offsets) {
  const full = search.decorateLines(lines, slice);           // whole buffer (offset 0)
  for (const start of offsets) {
    const fullWindow = full.slice(start, start + INNER_H);
    const win = search.decorateLines(
      lines.slice(start, start + INNER_H), slice, { offset: start, full: lines });
    eq(win, fullWindow, `${label} @offset ${start}`);
  }
}

describe('[1] search: windowed decoration == whole-buffer sliced', () => {
  const lines = doc(400);
  // idx 5 → an active match somewhere in the middle (reverse-highlighted).
  const slice = { search: { active: true, term: 'fox', idx: 5 } };
  const offsets = [0, 1, 50, 200, 362];   // top, near-top, mid, mid, near-end
  it('matches across the buffer, active match mid-buffer', () => {
    assertSearchEquiv('search', lines, slice, offsets);
  });
  it('active match exactly at a window edge', () => {
    // place the window so the active match's line is the first/last visible row
    const fullMatches = require('../leaves/text/search').matchesFor(lines, 'fox');
    const activeLine = fullMatches[5].line;
    assertSearchEquiv('edge', lines, slice,
      [Math.max(0, activeLine - INNER_H + 1), activeLine]);
  });
  it('no matches → passthrough, still window-equal', () => {
    assertSearchEquiv('nomatch', lines, { search: { active: true, term: 'zzzzz', idx: 0 } }, [0, 100]);
  });
  it('inactive search → passthrough', () => {
    assertSearchEquiv('inactive', lines, { search: { active: false, term: '', idx: 0 } }, [0, 100]);
  });
});

// select.decorateLines reads _detail().select; set it on the primary detail slice.
function withSelect(sel, fn) {
  const ds = getInstanceSlice('detail');
  const prev = ds.select;
  ds.select = sel;
  try { fn(); } finally { ds.select = prev; }
}
function assertSelectEquiv(label, lines, offsets) {
  const full = select.decorateLines(lines);                  // whole buffer (offset 0)
  for (const start of offsets) {
    const fullWindow = full.slice(start, start + INNER_H);
    const win = select.decorateLines(lines.slice(start, start + INNER_H), { offset: start });
    eq(win, fullWindow, `${label} @offset ${start}`);
  }
}

describe('[2] selection: windowed decoration == whole-buffer sliced', () => {
  const lines = doc(400);
  it('char selection spanning lines 60..75', () => {
    withSelect({ active: true, kind: 'char', anchor: { line: 60, col: 3 }, cursor: { line: 75, col: 12 } }, () => {
      // windows that: precede, contain, start-inside, end-inside, straddle the selection
      assertSelectEquiv('char', lines, [0, 40, 60, 70, 75, 100]);
    });
  });
  it('line selection 100..130', () => {
    withSelect({ active: true, kind: 'line', anchor: { line: 100, col: 0 }, cursor: { line: 130, col: 0 } }, () => {
      assertSelectEquiv('line', lines, [90, 100, 115, 130, 200]);
    });
  });
  it('inactive selection → passthrough', () => {
    withSelect({ active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } }, () => {
      assertSelectEquiv('inactive', lines, [0, 50]);
    });
  });
});

report();
