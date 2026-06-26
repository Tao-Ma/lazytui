/**
 * Replay change-highlighting — per-row diff decoration (pure leaf).
 *
 * v0.6.6 replay arc. While replaying, the scrubber can tint what changed since
 * the previously-displayed frame so a step/seek's effect is visible at a glance.
 * The render path already computes the row-level delta (painter.paintFrame only
 * re-emits rows where `newRows[i] !== prevRows[i]`); this leaf sub-divides a
 * changed row down to the CELL.
 *
 * `highlightRow(prevMarkup, curMarkup, mode, hlOn, hlOff)` → the ANSI for the
 * current row with changed regions wrapped in the highlight SGR:
 *   - 'line' — the whole row (every visible cell) is the changed region.
 *   - 'cell' — only the visible columns whose GLYPH differs from prev
 *     (glyph-only: a style/color-only change — e.g. the selection bar moving —
 *     is not flagged; it already reads clearly via reverse-video).
 *   - anything else / 'off' — plain `richToAnsi(curMarkup)`.
 *
 * Both rows are converted to ANSI first (`richToAnsi`) so markup tags AND raw
 * SGR from streamed/terminal content unify into one syntax. The current row is
 * reproduced byte-for-byte; hlOn/hlOff are SPLICED around changed runs only — an
 * unchanged input yields output identical to `richToAnsi`. hlOn is re-asserted
 * after any interior SGR while inside a run (a passed-through reset would
 * otherwise clear the highlight background). The run is always closed before the
 * row ends, so the caller's trailing RESET + `\x1b[K` can't bleed the background
 * past end-of-line.
 *
 * Pure: string in, string out. No I/O, no module state. Lives in leaves/.
 */
'use strict';

const { richToAnsi, charWidth } = require('../text/ansi');

const HL_ON  = '\x1b[48;5;238m';   // subtle gray background (default highlight)
const HL_OFF = '\x1b[49m';         // reset BACKGROUND only — leaves foreground intact

// A CSI sequence (SGR + friends). Post-richToAnsi rows carry only SGR (`\x1b[…m`)
// — content cursor moves are stripped by the sanitizer — but pass through any
// zero-width CSI to be safe. Anchored: callers slice from the current index.
const _CSI = /^\x1b\[[0-9;?]*[ -/]*[@-~]/;

// Walk an ANSI row → { g: {startCol: glyph}, width }. Double-width (CJK) glyphs
// claim two columns; the start column holds the glyph, the continuation column
// has no entry. SGR sequences are zero-width.
function _glyphByCol(ansi) {
  const g = {};
  let col = 0, i = 0;
  while (i < ansi.length) {
    if (ansi[i] === '\x1b') {
      const m = ansi.slice(i).match(_CSI);
      if (m) { i += m[0].length; continue; }
    }
    const cp = ansi.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    g[col] = ch;
    col += charWidth(cp);
    i += ch.length;          // past the surrogate pair, if any
  }
  return { g, width: col };
}

// Which visible columns changed (glyph differs by start column). A wide glyph
// whose start differs taints both its columns so the whole cell tints.
function _changedCols(prevAnsi, curAnsi) {
  const a = _glyphByCol(prevAnsi);
  const b = _glyphByCol(curAnsi);
  const max = Math.max(a.width, b.width);
  const changed = new Array(max).fill(false);
  for (let c = 0; c < max; c++) {
    const ga = a.g[c], gb = b.g[c];
    if (ga !== gb) {
      changed[c] = true;
      const wide = (ga && charWidth(ga.codePointAt(0)) === 2) || (gb && charWidth(gb.codePointAt(0)) === 2);
      if (wide && c + 1 < max) changed[c + 1] = true;
    }
  }
  return changed;
}

// Reproduce `curAnsi` byte-for-byte, splicing hlOn/hlOff around runs of columns
// for which `isChanged(col)` is true.
function _emit(curAnsi, isChanged, hlOn, hlOff) {
  let out = '';
  let col = 0, i = 0, inRun = false;
  while (i < curAnsi.length) {
    if (curAnsi[i] === '\x1b') {
      const m = curAnsi.slice(i).match(_CSI);
      if (m) {
        out += m[0];
        if (inRun) out += hlOn;   // re-assert bg — a passed-through reset would clear it
        i += m[0].length;
        continue;
      }
    }
    const cp = curAnsi.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const want = isChanged(col);
    if (want && !inRun) { out += hlOn; inRun = true; }
    else if (!want && inRun) { out += hlOff; inRun = false; }
    out += ch;
    col += charWidth(cp);
    i += ch.length;
  }
  if (inRun) out += hlOff;
  return out;
}

function highlightRow(prevMarkup, curMarkup, mode, hlOn = HL_ON, hlOff = HL_OFF) {
  const curAnsi = richToAnsi(curMarkup);
  if (mode === 'line') return _emit(curAnsi, () => true, hlOn, hlOff);
  if (mode === 'cell') {
    const changed = _changedCols(richToAnsi(prevMarkup), curAnsi);
    return _emit(curAnsi, (c) => !!changed[c], hlOn, hlOff);
  }
  return curAnsi;
}

module.exports = { highlightRow, HL_ON, HL_OFF };
