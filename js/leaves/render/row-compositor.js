/**
 * Row compositor — the overlay-compositor migration (Release 2 of 3,
 * docs/overlay-compositor-migration.md). A pure leaf.
 *
 * Splices ONE overlay row into a main-frame row buffer at column `x`,
 * for `w` visible columns. Cells outside [x..x+w) are preserved verbatim;
 * cells inside the overlay rect get the overlay's content.
 *
 * Both inputs are Rich-markup strings (the format `painter.paintFrame`
 * compares and `richToAnsi` converts at emit time). Working in markup —
 * not already-converted ANSI — keeps the compositor out of the per-channel
 * SGR tracker (cell-grid.js); each overlay row carries its own balanced
 * `[/]` resets from `renderPanel`, so a markup-level splice preserves
 * terminal-state isolation without re-implementing the walker.
 *
 * Walk semantics mirror `draw.truncate`: `\[` → one literal `[`;
 * `\x1b[…m` → zero-width SGR run; `[tag]` → zero-width markup; otherwise
 * `charWidth(cp)` is the advance per codepoint. The SAME shared walker
 * both halves of the split rely on, so visible-column accounting agrees
 * with every other paint-side consumer (visibleLen, truncate, cell-diff).
 *
 * The caller (`draw.renderOverlay`) loops this per overlay row:
 *   for (let i = 0; i < content.length; i++)
 *     compositeRow(newRows, cols, content[i], offX, offY + i, menuW);
 *
 * Why `[/]` wraps the inserted overlay body: the main row may have an
 * open style spanning the splice region (e.g. a `[dim]…[/]` chip that
 * started before `x` and closes after `x+w`). Without the wrap, the
 * overlay would paint under that style; after the wrap, the overlay
 * resets to the screen baseline, paints its own styling, and resets
 * again before the main-row suffix picks up where it left off. The
 * main-row suffix carries whatever SGR state it needs from its OWN
 * leading markup inside the suffix (`renderPanel`'s row shape puts a
 * `[fc]`/`[/]` guard at each component boundary, so cross-boundary
 * SGR carry is bounded by the next reset in the suffix). This is the
 * same `[/]`-is-a-hard-reset invariant that panels already rely on.
 */
'use strict';

const { visibleLen, charWidth } = require('../text/ansi');

