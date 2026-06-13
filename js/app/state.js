/**
 * App state — config loading, layout initialization, slice-reset wrappers.
 *
 * No mutable state lives here. The root model lives in runtime.js
 * (getModel()); Component slices live in the instance store
 * (panel/route.js). This module is the boot/init layer
 * (loadConfig + initState) plus the small set of read/write helpers the
 * rest of the codebase imports from `./state`: getSel / setSel /
 * getScroll / setScroll / toggleMultiSel / allPanels /
 * resetGroupContext / selectGroup / setViewerContent / appendViewerLines / recomputeGroups
 * (and friends).
 *
 * Helpers are thin routers: they resolve a panel type to its owning
 * Component, then dispatch a wrapped Msg into that Component's update.
 * The Component is the single writer for its slice.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { setTheme } = require('../render/themes');
const { getModel } = require('./runtime');
const { rebuildLayoutFromConfig } = require('../leaves/arrange');

// Memoized module refs for the nav hot path (_resolvePanelType /
// _navEntry / _navDispatch — getSel/getScroll ride them on every
// keystroke AND, since resize-as-Msg P2, every dispatch via the
// finalizer). They must stay lazy (state ↔ panel/api load cycle), but
// a bare require() per call re-RESOLVES the path — ~35μs of fs stats
// per call on containerized filesystems (Node's stat cache only spans
// startup), measured 1000× the actual lookup work. Resolve once at
// first call, after the cycle has settled.
let _apiRef = null, _routeRef = null;
function _api()      { return _apiRef   || (_apiRef   = require('../panel/api')); }
function _routeMod() { return _routeRef || (_routeRef = require('../panel/route')); }

// --- Component slice resolution ---
//
// Lazy auto-register covers tests that touch state without explicit
// Component setup; production registers detail + groups + layout at
// boot via tui.js, so these only trip in the test harness.
let _detailAutoRegistered = false;
function _detailSlice() {
  const api = require('../panel/api');
  let s = api.getInstanceSlice('detail');
  if (!s) {
    if (!_detailAutoRegistered) {
      try { require('../dispatch/effects').installBuiltins(); } catch (_) {}
      _detailAutoRegistered = true;
    }
    _layoutSlice();   // layout must register first — focus reader's primary instance
    api.registerComponent(require('../panel/viewer/viewer'));
    s = api.getInstanceSlice('detail');
  }
  return s;
}

let _groupsAutoRegistered = false;
function _groupsSlice() {
  const api = require('../panel/api');
  let s = api.getInstanceSlice('groups');
  if (!s) {
    if (!_groupsAutoRegistered) {
      try { require('../dispatch/effects').installBuiltins(); } catch (_) {}
      _groupsAutoRegistered = true;
    }
    _layoutSlice();   // layout must register first — focus reader's primary instance
    api.registerComponent(require('../panel/navigator/groups'));
    s = api.getInstanceSlice('groups');
  }
  return s;
}

// Same lazy-auto-register pattern for the layout (chrome) Component.
// The "first-touch" point is initState (sets initial focus + viewMode
// tag), so the helper is called there.
let _layoutAutoRegistered = false;
function _layoutSlice() {
  const api = require('../panel/api');
  let s = api.getInstanceSlice('layout');
  if (!s) {
    if (!_layoutAutoRegistered) {
      try { require('../dispatch/effects').installBuiltins(); } catch (_) {}
      _layoutAutoRegistered = true;
    }
    api.registerComponent(require('../panel/layout'));
    s = api.getInstanceSlice('layout');
  }
  return s;
}

// --- Config loading ---

function loadConfig(configPath) {
  const ext = path.extname(configPath);
  let config;
  if (ext === '.json') {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } else {
    // In-process JS parser — was an out-of-process `python -m parser`
    // call until the parser was rewritten in JS. Errors thrown by
    // parse() are ParseError subclasses with composed messages; let
    // them propagate so tui.js's top-level handler prints them and
    // exits non-zero (mirrors the old "parser: <msg>" stderr line).
    const { parse } = require('../parser');
    config = parse(path.resolve(configPath));
  }
  // v0.6.3 Phase D3 — route the root-model write through a Msg so
  // the reducer is the sole writer to model.config / projectDir /
  // configPath. Pre-D3 was direct `m.config = ...` (the BLESSED
  // outside-writer per docs/v0.5-layering.md §5).
  require('../dispatch/dispatch').applyMsg({
    type: 'set_config',
    config,
    configPath: path.resolve(configPath),
  });
}

// --- Layout initialization ---

function initState() {
  const m = getModel();
  const config = m.config;
  setTheme(config.theme || 'default');

  // Force-register the layout / groups / detail Components — production
  // (tui.js) already did, but the test harness path may have skipped them.
  _layoutSlice();
  _groupsSlice();
  _detailSlice();

  // Seed the layout arrange struct from config via the layout
  // Component's own writer (set_arrange Msg). Single-writer holds at
  // boot too — initState doesn't poke at slice fields directly. All
  // other slice/model state initializes from runtime.init() /
  // Component.init() defaults; only config-derived seeds (arrange,
  // currentGroup, register cap) and the theme set need a write here.
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('layout', {
    type: 'set_arrange',
    arrange: rebuildLayoutFromConfig(config),
    dirty: false,
  }));

  // Seed the model's terminal dimensions (resize-as-Msg P1). The ONLY
  // place besides the tui.js 'resize' listener that reads the live
  // terminal size — everything downstream reads layoutSlice.dims.
  const tdims = require('../io/term').dims();
  api.dispatchMsg(api.wrap('layout', {
    type: 'term_resized', cols: tdims.cols, rows: tdims.rows,
  }));

  // v0.6.3 Phase B — mint per-pane Component instances keyed by
  // paneId. Pre-B used the singleton convention (id === kind ===
  // Component name); post-B every PLACED pane gets its own instance
  // with id = pane.paneId (e.g. 'pane-detail', 'pane-groups'). The
  // kind-keyed instance that registerComponent minted earlier is
  // disposed for each kind we re-mint per pane — _primaryByKind
  // shifts to the new paneId. Service slots (chrome like 'layout',
  // content owners like 'docker') are never disposed — route refuses.
  //
  // Foundational for v0.7 multi-instance: a second pane of the
  // same kind gets its own paneId, its own slice. Today every
  // kind has exactly one pane; the convention just gets ready.
  const route = require('../panel/route');
  const mpool = require('../leaves/pool');
  const components = api._components ? api._components() : null;
  if (components) {
    const arrange = _layoutSlice().arrange;
    const placedPanes = arrange ? mpool.allPanesInColumns(arrange) : [];
    for (const p of placedPanes) {
      const kind = p.type;
      const paneId = p.paneId;
      if (!paneId || !kind) continue;
      // v0.6.4 Theme A Phase 5 Arc 2 — resolve panes via the panel-type
      // ownership registry (covers aliased types like `file-browser`,
      // owned by the `files` Component). Deliberately NOT
      // `components[kind]`: that arm matched Component NAMES too, so a
      // config pane of `type: docker` / `type: layout` resolved here
      // and disposed the kind-global service instance (docker's content
      // owner — fetching silently died). Every legitimate placeable
      // type is in the `_panelOwner` registry; a name-only kind now
      // mints nothing (honest unknown-type failure).
      const comp = components[route.componentForPanel(kind)];
      if (!comp) continue;
      // Dispose the kind-keyed singleton slice (minted at
      // registerComponent), then mint fresh keyed by paneId.
      if (route.hasInstance(kind) && kind !== paneId) {
        route.disposeInstance(kind);
      }
      if (!route.hasInstance(paneId)) {
        // Stamp the pane identity onto the slice (init(paneId)) so the
        // Component can resolve "my pane" from its own slice on every
        // path — including the broadcast `refresh` where no call-site
        // paneId is available. init() arity-ignores it for Components
        // that don't need identity.
        route.setInstance(paneId, kind, comp.init(paneId));
      }
    }
  }

  // Rebuild the visible group list from config, then seed currentGroup
  // from the first visible row. recomputeGroups dispatches into the
  // groups Component; set_current_group rides through the root reducer.
  recomputeGroups();
  const groupsAfter = _groupsSlice();
  const firstName = groupsAfter.list.length ? groupsAfter.list[0].name : '';
  require('../dispatch/dispatch').applyMsg({ type: 'set_current_group', name: firstName });

  // Yank register — bounded history, system-clipboard mirror. Cap is
  // configurable via top-level `register: { cap: N }` in YAML; default
  // 100. Init deferred to here so cap reflects the parsed config.
  // v0.6.3 Phase D3 — routed through set_register Msg so the reducer
  // is the sole writer to root.register. Was a BLESSED outside-writer.
  require('../dispatch/dispatch').applyMsg({
    type: 'set_register',
    register: require('../leaves/register').init(config.register || {}),
  });

  // Soft-fail diagnostics from parse (today: column over soft cap).
  // Records one event-log entry per warning + seeds layout's bootWarnings
  // so the footer paints "⚠ N config warning(s)" until dismissed.
  const warnings = Array.isArray(config.warnings) ? config.warnings : [];
  if (warnings.length > 0) {
    const log = require('../dispatch/event-log');
    const diag = require('../dispatch/diag-log');
    for (const w of warnings) {
      log.record('warning', { code: w.code, message: w.message });
      diag.warn(w.code || 'config', w.message);
    }
    api.dispatchMsg(api.wrap('layout', {
      type: 'set_boot_warnings',
      warnings: warnings.map(w => w.message),
    }));
  }
}

function allPanels() {
  const slice = _layoutSlice();
  if (!slice) return [];
  return require('../leaves/pool').allPanesInColumns(slice.arrange);
}

// --- Group tree (flatten + expand/collapse) ---
//
// The groups Component owns the tree slice + cascade logic. These wrappers
// dispatch the right Msgs — slice mutations go through the Component's
// update, and the cross-layer cascade Cmds (set_current_group /
// reset_group_context / viewer_reset_chrome) fire as a consequence.
// Kept here as named exports so non-reducer callers (mouse, recursive `"`
// expand, tests) have a stable surface.
// v0.6.3 Phase D1: thread the groupsBundle (+ paneMenuMode for the
// cascade-emit case) so the reducer arms stay pure of getModel().
function _groupsCtx() {
  const groupsComp = require('../panel/navigator/groups');
  const { getModel } = require('./runtime');
  const m = getModel();
  return { ...groupsComp.groupsBundle(m), paneMenuMode: !!m.modes.paneMenuMode };
}

function recomputeGroups() {
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('groups', { type: 'groups_recompute', ctx: _groupsCtx() }));
}
function switchGroupsTab(/* tab */) {
  // toggle_groups_tab flips All↔Quick (the only transition we use today);
  // explicit-target setters belong to the Component if ever needed.
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('groups', { type: 'toggle_groups_tab', ctx: _groupsCtx() }));
}
function expandGroup(path, recursive = false) {
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('groups', { type: 'toggle_group', name: path, recursive, ctx: _groupsCtx() }));
}
function collapseGroup(path, recursive = false) {
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('groups', { type: 'toggle_group', name: path, recursive, ctx: _groupsCtx() }));
}

