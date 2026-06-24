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
const { getModel } = require('../model/store');
const { rebuildLayoutFromConfig } = require('../leaves/wm/arrange');
// Panel-state accessors (readers/writers/composites) moved to
// panel/nav-state.js in v0.6.5 §1 Phase 2. This module keeps the boot layer
// (loadConfig/initState) + the two dispatch-layer group helpers
// (selectGroup/resetGroupContext) and RE-EXPORTS the accessors below so
// existing `require('../app/state')` importers (notably the test suite) keep
// working untouched; new code imports them from panel/nav-state directly.
const navState = require('../panel/nav-state');


// #D13 (2026-06-18) — subscriptions as canonical `Model → Sub`. A Component
// exports a PURE `subscriptions(paneDef, model) → [descriptor]` declaring the
// ongoing sources it needs for the current state; the framework re-evaluates
// the WHOLE desired set each update (the post-dispatch finalizer calls
// `reconcileSubscriptions` via the injected hook), DIFFS it against the live
// set, and starts/stops the delta. Replaces the v0.6.4 Phase D mount-time
// wiring, which subscribed on pane-mint but never tore down (a disposed pane's
// topic leaked a live sub + a wasted repaint per publish). A pane leaving the
// layout — or a sub whose existence depends on model state — reconciles
// correctly: the desired set is recomputed and the gone source is stopped.
//
// v0.6.6 FIX-3 Phase 1 — the reconciler is KIND-DISPATCHED. Each descriptor
// carries a `kind`; the `_subKinds` registry maps kind → {normalize, key,
// start, stop}, so the diff loop is source-agnostic. Today only `hub` is
// registered (a pure refactor — bare `{topic, window}` descriptors default to
// the hub kind: `onUpdate` is a repaint, deduped by topic+window). Later phases
// register `interval` / `resize` / `process-stream` and an app-global
// `appSubscriptions(model)` source beside the per-pane component subs. See
// docs/v0.6.6.md §7.
//
// Memoized module refs (the reconciler runs per outermost dispatch; a fresh
// relative require() each time is the ~tens-of-µs/call fs cost paint.js's hot
// path also memoizes away). Cycle-safe: lazy + cached, like reconcilePaneInstances.
let _apiRef, _routeRef, _mpoolRef, _hubRef, _loopRef, _termRef;
const _api = () => (_apiRef ||= require('../panel/api'));
const _route = () => (_routeRef ||= require('../panel/route'));
const _mpool = () => (_mpoolRef ||= require('../leaves/wm/pool'));
const _hub = () => (_hubRef ||= require('../leaves/infra/hub'));

// Live subscriptions: key → { kind, token }. The single source of what's
// currently running; the reconcile diff is computed against it. `stop` routes
// the token back through its kind handler.
const _liveSubs = new Map();

// Sub-kind handler registry — how each kind of ongoing source is keyed,
// started, and stopped. The reconciler is kind-agnostic; new external-source
// kinds (interval / resize / process-stream — FIX-3 later phases) plug in here.
// `ctx` carries what a handler may use to feed events back into the loop
// (today: scheduleRender; later: dispatch / applyMsg).
const _subKinds = {
  // Hub topics (#D13). Bare `{topic, window}` descriptors; repaint on publish.
  hub: {
    normalize: (d) => (d && d.topic ? { topic: d.topic, window: d.window || 1 } : null),
    key: (d) => `${d.topic}:${d.window}`,
    start: (d, ctx) => _hub().subscribe(d.topic, { window: d.window, onUpdate: () => ctx.scheduleRender() }),
    stop: (token) => _hub().unsubscribe(token),
  },
  // Terminal resize (FIX-3 Phase 2) — the app-global SIGWINCH source. Was
  // tui.js's `process.stdout.on('resize')` listener. On each resize: refresh
  // io/term's COLS/ROWS mirror (footer/overlay/panel renderers still read
  // cols()/rows()), dispatch the `term_resized` layout Msg (lands dims in the
  // model — resize-as-Msg), and repaint. Singleton: one descriptor `{kind:'resize'}`.
  resize: {
    normalize: () => ({}),
    key: () => 'resize',
    start: (d, ctx) => {
      const onResize = () => {
        (_termRef ||= require('../io/term')).refreshSize();
        ctx.dispatch(ctx.wrap('layout', {
          type: 'term_resized',
          cols: process.stdout.columns || 80,
          rows: process.stdout.rows || 24,
        }));
        ctx.scheduleRender();
      };
      process.stdout.on('resize', onResize);
      return onResize;
    },
    stop: (onResize) => process.stdout.removeListener('resize', onResize),
  },
};

// App-global subscriptions — ongoing sources not owned by any pane. Pure
// projection of the model, merged into the per-pane component subs by
// `_desiredSubs`. (FIX-3 Phase 2: resize. Later phases: the terminal-overlay
// poll + clock.) Always-desired today; future entries may be model-conditional
// (e.g. the overlay poll only while a terminal tab is on-screen).
function _appSubscriptions(/* model */) {
  return [{ kind: 'resize' }];
}

// Pure projection: the DESIRED subscription set for the current state. Walks the
// placed panes (layout arrange) and asks each pane's Component for its declared
// subs, passing the root `model` so a sub can depend on model state (canonical
// Model → Sub). Returns Map "<kind>:<handler key>" → { kind, desc }.
function _desiredSubs(model) {
  const out = new Map();
  // App-global sources first (resize today), then per-pane component subs.
  for (const d of _appSubscriptions(model)) _addDesired(out, d);
  const components = _api()._components ? _api()._components() : null;
  if (!components) return out;
  const arrange = _layoutSlice() && _layoutSlice().arrange;
  const placed = arrange ? _mpool().allPanesInColumns(arrange) : [];
  for (const p of placed) {
    const comp = components[_route().componentForPanel(p.type)];
    if (!comp || typeof comp.subscriptions !== 'function') continue;
    let descriptors;
    try { descriptors = comp.subscriptions(p, model) || []; }
    catch (e) { console.error(`[${comp.name || '?'}] subscriptions() threw: ${e && e.message}`); continue; }
    for (const d of descriptors) _addDesired(out, d);
  }
  return out;
}

