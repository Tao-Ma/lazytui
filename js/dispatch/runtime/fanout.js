/**
 * Component fan-out + post-dispatch finalizer — the TEA runtime for the
 * Component layer.
 *
 * v0.6.5 domain-detangle Stage 2-B: relocated here from `panel/api.js`. This is
 * the update loop (route a Msg to the right Component instance, run its
 * `update`, run the returned effects) plus the once-per-dispatch finalizer
 * (scroll clamp + viewer innerH derivation + per-pane instance reconcile). It
 * is *runtime* code — it belongs in the dispatch layer, ABOVE the Components it
 * drives, not among them. Components return `[slice, effects]` and never call
 * back up; the few async/subscription paths receive dispatch via an injected
 * host (see docs/v0.6.5-dispatch-loop.md "formalize injection").
 *
 * Reads the Component registry from `panel/api` (dispatch→panel, a legal
 * down-edge) and runs effects via `./effects` (intra-dispatch). The root
 * reducer driver (`applyMsg`) lives in `./dispatch`; this is its Component-side
 * twin. `applyMsg` does NOT run the finalizer (root Msgs don't move panes);
 * only the Component path here does.
 */
'use strict';

const route = require('../../panel/route');
const { wrap } = route;
const { getModel } = require('../../model/store');
const { runEffects } = require('./effects');
const geo = require('../../leaves/geometry');
const mpool = require('../../leaves/pool');
const { syncPanelScroll } = require('../../panel/nav-state');
const hub = require('../../leaves/hub');
// v0.6.5 §5 — the finalizer reconciles the active terminal tab's PTY session
// (spawn-on-demand + resize), moved out of render so the view is read-only for
// the overlay. dispatch→io and dispatch→panel are legal down-edges.
const terminal = require('../../io/terminal');
const tabs = require('../../panel/viewer/tabs');

// Render-exit-style seam: leaves/hub fans publishes out to Components as a
// `hub` Msg, but a leaf can't import panel/dispatch. Inject the dispatcher here
// (dispatchMsg is a hoisted fn declaration below). Was panel/api.js.
hub.setDispatch(dispatchMsg);

// Component registry lives in panel/api; read it lazily (the object ref is
// stable — registerComponent mutates it in place) so this module never eagerly
// drags api in at load. Cached after first dispatch (post-boot).
let _comps = null;
function _reg() { return _comps || (_comps = require('../../panel/api')._components()); }

// Broadcast lane — only the three framework signals fan out to every Component;
// every Component-specific Msg must arrive wrapped (via wrap()).
const BROADCAST_TYPES = new Set(['refresh', 'hub', 'action']);

// ——— Post-dispatch invariant pass (resize-as-Msg P2) ———————————————
//
// After the OUTERMOST dispatch completes, re-clamp every navigator pane's
// scroll so the selected row sits inside its viewport — a safety net that
// catches cursor-off-viewport from ANY cause because every state change IS a
// dispatch. The pass computes calcLayout itself (slice.paneBounds is the last
// render's stale write at dispatch time).
//
// Depth counter: both top-level entries (dispatchMsg + dispatchKeyToFocused)
// share it, so effect-chained nested dispatches run the pass once, at depth-0
// exit. _inScrollFinalize makes the pass's own set_scroll dispatches
// (syncPanelScroll → nav-state writer → dispatchMsg) skip re-finalizing.
let _dispatchDepth = 0;
let _inScrollFinalize = false;

// Runtime per-pane instance lifecycle. `state.reconcilePaneInstances` is
// injected at boot (setInstanceReconciler) — the impure mint shell stays in the
// boot layer; the finalizer just triggers it, gated on arrange-ref change so it
// fires only on placement/removal.
let _instanceReconciler = null;
let _lastReconciledArrange;
function setInstanceReconciler(fn) { _instanceReconciler = fn; }

// Layout memo for the finalizer. calcLayout's rects depend only on
// (arrange, dims) — updated IMMUTABLY by the reducers — so reference equality is
// a correct cache key. Most dispatches leave both refs untouched.
let _layoutMemo = null;

