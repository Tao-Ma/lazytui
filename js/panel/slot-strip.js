/**
 * Unified slot tab-strip (U2e stopgap) — flattens a MULTI-tab slot into ONE
 * consistent strip so running an action ADDS a tab instead of swapping the whole
 * strip to a different level.
 *
 * The problem it fixes: a slot's tabs live at two levels — the slot's
 * position-tabs (`pane.tabs[]`: the viewer `detail` tab + minted `text-view`s)
 * and, INSIDE the viewer tab, its own inner tabs (Info / Transcript / content).
 * Rendering one level or the other flips the strip ("Info | Transcript" →
 * "Detail | primary") when an action runs. This flattens both into a single
 * entry list — the viewer's inner tabs expanded in place, then each sibling
 * position-tab — so the strip reads `Info | Transcript | primary` and only the
 * bracketed (active) entry changes.
 *
 * Entry tags (consumed by the click hit-test in dispatch/control/input.js):
 *   { kind:'flat', poolId (the viewer tab), flatIdx }  → activate that viewer tab
 *                                                          + tab_switch to flatIdx
 *   { kind:'position', poolId }                         → set_active_tab poolId
 *
 * Returns null for a single-tab slot (the pane keeps its own title). Impure shell
 * (reads getInstance/getModel at render+dispatch time) — NOT a pure leaf; the
 * geometry engine it calls (leaves/viewer/tab-strip.buildEntryStrip) is pure.
 * The real unified strip lands in U2e P1b/U2f; this is the forward-compatible
 * interim + a building block for it.
 */
'use strict';

function unifiedSlotStrip(pane) {
  if (!pane || !Array.isArray(pane.tabs)) return null;
  const api = require('./api');
  const ts = require('./viewer/tab-strip');
  const layout = api.getInstanceSlice('layout');
  const pool = (layout && layout.arrange && layout.arrange.pool) || {};

  // U2e P1b — every tab is a real position-tab now (Info / Transcript / minted
  // text-views + terminals). The former viewer flat-tab expansion is gone; so is
  // the two-level flip that motivated this stopgap. The persistent `detail` anchor
  // is a HIDDEN, non-user-facing tab (kept only for save-layout) — skip it so the
  // strip reads e.g. `Info ─ Transcript ─ …` with no phantom entry.
  const entries = [];
  for (const t of pane.tabs) {
    const entry = pool[t.poolId];
    if (entry && entry.type === 'detail') continue;   // hidden anchor
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
