/**
 * Subscription-reconcile PERF gate (state.js#reconcileSubscriptions).
 *
 * The reconcile is skipped when the gate key is unchanged since the last run
 * (arrange, dims, viewMode, focus, halfView + jobsMode, diagLogMode, liveClock,
 * dockerRefresh) — a ~350µs/dispatch saving on every booted layout. focus/halfView
 * are covered live by test-terminal-pane (a half-slot swap starts/stops the
 * overlay-repaint poll); the terminal-on-screen check is why they're in the key. That skip is CORRECT iff the desired subscription set is a pure
 * function of exactly those inputs. This test pins that invariant: each gate-key
 * MODE input changes the desired set (so the gate MUST include it), and a
 * non-key model field does NOT (so the gate can safely ignore it — the skip is
 * lossless). The arrange input is covered through the live reconcile by
 * test-stats (place/remove a pane → sub starts/stops); jobsMode's effect on the
 * desired set is also pinned in test-jobs.
 *
 * If a future component's `subscriptions()` (or a new app-sub) starts depending
 * on some OTHER volatile model field, the "non-key field is inert" case below
 * will start failing for that field — the signal to extend the gate key.
 *
 * Run: node js/test/test-sub-gate.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const state = require('../app/state');

const keys = (model) => [...state._desiredSubs(model).keys()].sort();
const same = (a, b) => a.length === b.length && a.every((k, i) => k === b[i]);

// A booted layout so _desiredSubs walks a real arrange (placed panes + the
// on-screen-terminal check). The arrange is held constant across the cases
// below — only the model arg varies — so any difference is attributable to the
// model field under test.
sm.bootFresh({
  groups: { g1: { name: 'g1', label: 'G1', containers: [], actions: {}, children: [], parent: null, depth: 0, quick: false } },
});

describe('[sub-gate] every gate-key MODE input changes the desired set', () => {
  it('jobsMode toggles a sub (the clock) → must be in the gate key', () => {
    assert(!same(keys({ modes: {} }), keys({ modes: { jobsMode: true } })),
      'jobsMode on adds/removes a subscription');
  });
  it('diagLogMode toggles a sub (the clock) → must be in the gate key', () => {
    assert(!same(keys({ modes: {} }), keys({ modes: { diagLogMode: true } })),
      'diagLogMode on adds/removes a subscription');
  });
});

describe('[sub-gate] a NON-key model field leaves the desired set unchanged', () => {
  // If this fails, some sub started depending on the field — the gate would then
  // skip a reconcile it should run, leaving that sub stale. Fix: add the field to
  // the gate key in reconcileSubscriptions (and here).
  it('currentGroup is inert (the gate safely ignores it)', () => {
    assert(same(keys({ modes: {}, currentGroup: 'g1' }), keys({ modes: {}, currentGroup: 'g2' })),
      'switching groups does not change which subscriptions are desired');
  });
  it('a filter / selection field is inert', () => {
    assert(same(keys({ modes: {} }), keys({ modes: {}, filter: 'abc', sel: { groups: 3 } })),
      'nav filter/selection state does not change the desired subscription set');
  });
});

report();