function _finalizeLayout(layoutSlice) {
  const m = _layoutMemo;
  if (m && m.arrange === layoutSlice.arrange && m.dims === layoutSlice.dims
        && m.viewMode === layoutSlice.viewMode) {
    return m.layout;
  }
  const layout = geo.calcLayout(layoutSlice, layoutSlice.dims);
  _layoutMemo = {
    arrange: layoutSlice.arrange, dims: layoutSlice.dims,
    viewMode: layoutSlice.viewMode, layout,
  };
  return layout;
}

function _finalizeDispatch() {
  if (_inScrollFinalize) return;
  const layoutSlice = route.getInstanceSlice('layout');
  if (!layoutSlice || !layoutSlice.dims || !layoutSlice.arrange) return;
  _inScrollFinalize = true;
  try {
    // Reconcile per-pane instances with the placed layout (mint newly-placed
    // panes, dispose removed ones) BEFORE the scroll/innerH work that reads
    // them. Gated on arrange-ref change.
    if (_instanceReconciler && layoutSlice.arrange !== _lastReconciledArrange) {
      _lastReconciledArrange = layoutSlice.arrange;
      _instanceReconciler();
    }
    const layout = _finalizeLayout(layoutSlice);
    for (const p of mpool.allPanesInColumns(layoutSlice.arrange)) {
      if (mpool.isDetailPane(p) || p.collapsed) continue;
      syncPanelScroll(p.paneId,
        geo.getPanelViewportH(layoutSlice, p.paneId, layoutSlice.dims, layout));
    }
    // blessed-exceptions Phase A.1 — the viewer's `innerH` (the viewport-height
    // cache its reducer reads for scroll/cursor clamps) is produced HERE, in
    // the dispatch finalizer, from THIS dispatch's fresh Layout. One major/
    // visible viewer. The `!==` guard preserves the viewer slice's reference
    // identity when unchanged (the layout memo + downstream ref-equality
    // depend on it).
    const viewerTab = route.resolveTarget('viewer');
    const viewerPaneId = route.resolveViewerPaneId();
    if (viewerTab && viewerPaneId) {
      const innerH = geo.getPanelViewportH(layoutSlice, viewerPaneId, layoutSlice.dims, layout, viewerPaneId);
      const vs = route.getInstanceSlice(viewerTab);
      if (vs && vs.innerH !== innerH) route.setInstanceSlice(viewerTab, { ...vs, innerH });

      // v0.6.5 §5 — PTY-session reconcile for the active terminal tab. This is
      // the side-effect that used to run in render (paint.js's
      // ensureSession/resizeSession); moving it here makes render a pure read
      // of the session buffer. It is the SAME dispatch-runtime reconcile
      // category as the instance-mint above and the innerH write: ensure the
      // active terminal's PTY exists, and size it to the viewer pane's
      // COMMITTED geometry. visibleBoundsFor reads the committed arrange (not
      // render's drag-preview override), so the PTY holds its committed dims
      // through a free-config drag — no SIGWINCH churn per zone crossing.
      // Lazy: only the ACTIVE terminal tab spawns; tabs never visited never do.
      // ensureSession is idempotent, so re-running per dispatch is a no-op once
      // the session exists. activeTerminalId()/activeTerminalConfig() resolve
      // the same focused viewer render did (resolveTarget('viewer')).
      if (tabs.isTerminalTab()) {
        const ptyId = tabs.activeTerminalId();
        const tconf = tabs.activeTerminalConfig();
        const tb = (ptyId && tconf)
          ? geo.visibleBoundsFor(layoutSlice, viewerPaneId, viewerPaneId) : null;
        if (tb) {
          const cols = tb.w - 2, rows = tb.h - 2;
          const session = terminal.ensureSession(ptyId, tconf.cmd, cols, rows, getModel().projectDir);
          if (session.xterm.cols !== cols || session.xterm.rows !== rows) {
            terminal.resizeSession(ptyId, cols, rows);
          }
        }
      }
    }
  } catch (e) {
    console.error(`[dispatch] post-dispatch scroll clamp error: ${e.message}`);
  } finally {
    _inScrollFinalize = false;
  }
}

