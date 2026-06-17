/**
 * Feature-host port — the injected seam through which the `feature/` layer
 * reaches its host (panel + dispatch) WITHOUT importing upward.
 *
 * `feature/` holds workflows (open a file/docker path as a viewer tab, etc.)
 * that other layers invoke (panel components, dispatch). To keep feature a
 * pure BOTTOM layer (no feature→panel / feature→dispatch import edges that
 * would re-form the layer cycle), the few calls feature needs to make back
 * up are injected here and called through this port.
 *
 * Lives in `ports/` (its own bottom layer), NOT `leaves/`: like panel-host it
 * is a PURE injection port (injected fn slots + delegating wrappers, no
 * transform logic), so it sits apart from the pure-transform leaves
 * (TEA-review follow-up #6). Same render-exit seam mechanism as the
 * seam-bearing leaves render-queue / draw's dims provider — those keep real
 * pure logic, so they stay leaves; these two are nothing but the seam.
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
