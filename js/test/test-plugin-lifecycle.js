/**
 * Plugin lifecycle teardown (T10) — refresh loops stop on cleanup and
 * plugin cleanup() hooks fire (isolated). Without this, self-scheduling
 * refresh timers fired after quit and doubled on any restart, and a
 * plugin's long-lived child (e.g. docker's events stream) leaked.
 *
 * Run: node js/test/test-plugin-lifecycle.js
 */
'use strict';

const { describe, it, eq, assert, section, report } = require('./test-runner');
const api = require('../plugins/api');

// ---- [1] cleanupPlugins fan-out + isolation (sync) ----------------

describe('[1] cleanupPlugins', () => {
  it('calls each plugin cleanup() hook, isolating throws', () => {
    const calls = [];
    api.registerPlugin({ name: 'lc-a', cleanup: () => calls.push('a') });
    api.registerPlugin({ name: 'lc-boom', cleanup: () => { throw new Error('nope'); } });
    api.registerPlugin({ name: 'lc-b', cleanup: () => calls.push('b') });
    api.registerPlugin({ name: 'lc-none' });   // no cleanup — must be skipped, not crash

    const origErr = console.error;
    console.error = () => {};
    try { api.cleanupPlugins(); } finally { console.error = origErr; }

    assert(calls.includes('a') && calls.includes('b'),
      'both well-behaved cleanups ran despite the throwing one in between');
  });
});

// ---- [2] stopRefreshLoops actually stops the loop (async) ---------

section('[2] startRefreshLoops / stopRefreshLoops');
(async () => {
  let ticks = 0;
  api.registerPlugin({
    name: 'lc-refresh',
    refreshIntervalMs: 15,
    refresh: async () => { ticks += 1; return false; },
  });

  api.startRefreshLoops({}, { isFocused: () => true });
  await new Promise(r => setTimeout(r, 55));   // ~3 ticks
  const afterRunning = ticks;
  assert(afterRunning >= 1, `loop ticked while running (got ${afterRunning})`);

  api.stopRefreshLoops();
  const atStop = ticks;
  await new Promise(r => setTimeout(r, 60));    // would be several more ticks if not stopped
  eq(ticks, atStop, 'no further ticks after stopRefreshLoops');

  // Idempotent restart must not leave a doubled chain: start again,
  // measure one window, stop, confirm the rate is single not double.
  ticks = 0;
  api.startRefreshLoops({}, { isFocused: () => true });
  api.startRefreshLoops({}, { isFocused: () => true });  // second start — must replace, not add
  await new Promise(r => setTimeout(r, 55));
  api.stopRefreshLoops();
  assert(ticks <= 5, `single chain after double-start (got ${ticks} in ~3 intervals)`);

  report();
})().catch(err => { console.error(err); process.exit(1); });
