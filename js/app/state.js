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
const { setTheme } = require('../leaves/themes');
const { getModel } = require('../model/store');
const { rebuildLayoutFromConfig } = require('../leaves/arrange');
// Panel-state accessors (readers/writers/composites) moved to
// panel/nav-state.js in v0.6.5 §1 Phase 2. This module keeps the boot layer
// (loadConfig/initState) + the two dispatch-layer group helpers
// (selectGroup/resetGroupContext) and RE-EXPORTS the accessors below so
// existing `require('../app/state')` importers (notably the test suite) keep
// working untouched; new code imports them from panel/nav-state directly.
const navState = require('../panel/nav-state');


// v0.6.4 Phase D — declared hub subscriptions, wired at MOUNT (the
// per-pane mint loop in initState), not lazily from a Component's
// render(). A Component exports a PURE `subscriptions(paneDef) →
// [{topic, window}]` declaring the hub topics it consumes; the framework
// performs the hub.subscribe side effect here. This is the TEA
// `subscriptions` seam — the Component stays pure, the runtime owns the
// effect (replaces stats._ensureSub, the old paint-mixed-with-lifecycle
// blessed exception). `onUpdate` is always a repaint: hub data drives
// frames (see stats.js). Deduped by topic:window across all mints (two
// panes on one topic share a sub; mirrors the pre-D module Set, now
// framework-owned). NOTE no teardown yet — there is no post-boot
// topic-change or pane-dispose-unsubscribe path today; growing one is a
// follow-on the framework is now SHAPED for (the Component declares; the
// runtime could diff + unsubscribe).
const _wiredSubs = new Set();
function _wireSubscriptions(comp, paneDef) {
  if (!comp || typeof comp.subscriptions !== 'function') return;
  let descriptors;
  try { descriptors = comp.subscriptions(paneDef) || []; }
  catch (e) {
    console.error(`[${comp.name || '?'}] subscriptions() threw: ${e && e.message}`);
    return;
  }
  const hub = require('../leaves/hub');
  const { scheduleRender } = require('../panel/api');
  for (const d of descriptors) {
    if (!d || !d.topic) continue;
    const window = d.window || 1;
    const key = `${d.topic}:${window}`;
    if (_wiredSubs.has(key)) continue;
    hub.subscribe(d.topic, { window, onUpdate: () => scheduleRender() });
    _wiredSubs.add(key);
  }
}
// Test-only — clears the wired-sub dedup ledger so a test can re-wire
// after hub._reset() (mirrors hub._reset / jobs._reset).
function _resetSubscriptions() { _wiredSubs.clear(); }

// --- Component slice resolution ---
//
// Lazy auto-register covers tests that touch state without explicit
// Component setup; production registers detail + groups + layout at
// boot via tui.js, so these only trip in the test harness.
let _detailAutoRegistered = false;
function _detailSlice() {
  const api = require('../panel/api');
  // primarySliceOf, not getInstanceSlice: post-initState the kind-keyed
  // seed is disposed and the slice lives on the primary PANE instance —
  // an id read would miss and re-register the Component mid-session.
  let s = api.primarySliceOf('detail');
  if (!s) {
    if (!_detailAutoRegistered) {
      try { require('../dispatch/runtime/effects').installBuiltins(); } catch (_) {}
      _detailAutoRegistered = true;
    }
    _layoutSlice();   // layout must register first — focus reader's service slot
    api.registerComponent(require('../panel/viewer/viewer'));
    s = api.primarySliceOf('detail');
  }
  return s;
}

let _groupsAutoRegistered = false;
function _groupsSlice() {
  const api = require('../panel/api');
  // primarySliceOf for the same reason as _detailSlice — and this one
  // IS hit post-mint in production: initState calls _groupsSlice()
  // right after the mint loop disposed the 'groups' seed.
  let s = api.primarySliceOf('groups');
  if (!s) {
    if (!_groupsAutoRegistered) {
      try { require('../dispatch/runtime/effects').installBuiltins(); } catch (_) {}
      _groupsAutoRegistered = true;
    }
    _layoutSlice();   // layout must register first — focus reader's service slot
    api.registerComponent(require('../panel/navigator/groups'));
    s = api.primarySliceOf('groups');
  }
  return s;
}

