/**
 * v0.6.3 P3.1 — Rect painter.
 *
 * Two pure functions that together replace `paintColumns`:
 *
 *   composeRows(rects, cols, rows) → string[]
 *     Stamps each Rect's `lines[i]` at absolute screen position
 *     (rect.x, rect.y + i). For each output row, collects rects
 *     covering that row, sorts by x, stitches their lines together
 *     with blank-of-width filling any gaps. Output is exactly
 *     `rows` entries, each `cols` cells wide (visibleLen).
 *
 *   paintFrame(prevRows, newRows, force) → { ansi, didFull }
 *     Row-level diff between prevRows and newRows. Returns the
 *     ANSI bytes the caller should write to stdout + a flag for
 *     whether the entire screen was repainted (caller uses to
 *     re-arm the terminal-overlay diff cache).
 *
 * The "rects are positioned absolutely" semantics make the v0.6.2
 * column-shift bug class structurally impossible: a too-short
 * column leaves blank cells where it ended, not horizontal-shift-
 * into-missing-space. paintColumns' per-row column-concatenation
 * had the implicit invariant that every column emitted full-availH
 * rows; composeRows replaces it with explicit absolute positioning.
 *
 * P3.3 wires this up behind LAZYTUI_RECT_PAINTER=1; P3.6 deletes
 * paintColumns and the column-pad in renderNormal that was the
 * v0.6.2 (6d9ad31) local fix for the same bug class.
 */
'use strict';

const { richToAnsi, RESET, visibleLen } = require('../io/ansi');

/**
 * Stamp a list of rects into a screen-sized row array.
 *
 * `rects` is `[{ x, y, w, h, lines: string[] }]`. Each rect's
 * `lines[i]` is one row of content — expected to be `w` cells
 * wide (P2's _normalizeRender already enforces this for panel
 * renderers; tests may pass hand-built rects, in which case
 * mis-widthed lines pass through and may overflow the rect).
 *
 * Returns a `string[]` of length `rows`, each row exactly `cols`
 * cells wide. Gaps between rects fill with blanks; the right
 * remainder of each row pads to `cols`.
 *
 * Overlap behavior: when two rects cover the same cell, the
 * FIRST rect in sorted-by-x order wins — the painter advances
 * the row cursor past each rect's right edge, so any later rect
 * whose x falls before the cursor is skipped entirely. In normal
 * use rects don't overlap (each panel claims a disjoint column
 * region); this is recovery behavior, not a feature.
 */
function composeRows(rects, cols, rows) {
  const out = new Array(rows);
  // Index rects by the y range they touch — avoids re-scanning the
  // full rect list per row when row count grows. O(R) build, O(R)
  // worst-case per row but typically small (≤ column count).
  const byRow = new Array(rows);
  for (let y = 0; y < rows; y++) byRow[y] = [];
  for (const rect of rects) {
    if (!rect) continue;
    const yStart = Math.max(0, rect.y);
    const yEnd = Math.min(rows, rect.y + rect.h);
    for (let y = yStart; y < yEnd; y++) byRow[y].push(rect);
  }
  const blank = ' ';
  for (let y = 0; y < rows; y++) {
    const covering = byRow[y];
    if (covering.length === 0) {
      out[y] = blank.repeat(cols);
      continue;
    }
    covering.sort((a, b) => a.x - b.x);
    let row = '';
    let cursor = 0;
    for (const rect of covering) {
      // Skip rects whose x has already been overtaken by the cursor
      // (overlap — first-of-left wins by construction).
      if (rect.x < cursor) continue;
      if (rect.x > cursor) {
        row += blank.repeat(rect.x - cursor);
      }
      const lineIdx = y - rect.y;
      const line = rect.lines && rect.lines[lineIdx] != null ? rect.lines[lineIdx] : '';
      // Pad short lines to rect.w. P2's _normalizeRender enforces
      // line-width == rect.w in production, but the painter is
      // robust to under-padded fixture rects too — a short line
      // would otherwise let the next rect / right-pad slide into
      // the missing horizontal slot (same bug class composeRows
      // structurally closes between rects).
      const lineW = visibleLen(line);
      row += lineW < rect.w ? line + ' '.repeat(rect.w - lineW) : line;
      cursor = rect.x + rect.w;
    }
    if (cursor < cols) row += blank.repeat(cols - cursor);
    out[y] = row;
  }
  return out;
}

/**
 * Diff prevRows vs newRows; emit absolute-cursor-positioned ANSI
 * for the changed rows. When `force` is true OR the row count
 * changed, emit a full-screen clear + repaint.
 *
 * Returns `{ ansi: string, didFull: boolean }`. Caller writes ansi
 * to stdout. `didFull` lets the caller invalidate any sibling
 * diff caches (today's terminal-overlay prevFrame). Pure — no
 * stdout side-effect, no module-local mutation.
 */
function paintFrame(prevRows, newRows, force) {
  const n = newRows.length;
  let ansi = '';
  let didFull = false;
  if (force || prevRows.length !== n) {
    ansi += '\x1b[2J\x1b[H';
    for (let i = 0; i < n; i++) {
      ansi += `\x1b[${i + 1};1H` + richToAnsi(newRows[i]) + RESET + '\x1b[K';
    }
    didFull = true;
  } else {
    for (let i = 0; i < n; i++) {
      if (newRows[i] !== prevRows[i]) {
        ansi += `\x1b[${i + 1};1H` + richToAnsi(newRows[i]) + RESET + '\x1b[K';
      }
    }
  }
  return { ansi, didFull };
}

module.exports = { composeRows, paintFrame, visibleLen };
