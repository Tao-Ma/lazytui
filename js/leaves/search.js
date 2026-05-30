/**
 * Pure detail-`/`-search transforms over the detail slice.
 *
 * The matcher + the typing/nav/commit/cancel operations, called from the
 * detail Component's update. Each function takes the slice and returns
 * a NEW slice (or the same ref on no-op), matching the post-Phase-1
 * pure-TEA shape. Some operations return `[newSlice, info]` where
 * `info` carries cross-layer signals the caller folds into Cmds.
 *
 * Cross-layer concern: detailSearchMode is a ROOT chrome flag (modal
 * handler key — see modeChain). enter/commit/cancel don't write it
 * directly; instead they return whether the mode should turn on/off,
 * and the calling reducer branch in detail.update emits an apply_msg
 * Cmd for mode_set/mode_clear. Single-writer per layer.
 *
 * State homes (under slice.search): typing (in-progress buffer, separate
 * from the committed `term`), term, matches[{line,col,len}], idx, active.
 * scrollToActive returns a new slice with updated `scroll` when a scroll
 * is needed; the caller threads `innerH` (the detail viewport's inner
 * height) since the leaf is dependency-free.
 */
'use strict';

const { safeRegex } = require('./regex-guard');
const { stripMarkup, charWidth } = require('../io/ansi');

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

// --- pure transforms over slice.search ---
//
// Each public fn takes `slice` and returns `[newSlice, info]` (or just
// `newSlice` for the internal helpers). `info` carries cross-layer
// signals — today: { enableSearchMode } / { disableSearchMode } — that
// the calling reducer branch turns into apply_msg Cmds for mode_set /
// mode_clear on detailSearchMode. The leaves never write
// model.modes themselves (single-writer per layer).

function _withSearch(slice, patch) {
  return { ...slice, search: { ...slice.search, ...patch } };
}

/** Compute matches + reset idx. Pure: returns new slice. */
function recomputeFor(slice, term) {
  const matches = computeMatches(slice.lines || [], term);
  return _withSearch(slice, { matches, idx: 0 });
}

/** Recompute against the typing buffer (or empty if no typing). */
function recompute(slice) {
  const typing = slice.search.typing == null ? '' : slice.search.typing;
  if (!typing) return _withSearch(slice, { typing, matches: [], idx: 0 });
  return recomputeFor(_withSearch(slice, { typing }), typing);
}

/** Enter typing-phase. Returns `[newSlice, { enableSearchMode: true }]`
 *  so the calling reducer branch dispatches mode_set for
 *  detailSearchMode (cross-layer flag write — model.modes is root
 *  chrome, not the viewer slice). */
function enter(slice) {
  const seed = slice.search.term || '';
  return [recompute(_withSearch(slice, { typing: seed })), { enableSearchMode: true }];
}

function cancel(slice) {
  // Esc during typing: drop the in-progress edit. No prior committed term →
  // fully clear; else restore the committed highlights.
  const s = slice.search;
  let next;
  if (!s.term) {
    next = _withSearch(slice, { typing: '', matches: [], idx: 0, active: false });
  } else {
    next = recomputeFor(_withSearch(slice, { typing: '' }), s.term);
  }
  return [next, { disableSearchMode: true }];
}

function commit(slice, innerH) {
  const term = slice.search.typing || '';
  if (!term) {
    return [_withSearch(slice, { term: '', matches: [], idx: 0, active: false }), { disableSearchMode: true }];
  }
  let next = recomputeFor(_withSearch(slice, { term }), term);
  const active = next.search.matches.length > 0;
  next = _withSearch(next, { active });
  if (active) next = scrollToActive(next, innerH);
  return [next, { disableSearchMode: true }];
}

function clearCommitted(slice) {
  return _withSearch(slice, { typing: '', term: '', matches: [], idx: 0, active: false });
}

function keystroke(slice, seq) {
  // Caller guards on detailSearchMode (modal handler ensures we're in
  // typing phase before invoking this).
  const typing = slice.search.typing == null ? '' : slice.search.typing;
  if (seq === '\x7f') return recompute(_withSearch(slice, { typing: typing.slice(0, -1) }));
  if (seq === '\x15') return recompute(_withSearch(slice, { typing: '' }));
  if (seq && seq.length === 1 && seq.charCodeAt(0) >= 32 && seq.charCodeAt(0) < 127) {
    return recompute(_withSearch(slice, { typing: typing + seq }));
  }
  return slice;
}

function next(slice, innerH) {
  const s = slice.search;
  if (!s.matches.length) return slice;
  return scrollToActive(_withSearch(slice, { idx: (s.idx + 1) % s.matches.length }), innerH);
}

function prev(slice, innerH) {
  const s = slice.search;
  if (!s.matches.length) return slice;
  const n = s.matches.length;
  return scrollToActive(_withSearch(slice, { idx: (s.idx - 1 + n) % n }), innerH);
}

/** Center the active match in the detail viewport when off-screen.
 *  `innerH` is the caller-supplied viewport height (rows inside the
 *  border) — the one terminal-derived value this leaf can't read pure.
 *  Returns a new slice with updated `scroll` only when a scroll is
 *  actually needed; same ref otherwise. */
function scrollToActive(slice, innerH) {
  const s = slice.search;
  const m = s.matches[s.idx];
  if (!m) return slice;
  const h = Math.max(1, innerH || 4);
  const top = slice.scroll || 0;
  if (m.line < top || m.line >= top + h) {
    const maxScroll = Math.max(0, slice.lines.length - h);
    const desired = Math.max(0, m.line - Math.floor(h / 2));
    const scroll = Math.max(0, Math.min(maxScroll, desired));
    return { ...slice, scroll };
  }
  return slice;
}

module.exports = {
  computeMatches, _displayWidthBefore,
  enter, cancel, commit, clearCommitted, keystroke, recompute, recomputeFor,
  next, prev, scrollToActive,
};
