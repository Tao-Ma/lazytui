/**
 * Post-dispatch finalizer — the runtime's "after-update phase" (#D4).
 *
 * Runs ONCE after the outermost dispatch completes (the loop gates it at
 * depth-0 exit, see `./loop`). It is NOT routing and NOT a pump — it's the
 * invariant pass that reconciles derived/runtime state against the freshly
 * committed model:
 *   - per-pane instance reconcile (mint newly-placed panes, dispose removed),
 *     gated on arrange-ref change;
 *   - keep-in-view scroll clamp over every navigator pane (routes a `set_scroll`
 *     Msg via nav-state — single-writer; resize-as-Msg P2);
 *   - the active terminal tab's PTY session reconcile (spawn-on-demand + resize;
 *     v0.6.5 §5).
 *
 * v0.6.6 FIX-2: the viewer's derived `innerH` is no longer written here.
 * Blessed-exception B (the finalizer's direct same-slice write) is RETIRED — the
 * value is threaded onto each viewer Msg by the viewer's `augmentMsg` and the
 * viewer's own pure reducer commits it. See docs/v0.6.6.md.
 *
 * Was inlined in the Component fan-out file (`fanout.js`); #D4 split it out so
 * the loop's two pumps and this after-update phase have distinct, findable
 * homes. The dispatch DEPTH counter that gates this stays in `./loop` (it's the
 * pump's concern); this module only runs the pass + owns the re-entrancy guard.
 *
 * `_inScrollFinalize` makes the pass's own `set_scroll` dispatches (syncPanelScroll
 * → nav-state writer → loop.dispatchMsg) skip re-finalizing rather than relying
 * on bounded-depth convergence.
 *
 * Reaches dispatch only indirectly (via nav-state's host-port writer), so this
 * module imports no pump — `loop → finalize` is a one-way edge.
 */
'use strict';

const route = require('../../panel/route');
const { getModel } = require('../../model/store');
const geo = require('../../leaves/wm/geometry');
const mpool = require('../../leaves/wm/pool');
const { syncPanelScroll } = require('../../panel/nav-state');
const terminal = require('../../io/terminal');
const tabs = require('../../panel/viewer/tabs');
const diag = require('../../io/diag-log');
// Replay flag (zero-dependency sibling — safe to top-require; no load cycle).
const replay = require('./replay');

let _inScrollFinalize = false;

// Runtime per-pane instance lifecycle. `state.reconcilePaneInstances` is
// injected at boot (setInstanceReconciler) — the impure mint shell stays in the
// boot layer; the finalizer just triggers it, gated on arrange-ref change so it
// fires only on placement/removal.
let _instanceReconciler = null;
let _lastReconciledArrange;
function setInstanceReconciler(fn) { _instanceReconciler = fn; }

// Run the per-pane instance reconcile NOW, outside the normal finalizer gate.
// Used by replay's checkpoint restore (./replay restoreState) to recreate the
// per-pane instance set from a restored arrange BEFORE the per-pane slices are
// written — "mint-on-restore", so a checkpoint can be restored into a BARE
// registry (the --record-load CLI), not only an already-booted app. Calls the same
// injected reconciler the finalizer uses (no dispatch→app import here), then
// syncs the arrange gate so the next finalizeDispatch doesn't redundantly redo
// it. No-op if no reconciler is wired.
function reconcileInstancesNow() {
  if (!_instanceReconciler) return;
  _instanceReconciler();
  const layoutSlice = route.getInstanceSlice('layout');
  if (layoutSlice) _lastReconciledArrange = layoutSlice.arrange;
}

// #D13 — the Model → Sub reconciler (app/state.reconcileSubscriptions), injected
// at boot. The finalizer calls it each outermost dispatch (canonical "subs are a
// function of the model, re-evaluated each update + diffed"). Injected (not
// imported) so this runtime module stays free of an app/ back-edge — same seam
// as the instance reconciler above.
let _subscriptionReconciler = null;
function setSubscriptionReconciler(fn) { _subscriptionReconciler = fn; }

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

function finalizeDispatch() {
  if (_inScrollFinalize) return;
  // v0.6.6 §9 follow-up — drain render-path diagnostic detections (strict-miss
  // tripwire, plugin purity/timing guard). They recordDeferred during the
  // frame; here, OFF the read path, one flush lands the whole batch through the
  // normal diag store-mirror → diag_synced dispatch. Before the layout guard
  // below so it drains regardless of layout state; no-op (cheap) when empty.
  diag.flushDeferred();
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
    // v0.6.6 replay arc — under replay the finalizer does the per-pane instance
    // reconcile ONLY (deterministic slice creation, regenerated from the
    // recorded layout Msgs). Skip the rest: the scroll-clamp's `set_scroll`
    // Msgs are in the recorded log (re-clamping would double-apply); the
    // subscription reconcile + PTY ensure/resize are live IO (would spawn
    // subs/PTYs during replay). The `finally` below still clears the guard.
    if (replay.isReplaying()) return;
    // #D13 — reconcile hub subscriptions against the model (canonical Model →
    // Sub). Ungated: the desired set is recomputed + diffed every outermost
    // dispatch so a sub whose existence depends on model state (today: which
    // panes are placed) starts/stops correctly — incl. tearing down a disposed
    // pane's topic. The diff no-ops when unchanged (the common case), so the
    // steady-state cost is one cheap desired-set build + Map compare.
    if (_subscriptionReconciler) _subscriptionReconciler(getModel());
    const layout = _finalizeLayout(layoutSlice);
    for (const p of mpool.allPanesInColumns(layoutSlice.arrange)) {
      if (mpool.isDetailPane(p) || p.collapsed) continue;
      syncPanelScroll(p.paneId,
        geo.getPanelViewportH(layoutSlice, p.paneId, layoutSlice.dims, layout));
    }
    // v0.6.6 FIX-2 — the viewer's `innerH` is NO LONGER written here
    // (blessed-exception B retired). It rides onto each viewer Msg via the
    // viewer's `augmentMsg` (computed from the pane's committed geometry) and
    // the viewer's own reducer commits it. What remains is the PTY reconcile.
    const viewerPaneId = route.resolveViewerPaneId();
    if (viewerPaneId) {
      // v0.6.5 §5 — PTY-session reconcile for the active terminal tab. This is
      // the side-effect that used to run in render (paint.js's
      // ensureSession/resizeSession); moving it here makes render a pure read
      // of the session buffer. It is the SAME dispatch-runtime reconcile
      // category as the instance-mint above: ensure the
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
          terminal.ensureSession(ptyId, tconf.cmd, cols, rows, getModel().projectDir);
          const sz = terminal.sessionSize(ptyId);
          if (sz && (sz.cols !== cols || sz.rows !== rows)) {
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

module.exports = { finalizeDispatch, setInstanceReconciler, setSubscriptionReconciler, reconcileInstancesNow };
