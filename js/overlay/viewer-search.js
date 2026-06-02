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

const { getModel } = require('../app/runtime');
const ms = require('../leaves/search');

// The typing-phase state + transforms live in the detail Component's
// slice + update. The user-facing wrappers dispatch viewer_search_* Msgs
// (handled by detail.update, which emits the cross-layer mode_set /
// mode_clear Cmds); low-level helpers (recompute, clearCommitted) still
// mutate the slice directly via the api facade.
// All Msgs target the focused-or-sticky viewer (viewer_search_*).
// v0.6.1 Phase 8 — resolveTarget so multi-viewer routes searches into
// the right pane; null = no viewer registered, drop. _slice reads the
// same resolved target.
function _viewerTarget() { return require('../leaves/route').resolveTarget('viewer'); }
function _dispatch(msg) {
  const target = _viewerTarget();
  if (!target) return;
  const api = require('../panel/api');
  return api.dispatchMsg(api.wrap(target, msg));
}
function _slice() {
  const target = _viewerTarget();
  return target ? require('../panel/api').getInstanceSlice(target) : null;
}

function enter()            { _dispatch({ type: 'viewer_search_enter' }); }
function cancel()           { _dispatch({ type: 'viewer_search_cancel' }); }
function commit()           { _dispatch({ type: 'viewer_search_commit' }); }
function keystroke(seq)     { _dispatch({ type: 'viewer_search_key', seq }); }
function next()             { _dispatch({ type: 'viewer_search_nav', dir: +1 }); }
function prev()             { _dispatch({ type: 'viewer_search_nav', dir: -1 }); }
// Pure-TEA conversion (Phase 1d): the leaf returns a new slice — these
// facades write the result back to the slice store. Used by tests + the
// committed-search `n`/`N`/Esc adapter; production search-mode is
// already routed through viewer.update's Msg arms.
function _writeBack(next) {
  const target = _viewerTarget();
  if (target) require('../leaves/route').setInstanceSlice(target, next);
}
function clearCommitted()    { const s = _slice(); if (s) _writeBack(ms.clearCommitted(s)); }
function recompute()         { const s = _slice(); if (s) _writeBack(ms.recompute(s)); }
function _recomputeFor(term) { const s = _slice(); if (s) _writeBack(ms.recomputeFor(s, term)); }

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
function decorateLines(lines) {
  const search = _slice()?.search;
  if (!search || !search.matches.length) return lines;
  // Group matches by line index for O(N) decoration.
  const byLine = new Map();
  search.matches.forEach((m, i) => {
    if (!byLine.has(m.line)) byLine.set(m.line, []);
    byLine.get(m.line).push({ ...m, _i: i });
  });
  const activeIdx = search.idx;
  return lines.map((line, i) => {
    const spans = byLine.get(i);
    if (!spans) return line;
    // Multi-span single pass: each pass to plain→segments would lose info,
    // so we decorate all of a line's spans in one go.
    return _multiHighlight(line, spans, activeIdx);
  });
}

/**
 * Render `line` with multiple highlight spans in one pass. `spans` is an
 * array of {col, len, _i} (non-overlapping, within the line's width);
 * `activeIdx` flags which span gets the "current match" style. Drops the
 * line's existing markup (same v1 tradeoff as select.highlightLine).
 */
function _multiHighlight(line, spans, activeIdx) {
  const { stripMarkup, charWidth } = require('../io/ansi');
  const plain = stripMarkup(line);
  const chars = [...plain];
  // Codepoint-index → display-col cumulative array → map [col,col+len) → cp range.
  const colAt = new Array(chars.length + 1);
  colAt[0] = 0;
  for (let i = 0; i < chars.length; i++) {
    colAt[i + 1] = colAt[i] + charWidth(chars[i].codePointAt(0));
  }
  const totalCols = colAt[chars.length];

  const sorted = spans
    .filter(s => s.col < totalCols)
    .sort((a, b) => a.col - b.col);

  const esc = (s) => s.replace(/\[/g, '\\[');
  let cursor = 0;  // codepoint index
  let out = '';
  for (const sp of sorted) {
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
  recompute, _recomputeFor, _displayWidthBefore: ms._displayWidthBefore,
};
