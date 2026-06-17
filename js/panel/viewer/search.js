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
const ms = require('../../leaves/search');

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
  return require('../../leaves/panel-host').dispatchMsg(require('../../panel/route').wrap(target, msg));
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
function decorateLines(lines, slice) {
  // P4 review fix (multi-viewer) — decorate with the RENDERED pane's
  // search state, not the focused pane's. The render path passes its
  // own slice; legacy callers without one fall back to the focused
  // viewer (singleton-equivalent). Pre-arc this read the focused
  // pane's stored matches and painted their POSITIONS onto whatever
  // pane was being rendered — cross-pane in a worse way.
  const focusedSlice = _slice();
  const s = slice || focusedSlice;
  const search = s?.search;
  if (!search) return lines;
  // P1 (viewer-lines selector) — matches DERIVE from the very lines
  // being decorated (ms.matchesFor memo), so highlights always align
  // with the displayed content. Phase picks the term: typing while the
  // `/` prompt is open (live preview) — but the typing buffer belongs
  // to the FOCUSED viewer only; an unfocused pane shows its own
  // committed term.
  const typingPhase = getModel().modes.detailSearchMode && s === focusedSlice;
  const term = typingPhase
    ? (search.typing || '')
    : (search.active ? (search.term || '') : '');
  const matches = ms.matchesFor(lines, term);
  if (!matches.length) return lines;
  // Group matches by line index for O(N) decoration.
  const byLine = new Map();
  matches.forEach((m, i) => {
    if (!byLine.has(m.line)) byLine.set(m.line, []);
    byLine.get(m.line).push({ ...m, _i: i });
  });
  // Stale idx (content shrank since it was set) clamps into range.
  const activeIdx = Math.min(search.idx || 0, matches.length - 1);
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
  const { stripMarkup, charWidth } = require('../../io/ansi');
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
  _displayWidthBefore: ms._displayWidthBefore,
};