// Nav chrome (cursor / scroll / multiSel / filter) lives on each
// Navigator Component's slice — single-panel Components store the
// entry directly at `slice.nav`, multi-panel keep `slice.nav[panel]`.
// The helpers walk panel-type → owning Component → entry; shape
// detection is the `leaves/nav` reader.

const mnav = require('../leaves/nav');

// v0.6.3 post-arch-arc T3.5 — canonical dual-input resolver:
// accepts panel-type (production renderers, direct callers) or
// paneId (post-B3 `getFocus()` consumers). Returns panel-type
// (the form mnav.entryOf / Component.update use for keying).
// Single-panel Components don't differentiate (slice.nav is a flat
// entry); multi-panel Components (docker) need the type form to
// find the right nav[panelType] entry.
function _resolvePanelType(id) {
  // Delegates to route.paneTypeOf — accepts paneId or panel-type and
  // returns the panel-type form. Single canonical resolver across
  // the codebase.
  return _routeMod().paneTypeOf(id) || id;
}

function _navEntry(id) {
  const api = _api();
  const panelType = _resolvePanelType(id);
  const compName = api.getComponentOwningPanel(panelType);
  if (!compName) return null;
  // v0.6.4 Theme A Phase 5 — read THIS pane's own nav entry. sliceForPane
  // resolves `id` (paneId) → its own instance; falls back to compName's
  // primary for docker-style panes + legacy kind-name callers. entryOf
  // keys by panelType within the slice (multi-panel Components like files).
  return mnav.entryOf(api.sliceForPane(id, compName), panelType);
}