/**
 * Dispatch a Msg. Two shapes: a WRAPPED Msg `{ kind, msg }` routes only to the
 * Component named `kind` (its update() sees the unwrapped inner); a BROADCAST
 * Msg (refresh / hub / action) fans out to every instance. Every other flat Msg
 * is a missed wrap site (logged + dropped). Failures in one Component's update
 * don't stop the others.
 */
function dispatchMsg(msg) {
  _dispatchDepth++;
  try { _dispatchMsgInner(msg); }
  finally {
    _dispatchDepth--;
    if (_dispatchDepth === 0) _finalizeDispatch();
  }
}

function _dispatchMsgInner(msg) {
  const components = _reg();
  // Free-config freeze gate. While free-config mode is active, only layout-
  // wrapped Msgs flow (they drive the mode itself). Broadcasts + wrapped Msgs
  // to non-layout components are dropped so the canvas stays stable under
  // drag/resize. Mode entry/exit ride apply_msg Cmds through the root reducer.
  const m = getModel();
  if (m && m.modes && m.modes.freeConfigMode) {
    const isLayoutWrap = msg && msg.kind === 'layout' && msg.type === undefined;
    // Narrow exception: the free-config tab-reorder gesture lives on layout's
    // slice but emits a viewer_reorder_content_tab dispatch_msg back through
    // this gate to permute detail's contentTabs.
    const isTabReorder = msg && msg.msg
      && msg.msg.type === 'viewer_reorder_content_tab'
      && typeof msg.kind === 'string' && route.isViewerKind(msg.kind);
    if (!isLayoutWrap && !isTabReorder) return;
  }
  // Wrapped-Msg path. Routes to exactly one Component instance. Discriminator:
  // `{ kind: string, msg: any }` AND no top-level `type`.
  if (msg && typeof msg.kind === 'string' && msg.msg !== undefined && msg.type === undefined) {
    const kind = msg.kind;
    // `kind` may be a Component name (legacy primary-instance routing) OR a
    // paneId (post-B3 multi-instance routing). Try paneId lookup first.
    let inst = route.getInstance(kind);
    let comp;
    if (inst) {
      // paneId form. Find the Component for this instance's kind — by direct
      // Component-name match, or via the panel-type → Component-name table.
      comp = components[inst.kind] || components[route.componentForPanel(inst.kind)];
    } else {
      // Component-name form. Look up via _primaryByKind for the canonical
      // instance.
      comp = components[kind];
      let primaryKind = kind;
      if (!comp) {
        // `kind` may be a paneId whose per-pane instance wasn't minted
        // (docker-style panes, or a kind-keyed singleton harness). Resolve the
        // Component + panel-type via the arrange, then route to the primary.
        comp = components[route.componentForPanel(kind)];
        primaryKind = route.paneTypeOf(kind) || primaryKind;
      }
      const id = comp ? route.getPrimaryByKind(primaryKind) : undefined;
      if (id !== undefined) inst = route.getInstance(id);
    }
    if (!comp || !inst) {
      console.error(`[dispatch] wrapped Msg targeting unknown Component '${kind}'; dropped`);
      return;
    }
    _runInstance(inst, comp, msg.msg);
    return;
  }
  // Broadcast path. Only the 3 framework signals fan out; everything else must
  // arrive wrapped. Iterates instances so a multi-instance Component has each
  // one's update called independently.
  if (msg && BROADCAST_TYPES.has(msg.type)) {
    route.eachInstance(inst => {
      // Resolve panelType-aliased instances (e.g. a `file-browser` instance
      // owned by the `files` Component) via the panel-type → Component table.
      const comp = components[inst.kind] || components[route.componentForPanel(inst.kind)];
      if (!comp) return;  // defensive: orphan instance (Component unregistered)
      _runInstance(inst, comp, msg);
    });
    return;
  }
  // Any other flat Msg is a missed wrap site.
  const ty = msg && msg.type ? `'${msg.type}'` : '(no type)';
  console.error(`[dispatch] unwrapped Component-specific Msg ${ty}; dropped. Wrap with api.wrap('<component>', msg).`);
}

