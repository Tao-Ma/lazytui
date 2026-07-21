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
  if (!pane || !Array.isArray(pane.tabs) || pane.tabs.length <= 1) return null;
  const api = require('./api');
  const route = require('./route');
  const { getModel } = require('../model/store');
  const pt = require('../leaves/wm/pane-tabs');
  const mpane = require('../leaves/wm/pane');
  const ts = require('./viewer/tab-strip');
  const m = getModel();
  const layout = api.getInstanceSlice('layout');
  const pool = (layout && layout.arrange && layout.arrange.pool) || {};
  const activePoolId = pane.activeTabId;

  const entries = [];
  for (const t of pane.tabs) {
    const entry = pool[t.poolId];
    const kind = entry ? entry.type : null;
    if (kind === 'detail') {
      // Expand the viewer tab into its inner flat tabs (Info / Transcript /
      // content). Read the DETAIL instance's slice LITERALLY (getInstance, not
      // getInstanceSlice — the latter resolves the slot's ACTIVE instance, which
      // is a text-view when an action tab is up, R2 collision).
      const inst = route.getInstance(mpane.newPaneId(t.poolId));
      const dSlice = (inst && inst.slice) || {};
      const info = pt.flatTabInfo(dSlice, m, m.currentGroup);
      const labels = ['Info', 'Transcript',
        ...info.contentTabs.map(([k, c]) => (c && c.label) || k)];
      for (let i = 0; i < info.total; i++) {
        entries.push({ label: labels[i] || `tab${i}`, kind: 'flat', poolId: t.poolId, flatIdx: i });
      }
    } else {
      entries.push({ label: (entry && entry.title) || t.poolId, kind: 'position', poolId: t.poolId });
    }
  }

  // Which entry is active? If the slot's active position-tab is the viewer, the
  // active entry is the viewer's own inner tab (dSlice.tab); else the active
  // position-tab entry.
  let activeIdx = -1;
  const activeEntry = pool[activePoolId];
  if (activeEntry && activeEntry.type === 'detail') {
    const inst = route.getInstance(mpane.newPaneId(activePoolId));
    const dtab = (inst && inst.slice && inst.slice.tab) || 0;
    activeIdx = entries.findIndex(e => e.kind === 'flat' && e.poolId === activePoolId && e.flatIdx === dtab);
  } else {
    activeIdx = entries.findIndex(e => e.kind === 'position' && e.poolId === activePoolId);
  }

  const strip = ts.buildEntryStrip(entries, activeIdx, pane.hotkey, true);
  // Return the ENTRIES + activeIdx alongside the rendered strip so the `[≡]`
  // pane-menu shows the SAME flattened list as the visible border strip (they
  // must not disagree). `title`/`tabBounds` drive the visible strip + click
  // hit-test; `entries`/`activeIdx` drive the menu.
  return { ...strip, entries, activeIdx };
}

module.exports = { unifiedSlotStrip };
