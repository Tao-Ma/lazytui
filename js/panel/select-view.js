/**
 * Per-pane selection — the render-side glue + owner resolution
 * (docs/pane-selection.md). Selection STATE lives on the owning pane's
 * instance slice (`slice.select`, per-tab by construction since every tab is
 * its own instance); this module contributes the three impure-shell services
 * around it:
 *
 *   1. CAPTURE — record each pane's content lines (+ scroll, + whether they
 *      were pre-windowed) per frame, keyed by paneId, so the mouse pipeline can
 *      map a click to content coords and resolve the selected text on release.
 *   2. DECORATE — reverse-highlight a pane's active `slice.select` in its
 *      content before the box is drawn. Only for panes that DON'T window their
 *      buffer themselves: the content panes render through buildTextView, which
 *      windows + self-decorates offset-aware, so the renderPanel wrapper skips
 *      them (opts.windowed).
 *   3. RESOLVE — find the pane owning the active selection (activeSelection)
 *      and extract its text: from the instance's own content buffer when the
 *      capture was windowed (the capture then only holds the visible rows), else
 *      from the captured full-content lines.
 *
 * The "pane being rendered" is an AMBIENT module-local set by paint around each
 * Component render (enterPane/exitPane) — render is synchronous and single-
 * threaded, so one local is safe, and it spares every render() call site from
 * threading its own paneId into renderPanel.
 *
 * Panel-layer module: reads pane slices through route (lazy — allowed here) and
 * the pure geometry leaf (leaves/text/select-core). Imports nothing from api,
 * so the api → select-view edge is a clean down-edge (no cycle).
 */
'use strict';

const core = require('../leaves/text/select-core');

// paneId -> { lines, scroll, windowed }. Overwritten every frame (composeRects
// renders every pane), so it always reflects the latest paint.
const _content = new Map();

// The pane currently being rendered (ambient, set by paint's _safeRender).
let _current = null;
function enterPane(paneId) { _current = paneId || null; }
function exitPane() { _current = null; }
function currentPaneId() { return _current; }

/** Record a pane's content window (the lines handed to renderPanel) + scroll.
 *  `windowed` marks a pre-windowed buffer (content panes): the capture then
 *  holds only the visible rows, so text extraction must read the instance's
 *  own buffer instead. */
function recordContent(paneId, lines, scroll, windowed) {
  if (!paneId) return;
  _content.set(paneId, { lines: lines || [], scroll: scroll || 0, windowed: !!windowed });
}
/** The last-recorded content for a pane, or null. */
function contentFor(paneId) { return _content.get(paneId) || null; }

// The ACTIVE instance slice for a pane (paneId → active tab's instance), via
// the same resolution the wrapped-Msg dispatch uses; the panel-type fallback
// covers kind-keyed panes (docker-style) whose state lives on the kind's
// primary instance. Lazy require: select-view loads before route in some boot
// orders, and api → select-view must stay a leaf-ward edge.
function _sliceFor(paneId, type) {
  const route = require('./route');
  return route.sliceForPane(paneId, type || route.paneTypeOf(paneId));
}

// The panel list — pane ids + types for the ownership scan.
function _panels() {
  return require('./nav-state').allPanels();
}

/**
 * Highlight the active selection in a pane's content lines — but only if this
 * pane's ACTIVE instance owns one. `lines` is the full pre-window content, so
 * an absolute content-line index equals the array index (offset 0); the
 * renderPanel wrapper never calls this for `windowed` opts (those panes
 * self-decorate). Returns the same array reference untouched when this pane
 * has no active selection (the common case), so the wrapper can skip the copy.
 */
function decorateFor(paneId, lines, type) {
  const sl = _sliceFor(paneId, type);
  const sel = sl && sl.select;
  if (!sel || !sel.active) return lines;
  return core.decorateWindow(lines, sel, 0);
}

/** One pane's OWN active selection: `{ paneId, type, sel, slice }`, or null.
 *  Reads the pane's ACTIVE instance slice — a hidden tab's persisted selection
 *  stays out (per-tab persistence: it re-owns when its tab is active again). */
function selectionFor(paneId, type) {
  const slice = _sliceFor(paneId, type);
  const sel = slice && slice.select;
  return (sel && sel.active) ? { paneId, type, sel, slice } : null;
}

/**
 * EVERY pane whose active instance holds an active selection. More than one is
 * reachable by design (a keyboard visual-mode selection on the focused content
 * pane + a persisted mouse selection elsewhere; a hidden tab re-owning its
 * selection on switch-back) — the press-clear sweep must cancel them ALL, not
 * the first hit. VISIBLE selections only: hidden tabs' persisted ones stay
 * (per-tab persistence); the group-switch clear uses allSelections instead.
 */
function activeSelections() {
  const out = [];
  for (const p of _panels()) {
    const own = selectionFor(p.paneId, p.type);
    if (own) out.push(own);
  }
  return out;
}

/**
 * EVERY registered instance holding an active selection — hidden tabs'
 * persisted ones included (the per-pane scans above see only each pane's
 * ACTIVE instance). The group-switch select_cancel_all sweep needs this
 * registry-wide view: a hidden tab's selection would otherwise survive the
 * switch and re-own over whatever content the NEW group loads into that
 * instance (docs/pane-selection.md §Clearing). `{ instId, sel }` — instance
 * ids are directly addressable through the wrapped-Msg path.
 */
function allSelections() {
  const out = [];
  require('./route').eachInstance((inst) => {
    const sel = inst.slice && inst.slice.select;
    if (sel && sel.active) out.push({ instId: inst.id, sel });
  });
  return out;
}

/**
 * THE active selection — the one highlight/copy consumers act on. The FOCUSED
 * pane's own selection wins (a keyboard visual-mode selection is always on the
 * focused pane, and the pre-unification viewer had the same precedence);
 * otherwise the first pane-order hit.
 */
function activeSelection() {
  const focus = require('./route').getFocus();
  if (focus) {
    const own = selectionFor(focus);
    if (own) return own;
  }
  const all = activeSelections();
  return all.length ? all[0] : null;
}

// The content buffer a selection resolves against when the frame capture is
// windowed: the instance's own full buffer (`slice.lines`, or the agent pane's
// `slice.transcript`).
function _bufferOf(slice) {
  if (!slice) return null;
  if (Array.isArray(slice.lines)) return slice.lines;
  if (Array.isArray(slice.transcript)) return slice.transcript;
  return null;
}

// Resolve an owner's selection to text: the frame capture when it holds the
// full content, else the instance's own buffer (windowed captures only carry
// the visible rows).
function _textOf(own) {
  if (!own) return '';
  const cap = _content.get(own.paneId);
  const lines = (cap && !cap.windowed) ? cap.lines : (_bufferOf(own.slice) || (cap && cap.lines));
  if (!lines) return '';
  return core.selectedTextFrom(lines, own.sel);
}

/** THE active selection's text ('' when none) — highlight/copy consumers. */
function selectedText() { return _textOf(activeSelection()); }

/** A specific pane's own active selection's text ('' when none) — the mouse
 *  release settles the ARMED pane, not whatever pane a scan finds first. */
function selectedTextFor(paneId) { return _textOf(selectionFor(paneId)); }

/** True iff a selection is active. */
function isActive() {
  return activeSelection() != null;
}

module.exports = {
  enterPane, exitPane, currentPaneId,
  recordContent, contentFor, decorateFor,
  selectionFor, activeSelection, activeSelections, allSelections,
  selectedText, selectedTextFor, isActive,
};
