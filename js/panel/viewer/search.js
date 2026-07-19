/**
 * Detail-panel search — vim/less-style `/pattern` with regex-by-default.
 *
 * Two phases:
 *   1. Typing phase (detailSearchMode === true): user types into a search
 *      buffer at the bottom. Each keystroke re-runs the matcher against the
 *      detail lines (markup-stripped); every match becomes a {line,col,len}
 *      record. Forgiving — invalid regex yields an empty match list.
 *   2. Committed phase (detailSearchMode false, search.active true): the
 *      typing overlay is gone; matches stay highlighted; `n`/`N` cycle
 *      through them; `Esc` clears the committed search.
 *
 * The typing-phase TRANSFORMS (matcher + keystroke/nav/commit/cancel) live in
 * the pure leaf js/leaves/search.js, called from the detail Component's
 * update. This module is the FACADE: thin wrappers binding the leaf for
 * non-reducer callers (select.js committed-phase n/N, tests), plus the
 * render-side highlight (decorateLines) which reads the detail slice's
 * `search`.
 *
 * Regex flavor: JS RegExp with `gi` flags. Matches are display columns.
 */
'use strict';

const { getModel } = require('../../model/store');
const ms = require('../../leaves/text/search');

// The typing-phase state + transforms live in the detail Component's
// slice + update. Every wrapper here dispatches a viewer_search_* Msg
// through the api facade so writes flow through viewer.update — the
// single writer for the viewer slice (docs/PRINCIPLES.md §12).
// All Msgs target the focused-or-sticky viewer; v0.6.1 Phase 8 —
// resolveTarget so multi-viewer routes searches into the right pane;
// null = no viewer registered, drop.
function _viewerTarget() { return require('../../panel/route').resolveTarget('viewer'); }
function _dispatch(msg) {
  const target = _viewerTarget();
  if (!target) return;
  return require('../../hosts/panel-host').dispatchMsg(require('../../panel/route').wrap(target, msg));
}
function _slice() {
  const target = _viewerTarget();
  return target ? require('../api').getInstanceSlice(target) : null;
}

function enter()            { _dispatch({ type: 'viewer_search_enter' }); }
function cancel()           { _dispatch({ type: 'viewer_search_cancel' }); }
function commit()           { _dispatch({ type: 'viewer_search_commit' }); }
function keystroke(seq)     { _dispatch({ type: 'viewer_search_key', seq }); }
function next()             { _dispatch({ type: 'viewer_search_nav', dir: +1 }); }
function prev()             { _dispatch({ type: 'viewer_search_nav', dir: -1 }); }
// Committed-search adapter (`n`/`N`/Esc after search committed) +
// tests. Dispatches into viewer.update; single-writer-per-slice
// holds. Pre-v0.6.1 these wrote route.setInstanceSlice directly —
// a TEA back-channel the audit caught.
function clearCommitted()    { _dispatch({ type: 'viewer_search_clear_committed' }); }
// P1 (viewer-lines selector) — recompute/_recomputeFor retired: matches
// derive via ms.matchesFor (chained selector); no stored list to refresh.

function isActive() {
  const search = _slice()?.search;
  return !!(search && (search.active || getModel().modes.detailSearchMode));
}

function typingText() { return _slice()?.search?.typing || ''; }

/**
 * Apply search highlights to a copy of `lines`. All matches get [yellow];
 * the active one gets [reverse][yellow]. Pass-through when no search active.
 * Render-side (reads the detail slice's `search`); composes with
 * select.decorateLines.
 */
// A3 (v0.6.7) — `opts.offset`/`opts.full`: decorate only the VISIBLE WINDOW.
// `lines` is the window (the ~innerH visible rows); `opts.offset` is the window's
// absolute start index; `opts.full` is the whole buffer (for matchesFor — the
// match list + active-match index must be computed over ALL content, not the
// window, or "match k of N" and the active-match reverse-highlight break). The
// match scan is memoized (ms.matchesFor, WeakMap on the full-array ref), so a
// pure scroll re-paints only the window and recomputes no matches. Output is
// byte-identical to the old whole-buffer decorate sliced to the window: each
// line is decorated from its OWN content + ABSOLUTE index, so slice-then-decorate
// equals decorate-then-slice. Defaults (offset 0, full = lines) reproduce the
// legacy whole-array behavior for direct callers (tests).
function decorateLines(lines, slice, opts) {
  const offset = (opts && opts.offset) || 0;
  const full = (opts && opts.full) || lines;
  const d = decorationFor(slice, full);
  if (!d) return lines;
  // Pure highlight geometry lives in the leaf now (ms.decorateWindow — mirror of
  // select-core#decorateWindow); this facade owns only the impure resolution.
  return ms.decorateWindow(lines, d.matches, d.activeIdx, offset);
}

/**
 * Resolve the search decoration inputs for a pane's `slice` over the whole
 * buffer `full`: `{ matches, activeIdx }`, or `null` when nothing is
 * highlighted. This is the IMPURE half (reads getModel + the focused slice);
 * the pure geometry that consumes it is ms.decorateWindow. Kept separate so the
 * text-view render leaf (U2a) can take `{matches, activeIdx}` as data.
 *
 * P4 review fix (multi-viewer): decorate with the RENDERED pane's search state,
 * not the focused pane's. The render path passes its own slice; legacy callers
 * without one fall back to the focused viewer (singleton-equivalent). Phase
 * picks the term — typing while the `/` prompt is open (live preview, FOCUSED
 * viewer only) vs the committed term; matches DERIVE from the buffer content
 * (ms.matchesFor memo) so highlights always align with what's shown.
 */
function decorationFor(slice, full) {
  const focusedSlice = _slice();
  const s = slice || focusedSlice;
  const search = s?.search;
  if (!search) return null;
  const typingPhase = getModel().modes.detailSearchMode && s === focusedSlice;
  const term = typingPhase
    ? (search.typing || '')
    : (search.active ? (search.term || '') : '');
  const matches = ms.matchesFor(full || [], term);
  if (!matches.length) return null;
  // Stale idx (content shrank since it was set) clamps into range.
  const activeIdx = Math.min(search.idx || 0, matches.length - 1);
  return { matches, activeIdx };
}

module.exports = {
  enter, cancel, commit, clearCommitted, keystroke,
  next, prev, isActive, typingText,
  decorateLines, decorationFor,
  // exposed for tests
  _displayWidthBefore: ms._displayWidthBefore,
};
