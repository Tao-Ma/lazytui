/**
 * text-view render leaf — the reusable "render a scrollable text buffer"
 * primitive (U2a, docs/one-tab-system.md). Given a ready line buffer + resolved
 * view-state, it windows the visible rows (the A3 windowed-decorate: slice the
 * ~innerH visible rows FIRST, then decorate only those), applies at most one
 * decoration (selection OR search — the caller's precedence), and assembles the
 * renderPanel argument object. The viewer's render() is its first client; U2b/U2c
 * (mint-into-slot, routed output) will call the same primitive.
 *
 * PURE: takes resolved state as params (no getModel / getInstanceSlice / ambient
 * reads). The caller (viewer.render, impure shell) resolves the decoration inputs
 * — the selection object and/or the {matches, activeIdx} search decoration — and
 * passes them in. Deps are only sibling text leaves.
 *
 * It returns renderPanel ARGS (a plain object), NOT the drawn string: the viewer
 * passes them to panel/api#renderPanel (the selection-aware wrapper that captures
 * content for the per-pane MOUSE selection pipeline before the leaf draws). A
 * text-view that called the leaf renderPanel directly would silently bypass that
 * capture.
 */
'use strict';

const selectCore = require('../text/select-core');
const search = require('../text/search');

/**
 * @param {object} o
 *   lines            the full content buffer (already derived by the caller)
 *   scroll           window top (absolute line index)
 *   innerH           visible rows (panel height minus border chrome)
 *   select           the active selection object, or null   (wins over search)
 *   searchDecoration { matches, activeIdx } over the full buffer, or null
 *   width, height, title, hotkey, focused, chrome, panelType   renderPanel chrome
 * @returns renderPanel argument object
 */
function buildTextView(o) {
  const lines = o.lines || [];
  const total = lines.length;
  const scroll = o.scroll || 0;
  const innerH = o.innerH;
  // Scroll indicator — same rule the viewer used: only when content overflows.
  const count = total > innerH ? [scroll + innerH, total] : null;
  // A3 — window FIRST, then decorate only the visible rows (offset-aware). Both
  // decorate leaves are byte-identical to whole-buffer-decorate-then-slice.
  let window = lines.slice(scroll, scroll + innerH);
  if (o.select) {
    window = selectCore.decorateWindow(window, o.select, scroll);
  } else if (o.searchDecoration) {
    window = search.decorateWindow(window, o.searchDecoration.matches, o.searchDecoration.activeIdx, scroll);
  }
  return {
    width: o.width,
    height: o.height,
    lines: window,
    title: o.title,
    hotkey: o.hotkey,
    panelType: o.panelType,
    focused: o.focused,
    count,
    scrollOffset: scroll,
    windowed: true,
    chrome: o.chrome,
  };
}

module.exports = { buildTextView };
