/**
 * Occlusion of a terminal surface by the overlays on top of it — pure helpers.
 *
 * A terminal pane's grid is painted AFTER the main frame (render/paint.js
 * renderTerminalOverlay), outside the frame's cell-diff, while every popup
 * (palette, menus, which-key, confirm, tooltip, …) composites INTO the frame
 * (row-compositor.compositeRow). The frame buffer records the column spans each
 * composite covered (`rows.covered`), and the terminal painter draws only the
 * parts of each grid row that no overlay covers — so a popup stays on top while
 * the program keeps drawing around it, and when the popup closes the coverage
 * change repaints the rows it uncovered (the frame's diff paints the vacated
 * cells with the pane's blank body; the grid has to come back over them).
 *
 * Rows are styled runs `[{ sgr, text }]` (io/term-screen readViewport): `text`
 * advances `charWidth` columns per codepoint.
 */
'use strict';

const { charWidth, stringWidth } = require('../text/char-width');

/** The parts of [lo, hi) no span in `spans` ([[a, b), …], any order, may
 *  overlap or fall outside) covers, as [[a, b), …] left to right. */
function uncovered(lo, hi, spans) {
  const cuts = spans
    .map(([a, b]) => [Math.max(lo, a), Math.min(hi, b)])
    .filter(([a, b]) => a < b)
    .sort((p, q) => p[0] - q[0]);
  const out = [];
  let at = lo;
  for (const [a, b] of cuts) {
    if (a > at) out.push([at, a]);
    if (b > at) at = b;
  }
  if (at < hi) out.push([at, hi]);
  return out;
}

/** Columns [c0, c1) of a styled row, as runs. A wide glyph cut by either edge
 *  is not drawn half: its column inside the range becomes a blank in the
 *  glyph's own style, so the slice is exactly c1 − c0 columns. */
function sliceRuns(runs, c0, c1) {
  const out = [];
  let col = 0;
  let baseIn = false;                 // was the last glyph drawn? (its marks follow it)
  for (const r of runs) {
    if (col >= c1) break;
    let text = '';
    for (const ch of r.text) {
      const w = charWidth(ch.codePointAt(0));
      if (w === 0) { if (baseIn) text += ch; continue; }
      const start = col, end = col + w;
      col = end;
      baseIn = start >= c0 && end <= c1;
      if (end <= c0) continue;
      if (start >= c1) break;
      if (baseIn) text += ch;
      else text += ' '.repeat(Math.min(end, c1) - Math.max(start, c0));
    }
    if (text) {
      const last = out[out.length - 1];
      if (last && last.sgr === r.sgr) last.text += text;
      else out.push({ sgr: r.sgr, text });
    }
  }
  return out;
}

/** `runs` (`width` columns) with columns [col, col + w(insert)) replaced by
 *  `insert` runs; anything past `width` is dropped. */
function spliceRuns(runs, width, col, insert) {
  let w = 0;
  for (const r of insert) w += stringWidth(r.text);
  const end = Math.min(width, col + w);
  const mid = sliceRuns(insert, 0, end - col);
  return sliceRuns(runs, 0, col).concat(mid, sliceRuns(runs, end, width));
}

module.exports = { uncovered, sliceRuns, spliceRuns };
