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
const { stripMarkup, charWidth } = require('./ansi');

/** Display-column count of plain text up to (not including) codepoint index
 *  `charIdx` (a UTF-16 index). Translates regex match positions into columns. */
function _displayWidthBefore(plain, charIdx) {
  let consumed = 0;
  let width = 0;
  for (const ch of plain) {
    if (consumed >= charIdx) break;
    width += charWidth(ch.codePointAt(0));
    consumed += ch.length;
  }
  return width;
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
      const col = _displayWidthBefore(plain, m.index);
      let len = 0;
      for (const ch of m[0]) len += charWidth(ch.codePointAt(0));
      if (len > 0) matches.push({ line: li, col, len });
      if (m.index === rx.lastIndex) rx.lastIndex++;  // zero-width safety
    }
  }
  return matches;
}

module.exports = { computeMatches, _displayWidthBefore };
