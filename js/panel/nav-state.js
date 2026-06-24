/**
 * Panel-state accessors — the per-panel nav chrome (cursor / scroll /
 * multiSel) readers + writers, the group-tree write wrappers, the viewer
 * content writers, and the `selectedOrFocused` / `infoLinesFromFocus`
 * composites.
 *
 * Re-homed from `app/state.js` in v0.6.5 §1 Phase 2: these are panel-domain
 * operations (they resolve panel→instance via `panel/route` and write via an
 * injected dispatch host — the fan-out lives in `dispatch/runtime/loop` since B/S6),
 * so they belong in `panel/`, not at the top
 * `app` layer. The move turns the old upward `dispatch/* → app/state` and
 * `panel/* → app/state` edges into downward `dispatch → panel` /
 * intra-panel edges. `app/state.js` re-exports these for back-compat so the
 * test suite is untouched; new code imports them here.
 *
 * Dependencies:
 *   - READERS (`getSel`/`getScroll`/`isMultiSel`/`multiSelCount`/`allPanels`)
 *     are `panel/api`-free — they use `panel/route` + leaves only, so they
 *     import cleanly at top level.
 *   - WRITERS dispatch through an INJECTED host (`setNavDispatch`, wired at
 *     boot) rather than importing the fan-out — so panel takes no static edge
 *     to the (relocating) dispatch core. v0.6.5 B/S3 formalized-injection.
 *   - COMPOSITES (`selectedOrFocused`/`infoLinesFromFocus`) still need `api`'s
 *     READ helpers (getItems/idOf/getPanelDef). `panel/api` in turn imports
 *     THIS module (`syncPanelScroll`, used in its per-dispatch finalizer), so
 *     api↔nav-state remain mutually dependent for reads — an intra-panel edge,
 *     broken the cheap way: `api` is required lazily (cached once in `_api()`),
 *     so the TOP-LEVEL import graph stays acyclic.
 *
 *     Caching the ref is safe only because no `_api()` caller runs during the
 *     require cycle: every caller is a runtime (dispatch-time) read, by which
 *     point `panel/api`'s `module.exports = {…}` has fully executed.
 */
'use strict';

const route = require('./route');
const mnav = require('../leaves/wm/nav');
const mpool = require('../leaves/wm/pool');
const pt = require('../leaves/wm/pane-tabs');
const { getModel } = require('../model/store');

// Lazy + cached panel/api ref — see the header note on the api↔nav-state
// intra-panel cycle. A bare require() per call re-resolves the path
// (~0.24µs of module-cache lookup); resolve once after load settles.
// Used by the READ composites only (getItems/idOf/getPanelDef) now that the
// writers dispatch through the injected host below.
let _apiRef = null;
function _api() { return _apiRef || (_apiRef = require('./api')); }

// Injected dispatch host (set at boot via setNavDispatch). nav-state's writers
// feed Msgs back through it instead of importing the (relocating) fan-out — the
// formalized-injection model (the runtime hands a panel writer module dispatch
// at boot). Wired from tui.js#main + the test-runner auto-setup, before any
// dispatch. See docs/v0.6.5-dispatch-loop.md.
let _host = null;
function setNavDispatch(host) { _host = host; }

// --- panel-type resolution + nav-entry access ---

// Canonical dual-input resolver: accepts panel-type (renderers, direct
// callers) or paneId (post-B3 getFocus() consumers). Returns panel-type
// (the form mnav.entryOf / Component.update key by).
function _resolvePanelType(id) {
  return route.paneTypeOf(id) || id;
}

// Walk panel-type → owning Component → nav entry. Reader-side: route only
// (componentForPanel + sliceForPane), no api.
function _navEntry(id) {
  const panelType = _resolvePanelType(id);
  const compName = route.componentForPanel(panelType);
  if (!compName) return null;
  // v0.6.4 Theme A Phase 5 — read THIS pane's own nav entry. sliceForPane
  // resolves `id` (paneId) → its own instance; falls back to compName's
  // primary for docker-style panes + legacy kind-name callers. entryOf
  // keys by panelType within the slice (multi-panel Components like files).
  return mnav.entryOf(route.sliceForPane(id, compName), panelType);
}

