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
 * The split is ansi `markupCut` — the walk `draw.truncate` cuts with: `\[` →
 * one literal `[`; `\x1b[…m` → zero-width SGR run; `[tag]` → zero-width markup;
 * otherwise the advance is one CELL's width (a sequence like ❤️ or a flag is one
 * cell, never cut — even with markup inside it, which the host joins across).
 * The SAME walk both halves of the split rely on, so visible-column accounting
 * agrees with every other paint-side consumer (visibleLen, truncate, cell-diff).
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

const { visibleLen, markupCut, pairTrailingBackslash } = require('../text/ansi');

/**
 * Split `text` after the most whole cells that fit in `col` visible columns
 * (ansi markupCut, non-greedy). Zero-width markup (`[tag]`, `\x1b[…m`) and
 * `\[` escapes route through verbatim. Returns `{ prefix, suffix, prefixW }`
 * where `prefix` holds the markup for the first `prefixW <= col` visible
 * columns and `suffix` is everything past the cut.
 *
 * When a wide (2-col) glyph straddles the cut, the split lands BEFORE
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
  const { cut, width } = markupCut(text, col, false);
  return { prefix: text.slice(0, cut), suffix: text.slice(cut), prefixW: width };
}

// Record on the buffer the columns [x0, x1) an overlay now covers on row `y`:
// `rows.covered` = Map(row → [[x0, x1), …]). Every overlay writes through
// compositeRow (draw.renderOverlay, the cmdline dropdown, the pane menu), so
// after the compositor pass the frame buffer says exactly which cells are on top
// of the panes. render/paint.js reads it for the terminal surfaces, which paint
// after the frame and outside its diff (leaves/render/occlusion). Non-enumerable:
// the buffer still compares and serializes as a plain row array.
function _cover(rows, y, x0, x1) {
  if (!rows.covered) Object.defineProperty(rows, 'covered', { value: new Map(), writable: true });
  const spans = rows.covered.get(y);
  if (spans) spans.push([x0, x1]);
  else rows.covered.set(y, [[x0, x1]]);
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
 * is topped up with blanks to keep the splice width exact. Records what it
 * covered on `rows.covered` (_cover).
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
  const leftPad = ox - left.prefixW;    // >0 iff a wide glyph straddled the LEFT edge (or the row is short)
  // Advance the main row to the overlay's RIGHT edge, ox + ow: its prefix is
  // discarded (the cells the overlay covers — and a wide glyph the left edge
  // cut, which starts at left.prefixW), its suffix is the right-of-overlay
  // remainder. A wide glyph straddling the right edge makes _splitAt stop one
  // column short, BEFORE it; it is cut too (no half glyph), so take it with the
  // prefix and stand a blank in for its right half.
  const need = ox + ow - left.prefixW;
  let right = _splitAt(left.suffix, need);
  if (right.prefixW < need) {
    const past = _splitAt(left.suffix, need + 1);
    if (past.prefixW === need + 1) right = past;
  }
  const rightPad = right.prefixW - need;  // 1 iff a wide glyph straddled the RIGHT edge
  const bodyVis = visibleLen(otext);
  const bodyPad = ow - bodyVis;         // >0 iff overlay was short of its promised width

  // The cut ends wherever the overlay's edge falls — after a lone `\` too (a
  // pane title `C:\tmp`, help's `Ctrl+\`), and a `\` before the `[/]` appended
  // here would escape it into the text `[/]`: pair it (ansi pairTrailingBackslash).
  rows[y] =
    pairTrailingBackslash(left.prefix) +
    (leftPad > 0 ? ' '.repeat(leftPad) : '') +
    '[/]' + pairTrailingBackslash(otext) + (bodyPad > 0 ? ' '.repeat(bodyPad) : '') + '[/]' +
    (rightPad > 0 ? ' '.repeat(rightPad) : '') +
    right.suffix;
  // The overlay body is [ox, ox + ow); leftPad/rightPad are blanks standing in
  // for a main-row wide glyph the edge cut, not overlay — what's beneath shows.
  _cover(rows, y, ox, ox + ow);
  return true;
}

module.exports = { compositeRow, _splitAt };