// Normalize + key one descriptor through its kind handler into the desired-set.
// Bare `{topic, window}` (no `kind`) = the hub kind (back-compat). Unknown kinds,
// or descriptors a kind rejects (e.g. hub without a topic), are skipped. Keyed
// `<kind>:<handler key>` so kinds never collide on a shared key. (FIX-3
// app-global subs will route through here from an appSubscriptions(model) source
// too.)
function _addDesired(out, d) {
  if (!d) return;
  const kind = d.kind || 'hub';
  const h = _subKinds[kind];
  if (!h) { console.error(`[subscriptions] unknown sub kind: ${kind}`); return; }
  const desc = h.normalize ? h.normalize(d) : d;
  if (!desc) return;
  out.set(`${kind}:${h.key(desc)}`, { kind, desc });
}

// Reconcile the live subscriptions to match `_desiredSubs(model)`: start the
// newly-desired, stop the no-longer-desired, each routed through its kind
// handler. Called by the dispatch finalizer each outermost dispatch (#D13); the
// diff makes it a no-op when the desired set is unchanged (the common case) —
// so a live source is NOT torn down + restarted while its key is stable.
function reconcileSubscriptions(model) {
  const ctx = _subCtx();
  const desired = _desiredSubs(model);
  // stop — live sources no longer desired (e.g. a disposed pane's sub).
  for (const [key, live] of _liveSubs) {
    if (!desired.has(key)) { _subKinds[live.kind].stop(live.token); _liveSubs.delete(key); }
  }
  // start — desired sources not yet live.
  for (const [key, { kind, desc }] of desired) {
    if (_liveSubs.has(key)) continue;
    _liveSubs.set(key, { kind, token: _subKinds[kind].start(desc, ctx) });
  }
}

// The handler context — what a kind's `start` may use to feed its source back
// into the loop. Today just `scheduleRender` (the hub kind's repaint-on-publish).
// FIX-3 later phases add `dispatch` / `applyMsg` for interval/resize/process.
function _subCtx() {
  const api = _api();
  return {
    scheduleRender: api.scheduleRender,
    wrap: api.wrap,
    dispatch: (msg) => (_loopRef ||= require('../dispatch/runtime/loop')).dispatchMsg(msg),
  };
}

// Test-only — tear down every live sub + clear the ledger (mirrors hub._reset /
// jobs._reset), so a test starts from a clean subscription set.
function _resetSubscriptions() {
  for (const { kind, token } of _liveSubs.values()) _subKinds[kind].stop(token);
  _liveSubs.clear();
}

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
    // #D9 — resolve the config-status owner here (impure shell) so the
    // reducer's set_config arm stays pure of the ownership registry.
    csOwner: require('../panel/route').componentForPanel('config-status'),
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
  const mpool = require('../leaves/wm/pool');
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
    // (#D13 — hub subscriptions are no longer wired per-pane here; the dispatch
    // finalizer reconciles the whole desired set against the live set each
    // dispatch via reconcileSubscriptions, so a disposed pane's sub is torn down.)
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
  // Theme is model state (model.theme) — seed it through the reducer like the
  // other boot Msgs below, not by poking the palette cache. The `set_theme`
  // effect (registered by installBuiltins, which runs before initState in both
  // tui.js#main and the test harness) syncs leaves/infra/themes from model.theme.
  // This is the init→Cmd shape: initial model carries the theme, an initial
  // Msg applies the configured one.
  require('../dispatch/control/dispatch').applyMsg({ type: 'set_theme', name: config.theme || 'default' });

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
  require('../dispatch/runtime/loop').dispatchMsg(api.wrap('layout', {
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
  require('../dispatch/runtime/finalize').setInstanceReconciler(reconcilePaneInstances);
  // #D13 — hub subscriptions reconcile each outermost dispatch (canonical
  // Model → Sub). Wired BEFORE the term_resized dispatch below, so its finalizer
  // performs the boot sub-wiring through the same path as the boot instance mint.
  require('../dispatch/runtime/finalize').setSubscriptionReconciler(reconcileSubscriptions);

  // Seed the model's terminal dimensions (resize-as-Msg P1). The ONLY
  // place besides the tui.js 'resize' listener that reads the live
  // terminal size — everything downstream reads layoutSlice.dims. This
  // dispatch's finalizer also performs the boot instance mint (see above).
  const tdims = require('../io/term').dims();
  require('../dispatch/runtime/loop').dispatchMsg(api.wrap('layout', {
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
    require('../dispatch/runtime/loop').dispatchMsg(api.wrap('layout', {
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
  // #D9 — resolve the per-panel owners here (impure shell) so the reducer's
  // reset_group_context arm stays pure of the ownership registry.
  dispatch.applyMsg({ type: 'reset_group_context', owners: route.resetGroupOwners() });
  const target = route.resolveTarget('viewer');
  if (target) {
    // v0.6.3 Phase D1: thread paneMenuMode so the reducer stays pure.
    const m = getModel();
    require('../dispatch/runtime/loop').dispatchMsg(api.wrap(target, { type: 'viewer_reset_chrome', paneMenuMode: !!m.modes.paneMenuMode }));
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
  // #D13 — exposed for tests: the Model→Sub reconciler, its pure desired-set
  // projection, and the live-set teardown/reset.
  reconcileSubscriptions, _desiredSubs, _resetSubscriptions,
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