// Match an SGR run — raw (`\x1b[…m`) or esc()'d (`\x1b\[…m`). Zero visible
// width, kept verbatim through the split. STICKY (`y`) to avoid slicing
// per step — mirrors the `_SGR_RUN` pattern in draw.truncate so both
// walkers tokenise raw SGR the same way.
const _SGR_RUN = /\x1b\\?\[[0-9;]*m/y;

/**
 * Walk `text` consuming cells until `col` visible columns have been
 * emitted. Zero-width markup (`[tag]`, `\x1b[…m`) and `\[` escapes
 * route through verbatim. Returns `{ prefix, suffix, prefixW }` where
 * `prefix` holds the markup for the first `prefixW <= col` visible
 * columns and `suffix = text.slice(i)` is everything past the cut.
 *
 * When a wide (2-col) glyph straddles the cut, the walker stops BEFORE
 * it — `prefixW` can lag `col` by one; the caller pads with a blank so
 * the output cell count still matches `col` exactly.
 *
 * Any trailing zero-width markup/SGR at the exact column boundary ends
 * up in `suffix`; this keeps the walker's state local (no "scan ahead
 * for a tag we don't own") and makes the split invertible — concatenating
 * prefix + suffix yields the original.
 */
function _splitAt(text, col) {
  if (col <= 0) return { prefix: '', suffix: text, prefixW: 0 };
  let prefix = '';
  let w = 0;
  let i = 0;
  const n = text.length;
  while (i < n && w < col) {
    if (text[i] === '\\' && text[i + 1] === '[') {
      if (w + 1 > col) break;
      prefix += '\\[';
      w += 1;
      i += 2;
      continue;
    }
    if (text[i] === '\x1b') {
      _SGR_RUN.lastIndex = i;
      const m = _SGR_RUN.exec(text);
      if (m) { prefix += m[0]; i += m[0].length; continue; }
    }
    if (text[i] === '[') {
      const close = text.indexOf(']', i);
      if (close !== -1) { prefix += text.slice(i, close + 1); i = close + 1; continue; }
      // unmatched `[` → fall through as visible char
    }
    const cp = text.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = charWidth(cp);
    if (w + cw > col) break;
    prefix += ch;
    w += cw;
    i += ch.length;
  }
  return { prefix, suffix: text.slice(i), prefixW: w };
}

/**
 * Composite one overlay row into `rows[y]` at column `x` for `w` cells.
 *
 * MUTATES `rows[]` in place. Returns `true` on composite, `false` when
 * the overlay is off-screen (y out of range, w <= 0, or x >= cols).
 *
 * `rows[y]` AND `overlayText` are Rich-markup strings; the result is
 * also Rich markup (same format), so this plugs directly into the
 * `painter.composeRows` output that `paintFrame` consumes.
 *
 * The overlay's own visible width is NOT inferred from `w` — the caller
 * passes `w` as the target cell count (menuW from `renderPanel`), and
 * `overlayText` is trusted to measure exactly `w` cells. A short overlay
 * row (shouldn't happen in practice; `renderPanel` right-pads to menuW)
 * is topped up with blanks to keep the splice width exact.
 */
function compositeRow(rows, cols, overlayText, x, y, w) {
  if (!rows || y < 0 || y >= rows.length) return false;
  if (w <= 0 || x >= cols) return false;
  // Clamp the overlay rect to the main row — a trailing panel edge off the
  // right of the screen or an anchor that overshot can land us here; we
  // trim rather than refuse so the visible portion still composites.
  let ox = x, ow = w, otext = overlayText;
  if (ox < 0) {
    const trimLeft = -ox;
    const cut = _splitAt(otext, trimLeft);
    otext = cut.suffix;
    ow -= cut.prefixW;
    // If a wide glyph straddles the trim, _splitAt stops short; drop that
    // column too (we discard the glyph entirely since its continuation
    // would land in the kept portion with no leading half).
    if (cut.prefixW < trimLeft) ow -= (trimLeft - cut.prefixW);
    ox = 0;
    if (ow <= 0) return false;
  }
  if (ox + ow > cols) {
    const keep = cols - ox;
    if (keep <= 0) return false;
    const cut = _splitAt(otext, keep);
    otext = cut.prefix;
    ow = cut.prefixW;
  }

  const row = rows[y];
  const left = _splitAt(row, ox);
  // Advance over `ow` cells of the main row; its prefix is discarded (the
  // cells the overlay covers), its suffix is the right-of-overlay remainder.
  const right = _splitAt(left.suffix, ow);

  const leftPad = ox - left.prefixW;    // >0 iff a wide glyph straddled the LEFT edge
  const bodyVis = visibleLen(otext);
  const bodyPad = ow - bodyVis;         // >0 iff overlay was short of its promised width
  // When a wide glyph straddled the RIGHT edge of the overlay rect, right.prefixW
  // can run ONE short of `ow` — the discarded prefix stopped before the glyph,
  // leaving one invisible column. The main-row suffix picks up PAST the glyph,
  // which is correct (the glyph is gone), but we need a filler cell to keep the
  // total row width exact.
  const rightPad = ow - right.prefixW;

  rows[y] =
    left.prefix +
    (leftPad > 0 ? ' '.repeat(leftPad) : '') +
    '[/]' + otext + (bodyPad > 0 ? ' '.repeat(bodyPad) : '') + '[/]' +
    (rightPad > 0 ? ' '.repeat(rightPad) : '') +
    right.suffix;
  return true;
}

module.exports = { compositeRow, _splitAt };
