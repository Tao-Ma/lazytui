/**
 * Feature-host port — the injected seam through which the `feature/` layer
 * reaches its host (panel + dispatch) WITHOUT importing upward.
 *
 * `feature/` holds workflows (open a file/docker path as a viewer tab, etc.)
 * that other layers invoke (panel components, dispatch). To keep feature a
 * pure BOTTOM layer (no feature→panel / feature→dispatch import edges that
 * would re-form the layer cycle), the few calls feature needs to make back
 * up are injected here and called through this leaf — the same render-exit
 * seam pattern as render-queue / draw's dims provider.
 *
 * Wired at boot:
 *   - panel/viewer/tabs.js  → addContentTab, updateContentTabLines
 *   - dispatch/runtime/effects.js   → refireCmdlineRebuild
 *
 * See docs/v0.6.5-render-exit.md (the layering arc) for the pattern.
 */
'use strict';

let _addContentTab = null;
let _updateContentTabLines = null;
let _refireCmdlineRebuild = null;

/** Register host functions. Each owner sets its own slice (Object.assign
 *  semantics) so panel and dispatch can wire independently at boot. */
function setFeatureHost({ addContentTab, updateContentTabLines, refireCmdlineRebuild } = {}) {
  if (addContentTab) _addContentTab = addContentTab;
  if (updateContentTabLines) _updateContentTabLines = updateContentTabLines;
  if (refireCmdlineRebuild) _refireCmdlineRebuild = refireCmdlineRebuild;
}

function addContentTab(...args) { return _addContentTab(...args); }
function updateContentTabLines(...args) { return _updateContentTabLines(...args); }
function refireCmdlineRebuild() { if (_refireCmdlineRebuild) _refireCmdlineRebuild(); }

module.exports = {
  setFeatureHost, addContentTab, updateContentTabLines, refireCmdlineRebuild,
};
