/**
 * leaves/render/hints — declared key hints → markup + clickable chip spans
 * (docs/mouse-hit-map.md §renderOverlay contract).
 *
 *   [1] formatHints: markup unchanged vs the hand-built hint, chip columns
 *   [2] chipSurvives: renderPanel's truncation rule (… keeps innerW-1 cells)
 *   [3] seqForKey: the seq a REAL keystroke carries (named keys carry none)
 *
 * Run: node js/test/test-hints.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { formatHints, chipSurvives, seqForKey } = require('../leaves/render/hints');
const { visibleLen } = require('../leaves/text/ansi');

describe('[1] formatHints', () => {
  it('reproduces the hand-built confirm hint markup byte-for-byte', () => {
    const { markup } = formatHints([
      { cap: 'y', label: 'confirm', key: 'y' },
      { cap: 'n', label: 'cancel', key: 'n' },
    ]);
    eq(markup, '[dim]\\[y] confirm   \\[n] cancel[/]');
  });
  it('chip columns span the visible `[cap] label`, separated by 3 spaces', () => {
    const { chips, markup } = formatHints([
      { cap: 'y', label: 'confirm', key: 'y' },
      { cap: 'n', label: 'cancel', key: 'n' },
    ]);
    eq(chips, [
      { key: 'y', seq: 'y', x0: 0, x1: 10 },     // "[y] confirm" = 11 cells
      { key: 'n', seq: 'n', x0: 14, x1: 23 },    // 3 spaces, "[n] cancel" = 10 cells
    ]);
    eq(visibleLen(markup), 24);
  });
  it('key:null hints draw but publish no chip; seq overrides', () => {
    const { chips, markup } = formatHints([
      { cap: '↑/↓', label: 'nav', key: null },
      { cap: 'enter', label: 'run', key: 'return', seq: '\r' },
    ]);
    eq(markup, '[dim]\\[↑/↓] nav   \\[enter] run[/]');
    eq(chips.length, 1);
    eq(chips[0], { key: 'return', seq: '\r', x0: 12, x1: 22 });
  });
  it('labels are markup-escaped', () => {
    const { markup } = formatHints([{ cap: 'x', label: '[evil]', key: 'x' }]);
    eq(markup, '[dim]\\[x] \\[evil][/]');
  });
});

describe('[2] chipSurvives', () => {
  it('a line that fits keeps every chip', () => {
    assert(chipSurvives({ x0: 14, x1: 23 }, 24, 24), 'exact fit');
  });
  it('a truncated line keeps innerW-1 intact cells (the last is …)', () => {
    // 24-wide hint in a 20-wide box: cells 0..18 intact, col 19 = '…'.
    assert(chipSurvives({ x0: 0, x1: 10 }, 24, 20), 'first chip intact');
    assert(!chipSurvives({ x0: 14, x1: 23 }, 24, 20), 'second chip cut');
    assert(chipSurvives({ x0: 14, x1: 18 }, 24, 20), 'ends on the last intact cell');
    assert(!chipSurvives({ x0: 14, x1: 19 }, 24, 20), 'touches the ellipsis cell');
  });
  it('a non-positive inner width keeps nothing', () => {
    assert(!chipSurvives({ x0: 0, x1: 0 }, 1, 0));
  });
});

describe('[3] seqForKey', () => {
  it('single characters carry themselves; named keys carry nothing', () => {
    eq(seqForKey('y'), 'y');
    eq(seqForKey('\t'), '\t');
    eq(seqForKey(' '), ' ');
    for (const k of ['return', 'escape', 'backtab', 'up', 'down']) eq(seqForKey(k), undefined, k);
  });
  it('formatHints chips default their seq the same way', () => {
    const { chips } = formatHints([{ cap: 'esc', label: 'close', key: 'escape' }, { cap: 'y', label: 'yes', key: 'y' }]);
    eq(chips.map(c => c.seq), [undefined, 'y']);
  });
});

report();