// Write-side: routes a nav Msg to the owning Component via the injected host.
function _navDispatch(id, msg) {
  const panelType = _resolvePanelType(id);
  const compName = route.componentForPanel(panelType);
  if (!compName) return;
  // v0.6.4 Theme A Phase 5 — route the write to THIS pane's instance when
  // `id` is a live paneId (so setSel/setScroll/multisel land on the pane the
  // user is acting on, not the kind's primary); else the kind/Component name
  // (docker-style panes + legacy callers route to primary). `panel: panelType`
  // still keys nav[panelType] inside multi-panel Components (files).
  const target = route.hasInstance(id) ? id : compName;
  _host.dispatchMsg(route.wrap(target, { ...msg, panel: panelType }));
}

/** Get selection index for a panel type (default 0). */
function getSel(panelType) { const e = _navEntry(panelType); return e ? e.cursor : 0; }
/** Set selection index for a panel type. */
function setSel(panelType, idx) { _navDispatch(panelType, { type: 'set_cursor', index: idx | 0 }); }
/** Get scroll offset for a panel type (default 0). */
function getScroll(panelType) { const e = _navEntry(panelType); return e ? e.scroll : 0; }
/** Set scroll offset for a panel type. */
function setScroll(panelType, offset) { _navDispatch(panelType, { type: 'set_scroll', offset: offset | 0 }); }

/**
 * Clamp a panel's scroll so the selection stays in view. Scrolls down if
 * the selection is past the viewport bottom; up if above. Called per pane
 * by api's dispatch finalizer.
 */
function syncPanelScroll(panelType, innerH) {
  const sel = getSel(panelType);
  const scroll = getScroll(panelType);
  if (sel >= scroll + innerH) setScroll(panelType, sel - innerH + 1);
  else if (sel < scroll) setScroll(panelType, sel);
}

// layout is a SERVICE slot (chrome Component) — explicit read; null pre-boot
// (production registers it at boot; a pre-boot reader just sees no panes).
function _layoutSlice() { return route.serviceSlice('layout'); }

function allPanels() {
  const slice = _layoutSlice();
  if (!slice) return [];
  return mpool.allPanesInColumns(slice.arrange);
}

// --- Group tree (flatten + expand/collapse) ---
//
// The groups Component owns the tree slice + cascade logic. These wrappers
// dispatch the right Msgs — slice mutations go through the Component's
// update, and the cross-layer cascade Cmds (set_current_group /
// reset_group_context / viewer_reset_chrome) fire as a consequence. Kept as
// named exports so non-reducer callers (mouse, recursive `"` expand, tests)
// have a stable surface.
// v0.6.3 Phase D1: thread the groupsBundle (+ paneMenuMode for the
// cascade-emit case) so the reducer arms stay pure of getModel().
function _groupsCtx() {
  const groupsComp = require('../panel/navigator/groups');
  const m = getModel();
  // viewerTarget — the cascade's viewer_reset_chrome destination, resolved
  // here in the impure shell so groups.update reads it off msg.ctx instead
  // of reading route topology at reduce time (#D10). resetOwners — the
  // per-panel reset targets for the reset_group_context cascade, likewise
  // resolved here so the root reducer reads no ownership registry (#D9).
  return {
    ...groupsComp.groupsBundle(m),
    paneMenuMode: !!m.modes.paneMenuMode,
    viewerTarget: route.resolveTarget('viewer'),
    resetOwners: route.resetGroupOwners(),
  };
}

function recomputeGroups() {
  _host.dispatchMsg(route.wrap('groups', { type: 'groups_recompute', ctx: _groupsCtx() }));
}
function switchGroupsTab(/* tab */) {
  // toggle_groups_tab flips All↔Quick (the only transition we use today);
  // explicit-target setters belong to the Component if ever needed.
  _host.dispatchMsg(route.wrap('groups', { type: 'toggle_groups_tab', ctx: _groupsCtx() }));
}
function expandGroup(path, recursive = false) {
  _host.dispatchMsg(route.wrap('groups', { type: 'toggle_group', name: path, recursive, ctx: _groupsCtx() }));
}
function collapseGroup(path, recursive = false) {
  _host.dispatchMsg(route.wrap('groups', { type: 'toggle_group', name: path, recursive, ctx: _groupsCtx() }));
}

// --- Viewer content writers ---

