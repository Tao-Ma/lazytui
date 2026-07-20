/**
 * text-view — a scrollable text buffer as a first-class pane type (U2b/U2c,
 * docs/one-tab-system.md). Minted into a slot's `tabs[]` at runtime (the
 * mint-into-slot primitive); its content is a line buffer seeded from the pool
 * entry's `config.lines`. Rendering delegates to the pure `leaves/text-view`
 * render primitive (window → decorate → renderPanel args).
 *
 * U2c P0 — full interaction: scroll / search / select / cursor now flow through
 * the SHARED reducer `leaves/text/text-view-update` (the same one the viewer
 * uses), so a text-view instance is per-instance-stateful (its slice owns its
 * scroll/search/select/cursor — the partial D4 collapse). `innerH` is stamped by
 * `augmentMsg` via the shared `paneInnerH` helper so scroll clamps correctly even
 * when this tab is not the active tab of its slot (background streaming — U2c P1).
 * U2c P1 will add the `tv_*` streamed-content arms + hint-keyed reuse.
 */
'use strict';

const { renderPanel } = require('../api');
const { buildTextView } = require('../../leaves/text-view/render');
const tvu = require('../../leaves/text/text-view-update');
const ms = require('../../leaves/text/search');
const { paneInnerH } = require('../pane-viewport');
const { getModel } = require('../../model/store');

function init(paneId, seed) {
  const cfg = (seed && seed.paneDef && seed.paneDef.config) || {};
  return {
    // Self-identity: the COLUMN paneId (for geometry), threaded by the mint loop.
    paneId: paneId || null,
    lines: Array.isArray(cfg.lines) ? cfg.lines : [],
    scroll: 0,
    // Viewport rows, stamped by augmentMsg (mirror viewer FIX-2); 0 pre-first-
    // dispatch → the shared reducer's _innerH falls back to 1.
    innerH: 0,
    // Full interaction state (U2c P0) — same shapes the shared reducer + the
    // viewer use, per-instance (each text-view tab owns its own view state).
    search: { active: false, term: '', idx: 0, typing: '' },
    select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
    cursor: { line: 0, col: 0 },
  };
}

function update(msg, slice) {
  // Project the stamped viewport height onto the slice so the shared reducer's
  // clamps read it through _innerH (mirror viewer.js FIX-2). The `!==` guard
  // preserves slice ref-identity when innerH is unchanged.
  if (msg && msg.innerH > 0 && slice.innerH !== msg.innerH) slice = { ...slice, innerH: msg.innerH };
  // A text-view's content IS its own line buffer — no boundary derivation.
  const r = tvu.reduce(msg, slice, slice.lines || [], 'text-view');
  return r === null ? slice : r;
}

// Framework (loop._augment) stamps the viewport height so update() stays pure of
// layout geometry. Idempotent: a pre-attached innerH wins. Reuses the shared
// paneInnerH (keyed on this instance's column paneId) so a background-streaming
// off-tab text-view still clamps against its container slot's height.
function augmentMsg(msg, model, slice) {
  if (msg.innerH > 0) return msg;
  const ih = paneInnerH(slice);
  return ih > 0 ? { ...msg, innerH: ih } : msg;
}

// Search decoration for THIS instance's slice (mirror of panel/viewer/search.js
// decorationFor, resolved against the own slice + focus). Render is impure shell,
// so the getModel() read of the global detailSearchMode flag is fine. Selection
// wins over search (same precedence as the viewer).
function _searchDecoration(slice, lines, focused) {
  const search = slice.search;
  if (!search) return null;
  const typingPhase = focused && getModel().modes.detailSearchMode;
  const term = typingPhase ? (search.typing || '') : (search.active ? (search.term || '') : '');
  const matches = ms.matchesFor(lines, term);
  if (!matches.length) return null;
  const activeIdx = Math.min(search.idx || 0, matches.length - 1);
  return { matches, activeIdx };
}

function render(panel, w, h, slice, opts) {
  const focused = !!(opts && opts.focused);
  const lines = slice.lines || [];
  const sel = (slice.select && slice.select.active) ? slice.select : null;
  const searchDecoration = sel ? null : _searchDecoration(slice, lines, focused);
  const args = buildTextView({
    lines, scroll: slice.scroll, innerH: h - 2,
    select: sel, searchDecoration,
    width: w, height: h,
    title: panel.title, hotkey: panel.hotkey,
    panelType: 'text-view', focused,
    chrome: opts && opts.chrome,
  });
  return renderPanel(args);
}

module.exports = {
  name: 'text-view',
  init,
  update,
  augmentMsg,
  panelTypes: { 'text-view': { render } },
};
