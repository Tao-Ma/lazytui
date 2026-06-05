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
  const nextPane = {
    ...(entry.config || {}),
    id: entry.id,
    type: entry.type,
    title: entry.title,
    hotkey: pane.hotkey,
    columnIndex: pane.columnIndex,
    config: entry.config,
    paneId: pane.paneId,
    tabs: pane.tabs,
    activeTabId: tabPoolId,
  };
  if (pane.heightPct !== undefined) nextPane.heightPct = pane.heightPct;
  if (pane.collapsed === true)      nextPane.collapsed = true;
  return nextPane;
}

module.exports = {
  newPaneId,
  wrapAsPane,
  setActiveTab,
};
