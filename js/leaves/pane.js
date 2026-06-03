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
 * Pane-id format: `pane-<poolId>` in Phase 1. Stable (1:1 with the
 * placed pool entry) and debugger-friendly. When multi-mount lands in
 * Phase 4+, synth ids `pane-<poolId>#n` extend the same scheme.
 *
 * Zero deps. Used by parser + state.js + leaves/pool + renderer +
 * leaves/free-config — everything that constructs or reads pane shape.
 *
 * Earlier versions also exported `firstTab` / `paneKind` /
 * `activePoolId` as a migration shim toward Phase 9's Panel-field
 * removal. No consumer migrated, so they were dead scaffolding kept
 * alive only by tests. Retired here; the v0.7 multi-instance arc
 * will pick up the migration with the right tab-resolution semantics.
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

module.exports = {
  newPaneId,
  wrapAsPane,
};
