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
// remove_tab, showSelectedInfo's set_active_tab yank).
//
// U2f — the content-tab MUTATION surface (addContentTab / updateContentTabLines,
// which dispatched viewer_add_content_tab / viewer_update_content_tab_lines) is
// retired: the feature-host seam is wired by panel/content-tab.js, which mints a
// `text-view` POSITION-tab instead of a viewer inner content-tab. getTabInfo is
// the last survivor (footer tab-count); it retires when the footer switches to a
// position-tab count.

module.exports = {
  getTabInfo,
};
