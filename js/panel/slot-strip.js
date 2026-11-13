/**
 * Slot tab-strip — the ONE consistent strip for a MULTI-tab slot, so running an
 * action / opening a file just ADDS a tab. Every tab is a real position-tab
 * (`pane.tabs[]`: Info / Transcript / minted `text-view`s + terminals); the strip
 * reads e.g. `Info ─ Transcript ─ primary` and only the bracketed (active) entry
 * changes.
 *
 * Entry tags (consumed by the tab clicks — `titleTargets`, published on the hit
 * map where renderPanel drew each tab — and the `[≡]` menu in
 * overlay/pane-menu.js):
 *   { kind:'position', poolId }  → set_active_tab poolId
 *
 * Returns null for a ≤1-tab slot (the pane keeps its own title). Impure shell
 * (reads getInstanceSlice('layout') at render+dispatch time) — NOT a pure leaf;
 * the geometry engine it calls (leaves/wm/tab-strip.buildEntryStrip) is pure.
 */
'use strict';

// Lazily required (load order: api pulls the panel graph) and CACHED — this runs
// per slot render, and a require() per call costs tens of µs.
let _apiRef = null, _tsRef = null;
function unifiedSlotStrip(pane) {
  if (!pane || !Array.isArray(pane.tabs)) return null;
  const api = _apiRef || (_apiRef = require('./api'));
  const ts = _tsRef || (_tsRef = require('../leaves/wm/tab-strip'));
  const layout = api.getInstanceSlice('layout');
  const pool = (layout && layout.arrange && layout.arrange.pool) || {};

  // Every tab is a real position-tab (U2f — the viewer's flat-tab expansion + the
  // hidden `detail` anchor are gone).
  const entries = [];
  for (const t of pane.tabs) {
    const entry = pool[t.poolId];
    entries.push({ label: (entry && entry.title) || t.poolId, kind: 'position', poolId: t.poolId });
  }
  // A single visible tab needs no strip — the pane keeps its own title.
  if (entries.length <= 1) return null;

  const activeIdx = entries.findIndex(e => e.poolId === pane.activeTabId);
  const strip = ts.buildEntryStrip(entries, activeIdx, pane.hotkey, true);
  // Return the ENTRIES + activeIdx alongside the rendered strip so the `[≡]`
  // pane-menu shows the SAME list as the visible border strip (they must not
  // disagree). `title` is the visible strip; `tabBounds` (pane-local, with the
  // hotkey + [≡] offsets) is an independent geometry oracle the tab-click smoke
  // test checks the published regions against; `entries`/`activeIdx` drive the
  // menu.
  // Title-RELATIVE click targets (x from the title's first cell) for renderPanel's
  // `titleTargets`: renderPanel knows where the title actually starts and which
  // tabs survived truncation, and reports only those (docs/mouse-hit-map.md R2).
  const x0 = strip.tabBounds.length ? strip.tabBounds[0].x : 0;
  const titleTargets = strip.tabBounds.map(t => ({ x: t.x - x0, w: t.w, poolId: t.poolId }));
  return { ...strip, entries, activeIdx, titleTargets };
}

/** renderPanel title opts for a slot pane: the unified strip + its click targets
 *  for a multi-tab slot, else the pane's own title (no targets). */
function slotTitleOpts(pane) {
  const strip = unifiedSlotStrip(pane);
  return strip
    ? { title: strip.title, titleTargets: strip.titleTargets }
    : { title: pane && pane.title, titleTargets: null };
}

module.exports = { unifiedSlotStrip, slotTitleOpts };
