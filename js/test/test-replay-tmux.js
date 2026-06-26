/**
 * v0.6.6 replay arc — type:spawn forces the embedded PTY while recording.
 *
 * A `tmux new-window` runs OUTSIDE the app, so its output never enters the WAL
 * and can't replay (and is tied to that host). While recording, spawns are
 * forced onto the embedded PTY path — whose output IS captured — so the session
 * replays fully and position-independently. `_spawnUsesTmux()` encodes that
 * decision: tmux ONLY when under $TMUX AND not recording.
 *
 * Run: node js/test/test-replay-tmux.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const sessionLog = require('../io/session-log');
const { _spawnUsesTmux } = require('../dispatch/runtime/action-runner');

const origTmux = process.env.TMUX;
const origEnabled = sessionLog.isEnabled();

function decide(underTmux, recording) {
  if (underTmux) process.env.TMUX = '/tmp/tmux-test,1,0'; else delete process.env.TMUX;
  sessionLog.enable(recording);
  try { return _spawnUsesTmux(); }
  finally {
    if (origTmux === undefined) delete process.env.TMUX; else process.env.TMUX = origTmux;
    sessionLog.enable(origEnabled);
  }
}

describe('type:spawn uses tmux ONLY under $TMUX and NOT recording', () => {
  it('under tmux, not recording → real tmux window', () => eq(decide(true, false), true));
  it('under tmux, RECORDING → forced embedded (capturable + portable)', () => eq(decide(true, true), false));
  it('no tmux, not recording → embedded', () => eq(decide(false, false), false));
  it('no tmux, recording → embedded', () => eq(decide(false, true), false));
});

report();
