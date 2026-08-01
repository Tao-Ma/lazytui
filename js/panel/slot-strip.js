/**
 * Slot tab-strip — the ONE consistent strip for a MULTI-tab slot, so running an
 * action / opening a file just ADDS a tab. Every tab is a real position-tab
 * (`pane.tabs[]`: Info / Transcript / minted `text-view`s + terminals); the strip
 * reads e.g. `Info ─ Transcript ─ primary` and only the bracketed (active) entry
 * changes.
 *
 * Entry tags (consumed by the click hit-test in dispatch/control/input.js + the
 * `[≡]` menu in overlay/pane-menu.js):
 *   { kind:'position', poolId }  → set_active_tab poolId
 *
 * Returns null for a ≤1-tab slot (the pane keeps its own title). Impure shell
 * (reads getInstanceSlice('layout') at render+dispatch time) — NOT a pure leaf;
 * the geometry engine it calls (leaves/wm/tab-strip.buildEntryStrip) is pure.
 */
'use strict';

function unifiedSlotStrip(pane) {
  if (!pane || !Array.isArray(pane.tabs)) return null;
  const api = require('./api');
  const ts = require('../leaves/wm/tab-strip');
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
  // disagree). `title`/`tabBounds` drive the visible strip + click hit-test;
  // `entries`/`activeIdx` drive the menu.
  return { ...strip, entries, activeIdx };
}

module.exports = { unifiedSlotStrip };
