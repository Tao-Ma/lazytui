/**
 * Per-pane selection — the render-side glue (docs/pane-selection.md). Two jobs,
 * both hung off the ONE chrome seam every pane already routes through
 * (panel/api.js's renderPanel wrapper), so selection is universal with no
 * per-pane render edits:
 *
 *   1. CAPTURE — record each pane's content lines (+ its scroll offset) per
 *      frame, keyed by paneId, so the mouse pipeline can map a click to content
 *      coords and resolve the selected text on release.
 *   2. DECORATE — if a pane owns the active selection (model.selection.paneId),
 *      reverse-highlight the selected range in its content before the box is
 *      drawn.
 *
 * The "pane being rendered" is an AMBIENT module-local set by paint around each
 * Component render (enterPane/exitPane) — render is synchronous and single-
 * threaded, so one local is safe, and it spares every render() call site from
 * threading its own paneId into renderPanel.
 *
 * Panel-layer module: reads the root model (getModel) — allowed here — and the
 * pure geometry leaf (leaves/text/select-core). Imports nothing from api, so the
 * api → select-view edge is a clean down-edge (no cycle).
 */
'use strict';

const { getModel } = require('../model/store');
const core = require('../leaves/text/select-core');

// paneId -> { lines, scroll }. Overwritten every frame (composeRects renders
// every pane), so it always reflects the latest paint.
const _content = new Map();

// The pane currently being rendered (ambient, set by paint's _safeRender).
let _current = null;
function enterPane(paneId) { _current = paneId || null; }
function exitPane() { _current = null; }
function currentPaneId() { return _current; }

/** Record a pane's content window (the lines handed to renderPanel) + scroll. */
function recordContent(paneId, lines, scroll) {
  if (!paneId) return;
  _content.set(paneId, { lines: lines || [], scroll: scroll || 0 });
}
/** The last-recorded content for a pane, or null. */
function contentFor(paneId) { return _content.get(paneId) || null; }

/**
 * Highlight the active selection in a pane's content lines — but only if this
 * pane owns the selection. `lines` is the full pre-window content, so an
 * absolute content-line index equals the array index (offset 0). Returns the
 * same array reference untouched when this pane isn't the owner (the common
 * case), so the wrapper can skip the copy.
 */
function decorateFor(paneId, lines) {
  const sel = getModel().selection;
  if (!sel || !sel.active || sel.paneId !== paneId) return lines;
  return core.decorateWindow(lines, sel, 0);
}

/** The current selection's text, resolved from the owner pane's captured
 *  content. '' when there's no active selection or its pane didn't render. */
function selectedText() {
  const sel = getModel().selection;
  if (!sel || !sel.active || !sel.paneId) return '';
  const c = _content.get(sel.paneId);
  if (!c) return '';
  return core.selectedTextFrom(c.lines, sel);
}

/** True iff a selection is active. */
function isActive() {
  const sel = getModel().selection;
  return !!(sel && sel.active);
}

module.exports = {
  enterPane, exitPane, currentPaneId,
  recordContent, contentFor, decorateFor, selectedText, isActive,
};
