/**
 * Cell-granular render diff (A2, v0.6.7) — pure leaf.
 *
 * The row painter (leaves/render/painter.js `paintFrame`) repaints a WHOLE row
 * whenever it changed (`\x1b[row;1H` + the full row + `\x1b[K`). That re-emits an
 * entire line for a one-cell change (a moving cursor, a spinner frame, one digit
 * in a footer). This module diffs a row CELL-by-CELL and emits only the changed
 * cells, with three byte-savings borrowed from Ratatui's `Buffer::diff`:
 *   - **MoveTo only on non-adjacency** — within a run of consecutive changed
 *     cells the cursor is already in place, so no `\x1b[..H` between them;
 *   - **SGR only on change** — the active style is re-asserted only when it
 *     differs from the previously emitted cell, carried across a run;
 *   - **two-sided wide-char invalidation** — when either side of a column is a
 *     double-width (CJK) glyph and it changed, its continuation column is tainted
 *     too, so a half-overwritten wide cell never lingers.
 *
 * Enabling invariant: `composeRows` pads every row to exactly `cols` visible
 * cells, so a row diff is column-for-column with NO length change — hence no
 * per-row `\x1b[K` is needed (cells are overwritten in place).
 *
 * Deterministic: output is a pure function of (prevMarkup, curMarkup, rowIdx), so
 * the emitted byte stream is itself a function of the model — replay-safe.
 *
 * Style model: rows come from richToAnsi, which is deterministic, so the SGR
 * bytes for a given style are stable. `rowToCells` accumulates the active SGR
 * (cleared by a full reset `\x1b[0m`/`\x1b[m`) and tags each glyph with it; two
 * cells are "equal" iff same glyph AND byte-identical active SGR. That is
 * CONSERVATIVE (a semantically-equal style reached via different bytes re-emits)
 * — never wrong, occasionally a few extra bytes; for richToAnsi output the bytes
 * match, so it is also minimal in practice.
 *
 * Pure: string in, string out. No I/O, no module state. Lives in leaves/.
 */
'use strict';

const { richToAnsi, charWidth, RESET } = require('../text/ansi');

// A CSI sequence. Post-richToAnsi rows carry SGR (`\x1b[…m`); pass through any
// other zero-width CSI defensively. Anchored: callers slice from the index.
const _CSI = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;
const _SGR = /^\x1b\[[0-9;]*m$/;

/**
 * Parse a post-richToAnsi row into an array indexed by VISIBLE column.
 *   - a glyph's start column → { g, w, sgr }  (w = 1 or 2; sgr = active style)
 *   - a wide glyph's continuation column → { cont: true }
 * Trailing SGR after the last glyph is dropped (no cell to attach it to).
 */
function rowToCells(ansi) {
  const cells = [];
  let active = '';
  let i = 0;
  while (i < ansi.length) {
    if (ansi[i] === '\x1b') {
      const m = ansi.slice(i).match(_CSI);
      if (m) {
        const seq = m[0];
        if (_SGR.test(seq)) {
          const body = seq.slice(2, -1);          // between '\x1b[' and 'm'
          if (body === '' || body === '0') active = '';   // full reset
          else active += seq;                     // accumulate
        }
        i += seq.length;
        continue;
      }
    }
    const cp = ansi.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp) || 1;
    cells.push({ g: ch, w, sgr: active });
    if (w === 2) cells.push({ cont: true });
    i += ch.length;
  }
  return cells;
}

/**
 * Diff two rows of the SAME screen position and return the minimal ANSI to turn
 * the prev-rendered row into the cur row. `rowIdx` is 0-based (emits
 * `\x1b[rowIdx+1;col+1H`). Returns '' when the rows render identically (rare:
 * the caller only invokes this when the markup strings differ, but a difference
 * confined to trailing SGR yields no visible-cell change).
 */
function diffRowToAnsi(prevMarkup, curMarkup, rowIdx) {
  const a = rowToCells(richToAnsi(prevMarkup));
  const b = rowToCells(richToAnsi(curMarkup));
  const cols = Math.max(a.length, b.length);

  // changed[col] — glyph or style differs. Two-sided wide invalidation: when a
  // wide glyph differs on either side, taint its continuation column too.
  const changed = new Array(cols).fill(false);
  for (let c = 0; c < cols; c++) {
    const pa = a[c], pb = b[c];
    const ga = pa ? (pa.cont ? 1 : pa.g) : 0;
    const gb = pb ? (pb.cont ? 1 : pb.g) : 0;
    const sa = (pa && !pa.cont) ? pa.sgr : '';
    const sb = (pb && !pb.cont) ? pb.sgr : '';
    if (ga !== gb || sa !== sb) {
      changed[c] = true;
      if (((pa && pa.w === 2) || (pb && pb.w === 2)) && c + 1 < cols) changed[c + 1] = true;
    }
  }

  let out = '';
  let cursor = -1;        // terminal cursor column (0-based); -1 = unknown
  let lastSgr = null;     // SGR last emitted this row (null = none yet → force)
  for (let c = 0; c < cols; c++) {
    if (!changed[c]) continue;
    const cell = b[c];
    if (!cell || cell.cont) continue;            // emit only at glyph starts
    if (c !== cursor) { out += `\x1b[${rowIdx + 1};${c + 1}H`; cursor = c; }
    if (cell.sgr !== lastSgr) { out += RESET + cell.sgr; lastSgr = cell.sgr; }
    out += cell.g;
    cursor += cell.w;
  }
  if (out) out += RESET;     // close the row so style can't bleed into later writes
  return out;
}

module.exports = { rowToCells, diffRowToAnsi };
