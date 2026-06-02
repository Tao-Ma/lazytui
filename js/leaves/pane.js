/**
 * Pane helpers — v0.6.1 Phase 1.
 *
 * A pane is the unit of placement in the layout grid (a rectangular
 * slot). It holds 1+ tabs; each tab is the content (a panel-type
 * instance). In Phase 1 every pane has exactly one tab — the wrapping
 * is a thin shim alongside the existing Panel fields. Phase 2+ lifts
 * the tab-list machinery into a real container; Phase 9 retires the
 * legacy Panel fields entirely.
 *
 * Wide intermediate form. During Phases 1-8 an `arrange.columns[ci].panels[i]`
 * entry carries BOTH shapes simultaneously:
 *
 *   - Pane fields  (new): paneId, tabs[], activeTabId
 *   - Panel fields (kept for compat): id, type, title, hotkey, columnIndex,
 *     config, heightPct?, collapsed?, and any pool-config spread
 *
 * Legacy consumers reading `p.type` / `p.id` keep working; new
 * consumers read through `firstTab(p)` / `paneKind(p)` so the eventual
 * removal of Panel fields lands without rewriting render & dispatch
 * call sites a second time.
 *
 * Pane-id format: `pane-<poolId>` in Phase 1. Stable (1:1 with the
 * placed pool entry) and debugger-friendly. When multi-mount lands in
 * Phase 4+, synth ids `pane-<poolId>#n` extend the same scheme.
 *
 * Zero deps. Used by parser + state.js + leaves/pool + renderer +
 * design.js — everything that constructs or reads pane shape.
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
 *   - tabs         — array of { id, poolId }; single-tab in Phase 1
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

/** The single tab in a Phase-1 pane. Phase 2+ pane may have many. */
function firstTab(pane) {
  return pane && pane.tabs && pane.tabs[0];
}

/**
 * Panel-type kind of the pane's currently-active tab. Phase 1 reads
 * the legacy `pane.type` field directly; Phase 2+ will resolve through
 * the pool entry referenced by `firstTab(pane).poolId`. Centralised
 * here so the eventual switch lands in one spot.
 */
function paneKind(pane) {
  return pane && pane.type;
}

/** Pool id of the active tab. Phase 1 == pane.id (single-tab pane). */
function activePoolId(pane) {
  const t = firstTab(pane);
  return t ? t.poolId : null;
}

module.exports = {
  newPaneId,
  wrapAsPane,
  firstTab,
  paneKind,
  activePoolId,
};
