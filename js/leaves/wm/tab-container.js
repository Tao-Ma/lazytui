/**
 * Tab-container interface — one contract over the two tab systems (U1,
 * docs/one-tab-system.md). lazytui has TWO tab machines: position/slot tabs
 * (a pane's `tabs[]` + `activeTabId`, leaves/wm/pane) and the viewer's content
 * tabs (the flat strip over `slice.{contentTabs,ephemeralTerminals,…}` +
 * per-tab view-state in `slice.tabState`, leaves/wm/pane-tabs + tab-state).
 * This leaf is the keystone that lets a consumer talk to either one the same
 * way, so later phases can migrate a content-kind BEHIND this contract without
 * the consumer noticing.
 *
 * The contract is FOUR verbs over a plain **descriptor** (tagged by `backing`):
 *   listTabs(c)        → [ { key, idx, label, kind, active, closeable?,
 *                            closeKind?, closeKey? } ]   (left→right strip order)
 *   activeTab(c)       → the active row, or null
 *   switchTab(c, key)  → { target, msg } | null  (READ-ONLY: names the wrap
 *                        target + the switch Msg; the caller dispatches — a
 *                        pure leaf can't. null when the key is unknown / already
 *                        active.)
 *   perTabState(c, key)→ { field, withField, withFields, drop, entry } bound to
 *                        one tab's view-state.
 *
 * Two backings today:
 *   instance — a slot's `pane.tabs[]` (`containerFor('instance', {pane, pool})`;
 *              the pool supplies each tab's label/kind, since `pane.tabs[i]` is
 *              only `{id, poolId}`). `perTabState` is a documented STUB here: a
 *              position tab's view-state is its mounted instance's own slice,
 *              addressed by instance id — a pure leaf can't reach it. The real
 *              wiring lands in U2b (mint-into-slot).
 *   viewer   — the today-viewer's content tabs. Comes in a model-path form
 *              (`containerFor('viewer', {slice, model, paneId})`, for impure-
 *              shell callers) and a from-bundle twin (`containerFor('viewerB',
 *              {slice, bundle, paneId})`, for the getModel-pure viewer reducer).
 *              The twin only matters for tab ENUMERATION (listTabs/activeTab/
 *              switchTab), which needs the group's tab structure; `perTabState`
 *              is slice-only (the tab-state store keys on the slice alone), so
 *              it behaves identically in both contexts.
 *
 * Pure leaf: no globals, no dispatch. Imports only sibling leaves/wm modules.
 */
'use strict';

const pt = require('./pane-tabs');
const ts = require('./tab-state');

/** Build a container descriptor. `kind` is 'viewer' | 'viewerB' | 'instance'. */
function containerFor(kind, args) {
  const a = args || {};
  if (kind === 'viewer')   return { backing: 'viewer', slice: a.slice, model: a.model, paneId: a.paneId };
  if (kind === 'viewerB')  return { backing: 'viewer', slice: a.slice, bundle: a.bundle, paneId: a.paneId };
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

/** The active tab idx a viewer slice is on (defaults to 0 — Info). */
function _viewerActiveIdx(slice) {
  return (slice && typeof slice.tab === 'number') ? slice.tab : 0;
}

/** Build the flat viewer strip as neutral rows. `info` is a flatTabInfo result,
 *  `g` the group the strip belongs to (for the ephemeral-terminal closeable
 *  probe), `keyOf(idx)` resolves the stable tab key. Mirrors pane-menu._flatTabs
 *  field-for-field (kind / closeable / closeKind / closeKey) so it can back it. */
function _viewerRows(slice, info, g, keyOf, activeIdx) {
  const s = slice || {};
  const rows = [
    { key: keyOf(0), idx: 0, label: 'Info', kind: '', active: activeIdx === 0 },
    { key: keyOf(1), idx: 1, label: 'Transcript', kind: '', active: activeIdx === 1 },
  ];
  // U2c P2 — action tabs retired (action output → its own text-view position-tab),
  // so terminals/content follow Info+Transcript directly.
  const eph = (s.ephemeralTerminals && s.ephemeralTerminals[g]) || {};
  info.termTabs.forEach(([key, t], i) => {
    const idx = 2 + i;
    rows.push({
      key: keyOf(idx), idx, label: t.label || key, kind: 'term', active: activeIdx === idx,
      closeable: !!eph[key], closeKind: 'terminal', closeKey: key,
    });
  });
  info.contentTabs.forEach(([key, c], i) => {
    let k = 'content';
    if (key.startsWith('docker:')) k = 'docker';
    else if (key.startsWith('file:')) k = 'file';
    const idx = 2 + info.termTabs.length + i;
    rows.push({
      key: keyOf(idx), idx, label: c.label || key, kind: k, active: activeIdx === idx,
      closeable: true, closeKind: 'content', closeKey: key,
    });
  });
  return rows;
}

/** listTabs — the strip, left→right. Empty for an unrecognized backing. */
function listTabs(container) {
  if (!container) return [];
  if (container.backing === 'viewer') {
    const s = container.slice || {};
    const activeIdx = _viewerActiveIdx(s);
    if (container.bundle) {
      const b = container.bundle;
      const info = pt.flatTabInfoFromBundle(s, b);
      return _viewerRows(s, info, b.currentGroup, idx => pt.resolveTabKeyFromBundle(idx, s, b), activeIdx);
    }
    const m = container.model;
    const g = m && m.currentGroup;
    const info = pt.flatTabInfo(s, m, g);
    return _viewerRows(s, info, g, idx => pt.resolveTabKey(idx, s, m), activeIdx);
  }
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
  if (container.backing === 'viewer') {
    const rows = listTabs(container);
    const row = rows.find(r => r.key === key);
    if (!row) return null;
    if (row.idx === _viewerActiveIdx(container.slice)) return null;   // already active
    const g = container.bundle ? container.bundle.currentGroup
                               : (container.model && container.model.currentGroup);
    return {
      target: container.paneId,
      msg: { type: 'tab_switch', idx: row.idx, targetKey: key, currentGroup: g },
    };
  }
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
