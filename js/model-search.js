/**
 * Pure detail-`/`-search transforms over the detail slice.
 *
 * The matcher + the typing/nav/commit/cancel operations, called from the
 * detail Component's update. Each function takes the slice and mutates
 * it in place. App-global reads (model.panelHeights.detail for
 * scroll-to-match centering) go via lazy `getModel()`.
 *
 * Cross-layer concern: detailSearchMode is a ROOT chrome flag (modal handler
 * key — see modeChain). enter/commit/cancel don't write it directly;
 * instead they return whether the mode should turn on/off, and the
 * calling reducer branch in detail.update emits an apply_msg Cmd for
 * mode_set/mode_clear. Single-writer per layer.
 *
 * State homes (under slice.search): typing (in-progress buffer, separate
 * from the committed `term`), term, matches[{line,col,len}], idx, active.
 * scrollToActive reads/writes slice.scroll + reads getModel().panelHeights.detail
 * and slice.lines.
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
 *  columns. Invalid/empty-match-prone patterns yield [] (never throws/loops). */
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

function recomputeFor(slice, term) {
  const s = slice.search;
  s.matches = computeMatches(slice.lines || [], term);
  s.idx = 0;
}

function recompute(slice) {
  const s = slice.search;
  if (s.typing == null) s.typing = '';
  if (!s.typing) { s.matches = []; s.idx = 0; return; }
  recomputeFor(slice, s.typing);
}

/** Enter typing-phase. Returns { enableSearchMode: true } so the calling
 *  reducer branch dispatches mode_set for detailSearchMode (cross-layer
 *  flag write — model.modes is root chrome, not the viewer slice). */
function enter(slice) {
  const s = slice.search;
  s.typing = s.term || '';
  recompute(slice);
  return { enableSearchMode: true };
}

function cancel(slice) {
  const s = slice.search;
  // Esc during typing: drop the in-progress edit. No prior committed term →
  // fully clear; else restore the committed highlights.
  s.typing = '';
  if (!s.term) {
    s.matches = [];
    s.idx = 0;
    s.active = false;
  } else {
    recomputeFor(slice, s.term);
  }
  return { disableSearchMode: true };
}

function commit(slice) {
  const s = slice.search;
  s.term = s.typing || '';
  if (!s.term) {
    s.matches = [];
    s.idx = 0;
    s.active = false;
    return { disableSearchMode: true };
  }
  recomputeFor(slice, s.term);
  s.active = s.matches.length > 0;
  if (s.active) scrollToActive(slice);
  return { disableSearchMode: true };
}

function clearCommitted(slice) {
  const s = slice.search;
  s.typing = '';
  s.term = '';
  s.matches = [];
  s.idx = 0;
  s.active = false;
}

function keystroke(slice, seq) {
  // Caller guards on detailSearchMode (modal handler ensures we're in typing
  // phase before invoking this).
  const s = slice.search;
  if (s.typing == null) s.typing = '';
  if (seq === '\x7f') { s.typing = s.typing.slice(0, -1); recompute(slice); return; }
  if (seq === '\x15') { s.typing = ''; recompute(slice); return; }
  if (seq && seq.length === 1 && seq.charCodeAt(0) >= 32 && seq.charCodeAt(0) < 127) {
    s.typing += seq;
    recompute(slice);
  }
}

function next(slice) {
  const s = slice.search;
  if (!s.matches.length) return;
  s.idx = (s.idx + 1) % s.matches.length;
  scrollToActive(slice);
}

function prev(slice) {
  const s = slice.search;
  if (!s.matches.length) return;
  const n = s.matches.length;
  s.idx = (s.idx - 1 + n) % n;
  scrollToActive(slice);
}

/** Center the active match in the detail viewport when off-screen.
 *  Reads panelHeights from the layout Component's slice (Phase 1e). */
function scrollToActive(slice) {
  const s = slice.search;
  const m = s.matches[s.idx];
  if (!m) return;
  const layoutSlice = require('./plugins/api').getComponentSlice('layout');
  const ph = layoutSlice && layoutSlice.panelHeights;
  const h = ph && ph.detail;
  const innerH = Math.max(1, (h || 6) - 2);
  const top = slice.scroll || 0;
  if (m.line < top || m.line >= top + innerH) {
    const maxScroll = Math.max(0, slice.lines.length - innerH);
    const desired = Math.max(0, m.line - Math.floor(innerH / 2));
    slice.scroll = Math.max(0, Math.min(maxScroll, desired));
  }
}

module.exports = {
  computeMatches, _displayWidthBefore,
  enter, cancel, commit, clearCommitted, keystroke, recompute, recomputeFor,
  next, prev, scrollToActive,
};
