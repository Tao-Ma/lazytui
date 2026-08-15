/**
 * U2e P1b — open a file / docker path as a `text-view` POSITION-tab in the content
 * slot (was the viewer's inner `contentTabs` machinery, which rendered on the
 * now-retired flat strip). PROVIDES the `hosts/feature-host` seam that
 * `feature/open-file` + `feature/open-docker` call — so those bottom-layer
 * workflows stay panel-free; only the destination moves from the detail viewer to
 * a real minted position-tab instance. (Panel-side provider, mirroring the old
 * `panel/viewer/tabs.js` wiring; dispatch goes through the panel-host seam, so no
 * panel→dispatch edge.)
 *
 * Reuse: the tab's poolId derives deterministically from the content `key`
 * (`file:<abs>` / `docker:<c>:<path>`), so re-opening the same target re-activates
 * its existing tab instead of stacking duplicates (mint_tab no-ops on a poolId
 * collision; the following set_active_tab re-activates either way).
 *
 * Behaviour note: unlike the old per-group `contentTabs[group]`, a text-view tab is
 * a slot position-tab — it PERSISTS across group switches, exactly like a terminal
 * pane (U2d). This is the arc's full-dissolution direction (one tab system); the
 * `groupName` arg is retained for signature compatibility but no longer scopes the
 * tab. Content lands via `tv_set_lines` (replace), so the async loading→resolved
 * swap is one clean buffer replacement.
 */
'use strict';

const route = require('./route');
const mpane = require('../leaves/wm/pane');

// Stable, replay-deterministic poolId per content key.
function _poolId(key) {
  return 'content-' + String(key).replace(/[^A-Za-z0-9_.-]+/g, '-');
}

function _dispatch(msg) {
  require('../hosts/panel-host').dispatchMsg(msg);
}

function addContentTab(groupName, key, label, lines) {
  const slotPaneId = route.resolveViewerPaneId();
  if (!slotPaneId) return;   // no content slot placed → nowhere to open
  const poolId = _poolId(key);
  const seedLines = Array.isArray(lines) ? lines : [];
  // Mint (no-op if the tab already exists) then activate — reuse re-focuses the
  // existing tab; a fresh mint is already active but set_active_tab is idempotent.
  // Seed the INITIAL content via the mint's `config.lines` — text-view.init reads
  // it — so a freshly-minted tab has its content immediately, WITHOUT depending on
  // the mint's post-dispatch reconcile having minted the instance before the
  // tv_set_lines below (which it hasn't when addContentTab is called from a NESTED
  // dispatch, e.g. the jobs cascade — the instance doesn't exist mid-cascade, so
  // that tv_set_lines is dropped). updateContentTabLines then covers the REUSE case
  // (existing tab → replace) + the async-resolve case (open-file's .then()).
  _dispatch(route.wrap('layout', {
    type: 'mint_tab', paneId: slotPaneId, paneType: 'text-view', poolId,
    title: label, hint: { origin: 'open', key }, config: { lines: seedLines },
  }));
  _dispatch(route.wrap('layout', {
    // set_active_tab / mint_tab are transient (layout.js), so opening/viewing a
    // (session-only) content tab doesn't mark the layout dirty.
    type: 'set_active_tab', paneId: slotPaneId, tabPoolId: poolId,
  }));
  updateContentTabLines(groupName, key, seedLines);
}

function updateContentTabLines(groupName, key, lines) {
  const tabInstId = mpane.newPaneId(_poolId(key));
  // The tab may be gone (closed) by the time an async load resolves — drop silently.
  if (!route.getInstance(tabInstId)) return;
  _dispatch(route.wrap(tabInstId, {
    type: 'tv_set_lines', lines: Array.isArray(lines) ? lines : [],
  }));
}

require('../hosts/feature-host').setFeatureHost({ addContentTab, updateContentTabLines });

module.exports = { addContentTab, updateContentTabLines, _poolId };
