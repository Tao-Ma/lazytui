/**
 * Detail-panel search — vim/less-style `/pattern` with regex-by-default.
 *
 * Two phases:
 *   1. Typing phase (S.detailSearchMode === true): user types into a
 *      search buffer at the bottom. Each keystroke re-runs the matcher
 *      against S.detailLines (markup-stripped); every match becomes
 *      a {line, col, len} record. The matcher is forgiving — invalid
 *      regex (e.g. user typed `[` mid-pattern) yields an empty match
 *      list, never throws.
 *   2. Committed phase (S.detailSearchMode === false, S.detailSearch.active
 *      === true): the typing overlay is gone; matches stay highlighted
 *      in the detail panel; `n`/`N` cycle through them. `Esc` while in
 *      this phase clears the committed search.
 *
 * Regex flavor: JS RegExp with `gi` flags. Substring patterns like
 * `web-1` work as plain literals — `-` and digits aren't regex
 * metachars. Patterns like `error|warn` and `[0-9]+` behave like vim.
 *
 * Matches are stored as display columns (not codepoint indices) so the
 * highlight render can re-use the same column math the selection
 * highlighter uses. _displayWidthBefore() walks the plain text and
 * sums charWidth() of each codepoint to get the column count.
 */
'use strict';

const { S } = require('./state');
const { stripMarkup, charWidth } = require('./ansi');

function _ensure() {
  if (!S.detailSearch) {
    S.detailSearch = { active: false, term: '', matches: [], idx: 0 };
  }
}

// Module-private typing buffer. Stays separate from S.detailSearch.term
// (which is the *committed* term) so an in-progress edit doesn't leak
// into n/N navigation if the user backs out with Esc mid-typing.
let _typing = '';

function enter() {
  _ensure();
  _typing = S.detailSearch.term || '';
  S.detailSearchMode = true;
  recompute();
}

function cancel() {
  _ensure();
  // Esc during typing: drop the in-progress edit. If there was no
  // prior committed search, fully clear. If there was, restore it.
  _typing = '';
  S.detailSearchMode = false;
  if (!S.detailSearch.term) {
    S.detailSearch.matches = [];
    S.detailSearch.idx = 0;
    S.detailSearch.active = false;
  } else {
    // Re-match against the previously committed term so the highlights
    // stay consistent (in case detailLines mutated during typing).
    _recomputeFor(S.detailSearch.term);
  }
}

function commit() {
  _ensure();
  S.detailSearch.term = _typing;
  S.detailSearchMode = false;
  if (!_typing) {
    S.detailSearch.matches = [];
    S.detailSearch.idx = 0;
    S.detailSearch.active = false;
    return;
  }
  _recomputeFor(_typing);
  S.detailSearch.active = S.detailSearch.matches.length > 0;
  if (S.detailSearch.active) _scrollToActive();
}

function clearCommitted() {
  _ensure();
  _typing = '';
  S.detailSearch.term = '';
  S.detailSearch.matches = [];
  S.detailSearch.idx = 0;
  S.detailSearch.active = false;
}

function keystroke(seq) {
  _ensure();
  if (!S.detailSearchMode) return;
  if (seq === '\x7f') { _typing = _typing.slice(0, -1); recompute(); return; }
  if (seq === '\x15') { _typing = ''; recompute(); return; }
  if (seq && seq.length === 1 && seq.charCodeAt(0) >= 32 && seq.charCodeAt(0) < 127) {
    _typing += seq;
    recompute();
  }
}

function recompute() {
  _ensure();
  if (!_typing) {
    S.detailSearch.matches = [];
    S.detailSearch.idx = 0;
    return;
  }
  _recomputeFor(_typing);
}

/**
 * Run the matcher for `term` against S.detailLines and populate
 * S.detailSearch.matches. Invalid regex → empty matches (no throw).
 * Live-typing uses this; commit() uses this; cancel-restore uses this.
 */
function _recomputeFor(term) {
  _ensure();
  // safeRegex caps pattern length and rejects nested-quantifier shapes
  // that would otherwise freeze the event loop on .exec — same defense
  // as files.js's filter path.
  const { safeRegex } = require('./regex-guard');
  const rx = safeRegex(term, 'gi');
  if (!rx) {
    S.detailSearch.matches = [];
    S.detailSearch.idx = 0;
    return;
  }
  // Empty-match guard: patterns like `a*` can match empty strings at
  // every position. We'd loop forever in exec(). Detect by requiring
  // each subsequent match's index to advance past the prior one.
  const matches = [];
  const lines = S.detailLines || [];
  for (let li = 0; li < lines.length; li++) {
    const plain = stripMarkup(lines[li]);
    rx.lastIndex = 0;
    let prev = -1;
    let m;
    while ((m = rx.exec(plain)) !== null) {
      if (m.index <= prev) { rx.lastIndex = m.index + 1; continue; }
      prev = m.index;
      const col = _displayWidthBefore(plain, m.index);
      // Length in display columns — the matched text may contain
      // wide chars; sum charWidth across its codepoints.
      let len = 0;
      for (const ch of m[0]) len += charWidth(ch.codePointAt(0));
      if (len > 0) matches.push({ line: li, col, len });
      if (m.index === rx.lastIndex) rx.lastIndex++;  // zero-width safety
    }
  }
  S.detailSearch.matches = matches;
  // Keep idx in bounds; default to 0 on recompute (most common UX:
  // typing brings you to the first match).
  S.detailSearch.idx = matches.length ? 0 : 0;
}

/**
 * Display-column count of plain text up to (not including) codepoint
 * index `charIdx`. Used to translate regex match positions (UTF-16
 * code-unit indices, like all JS string ops) into display columns.
 */
