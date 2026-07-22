/**
 * Thin facade — singleton-detail specialisation over the pane-tabs leaf.
 *
 * Every read helper (getTabInfo / isContentTab / activeContentTab) is a
 * one-line call into leaves/pane-tabs, pinning the slice via
 * `resolveTarget('viewer')` and the group = `getModel().currentGroup`.
 * Phase 4 will retarget these singleton pins to real pane ids; the leaf's
 * *In(slice, model, groupName) variants are already paneId-agnostic.
 *
 * Mutation surface (addContentTab / updateContentTabLines / removeContentTab)
 * dispatches viewer_* Msgs wrapped with 'detail'. The reducer
 * (leaves/pane-tabs#reduceTabMsg) is paneId-parameterised, so Phase 4's
 * retarget swaps the wrap target without touching the mutator surface.
 *
 * The detail panel's tab bar is conceptually:
 *
 *   [Info] [Transcript] [contentTabs...]
 *      0        1          2..1+C
 *
 * (U2c P2 — action tabs retired: a tab:true action's output lives in its own
 * text-view position-tab. U2d P2b — embedded terminals became `terminal` panes,
 * so the strip no longer carries a terminal segment.) contentTabs come from
 * slice.contentTabs (runtime). slice.tab is the flat integer index into this strip.
 */
'use strict';

const { getModel } = require('../../model/store');
const pt = require('../../leaves/wm/pane-tabs');
const panelHost = require('../../hosts/panel-host');   // dispatchMsg (injected, B/S5)
const { wrap } = require('../../panel/route');

// --- Active-viewer slice fetcher ------------------------------------------

/** Resolve the active viewer Component's slice. Routes via
 *  `route.resolveTarget('viewer')` (paneId-aware post-Phase B1) so
 *  multi-viewer setups land on the focused viewer's slice; falls back
 *  to the kind-name lookup for the legacy primary. Empty fallback so
 *  callers don't have to guard before the Component is registered
 *  (mid-boot, tests). */
function _detailSlice() {
  const api = require('../api');
  const route = require('../../panel/route');
  const id = route.resolveTarget('viewer') || 'detail';
  return api.getInstanceSlice(id)
      || { contentTabs: {}, tab: 0 };
}

// --- Read helpers (used by the layout + render paths) ---------------------

/** Tab info for the current group: content tabs + total count (Info inclusive). */
function getTabInfo() {
  return pt.flatTabInfo(_detailSlice(), getModel(), getModel().currentGroup);
}

// U2e P1b — isContentTab / activeContentTab retired (the `x`-close + info-yank
// consumers moved to the position-tab model: instanceKind-based close via
// remove_tab, showSelectedInfo's set_active_tab yank). Excised fully in U2f.

// --- Mutation surface (all routed through update — single-writer) ---------
//
// v0.6.1 Phase 6 — the content-tab mutators (add / update / remove) share the
// 'viewer_tab_add' intent, since they all key into the same per-pane
// content-tab map. Phase 5 resolveTarget collapses all intents to the same
// body — the distinction is reserved for v0.7. null target (no viewer
// registered) drops the dispatch silently.

function _viewerTarget(intent) {
  return require('../../panel/route').resolveTarget(intent);
}

// Dispatchers thread the model-derived bundle (currentGroup, groupExists) so
// the reducer arm and the leaf can be pure of getModel(). pt.modelBundle is the
// single helper that computes it.

function _getModel() {
  return getModel();
}

function addContentTab(groupName, key, label, lines) {
  const target = _viewerTarget('viewer_tab_add');
  if (target == null) return;
  panelHost.dispatchMsg(wrap(target,
    { type: 'viewer_add_content_tab', groupName, key, label, lines,
      ...pt.modelBundle(_getModel(), groupName) }));
}

function updateContentTabLines(groupName, key, lines) {
  const target = _viewerTarget('viewer_tab_add');
  if (target == null) return;
  panelHost.dispatchMsg(wrap(target,
    { type: 'viewer_update_content_tab_lines', groupName, key, lines,
      ...pt.modelBundle(_getModel(), groupName) }));
}

module.exports = {
  getTabInfo,
  addContentTab, updateContentTabLines,
};

// U2e P1b — the feature-host seam (addContentTab/updateContentTabLines) is now
// wired by panel/content-tab.js, which mints a `text-view` POSITION-tab instead
// of a viewer inner content-tab. This viewer-facade wiring is retired (the whole
// contentTabs machinery here is dead post-P1b, excised in U2f).
