/**
 * Tab-container interface — one contract over a slot's position tabs (U1,
 * docs/one-tab-system.md). Since U2f there is ONE tab machine: position/slot tabs
 * (a pane's `tabs[]` + `activeTabId`, leaves/wm/pane). The former `viewer` backing
 * (the viewer's flat content-tab strip) retired with the viewer Component — every
 * tab is a real position-tab instance now.
 *
 * The contract is FOUR verbs over a plain **descriptor** (tagged by `backing`):
 *   listTabs(c)        → [ { key, idx, label, kind, active } ]  (left→right order)
 *   activeTab(c)       → the active row, or null
 *   switchTab(c, key)  → { target, msg } | null  (READ-ONLY: names the wrap
 *                        target + the switch Msg; the caller dispatches — a
 *                        pure leaf can't. null when the key is unknown / already
 *                        active.)
 *   perTabState(c, key)→ { field, withField, withFields, drop, entry } bound to
 *                        one tab's view-state.
 *
 * One backing:
 *   instance — a slot's `pane.tabs[]` (`containerFor('instance', {pane, pool})`;
 *              the pool supplies each tab's label/kind, since `pane.tabs[i]` is
 *              only `{id, poolId}`). `perTabState` is a documented STUB here: a
 *              position tab's view-state is its mounted instance's own slice,
 *              addressed by instance id — a pure leaf can't reach it.
 *
 * Pure leaf: no globals, no dispatch. Imports only sibling leaves/wm modules.
 */
'use strict';

const ts = require('./tab-state');

/** Build a container descriptor. `kind` is 'instance'. */
function containerFor(kind, args) {
  const a = args || {};
  if (kind === 'instance') return { backing: 'instance', pane: a.pane, pool: a.pool };
  return null;
}

/** Rows for a slot's position tabs. Each `pane.tabs[i]` is `{id, poolId}`; the
 *  pool (when supplied) gives the label/kind — the active tab is the one whose
 *  `id` matches `pane.activeTabId`. */
function _instanceRows(pane, pool) {
  if (!pane || !Array.isArray(pane.tabs)) return [];
  return pane.tabs.map((tab, idx) => {
    const entry = pool && pool[tab.poolId];
    return {
      key: tab.poolId, idx,
      label: (entry && entry.title) || tab.poolId,
      kind: (entry && entry.type) || '',
      active: tab.id === pane.activeTabId,
    };
  });
}

/** listTabs — the strip, left→right. Empty for an unrecognized backing. */
function listTabs(container) {
  if (!container) return [];
  if (container.backing === 'instance') return _instanceRows(container.pane, container.pool);
  return [];
}

/** activeTab — the row flagged active, or null. */
function activeTab(container) {
  const rows = listTabs(container);
  for (const r of rows) if (r.active) return r;
  return null;
}

/** switchTab — name the wrap target + the switch Msg for `key`, or null when
 *  the key is unknown or already active. READ-ONLY: the caller dispatches
 *  (and adds any close/focus enrichment — the leaf only describes the switch). */
function switchTab(container, key) {
  if (!container || key == null) return null;
  if (container.backing === 'instance') {
    const pane = container.pane;
    if (!pane || !Array.isArray(pane.tabs)) return null;
    const tab = pane.tabs.find(t => t.poolId === key);
    if (!tab) return null;
    if (tab.id === pane.activeTabId) return null;                    // already active
    return {
      target: 'layout',
      msg: { type: 'set_active_tab', paneId: pane.paneId, tabPoolId: key },
    };
  }
  return null;
}

/** perTabState — a slice-only accessor bound to one tab's view-state. Delegates
 *  to the tab-state store; the with* verbs return a fresh slice (like the store),
 *  `field` reads with presence-not-truthiness, `entry` reads the whole entry. */
function perTabState(container, key) {
  if (container && container.backing === 'instance') {
    // STUB — a position tab's view-state is its mounted instance's own slice
    // (addressed by instance id), which a pure leaf can't reach. Reads return
    // the fallback; writes are inert (null). Real wiring lands in U2b.
    return {
      field: (name, fallback) => fallback,
      withField: () => null,
      withFields: () => null,
      drop: () => null,
      entry: () => null,
    };
  }
  const slice = container && container.slice;
  return {
    field: (name, fallback) => ts.field(slice, key, name, fallback),
    withField: (name, value) => ts.withField(slice, key, name, value),
    withFields: (patch) => ts.withFields(slice, key, patch),
    drop: () => ts.dropEntry(slice, key),
    entry: () => ts.entry(slice, key),
  };
}

module.exports = { containerFor, listTabs, activeTab, switchTab, perTabState };
