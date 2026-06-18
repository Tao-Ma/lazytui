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
 *   - the viewer's derived `innerH` viewport-height (blessed-exception B — a
 *     direct same-slice write; see docs/v0.6.5-tea-reaudit.md);
 *   - the active terminal tab's PTY session reconcile (spawn-on-demand + resize;
 *     v0.6.5 §5).
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

function finalizeDispatch() {
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

module.exports = { finalizeDispatch, setInstanceReconciler };
