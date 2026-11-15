/**
 * match-core — the pure regex match scan shared by the main thread and the
 * bounded-match worker (leaves/text/regex-worker). Extracted from search.js so
 * BOTH sides run byte-identical matching: the worker proves a pattern terminates
 * within a wall-clock budget, then the main thread recomputes the real result
 * with this same code — so a "safe" verdict and the produced matches can't drift.
 *
 * Pure — no model/api/I/O. Depends only on the regex guard + the ansi width leaf.
 */
'use strict';

const { safeRegex } = require('./regex-guard');
const { stripMarkup } = require('./ansi');
const { nextCell } = require('./char-width');

/** The display columns [col, col + len) of plain text's UTF-16 range [a, b),
 *  widened to whole CELLS (char-width `nextCell`): a match that starts or ends
 *  inside a sequence — `❤` inside `❤️`, one flag letter — covers the whole
 *  glyph, never half of it. Translates regex match positions into columns. */
function _cellSpan(plain, a, b) {
  const cell = { end: 0 };
  let col = 0, start = -1;
  for (let i = 0; i < plain.length; i = cell.end) {
    const w = nextCell(plain, i, cell);
    if (start < 0 && cell.end > a) start = col;
    col += w;
    if (start >= 0 && cell.end >= b) break;
  }
  if (start < 0) start = col;
  return { col: start, len: col - start };
}

/** Display-column count of plain text before the cell holding UTF-16 index
 *  `charIdx` (all of the text when past its end). */
function _displayWidthBefore(plain, charIdx) {
  return _cellSpan(plain, charIdx, charIdx).col;
}

/** Run `term` (regex, gi) against `lines` → [{line, col, len}] in display
 *  columns. Invalid/empty-match-prone patterns yield [] (never throws). NOTE:
 *  a pathological pattern (catastrophic backtracking) can still take unbounded
 *  time HERE — callers on the hot path route through leaves/text/bounded-match,
 *  which runs this in a worker under a wall-clock budget. The heuristic guard in
 *  regex-guard is only a cheap first-line reject, not a completeness guarantee. */
function computeMatches(lines, term) {
  const rx = safeRegex(term, 'gi');
  if (!rx) return [];
  const matches = [];
  for (let li = 0; li < lines.length; li++) {
    const plain = stripMarkup(lines[li]);
    rx.lastIndex = 0;
    let prev = -1;
    let m;
    while ((m = rx.exec(plain)) !== null) {
      if (m.index <= prev) { rx.lastIndex = m.index + 1; continue; }
      prev = m.index;
      const { col, len } = _cellSpan(plain, m.index, m.index + m[0].length);
      if (len > 0) matches.push({ line: li, col, len });
      if (m.index === rx.lastIndex) rx.lastIndex++;  // zero-width safety
    }
  }
  return matches;
}

module.exports = { computeMatches, _displayWidthBefore };