/**
 * Dispatch a `key` Msg to the focused Component and return whether the
 * Component claimed the keystroke (asked the framework to skip its default).
 * The claim is a `_claimed` sentinel effect in the Component's return.
 */
function dispatchKeyToFocused(key, seq) {
  _dispatchDepth++;
  try { return _dispatchKeyToFocusedInner(key, seq); }
  finally {
    _dispatchDepth--;
    if (_dispatchDepth === 0) _finalizeDispatch();
  }
}

// blessed-exceptions #3 — apply a Component's optional augmentMsg enrichment
// hook in ONE place (the impure shell). When a Component declares
// augmentMsg(msg, model, slice), the shell reads the model and lets it thread
// model-derived facts into the Msg, so update(msg, slice) stays pure of
// getModel(); the instance's own slice is passed so per-pane Components (files)
// resolve pane-specific facts. `model` lets a caller that already read it (the
// key path, for terminalMode/focusKind) avoid a second read.
function _augment(comp, msg, slice, model) {
  if (!comp || !comp.augmentMsg) return msg;
  return comp.augmentMsg(msg, model || getModel(), slice);
}

function _dispatchKeyToFocusedInner(key, seq) {
  const components = _reg();
  const focus = route.getFocus();
  const compName = route.componentForPanel(focus);
  if (!compName) return false;
  const comp = components[compName];
  if (!comp) return false;
  // Route the keystroke to the FOCUSED instance: prefer the focused paneId
  // directly (per-pane mint), else fall back to the kind's primary (docker-
  // style panelTypes panes mint kind-keyed, not per-pane).
  const id = route.hasInstance(focus) ? focus : route.getPrimaryByKind(compName);
  if (id === undefined) return false;
  const inst = route.getInstance(id);

  let claimed = false;
  try {
    // Phase D1 — thread terminalMode + focusKind so the viewer's `key` arm
    // doesn't need getModel()/getFocus().
    const _m = getModel();
    let keyMsg = {
      type: 'key', key, seq,
      terminalMode: !!_m.modes.terminalMode,
      focusKind: route.instanceKind(route.getFocus()),
    };
    keyMsg = _augment(comp, keyMsg, inst.slice, _m);
    const result = comp.update(keyMsg, inst.slice);
    if (result === undefined) return false;
    if (Array.isArray(result)) {
      const [next, effects] = result;
      if (next !== undefined) route.setInstanceSlice(inst.id, next);
      const filtered = [];
      for (const e of (effects || [])) {
        if (e && e.type === '_claimed') claimed = true;
        else if (e) filtered.push(e);
      }
      if (filtered.length) runEffects(filtered);
    } else {
      route.setInstanceSlice(inst.id, result);
    }
  } catch (e) {
    console.error(`[component:${compName}] key update error: ${e.message}`);
    _recordError({ where: 'component_key', component: compName, instance: inst.id,
      message: e && e.message, stack: e && e.stack });
  }
  return claimed;
}

// Inner helper — runs ONE instance's update, handles the
// undefined / slice / [slice, effects] return contract, and isolates throws.
// Shared by the wrapped and broadcast dispatch paths.
function _runInstance(inst, comp, msg) {
  try {
    msg = _augment(comp, msg, inst.slice);
    const result = comp.update(msg, inst.slice);
    if (result === undefined) return;
    if (Array.isArray(result)) {
      const [next, effects] = result;
      if (next !== undefined) route.setInstanceSlice(inst.id, next);
      runEffects(effects);
    } else {
      route.setInstanceSlice(inst.id, result);
    }
  } catch (e) {
    console.error(`[component:${inst.kind}] update error: ${e.message}`);
    _recordError({ where: 'component_update', component: inst.kind, instance: inst.id,
      message: e && e.message, stack: e && e.stack });
  }
}

// Persist diagnostics from the Component fan-out paths to the event log — the
// console.error above is painted over by the next render; the event log is the
// only place a thrown Component update is inspectable post-mortem.
function _recordError(payload) {
  try { require('../../io/event-log').record('error', payload); }
  catch (_) { /* event-log unavailable — already logged to console */ }
}

module.exports = { dispatchMsg, dispatchKeyToFocused, setInstanceReconciler, wrap };
