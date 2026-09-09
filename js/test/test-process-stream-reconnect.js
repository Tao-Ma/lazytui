/**
 * process-stream Sub — reconnect after a SPAWN FAILURE (missing / non-executable binary).
 *
 * Regression (2026-09 deep review, finding #3): the sub wired reconnect to the child's
 * 'exit' event, but an async spawn failure (ENOENT / EACCES) emits 'error' + 'close' and
 * NEVER 'exit' — so a missing binary left the sub permanently dead, contradicting the
 * descriptor's "auto-reconnects on spawn failure" contract (the docker events watcher
 * would never recover if `docker` was absent when the pane was placed). The fix listens on
 * 'close', which fires after both a normal death and a spawn failure.
 *
 * The descriptor-level tests (test-docker-component.js [1b]) only assert reconnectMs > 0;
 * this drives the real start()/stop() path (via the test-only _subKinds export).
 *
 * Run: node js/test/test-process-stream-reconnect.js
 */
'use strict';

const { section, assert, report } = require('./test-runner');
const state = require('../app/state');

const proc = state._subKinds['process-stream'];

section('[process-stream] reconnects after a spawn failure (via close, not exit)');

assert(proc && typeof proc.start === 'function', 'the process-stream sub kind is registered');

const desc = {
  kind: 'process-stream', id: 'test-badbin',
  cmd: 'lazytui-no-such-binary-xyz', args: [], reconnectMs: 50,
  onLine: () => {},
};
const token = proc.start(desc, {});
assert(token && token.reconnectTimer == null, 'no reconnect armed immediately after start()');

// The ENOENT surfaces asynchronously as 'error' + 'close'; wait, then assert the
// 'close' handler scheduled a reconnect (it would NOT on the old 'exit'-only wiring).
setTimeout(() => {
  assert(token.reconnectTimer != null,
    'a reconnect is scheduled after the spawn failure surfaces (close fires; exit never did)');
  proc.stop(token);
  assert(token.reconnectTimer == null, 'stop() cancelled the pending reconnect');
  assert(token.stopped === true, 'token marked stopped (no further reconnect)');
  report();
}, 300);
