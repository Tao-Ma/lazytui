/**
 * v0.6.6 replay arc — Phase A: the replay-mode gate.
 *
 * Verifies the two suppression points that let a recorded Msg stream be
 * re-applied without re-running side effects against live external state:
 *   - `effects.runEffects` no-ops ENTIRELY under replay (skip ALL effects).
 *   - `finalize.finalizeDispatch` runs the per-pane instance reconcile ONLY
 *     under replay (skip sub-reconcile + scroll-clamp + PTY).
 *
 * Run: node js/test/test-replay-gate.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const replay = require('../dispatch/runtime/replay');
const effects = require('../dispatch/runtime/effects');
const finalize = require('../dispatch/runtime/finalize');

// --- boot a minimal-but-real app (mirrors tui.js boot, no PTY/input) ---
const _grp = (name, label) => ({
  name, label, containers: [],
  actions: { a1: { key: 'a1', label: 'Action 1', type: 'run', script: 'echo a1', tab: false } },
  children: [], parent: null, depth: 0, quick: false,
});
getModel().config = {
  project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
  groups: { g1: _grp('g1', 'Group 1'), g2: _grp('g2', 'Group 2') },
};
initState();
getModel().projectDir = '.';

describe('[1] replay flag', () => {
  it('defaults off and toggles', () => {
    eq(replay.isReplaying(), false, 'off by default');
    replay.setReplaying(true);
    eq(replay.isReplaying(), true, 'set on');
    replay.setReplaying(false);
    eq(replay.isReplaying(), false, 'set off');
  });
});

describe('[2] runEffects is gated by replay mode', () => {
  let fired = 0;
  effects.registerEffect('__replay_test_effect', () => { fired++; });

  it('runs effects when NOT replaying', () => {
    fired = 0;
    replay.setReplaying(false);
    effects.runEffects([{ type: '__replay_test_effect' }]);
    eq(fired, 1, 'effect handler fired');
  });

  it('skips ALL effects when replaying', () => {
    fired = 0;
    replay.setReplaying(true);
    effects.runEffects([{ type: '__replay_test_effect' }]);
    eq(fired, 0, 'effect handler suppressed under replay');
    replay.setReplaying(false);
  });
});

describe('[3] finalizeDispatch under replay: instance-mint only', () => {
  let subCalls = 0, instCalls = 0;
  // Swap in spy reconcilers (initState wired the real ones at boot). Tests run
  // in isolated processes (run-tests.js), so this swap doesn't leak.
  finalize.setSubscriptionReconciler(() => { subCalls++; });
  finalize.setInstanceReconciler(() => { instCalls++; });

  it('NORMAL mode runs the subscription reconcile', () => {
    subCalls = 0;
    replay.setReplaying(false);
    finalize.finalizeDispatch();
    eq(subCalls, 1, 'sub-reconcile ran when not replaying');
  });

  it('REPLAY mode skips the subscription reconcile (and scroll-clamp + PTY)', () => {
    subCalls = 0;
    replay.setReplaying(true);
    finalize.finalizeDispatch();
    eq(subCalls, 0, 'sub-reconcile suppressed under replay');
    replay.setReplaying(false);
  });

  it('REPLAY mode STILL runs the per-pane instance reconcile (mint)', () => {
    instCalls = 0;
    // Trip the arrange-ref gate (mint fires only on arrange change) with a
    // fresh ref so the instance reconcile is exercised under replay.
    const ls = require('../panel/api').getInstanceSlice('layout');
    ls.arrange = Array.isArray(ls.arrange) ? ls.arrange.slice() : { ...ls.arrange };
    replay.setReplaying(true);
    finalize.finalizeDispatch();
    eq(instCalls, 1, 'instance reconcile (mint) ran under replay');
    replay.setReplaying(false);
  });
});

report();
