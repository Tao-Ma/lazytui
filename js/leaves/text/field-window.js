/**
 * Single-line text field window — the part of a field's text that fits in a
 * fixed number of columns, scrolled so the caret cell stays in view.
 *
 * Every caret-bearing one-line editor paints through this: the agent prompt
 * (where it was born, as agent.js `_inputLine`), the `:` cmdline (hardware
 * cursor at `caretCol`), the fabric-field popup, the ports-pane in-grid
 * editor, the fabric-form's focused field and choices filter, the action
 * palette filter, and the footer's filter / search / rename fields. Before,
 * only the agent prompt scrolled: the others painted the text from its start
 * and let the row truncate, so past the field's width the end of what was typed
 * — and the caret — went off the right edge (the cmdline's row was never
 * truncated at all: a long command wrapped the last row and scrolled the whole
 * screen).
 *
 * Measured in CELLS (char-width `cellsOf`: ❤️, 👍🏽, a flag, a CJK glyph are one
 * cell each, 2 columns), so the window never splits a glyph and never overruns.
 * The text is expected to be field text (printable.fieldText: no tabs, no
 * control sequences) — what is measured is what esc() paints.
 *
 * Pure leaf.
 */
'use strict';

const { cellsOf, stringWidth } = require('./char-width');

/**
 * @param {string} text    the field's text
 * @param {number} cursor  the caret as a UTF-16 offset (text.length = after
 *                         the last glyph; an offset inside a cell → that cell)
 * @param {number} avail   columns for everything the field paints: the `…`
 *                         marker when scrolled, the text, and the caret cell
 *                         (one blank column at the end of the text)
 * @returns {{clipped: boolean, before: string, at: string, after: string, caretCol: number}}
 *   clipped  — text was dropped on the left: paint a 1-column `…` first
 *   before   — the cells left of the caret
 *   at       — the cell under the caret ('' at the end: the caret is a blank)
 *   after    — the cells right of the caret that fit
 *   caretCol — the caret's 0-based column from the window's start (`…` included)
 */
function fieldWindow(text, cursor, avail) {
  const raw = text || '';
  const chars = cellsOf(raw);
  const cur = Math.max(0, Math.min(raw.length, cursor | 0));
  let c = 0;                                         // cells that END at or before the cursor
  for (let at = 0; c < chars.length && at + chars[c].length <= cur; c++) at += chars[c].length;
  const cw = chars.map(stringWidth);
  const cols = Math.max(1, avail | 0);
  const cursorW = c < chars.length ? cw[c] : 1;
  let toCursor = 0;                                  // columns before the cursor
  for (let i = 0; i < c; i++) toCursor += cw[i];
  let start = 0;
  if (toCursor + cursorW > cols) {
    // Scroll: drop cells from the left until the caret cell fits beside `…`.
    let used = toCursor + cursorW;
    while (start < c && used > cols - 1) { used -= cw[start]; toCursor -= cw[start]; start++; }
  }
  let end = c + (c < chars.length ? 1 : 0), w = 0;
  for (let i = start; i < end; i++) w += cw[i];
  const room = cols - (start > 0 ? 1 : 0);
  while (end < chars.length && w + cw[end] <= room) w += cw[end++];
  return {
    clipped: start > 0,
    before: chars.slice(start, c).join(''),
    at: c < chars.length ? chars[c] : '',
    after: chars.slice(c + 1, end).join(''),
    caretCol: (start > 0 ? 1 : 0) + toCursor,
  };
}

module.exports = { fieldWindow };
