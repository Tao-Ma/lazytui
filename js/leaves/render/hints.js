/**
 * Key-hint lines as DECLARED data → markup + clickable chip spans
 * (docs/mouse-hit-map.md §renderOverlay contract).
 *
 * A popup's hint footer (`[y] confirm   [n] cancel`) used to be a hand-built
 * markup string — text that looked like buttons. Declaring it as data lets the
 * paint side publish each single-key hint as a hit-map chip whose handler is
 * that key, so clicking a hint IS pressing the key (dispatch.handleKey — the
 * keyboard path itself; mouse can't drift from keyboard).
 *
 *   formatHints([
 *     { cap: 'y', label: 'confirm', key: 'y' },
 *     { cap: 'n', label: 'cancel',  key: 'n' },
 *     { cap: '↑/↓', label: 'nav',   key: null },   // drawn, not clickable
 *   ])
 *   → { markup: '[dim]\\[y] confirm   \\[n] cancel   \\[↑/↓] nav[/]',
 *       chips:  [{ key: 'y', seq: 'y', x0: 0, x1: 10 }, { key: 'n', … }] }
 *
 * `cap` is the text inside the brackets; `key` is the handleKey token the chip
 * sends (`'return'`, `'escape'`, `'\t'`, `'backtab'`, `' '`, or a literal char;
 * `seq` defaults to `key`), or null for a non-key hint. Chip x0/x1 are visible
 * columns relative to the line start, inclusive, spanning the whole
 * `[cap] label` (a bigger target than the bracket alone).
 *
 * `chipSurvives` applies the truncation rule renderPanel uses (draw.truncate:
 * an over-wide line keeps `innerW - 1` cells then `…`), so a chip the box cut
 * publishes nothing.
 *
 * Pure leaf — depends only on the ansi text helpers.
 */
'use strict';

const { visibleLen, esc } = require('../text/ansi');

const SEP = '   ';

/** @returns {{ markup: string, chips: Array<{key, seq, x0, x1}> }} */
function formatHints(hints, opts) {
  const style = (opts && opts.style) || 'dim';
  const parts = [];
  const chips = [];
  let x = 0;
  for (const h of hints || []) {
    if (!h || h.cap == null) continue;
    if (parts.length) x += SEP.length;
    const label = h.label ? ` ${esc(String(h.label))}` : '';
    const part = `\\[${esc(String(h.cap))}]${label}`;
    const w = visibleLen(part);
    if (h.key != null && w > 0) {
      chips.push({ key: h.key, seq: h.seq != null ? h.seq : h.key, x0: x, x1: x + w - 1 });
    }
    parts.push(part);
    x += w;
  }
  return { markup: `[${style}]${parts.join(SEP)}[/]`, chips };
}

/** Does a chip spanning visible cols [x0..x1] of a line whose full visible
 *  width is `lineW` survive renderPanel's truncation at `innerW`? */
function chipSurvives(chip, lineW, innerW) {
  if (innerW <= 0) return false;
  const lastIntact = lineW <= innerW ? innerW - 1 : innerW - 2;
  return chip.x0 >= 0 && chip.x1 <= lastIntact;
}

module.exports = { formatHints, chipSurvives, SEP };