// Same lazy-auto-register pattern for the layout (chrome) Component.
// The "first-touch" point is initState (sets initial focus + viewMode
// tag), so the helper is called there.
let _layoutAutoRegistered = false;
function _layoutSlice() {
  const api = require('../panel/api');
  // layout is a SERVICE slot (chrome Component) — explicit read.
  let s = api.serviceSlice('layout');
  if (!s) {
    if (!_layoutAutoRegistered) {
      try { require('../dispatch/runtime/effects').installBuiltins(); } catch (_) {}
      _layoutAutoRegistered = true;
    }
    api.registerComponent(require('../panel/layout'));
    s = api.serviceSlice('layout');
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
  require('../dispatch/control/dispatch').applyMsg({
    type: 'set_config',
    config,
    configPath: path.resolve(configPath),
  });
}

// --- Layout initialization ---

// Mint/dispose per-pane Component instances to MATCH the placed layout. Runs
// at boot (initState) AND after every runtime placement/removal — the dispatch
// finalizer calls it (via api.setInstanceReconciler) gated on arrange-ref
// change. MINT: each placed pane lacking an instance, keyed by paneId — so a
// second same-kind pane added at runtime (pool_show / pool-drag / pane-select)
// gets its OWN slice instead of collapsing onto the kind primary (the v0.6.4
// multi-viewer guarantee, previously honored only for config-declared panes).
// DISPOSE: each per-pane instance whose pane left the layout (frees the slice).
// This IS the framework's impure first-touch shell — getModel() is blessed
// here, as it was in the boot mint loop; the reducer arms that place/remove
// panes stay pure.
function reconcilePaneInstances() {
  const api = require('../panel/api');
  const route = require('../panel/route');
  const mpool = require('../leaves/pool');
  const components = api._components ? api._components() : null;
  if (!components) return;
  const arrange = _layoutSlice().arrange;
  const placedPanes = arrange ? mpool.allPanesInColumns(arrange) : [];

  // MINT — resolve panes via the panel-type ownership registry (covers aliased
  // types like `file-browser`, owned by `files`). Deliberately NOT
  // `components[kind]`: that matched Component NAMES too, so a `type: docker`
  // pane disposed the kind-global service instance (its content owner). A
  // name-only kind mints nothing (honest unknown-type failure).
  const placedIds = new Set();
  for (const p of placedPanes) {
    const kind = p.type;
    const paneId = p.paneId;
    if (!paneId || !kind) continue;
    placedIds.add(paneId);
    const comp = components[route.componentForPanel(kind)];
    if (!comp) continue;
    // Dispose the kind-keyed seed (minted at registerComponent) on the first
    // per-pane mint; service slots are skipped (dispose refuses them anyway).
    if (route.hasInstance(kind) && kind !== paneId && !route.isService(kind)) {
      route.disposeInstance(kind);
    }
    if (!route.hasInstance(paneId)) {
      // init-injection (v0.6.4 #4): thread the seed facts a Component's init
      // would otherwise reach for as globals — init is a pure fn of (paneId,
      // seed). init(paneId) also stamps pane identity so the Component resolves
      // "my pane" from its own slice (incl. the broadcast refresh with no
      // call-site id). Seed-blind inits arity-ignore the args.
      const m = getModel();
      const seed = { config: m.config, projectDir: m.projectDir, paneDef: p };
      route.setInstance(paneId, kind, comp.init(paneId, seed));
    }
    // Wire the pane's DECLARED hub subscriptions at mount (no-op without a
    // subscriptions() hook; idempotent via the topic:window ledger).
    _wireSubscriptions(comp, p);
  }

  // DISPOSE — per-pane instances whose pane is no longer placed. Skip service
  // slots (route refuses) and kind-seed singletons (id === kind: docker-style
  // panelTypes content owners + un-replaced registry seeds — not placed panes).
  const orphans = [];
  route.eachInstance(inst => {
    if (inst.service || inst.id === inst.kind) return;
    if (!placedIds.has(inst.id)) orphans.push(inst.id);
  });
  for (const id of orphans) route.disposeInstance(id);
}

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
  require('../dispatch/runtime/fanout').dispatchMsg(api.wrap('layout', {
    type: 'set_arrange',
    arrange: rebuildLayoutFromConfig(config),
    dirty: false,
  }));

  // v0.6.3 Phase B / v0.6.4 multi-viewer — per-pane Component instances keyed
  // by paneId (every placed pane its own slice). The mint/dispose logic lives
  // in reconcilePaneInstances so the dispatch finalizer can re-run it after
  // runtime placement/removal. Wire the injection BEFORE seeding dims: the
  // term_resized dispatch below runs the finalizer with arrange + dims both
  // set, so the boot mint happens THROUGH the gate (which records
  // _lastReconciledArrange) — one unified reconcile path, no separate direct
  // boot call that would leave the gate's bookkeeping stale (→ a redundant
  // re-mint on the first post-boot dispatch).
  require('../dispatch/runtime/fanout').setInstanceReconciler(reconcilePaneInstances);

  // Seed the model's terminal dimensions (resize-as-Msg P1). The ONLY
  // place besides the tui.js 'resize' listener that reads the live
  // terminal size — everything downstream reads layoutSlice.dims. This
  // dispatch's finalizer also performs the boot instance mint (see above).
  const tdims = require('../io/term').dims();
  require('../dispatch/runtime/fanout').dispatchMsg(api.wrap('layout', {
    type: 'term_resized', cols: tdims.cols, rows: tdims.rows,
  }));

  // Rebuild the visible group list from config, then seed currentGroup
  // from the first visible row. recomputeGroups dispatches into the
  // groups Component; set_current_group rides through the root reducer.
  navState.recomputeGroups();
  const groupsAfter = _groupsSlice();
  const firstName = groupsAfter.list.length ? groupsAfter.list[0].name : '';
  require('../dispatch/control/dispatch').applyMsg({ type: 'set_current_group', name: firstName });

  // Yank register — bounded history, system-clipboard mirror. Cap is
  // configurable via top-level `register: { cap: N }` in YAML; default
  // 100. Init deferred to here so cap reflects the parsed config.
  // v0.6.3 Phase D3 — routed through set_register Msg so the reducer
  // is the sole writer to root.register. Was a BLESSED outside-writer.
  require('../dispatch/control/dispatch').applyMsg({
    type: 'set_register',
    register: require('../leaves/register').init(config.register || {}),
  });

  // Soft-fail diagnostics from parse (today: column over soft cap).
  // Records one event-log entry per warning + seeds layout's bootWarnings
  // so the footer paints "⚠ N config warning(s)" until dismissed.
  const warnings = Array.isArray(config.warnings) ? config.warnings : [];
  if (warnings.length > 0) {
    const log = require('../io/event-log');
    const diag = require('../io/diag-log');
    for (const w of warnings) {
      log.record('warning', { code: w.code, message: w.message });
      diag.warn(w.code || 'config', w.message);
    }
    require('../dispatch/runtime/fanout').dispatchMsg(api.wrap('layout', {
      type: 'set_boot_warnings',
      warnings: warnings.map(w => w.message),
    }));
  }
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
  const dispatch = require('../dispatch/control/dispatch');
  const api = require('../panel/api');
  const route = require('../panel/route');
  dispatch.applyMsg({ type: 'reset_group_context' });
  const target = route.resolveTarget('viewer');
  if (target) {
    // v0.6.3 Phase D1: thread paneMenuMode so the reducer stays pure.
    const m = getModel();
    require('../dispatch/runtime/fanout').dispatchMsg(api.wrap(target, { type: 'viewer_reset_chrome', paneMenuMode: !!m.modes.paneMenuMode }));
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
  require('../dispatch/control/dispatch').navSelect('groups', idx);
}


module.exports = {
  // Boot layer + dispatch-layer group helpers, defined here.
  loadConfig, initState, selectGroup, resetGroupContext,
  // v0.6.4 Phase D — exposed for tests: the declared-subscription wiring
  // seam + its dedup-ledger reset.
  _wireSubscriptions, _resetSubscriptions,
  // Panel-state accessors — re-exported from panel/nav-state for back-compat
  // (§1 Phase 2). New code should import these from panel/nav-state.
  allPanels: navState.allPanels,
  getSel: navState.getSel, setSel: navState.setSel,
  getScroll: navState.getScroll, setScroll: navState.setScroll,
  syncPanelScroll: navState.syncPanelScroll,
  toggleMultiSel: navState.toggleMultiSel, isMultiSel: navState.isMultiSel,
  clearMultiSel: navState.clearMultiSel, multiSelCount: navState.multiSelCount,
  expandGroup: navState.expandGroup, collapseGroup: navState.collapseGroup,
  recomputeGroups: navState.recomputeGroups, switchGroupsTab: navState.switchGroupsTab,
  setViewerContent: navState.setViewerContent, appendViewerLines: navState.appendViewerLines,
};