function _displayWidthBefore(plain, charIdx) {
  // charIdx is a UTF-16 index. Iterate codepoints from the start and
  // accumulate width until we've consumed charIdx code units.
  let consumed = 0;
  let width = 0;
  for (const ch of plain) {
    if (consumed >= charIdx) break;
    width += charWidth(ch.codePointAt(0));
    consumed += ch.length;  // 1 for BMP, 2 for surrogate pair
  }
  return width;
}

function next() {
  _ensure();
  if (!S.detailSearch.matches.length) return;
  S.detailSearch.idx = (S.detailSearch.idx + 1) % S.detailSearch.matches.length;
  _scrollToActive();
}

function prev() {
  _ensure();
  if (!S.detailSearch.matches.length) return;
  const n = S.detailSearch.matches.length;
  S.detailSearch.idx = (S.detailSearch.idx - 1 + n) % n;
  _scrollToActive();
}

function _scrollToActive() {
  _ensure();
  const m = S.detailSearch.matches[S.detailSearch.idx];
  if (!m) return;
  const h = S.panelHeights && S.panelHeights.detail;
  const innerH = Math.max(1, (h || 6) - 2);
  const top = S.detailScroll || 0;
  // Center the match line in the viewport when feasible; clamp to
  // valid scroll range otherwise.
  if (m.line < top || m.line >= top + innerH) {
    const maxScroll = Math.max(0, S.detailLines.length - innerH);
    const desired = Math.max(0, m.line - Math.floor(innerH / 2));
    S.detailScroll = Math.max(0, Math.min(maxScroll, desired));
  }
}

function isActive() {
  _ensure();
  return !!(S.detailSearch && (S.detailSearch.active || S.detailSearchMode));
}

function typingText() {
  return _typing;
}

/**
 * Apply search highlights to a copy of `lines`. All matches get
 * [yellow]; the active one gets [reverse][yellow]. Pass-through when
 * no search is active.
 *
 * Composes with select.decorateLines — caller chains them. If both
 * are active and overlap on the same chars, selection's [reverse]
 * wins (rendered second by convention).
 */
function decorateLines(lines) {
  _ensure();
  if (!S.detailSearch.matches.length) return lines;
  // Group matches by line index for O(N) decoration.
  const byLine = new Map();
  S.detailSearch.matches.forEach((m, i) => {
    if (!byLine.has(m.line)) byLine.set(m.line, []);
    byLine.get(m.line).push({ ...m, _i: i });
  });
  const { highlightLine } = require('./select');
  const activeIdx = S.detailSearch.idx;
  return lines.map((line, i) => {
    const ms = byLine.get(i);
    if (!ms) return line;
    // Sort right-to-left so each highlightLine call's column math
    // doesn't get disturbed by earlier insertions. highlightLine
    // re-renders the whole line each call though, so we apply them
    // sequentially on the resulting markup. The rebuilt line carries
    // its own markup ([yellow]…[/]); plain text outside matches is
    // re-escaped. Each pass converts the line to plain → segments,
    // so multiple passes lose information. To avoid that, do a
    // multi-span single-pass instead.
    return _multiHighlight(line, ms, activeIdx);
  });
}

/**
 * Render `line` with multiple highlight spans in one pass. `spans`
 * is an array of {col, len, _i} (assumed non-overlapping and within
 * the line's display width); `activeIdx` flags which span to render
 * with the "current match" style.
 *
 * Drops the line's existing markup (same v1 tradeoff as
 * select.highlightLine — Rich's [/] is unstacked so weaving inside
 * [bold]…[/] would need outer-state replay).
 */
function _multiHighlight(line, spans, activeIdx) {
  const { stripMarkup, charWidth } = require('./ansi');
  const plain = stripMarkup(line);
  const chars = [...plain];
  // Build a codepoint-index → display-col cumulative array so we can
  // map [col, col+len) → codepoint range cheaply.
  const colAt = new Array(chars.length + 1);
  colAt[0] = 0;
  for (let i = 0; i < chars.length; i++) {
    colAt[i + 1] = colAt[i] + charWidth(chars[i].codePointAt(0));
  }
  const totalCols = colAt[chars.length];

  // Sort spans by col, drop any past line end.
  const sorted = spans
    .filter(s => s.col < totalCols)
    .sort((a, b) => a.col - b.col);

  const esc = (s) => s.replace(/\[/g, '\\[');
  let cursor = 0;  // codepoint index
  let out = '';
  for (const sp of sorted) {
    // Translate display col to codepoint idx.
    const startCp = _colToCp(colAt, sp.col);
    const endCp   = _colToCp(colAt, Math.min(totalCols, sp.col + sp.len));
    if (startCp < cursor || endCp <= startCp) continue;  // overlap/empty
    out += esc(chars.slice(cursor, startCp).join(''));
    const inner = esc(chars.slice(startCp, endCp).join(''));
    out += sp._i === activeIdx
      ? `[reverse][yellow]${inner}[/]`
      : `[yellow]${inner}[/]`;
    cursor = endCp;
  }
  out += esc(chars.slice(cursor).join(''));
  return out;
}

function _colToCp(colAt, displayCol) {
  // First codepoint whose start is at or after displayCol.
  for (let i = 0; i < colAt.length; i++) {
    if (colAt[i] >= displayCol) return i;
  }
  return colAt.length - 1;
}

module.exports = {
  enter, cancel, commit, clearCommitted, keystroke,
  next, prev, isActive, typingText,
  decorateLines,
  // exposed for tests
  recompute, _recomputeFor, _displayWidthBefore,
};