function setViewerContent(tabId, text, opts) {
  // viewer_set_content REPLACES the body — single-writer for producers that
  // show a discrete document (history replay, config-status diff, help text,
  // Running-overlay job info). For ephemeral event/status messages, use
  // appendViewerLines below — that accumulates into viewerStreamBuffer and
  // survives tab switches.
  //
  // `tabId` is the producer-side address. When null, the destination resolves
  // via route.resolveTarget('viewer'). `opts.tab` (v0.6.2 R6) lands on a
  // specific tab in the SAME dispatch (e.g. history.replay parks on Info).
  if (tabId == null) {
    tabId = route.resolveTarget('viewer');
    if (tabId == null) return;   // no viewer registered — drop the write
  }
  // v0.6.3 Phase D1 — thread root facts the viewer_set_content arm needs so
  // the reducer stays pure of getModel(): currentGroup, fromTabKey (the
  // FROM-tab key for view-state capture), total (when msg.tab is set).
  const slice = route.getInstanceSlice(tabId) || { tab: 0 };
  const model = getModel();
  const inner = {
    type: 'viewer_set_content',
    lines: text ? text.split('\n') : [],
    currentGroup: model.currentGroup,
    fromTabKey: pt.resolveTabKey((slice.tab | 0), slice, model),
  };
  if (opts && typeof opts.tab === 'number') {
    inner.tab = opts.tab | 0;
    inner.total = pt.flatTabInfo(slice, model, model.currentGroup).total;
  }
  _host.dispatchMsg(route.wrap(tabId, inner));
}

/**
 * Append an event/status message to the viewer's unrouted accumulator
 * (`slice.viewerStreamBuffer`) — the same buffer streamed `type:run` output
 * writes to. Use for ephemeral "user did X" lines (spawn/background
 * confirmations, cmdline outcomes) that should join the transcript instead
 * of clobbering the current tab.
 */
function appendViewerLines(text) {
  if (!text) return;
  const tabId = route.resolveTarget('viewer');
  if (tabId == null) return;
  const lines = text.split('\n');
  if (!lines.length) return;
  _host.dispatchMsg(route.wrap(tabId, { type: 'viewer_append_lines', lines }));
}

// --- Multi-select (bulk-operation operand) ---

function toggleMultiSel(panelType, itemId) {
  _navDispatch(panelType, { type: 'multisel_toggle', id: itemId });
}
function isMultiSel(panelType, itemId) {
  const e = _navEntry(panelType);
  return !!(e && e.multiSel.has(itemId));
}
function clearMultiSel(panelType) {
  _navDispatch(panelType, { type: 'multisel_clear' });
}
function multiSelCount(panelType) {
  const e = _navEntry(panelType);
  return e ? e.multiSel.size : 0;
}

// --- Composites (relocated from panel/api.js: they read the nav chrome) ---

/**
 * The bulk operand: the multi-selected items if any, else the focused item.
 * Used by docker bulk actions.
 */
function selectedOrFocused(panelType) {
  const api = _api();
  const items = api.getItems(panelType);
  const sel = getSel(panelType);
  if (multiSelCount(panelType) > 0) {
    return items.filter(item => isMultiSel(panelType, api.idOf(panelType, item)));
  }
  return items[sel] ? [items[sel]] : [];
}

/**
 * Resolve the focused panel's info lines (the dispatcher-side compute that
 * `dispatch.showSelectedInfo` threads as `msg.lines`, so the
 * viewer_show_info reducer arm stays pure of plugin reads). null = no
 * def/selection (caller skips); [] = empty getInfo (still dispatches).
 */
function infoLinesFromFocus() {
  const api = _api();
  const focus = route.getFocus();
  const def = api.getPanelDef(focus);
  if (!def || typeof def.getItems !== 'function' || typeof def.getInfo !== 'function') return null;
  const items = api.getItems(focus);
  const item = items[getSel(focus)];
  if (!item) return null;
  // Thread the focused paneId so a multi-panelType Component (files) reads
  // THIS pane's browser/config. Arity-ignored by single-panel defs.
  const out = def.getInfo(item, focus);
  // EMPTY getInfo returns [] (not null): the dispatch (and yank) still
  // happens for an empty-info item; only no-def/no-selection skips.
  if (!out || !out.length) return [];
  return out.join('\n').split('\n');
}

module.exports = {
  setNavDispatch,
  getSel, setSel, getScroll, setScroll, syncPanelScroll,
  allPanels,
  toggleMultiSel, isMultiSel, clearMultiSel, multiSelCount,
  recomputeGroups, switchGroupsTab, expandGroup, collapseGroup,
  setViewerContent, appendViewerLines,
  selectedOrFocused, infoLinesFromFocus,
};
