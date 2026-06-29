/**
 * C5 — keyed/exclusive effect cancellation.
 *
 * Drives the REAL `runEffects` with controllable fake handlers (the seam lives
 * in effects.js, so this exercises the actual abort-prior / inject-signal /
 * handler-releases path). A handler captures its injected `host.signal` +
 * `host.releaseKey` and simulates an async settle via `finish()` (which, like a
 * real handler, suppresses its result when the signal is aborted).
 *
 * Run: node js/test/test-effect-cancel.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const effects = require('../dispatch/runtime/effects');
const replay = require('../dispatch/runtime/replay');

// A fake async handler: records each invocation, defers its "dispatch" to a
// test-driven finish() that drops the result if the signal aborted.
let runs = [];
effects.registerEffect('test_slow', (_eff, host) => {
  const rec = { signal: host.signal, dispatched: false };
  rec.finish = () => {
    if (rec.signal && rec.signal.aborted) rec.dispatched = false;   // stale → drop
    else rec.dispatched = true;
    if (host.releaseKey) host.releaseKey();                          // handler owns release
  };
  runs.push(rec);
});
// A synchronous keyed handler that releases its key in-body.
effects.registerEffect('test_sync', (_eff, host) => {
  if (host.releaseKey) host.releaseKey();
});

function reset() { effects._clearInflight(); runs = []; }

describe('[C5] supersede-by-key', () => {
  it('a second keyed Cmd aborts the prior + the prior suppresses its stale result', () => {
    reset();
    effects.runEffects([{ type: 'test_slow', key: 'k1' }]);
    effects.runEffects([{ type: 'test_slow', key: 'k1' }]);
    eq(runs.length, 2, 'both handlers ran');
    eq(runs[0].signal.aborted, true, 'prior signal aborted by the supersede');
    eq(runs[1].signal.aborted, false, 'new signal live');
    eq(effects._inflightKeys(), ['k1'], 'one live controller under the key');
    runs[0].finish();
    eq(runs[0].dispatched, false, 'prior dropped its stale result');
    eq(effects._inflightKeys(), ['k1'], 'a superseded handler\'s release does NOT drop the new controller');
    runs[1].finish();
    eq(runs[1].dispatched, true, 'new handler dispatched');
    eq(effects._inflightKeys(), [], 'key freed once the live handler settled');
  });

  it('distinct keys do not interfere', () => {
    reset();
    effects.runEffects([{ type: 'test_slow', key: 'a' }, { type: 'test_slow', key: 'b' }]);
    eq(runs[0].signal.aborted, false);
    eq(runs[1].signal.aborted, false);
    eq(effects._inflightKeys().sort(), ['a', 'b']);
  });
});

describe('[C5] cancelEffect (teardown / quit)', () => {
  it('cancelEffect aborts an in-flight keyed effect; finish drops the result', () => {
    reset();
    effects.runEffects([{ type: 'test_slow', key: 'pane-X' }]);
    effects.cancelEffect('pane-X');
    eq(runs[0].signal.aborted, true, 'cancelEffect aborted the signal');
    assert(!effects._inflightKeys().includes('pane-X'), 'key dropped');
    runs[0].finish();
    eq(runs[0].dispatched, false, 'stale result dropped');
  });
  it('cancelEffect on an unknown key is a no-op', () => {
    reset();
    effects.cancelEffect('nope');   // must not throw
    eq(effects._inflightKeys(), []);
  });
  it('_clearInflight aborts + clears everything', () => {
    reset();
    effects.runEffects([{ type: 'test_slow', key: 'x' }, { type: 'test_slow', key: 'y' }]);
    effects._clearInflight();
    eq(runs[0].signal.aborted, true);
    eq(runs[1].signal.aborted, true);
    eq(effects._inflightKeys(), []);
  });
});

describe('[C5] synchronous keyed handler', () => {
  it('a sync handler that releases in-body leaves no leak', () => {
    reset();
    effects.runEffects([{ type: 'test_sync', key: 's1' }]);
    eq(effects._inflightKeys(), [], 'no leaked controller');
  });
});

describe('[C5] non-keyed effects are unaffected', () => {
  it('no key → no controller, signal undefined', () => {
    reset();
    effects.runEffects([{ type: 'test_slow' }]);
    eq(runs.length, 1);
    eq(runs[0].signal, undefined, 'no signal injected without a key');
    eq(effects._inflightKeys(), [], 'no registry entry');
  });
});

describe('[C5] replay-safety', () => {
  it('runEffects is a no-op under replay — handler never runs, registry stays empty', () => {
    reset();
    replay.setReplaying(true);
    try {
      effects.runEffects([{ type: 'test_slow', key: 'r1' }]);
    } finally { replay.setReplaying(false); }
    eq(runs.length, 0, 'handler did not run during a fold');
    eq(effects._inflightKeys(), [], 'no controller created during a fold');
  });
});

// execAsync {signal} smoke — the abort SIGTERMs the child; the never-reject
// contract holds (resolves with the partial/empty stdout).
(async () => {
  const { execAsync } = require('../io/exec');
  const out = await execAsync('sleep 5', { signal: AbortSignal.timeout(20) });
  describe('[C5] execAsync {signal}', () => {
    it('an aborted exec resolves (never rejects) with no stdout', () => {
      eq(out, '', 'aborted before any output; child killed');
    });
  });
  report();
})();
