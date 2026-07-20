/**
 * Pane helpers.
 *
 * A pane is the unit of placement in the layout grid (a rectangular
 * slot). It holds 1+ tabs; each tab is the content (a panel-type
 * instance). v0.6.1 shipped the panes-as-containers refactor — every
 * `arrange.columns[ci].panels[i]` entry now carries the Pane shape
 * (paneId, tabs[], activeTabId) alongside the legacy Panel fields
 * (id, type, title, hotkey, columnIndex, config, heightPct?,
 * collapsed?) that pool/renderer/free-config still index by.
 *
 * Pane-id format: `pane-<poolId>` for single-mount entries. Stable
 * (1:1 with the placed pool entry) and debugger-friendly. A future
 * multi-mount arc would synth `pane-<poolId>#n`.
 *
 * Zero deps. Used by parser + state.js + leaves/pool + renderer +
 * leaves/free-config — everything that constructs or reads pane shape.
 */
'use strict';

function newPaneId(poolId) {
  return `pane-${poolId}`;
}

/**
 * Inverse of newPaneId: the poolId a `pane-<poolId>` tab-instance id was minted
 * from. Used to turn a terminal's PTY session id (== its tab-instance id) back
 * into the tabPoolId that `remove_tab` + the tab list key on. Passes through an
 * id lacking the prefix unchanged (defensive).
 */
function poolIdOf(instId) {
  return (typeof instId === 'string' && instId.startsWith('pane-')) ? instId.slice(5) : instId;
}

/**
 * Strict focus comparator. v0.6.3 post-arch-arc T3.5 collapsed the
 * Phase-B3 transitional fallback (type/id) — `slice.focus` is now
 * canonically a paneId, seeded by `set_arrange` (which auto-mints
 * `paneId` for panes missing one) and stamped by `_withFocus` on
 * every focus write. Pre-migration callers that hand-set type-form
 * focus must update to paneId-form.
 */
function paneMatchesFocus(p, focus) {
  if (!p || focus == null) return false;
  return p.paneId === focus;
}

/**
 * Return a new pane object with Pane fields minted onto `entry`.
 *
 * Adds:
 *   - paneId       — slot identity (stable across moves / collapse)
 *   - tabs         — array of { id, poolId } (single-tab in default
 *                    placements; multi-tab via the arrange-level tab-add)
 *   - activeTabId  — tabs[0].id
 *
 * Pure: returns a fresh object; the input is not mutated. Aligns with
 * the rest of the leaf pattern (return-new transforms).
 */
function wrapAsPane(entry, paneId) {
  return {
    ...entry,
    paneId,
    tabs: [{ id: entry.id, poolId: entry.id }],
    activeTabId: entry.id,
  };
}

/**
 * Flip a multi-tab pane's active tab. Legacy Panel fields (id/type/
 * title/config + spread config keys) mirror the active tab's pool
 * entry; switching active rebuilds those from the new active's pool
 * entry while preserving placement-only fields (paneId, tabs, hotkey,
 * columnIndex, heightPct, collapsed).
 *
 * Pure: returns a fresh pane object. Callers handle the `arrange`-level
 * splice + undo push + focus follow. Pre-validation (target tab exists,
 * not already active, pool entry exists) is the caller's responsibility.
 */
function setActiveTab(pane, tabPoolId, entry) {
  return _rebuildLegacyFields(pane, pane.tabs, tabPoolId, entry);
}

/**
 * Rebuild a pane's legacy Panel fields (id/type/title/config + spread config
 * keys) from a pool `entry`, with `tabs` + `activeTabId` set explicitly and the
 * placement-only fields (paneId/hotkey/columnIndex/heightPct/collapsed)
 * preserved. Shared by setActiveTab (switch) and addTab (append+activate) so the
 * wide-pane shape lives in ONE place.
 */
function _rebuildLegacyFields(pane, tabs, activeTabId, entry) {
  const next = {
    ...(entry.config || {}),
    id: entry.id,
    type: entry.type,
    title: entry.title,
    hotkey: pane.hotkey,
    columnIndex: pane.columnIndex,
    config: entry.config,
    paneId: pane.paneId,
    tabs,
    activeTabId,
  };
  if (pane.heightPct !== undefined) next.heightPct = pane.heightPct;
  if (pane.collapsed === true)      next.collapsed = true;
  return next;
}

/**
 * Append a tab `{ id, poolId }` to `pane.tabs` (the U2b mint-into-slot primitive).
 * When `opts.activate`, the appended tab becomes active and the pane's legacy
 * fields rebuild from `entry` (its pool entry); otherwise only `tabs` grows.
 * Pure: returns a fresh pane; the caller handles the arrange splice + focus.
 */
function addTab(pane, tab, entry, opts) {
  const tabs = [...(pane.tabs || []), tab];
  if (opts && opts.activate) return _rebuildLegacyFields(pane, tabs, tab.id, entry);
  return { ...pane, tabs };
}

/**
 * Remove the tab `tabId` from `pane.tabs` (the remove half of the mint-into-slot
 * primitive; mirror of addTab). When the removed tab was the active one, the
 * PREVIOUS tab (index clamped) becomes active and the legacy Panel fields rebuild
 * from its pool entry (resolved from `pool`); a background removal keeps the
 * active tab (its entry re-fetched, so the fields stay consistent). Refuses (→
 * null, caller no-ops) when the tab isn't in the pane, would empty the slot (last
 * tab), or the new-active entry is missing. Pure: returns
 * `{ pane, activeId, wasActive }`.
 */
function removeTab(pane, tabId, pool) {
  const tabs = pane.tabs || [];
  const idx = tabs.findIndex(t => t.id === tabId);
  if (idx < 0 || tabs.length <= 1) return null;
  const nextTabs = tabs.slice(0, idx).concat(tabs.slice(idx + 1));
  const wasActive = pane.activeTabId === tabId;
  const activeId = wasActive ? nextTabs[Math.min(idx, nextTabs.length - 1)].id : pane.activeTabId;
  const entry = (pool || {})[activeId];
  if (!entry) return null;
  return { pane: _rebuildLegacyFields(pane, nextTabs, activeId, entry), activeId, wasActive };
}

module.exports = {
  newPaneId,
  poolIdOf,
  wrapAsPane,
  setActiveTab,
  addTab,
  removeTab,
  paneMatchesFocus,
};