function _navDispatch(id, msg) {
  const api = _api();
  const route = _routeMod();
  const panelType = _resolvePanelType(id);
  const compName = api.getComponentOwningPanel(panelType);
  if (!compName) return;
  // v0.6.4 Theme A Phase 5 — route the write to THIS pane's instance
  // when `id` is a live paneId (so setSel/setScroll/multisel land on the
  // pane the user is acting on, not the kind's primary); else the
  // kind/Component name (docker-style panes + legacy callers route to
  // primary). `panel: panelType` still keys nav[panelType] inside
  // multi-panel Components (files). No-op under single-pane configs.
  const target = route.hasInstance(id) ? id : compName;
  api.dispatchMsg(api.wrap(target, { ...msg, panel: panelType }));
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
 * Sync scroll offset so the selected item is visible within innerH rows.
 * Scrolls down if selection is past the viewport bottom; scrolls up if above.
 */
function syncPanelScroll(panelType, innerH) {
  const sel = getSel(panelType);
  const scroll = getScroll(panelType);
  if (sel >= scroll + innerH) setScroll(panelType, sel - innerH + 1);
  else if (sel < scroll) setScroll(panelType, sel);
}

/**
 * Reset the per-group transient UI state. Called when the user navigates
 * to a different group — selections in group-scoped panels go back to
 * row 0, the detail tab returns to "Info", filters/last-action/terminal
 * mode are cleared. Routes through reset_group_context (root reducer) +
 * viewer_reset_chrome (detail Component).
 */
function resetGroupContext() {
  // Two writes: the root-chrome reset is a Msg into runtime.update; the
  // viewer-slice half is its own Msg dispatched to the resolved viewer
  // target. resolveTarget returns null when no viewer is registered —
  // the viewer-half Cmd drops in that case.
  const dispatch = require('../dispatch/dispatch');
  const api = require('../panel/api');
  const route = require('../panel/route');
  dispatch.applyMsg({ type: 'reset_group_context' });
  const target = route.resolveTarget('viewer');
  if (target) {
    // v0.6.3 Phase D1: thread paneMenuMode so the reducer stays pure.
    const m = require('./runtime').getModel();
    api.dispatchMsg(api.wrap(target, { type: 'viewer_reset_chrome', paneMenuMode: !!m.modes.paneMenuMode }));
  }
}

/**
 * Set the active group by its index in the visible group list. No-op on
 * out-of-range. Resets per-group transient state via resetGroupContext().
 */
function selectGroup(idx) {
  // dispatch.navSelect does the per-Component routing (set_cursor →
  // owning Component + show_selected_info + the groups_selected
  // cascade).
  require('../dispatch/dispatch').navSelect('groups', idx);
}

function setViewerContent(tabId, text, opts) {
  // viewer_set_content REPLACES the body — single-writer for producers
  // that show a discrete document (history replay, config-status diff,
  // help text, Running-overlay job info). For ephemeral event/status
  // messages (spawn-status, cmdline outcomes), use appendViewerLines
  // below — that path accumulates into viewerStreamBuffer and survives
  // tab switches.
  //
  // `tabId` is the producer-side address. When null, the destination
  // resolves via route.resolveTarget('viewer') (focused viewer-kind
  // tab / sticky lastViewerTab / first in arrange / any / null).
  //
  // `opts.tab` (v0.6.2 R6) lets the caller land on a specific tab in
  // the SAME dispatch — e.g. history.replay parks on Info so the
  // override paints with a clear home tab. Without opts.tab the
  // tab idx is left unchanged (the override paints regardless via
  // viewerLines's precedence chain).
  if (tabId == null) {
    const route = require('../panel/route');
    tabId = route.resolveTarget('viewer');
    if (tabId == null) return;   // no viewer registered — drop the write
  }
  const api = require('../panel/api');
  // v0.6.3 Phase D1 — thread root facts the viewer_set_content arm
  // needs so the reducer stays pure of getModel():
  //   currentGroup, fromTabKey (the FROM-tab key for view-state
  //   capture), total (when msg.tab is set, for the in-range clamp).
  const slice = api.getInstanceSlice(tabId) || { tab: 0 };
  const model = require('./runtime').getModel();
  const pt = require('../leaves/pane-tabs');
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
  api.dispatchMsg(api.wrap(tabId, inner));
}

/**
 * Append an event/status message to the viewer's unrouted accumulator
 * (`slice.viewerStreamBuffer`) — the same buffer streamed `type:run`
 * output writes to. Use this for ephemeral "user did X" lines —
 * spawn/background launch confirmations, cmdline verb outcomes —
 * where the message should join the transcript instead of clobbering
 * whatever tab is currently showing.
 *
 * The dispatch is unrouted (`viewer_append_lines` with no tabKey) —
 * the lines accumulate in viewerStreamBuffer and display on the
 * Transcript tab (P3: the slice.lines mirror is gone; display always
 * derives from the buffer).
 *
 * v0.6.2 fix — pre-fix `setViewerContent` was used for these messages
 * too, and clobbered whatever tab the user was on (not just Info).
 */
function appendViewerLines(text) {
  if (!text) return;
  const route = require('../panel/route');
  const tabId = route.resolveTarget('viewer');
  if (tabId == null) return;
  const lines = text.split('\n');
  if (!lines.length) return;
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap(tabId, { type: 'viewer_append_lines', lines }));
}

// --- Multi-select (bulk-operation operand) ---
//
// Each Navigator's `slice.nav[panelType].multiSel` is a Set of stable
// item IDs. Identity comes from each panelType's `idOf(item)`
// (panel/api.js#idOf), so selections are robust to filtering and
// re-sorting — you select a thing, not a position. Writes go through
// wrapped Msgs (multisel_toggle / multisel_select_all / multisel_clear)
// so each Component owns its own multiSel Set.

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

module.exports = {
  loadConfig, initState,
  allPanels, selectGroup, resetGroupContext, setViewerContent, appendViewerLines,
  getSel, setSel, getScroll, setScroll, syncPanelScroll,
  toggleMultiSel, isMultiSel, clearMultiSel, multiSelCount,
  expandGroup, collapseGroup, recomputeGroups, switchGroupsTab,
};
