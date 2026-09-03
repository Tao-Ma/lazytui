/**
 * Age-overlay clock Sub reconcile (B6). The 1 s `clock` interval Sub is DESIRED while an
 * age overlay is open (jobsMode / diagLogMode) — app/state.js#_desiredSubs `overlayClock`.
 * But reconcileSubscriptions is only CALLED by the dispatch finalizer, whose gate keys on
 * arrange / nav / jobs changes. An overlay open/close flips ONLY a mode flag, so before the
 * loop.js overlay-clock trigger the reconcile never ran on open/close: the clock Sub was
 * never armed on open (the overlay's age/duration column froze until some unrelated
 * dispatch) nor stopped on close (a 1 s tick kept mutating model.now on an idle TUI).
 *
 * test-sub-gate.js pins that the DESIRED set depends on jobsMode/diagLogMode; this pins that
 * the reconcile is actually TRIGGERED — by driving the real applyMsg dispatch path.
 *
 * Run: node js/test/test-overlay-clock-sub.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const state = require('../app/state');

// The clock Sub keys as `interval:clock:1000`; match on the stable `clock` id.
const clockLive = () => state._liveSubKeys().some((k) => k.includes('clock'));

sm.bootFresh({
  groups: { g1: { name: 'g1', label: 'G1', containers: [], actions: {}, children: [], parent: null, depth: 0, quick: false } },
});

describe('[overlay-clock-sub] the clock Sub arms on overlay open, tears down on close (real applyMsg path)', () => {
  it('jobs overlay: open arms the clock; close stops it', () => {
    assert(!clockLive(), 'baseline: no age overlay → clock Sub not live');
    sm.applyMsg({ type: 'jobs_open' });
    assert(clockLive(), 'jobs_open triggers reconcile → clock Sub armed (age column can tick)');
    sm.applyMsg({ type: 'jobs_close' });
    assert(!clockLive(), 'jobs_close triggers reconcile → clock Sub stopped (no idle ticks)');
  });

  it('diag-log overlay: open arms the clock; close stops it', () => {
    assert(!clockLive(), 'clean baseline after the jobs case');
    sm.applyMsg({ type: 'diag_log_open' });
    assert(clockLive(), 'diag_log_open triggers reconcile → clock Sub armed');
    sm.applyMsg({ type: 'diag_log_close' });
    assert(!clockLive(), 'diag_log_close triggers reconcile → clock Sub stopped');
  });
});

report();
