/**
 * metrics-mirror runtime-window-grow (state.js#reconcileSubscriptions).
 *
 * The metrics-mirror kind coalesces every consumer of a topic into ONE shared
 * mirror (it writes the single model.metrics[topic] field), so its Sub key is the
 * bare `topic` — the merged `window`/`ms` live OUTSIDE the key. That means a
 * wider-window consumer joining an ALREADY-LIVE topic at runtime (pool_show /
 * pane-select → a new arrange ref) changes the descriptor under a stable key. The
 * reconcile start loop used to `continue` on any already-live key, so the live
 * mirror kept its old (smaller) hub retention until full teardown — the
 * pre-existing gap found in the compact-pane arc round-2 review.
 *
 * The fix: the metrics-mirror kind opts into a `changed(a,b)` hook and reconcile
 * RESTARTS the live sub start-before-stop, so the overlapping hub subscription
 * holds max(window) across the swap (the ring buffer is preserved AND grown, not
 * trimmed to 0 by a stop-first unsubscribe). This pins: (1) retention grows on a
 * runtime window-grow, (2) the existing buffer survives the restart, (3) it
 * shrinks back symmetrically, (4) an unchanged window does NOT restart, and (5)
 * a co-live sub of another kind (store-mirror) is never restarted.
 *
 * Run: node js/test/test-metrics-mirror-window.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const api = require('../panel/api');
const { getInstanceSlice } = api;
const state = require('../app/state');
const hub = require('../leaves/infra/hub');

// Reconcile resolves a placed pane's Component via the registry — layout (service
// slot) first, then the stats Component whose `stats` panelType declares the
// metrics-mirror Sub.
api.registerComponent(require('../panel/layout'));
api.registerComponent(require('../panel/monitor/stats'));

const TOPIC = 'test.wingrow';
const KEY = `metrics-mirror:${TOPIC}`;

// A fresh arrange object each call (a new ref trips the reconcile gate, exactly
// as a real pane place/remove does) placing one stats pane per given window on
// TOPIC. stats.subscriptions() reads only topic/window off the pane def, so no
// per-pane mint is needed for the subscription path under test.
function reconcileWith(windows) {
  getInstanceSlice('layout').arrange = {
    columns: [{
      panels: windows.map((w, i) => ({
        type: 'stats', paneId: `s${i}`, title: `S${i}`, columnIndex: 0, topic: TOPIC, window: w,
      })),
    }],
    detailHeightPct: 60,
  };
  state.reconcileSubscriptions(getModel());
}

const fill = (n) => { for (let i = 0; i < n; i++) hub.publish(TOPIC, '_', { ts: i, v: i }); };
const retained = () => hub.history(TOPIC, '_').length;

describe('[metrics-mirror] runtime window-grow', () => {
  hub._reset();
  state._resetSubscriptions();

  it('mirror is live at the boot window', () => {
    reconcileWith([5]);
    assert(state._liveSubKeys().includes(KEY), 'mirror sub live after reconcile');
    eq(state._liveSub(KEY).desc.window, 5, 'live window is 5');
    fill(10);
    eq(retained(), 5, 'hub retention capped at the small window before any grow');
  });

  it('a wider consumer joining at runtime grows the live retention (restart)', () => {
    const tokBefore = state._liveSub(KEY).token;
    reconcileWith([5, 20]);                       // add a window:20 pane on the same topic
    const sub = state._liveSub(KEY);
    eq(sub.desc.window, 20, 'merged window grew to 20');
    assert(sub.token !== tokBefore, 'the live mirror was restarted (new token)');
    // start-before-stop: the buffer that existed at the smaller window survives.
    eq(retained(), 5, 'the pre-grow samples are preserved across the restart');
    fill(30);
    eq(retained(), 20, 'hub retention now grows to the new (larger) window');
  });

  it('shrinks back symmetrically when the wider consumer leaves', () => {
    const tokBefore = state._liveSub(KEY).token;
    reconcileWith([5]);                           // remove the wide pane
    const sub = state._liveSub(KEY);
    eq(sub.desc.window, 5, 'merged window shrank to 5');
    assert(sub.token !== tokBefore, 'restarted on the shrink too');
    eq(retained(), 5, 'over-window buffer trimmed to the smaller window');
  });

  it('an unchanged window does NOT restart the live mirror', () => {
    const tok = state._liveSub(KEY).token;
    reconcileWith([5]);                           // new arrange ref, identical merged desc
    // === (not eq): the token is a circular object; only identity matters here.
    assert(state._liveSub(KEY).token === tok, 'no spurious restart when changed() is false');
  });

  it('a co-live sub of another kind (store-mirror) is never restarted', () => {
    // store-mirror (history) is app-global + always desired, and defines no
    // `changed` hook — the reconcile above (which restarted the metrics-mirror)
    // must not have touched it. Guards against a blanket restart-on-any-change.
    const before = state._liveSub('store-mirror:history');
    reconcileWith([5, 40]);                        // force a metrics-mirror restart
    assert(state._liveSub(KEY).desc.window === 40, 'metrics-mirror did change');
    assert(state._liveSub('store-mirror:history').token === before.token,
      'the store-mirror sub kept its token (no restart)');
  });

  // Teardown so unref'd sample timers / hub subs don't leak into later test files
  // when the suite runs many files in one process.
  it('cleanup', () => { state._resetSubscriptions(); hub._reset(); assert(true); });
});

report();
