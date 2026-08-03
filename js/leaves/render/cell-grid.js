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
 * Style model (H1, docs/truecolor.md §Hardening): `rowToCells` FOLDS SGR into
 * a per-channel state — known attributes (bold/dim/italic/…, a bitmask with
 * their paired clears: 22 clears 1+2, 24 clears 4+21, …), fg / bg / underline
 * color (30-37/90-97, 38;5;n, 38;2;r;g;b and the 48/58 counterparts; 39/49/59
 * clear), full reset clears all, and rare unknown codes ride along as ordered
 * last-wins extras. Each glyph is tagged with the CANONICAL re-emission of
 * that state (one sequence, fixed channel order), so equal net style ⇒
 * identical string: cell equality stays a byte compare AND gains precision
 * (equal-net cells reached via different byte histories no longer re-emit).
 * The fold replaced plain accumulation (`active += seq`), which grew without
 * bound when styles changed with no interleaved reset — per-column-colored
 * content made cell N carry N concatenated sequences, a measured 128,530-byte
 * emit for ONE 120-col row. `cell.sgr` is now bounded by the channel count.
 * Malformed 38/48/58 tails are DROPPED (a terminal ignores them; re-emitting
 * them inside a rebuilt param list could make the terminal misparse what
 * follows).
 *
 * Pure: string in, string out. No I/O, no module state. Lives in leaves/.
 */
'use strict';

const { richToAnsi, charWidth, RESET } = require('../text/ansi');

// A CSI sequence. Post-richToAnsi rows carry SGR (`\x1b[…m`); pass through any
// other zero-width CSI defensively. STICKY (`y`), matched in place via
// `lastIndex` — H2 (docs/truecolor.md §Hardening): the previous anchored form
// was used as `ansi.slice(i).match(_CSI)`, allocating ~the remaining row per
// escape; escape-dense rows (per-column gradient graphs, colorful child
// output) paid quadratic allocation churn. `lastIndex` is always assigned
// before exec, so the shared regex carries no state between calls.
const _CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/y;
const _SGR = /^\x1b\[[0-9;]*m$/;

// H1 — per-channel SGR fold. Known attributes carry a bit each; the paired
// "off" codes clear exactly what the terminal clears. Everything the fold
// doesn't know is kept as a standalone extra param (safe anywhere in a
// rebuilt list — only 38/48/58 consume following params, and those are
// handled explicitly).
const _ATTR_BIT = { 1: 1, 2: 2, 3: 4, 4: 8, 5: 16, 6: 32, 7: 64, 8: 128, 9: 256, 21: 512, 51: 1024, 52: 2048, 53: 4096 };
const _ATTR_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 9, 21, 51, 52, 53];
const _ATTR_CLEAR = { 22: 1 | 2, 23: 4, 24: 8 | 512, 25: 16 | 32, 27: 64, 28: 128, 29: 256, 54: 1024 | 2048, 55: 4096 };

/** Fold one SGR body (the digits between `\x1b[` and `m`) into `st`. */
function _foldSgr(st, body) {
  const t = body.split(';');
  for (let i = 0; i < t.length; i++) {
    const n = t[i] === '' ? 0 : parseInt(t[i], 10);
    if (n === 0) { st.mask = 0; st.fg = null; st.bg = null; st.ul = null; if (st.ex) st.ex.length = 0; }
    else if (_ATTR_BIT[n]) st.mask |= _ATTR_BIT[n];
    else if (_ATTR_CLEAR[n]) st.mask &= ~_ATTR_CLEAR[n];
    else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) st.fg = String(n);
    else if (n === 39) st.fg = null;
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) st.bg = String(n);
    else if (n === 49) st.bg = null;
    else if (n === 38 || n === 48 || n === 58) {
      let val = null;
      const kind = t[i + 1] === '' ? 0 : parseInt(t[i + 1], 10);
      if (kind === 5 && i + 2 < t.length) { val = `${n};5;${parseInt(t[i + 2], 10)}`; i += 2; }
      else if (kind === 2 && i + 4 < t.length) {
        val = `${n};2;${parseInt(t[i + 2], 10)};${parseInt(t[i + 3], 10)};${parseInt(t[i + 4], 10)}`;
        i += 4;
      } else { i = t.length; }               // malformed tail — drop (see header)
      if (val !== null) { if (n === 38) st.fg = val; else if (n === 48) st.bg = val; else st.ul = val; }
    } else if (n === 59) st.ul = null;
    else {
      if (!st.ex) st.ex = [];
      const c = String(n);
      const k = st.ex.indexOf(c);
      if (k >= 0) st.ex.splice(k, 1);
      st.ex.push(c);                          // last occurrence wins, order kept
    }
  }
}

/** Canonical single-sequence re-emission of `st` ('' when default). */
function _sgrString(st) {
  if (!st.mask && st.fg === null && st.bg === null && st.ul === null && (!st.ex || !st.ex.length)) return '';
  const p = [];
  for (const a of _ATTR_ORDER) if (st.mask & _ATTR_BIT[a]) p.push(a);
  if (st.ex) for (const e of st.ex) p.push(e);
  if (st.fg !== null) p.push(st.fg);
  if (st.bg !== null) p.push(st.bg);
  if (st.ul !== null) p.push(st.ul);
  return `\x1b[${p.join(';')}m`;
}

/**
 * Parse a post-richToAnsi row into an array indexed by VISIBLE column.
 *   - a glyph's start column → { g, w, sgr }  (w = 1 or 2; sgr = active style)
 *   - a wide glyph's continuation column → { cont: true }
 * Trailing SGR after the last glyph is dropped (no cell to attach it to).
 */
function rowToCells(ansi) {
  const cells = [];
  const st = { mask: 0, fg: null, bg: null, ul: null, ex: null };
  let active = '';
  let i = 0;
  while (i < ansi.length) {
    if (ansi[i] === '\x1b') {
      _CSI.lastIndex = i;
      const m = _CSI.exec(ansi);
      if (m) {
        const seq = m[0];
        if (_SGR.test(seq)) {
          const body = seq.slice(2, -1);          // between '\x1b[' and 'm'
          if (body === '' || body === '0') {      // full reset (fast path)
            st.mask = 0; st.fg = null; st.bg = null; st.ul = null;
            if (st.ex) st.ex.length = 0;
            active = '';
          } else {
            _foldSgr(st, body);                   // H1 — per-channel fold
            active = _sgrString(st);
          }
        }
        i += seq.length;
        continue;
      }
    }
    const cp = ansi.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (w === 0) {
      // Zero-width (combining mark / ZWJ / variation selector): no column of its
      // own — the terminal folds it into the preceding glyph, so we must too, or
      // every absolute MoveTo after it drifts right. Append to the last real cell
      // (skip a wide glyph's continuation column). A leading combiner with no base
      // is dropped (matches the terminal; rows never start with one).
      let k = cells.length - 1;
      while (k >= 0 && cells[k].cont) k--;
      if (k >= 0) cells[k].g += ch;
      i += ch.length;
      continue;
    }
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
