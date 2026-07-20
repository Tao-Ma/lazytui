/**
 * text-view — a scrollable text buffer as a first-class pane type (U2b,
 * docs/one-tab-system.md). Minted into a slot's `tabs[]` at runtime (the
 * mint-into-slot primitive); its content is a line buffer seeded from the pool
 * entry's `config.lines`. Rendering delegates to the pure `leaves/text-view`
 * render primitive (window → decorate → renderPanel args).
 *
 * U2b scope: **scroll only** (j/k/↑/↓). The shared scroll/search/select/cursor
 * interaction reducer (`textViewUpdate`) + routed streamed content are U2c — this
 * is the thinnest pane that proves mint-into-slot with a visibly interactive tab.
 */
'use strict';

const { renderPanel } = require('../api');
const { buildTextView } = require('../../leaves/text-view/render');

function init(paneId, seed) {
  const cfg = (seed && seed.paneDef && seed.paneDef.config) || {};
  return {
    // Self-identity: the COLUMN paneId (for geometry), threaded by the mint loop.
    paneId: paneId || null,
    lines: Array.isArray(cfg.lines) ? cfg.lines : [],
    scroll: 0,
    // Inert in U2b (no search/selection/cursor interaction yet) — the shape is
    // what buildTextView + the U2c interaction reducer will fill.
    search: null,
    select: null,
    cursor: null,
  };
}

function update(msg, slice) {
  if (msg.type === 'key') {
    const lines = slice.lines || [];
    const max = Math.max(0, lines.length - 1);
    const cur = slice.scroll || 0;
    let next = cur;
    switch (msg.key) {
      case 'down': case 'j': next = Math.min(max, cur + 1); break;
      case 'up':   case 'k': next = Math.max(0, cur - 1); break;
      default: return slice;
    }
    return next === cur ? slice : { ...slice, scroll: next };
  }
  return slice;
}

function render(panel, w, h, slice, opts) {
  const args = buildTextView({
    lines: slice.lines, scroll: slice.scroll, innerH: h - 2,
    select: slice.select, searchDecoration: null,
    width: w, height: h,
    title: panel.title, hotkey: panel.hotkey,
    panelType: 'text-view', focused: !!(opts && opts.focused),
    chrome: opts && opts.chrome,
  });
  return renderPanel(args);
}

module.exports = {
  name: 'text-view',
  init,
  update,
  panelTypes: { 'text-view': { render } },
};
