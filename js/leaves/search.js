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
 * from the committed `term`), term, idx, active. P1 (viewer-lines
 * selector arc) — matches are NOT stored: `matchesFor(lines, term)` is a
 * ref-keyed memo (a chained selector over the displayed lines), so they
 * can never go stale against content and the old recompute/transition-
 * detect machinery is gone. Callers pass `lines` + the phase-correct
 * term (typing during detailSearchMode, committed `term` after) — each
 * call site knows its phase, the slice doesn't have to.
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

// --- the chained selector (P1, viewer-lines selector arc) ---

const EMPTY_MATCHES = [];   // shared ref — no-term lookups are ref-stable

// lines-array ref → { term, matches }. WeakMap keyed on the content
// array: per-viewer-per-content entry (multi-viewer safe — two viewers
// hold distinct arrays), GC-collected with the content, recomputed
// exactly when the (lines ref, term) pair changes. This is the
// replacement for BOTH the stored slice.search.matches AND the
// finalizer's ref-equality transition-detect: derived matches cannot
// go stale against content, so nothing has to notice content changed.
const _matchMemo = new WeakMap();

/** Matches of `term` over `lines` — memoized chained selector.
 *  Same (lines ref, term) → same matches ref. */
function matchesFor(lines, term) {
  if (!term || !Array.isArray(lines) || lines.length === 0) return EMPTY_MATCHES;
  const hit = _matchMemo.get(lines);
  if (hit && hit.term === term) return hit.matches;
  const matches = computeMatches(lines, term);
  _matchMemo.set(lines, { term, matches });
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

/** Enter typing-phase. Returns `[newSlice, { enableSearchMode: true }]`
 *  so the calling reducer branch dispatches mode_set for
 *  detailSearchMode (cross-layer flag write — model.modes is root
 *  chrome, not the viewer slice). */
function enter(slice) {
  const seed = slice.search.term || '';
  return [_withSearch(slice, { typing: seed, idx: 0 }), { enableSearchMode: true }];
}

function cancel(slice) {
  // Esc during typing: drop the in-progress edit. No prior committed
  // term → fully clear; else the committed highlights reappear on their
  // own (consumers derive from `term` once detailSearchMode drops).
  const s = slice.search;
  const next = s.term
    ? _withSearch(slice, { typing: '', idx: 0 })
    : _withSearch(slice, { typing: '', idx: 0, active: false });
  return [next, { disableSearchMode: true }];
}

function commit(slice, innerH, lines) {
  const term = slice.search.typing || '';
  if (!term) {
    return [_withSearch(slice, { term: '', idx: 0, active: false }), { disableSearchMode: true }];
  }
  let next = _withSearch(slice, { term, idx: 0 });
  const active = matchesFor(lines || [], term).length > 0;
  next = _withSearch(next, { active });
  if (active) next = scrollToActive(next, innerH, lines, term);
  return [next, { disableSearchMode: true }];
}

function clearCommitted(slice) {
  return _withSearch(slice, { typing: '', term: '', idx: 0, active: false });
}

function keystroke(slice, seq) {
  // Caller guards on detailSearchMode (modal handler ensures we're in
  // typing phase before invoking this). idx resets per edit (the match
  // list the idx points into derives from the new typing term).
  const typing = slice.search.typing == null ? '' : slice.search.typing;
  if (seq === '\x7f') return _withSearch(slice, { typing: typing.slice(0, -1), idx: 0 });
  if (seq === '\x15') return _withSearch(slice, { typing: '', idx: 0 });
  if (seq && seq.length === 1 && seq.charCodeAt(0) >= 32 && seq.charCodeAt(0) < 127) {
    return _withSearch(slice, { typing: typing + seq, idx: 0 });
  }
  return slice;
}

// next/prev take `lines` + the phase-correct `term` explicitly: the
// viewer_search_nav arm (typing phase) passes search.typing; the n/N
// key arm (committed phase) passes search.term. The call site knows
// the phase — the slice doesn't have to store which term is live.
// A stale idx (content shrank since it was set) re-enters at 0.
function next(slice, innerH, lines, term) {
  const matches = matchesFor(lines, term);
  if (!matches.length) return slice;
  const cur = slice.search.idx < matches.length ? slice.search.idx : -1;
  return scrollToActive(_withSearch(slice, { idx: (cur + 1) % matches.length }), innerH, lines, term);
}

function prev(slice, innerH, lines, term) {
  const matches = matchesFor(lines, term);
  if (!matches.length) return slice;
  const n = matches.length;
  const cur = slice.search.idx < n ? slice.search.idx : 1;
  return scrollToActive(_withSearch(slice, { idx: (cur - 1 + n) % n }), innerH, lines, term);
}

/** Center the active match in the detail viewport when off-screen.
 *  `innerH` is the caller-supplied viewport height (rows inside the
 *  border) — the one terminal-derived value this leaf can't read pure.
 *  Returns a new slice with updated `scroll` only when a scroll is
 *  actually needed; same ref otherwise. */
function scrollToActive(slice, innerH, lines, term) {
  const matches = matchesFor(lines, term);
  const m = matches[slice.search.idx];
  if (!m) return slice;
  const h = Math.max(1, innerH || 4);
  const top = slice.scroll || 0;
  if (m.line < top || m.line >= top + h) {
    const maxScroll = Math.max(0, lines.length - h);
    const desired = Math.max(0, m.line - Math.floor(h / 2));
    const scroll = Math.max(0, Math.min(maxScroll, desired));
    return { ...slice, scroll };
  }
  return slice;
}

module.exports = {
  computeMatches, matchesFor, _displayWidthBefore,
  enter, cancel, commit, clearCommitted, keystroke,
  next, prev, scrollToActive,
};
