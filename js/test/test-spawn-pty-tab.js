/**
 * `type: spawn` outside tmux runs in an embedded PTY tab (v0.3.1).
 *
 * Replaces the prior test-spawn-bare.js, which pinned the
 * suspend/spawnSync/resume bare-spawn dance — that path was deleted
 * in favor of an in-process node-pty session living in an ephemeral
 * detail-panel tab with `runtime.getModel().viewMode = 'full'` for auto-zoom.
 *
 * This file pins:
 *   1. Outside tmux, runAction(spawn) creates an ephemeral tab and
 *      sets viewMode='full' — no async spawn, no spawnSync.
 *   2. Inside tmux, the tmux new-window path still wins (opt-in tier).
 *   3. terminal.js#_onSessionExit drops viewMode='full' back to
 *      'normal' when the active session exits (clean or non-zero) and
 *      auto-removes the tab on clean exit only.
 *
 * Run: node js/test/test-spawn-pty-tab.js
 */
'use strict';

// --- Mocks BEFORE actions.js / terminal.js load ---

const child_process = require('child_process');
const spawnCalls = [];
child_process.spawn = (...args) => { spawnCalls.push(args); return { on() {}, kill() {} }; };

const layout = require('../layout');
let forceFullRepaintCalls = 0;
layout.forceFullRepaint = () => { forceFullRepaintCalls++; };
layout.render = () => {};

const history = require('../history');
const historyStarts = [];
history.start = (key, cmd, opts) => { historyStarts.push({ key, cmd, opts }); };

// --- Minimal state for addEphemeralTab + activeTerminalId ---
// Require test-runner first so its module-load side effects register the
// core Components (detail, groups). Without that, getComponentSlice('detail')
// returns undefined and the slice writes below fail.
require('./test-runner');
const runtime = require('../runtime');   // viewMode migrated to the TEA root model (v0.5 spike)
const { getModel } = runtime;
const { getComponentSlice } = require('../plugins/api');
getModel().projectDir = '/tmp/spawn-test-cwd';
getModel().currentGroup = 'g1';
getModel().config = { groups: { g1: { actions: {}, terminals: {} } } };
getComponentSlice('detail').ephemeralTerminals = {};
runtime.getModel().viewMode = 'normal';

const { runAction } = require('../actions');

// Mock terminal.writeToSession + isSessionDead BEFORE requiring input.js
// — input.js destructures these at module-load time, so the override has
// to happen before that destructure runs. terminal.js is already loaded
// (actions.js → tabs.js → terminal.js lazy-require chain), so we mutate
// its cached exports object.
const terminal = require('../terminal');
const { _onSessionExit } = terminal;
const writeToSessionCalls = [];
let mockSessionDead = false;
terminal.writeToSession = (id, data) => { writeToSessionCalls.push({ id, data }); };
terminal.isSessionDead = (_id) => mockSessionDead;

const { _handleTerminalModeData } = require('../input');

const { describe, it, assert, eq, report } = require('./test-runner');


function resetState() {
  getComponentSlice('detail').ephemeralTerminals = {};
  runtime.getModel().viewMode = 'normal';
  getComponentSlice('detail').tab = 0;
  getModel().focus = null;
  getModel().modes.terminalMode = false;
  spawnCalls.length = 0;
  historyStarts.length = 0;
  forceFullRepaintCalls = 0;
  writeToSessionCalls.length = 0;
  mockSessionDead = false;
  delete process.env.TMUX;
}

describe('[1] spawn outside tmux → embedded PTY tab + viewMode=full', () => {
  resetState();
  runAction(runtime.getModel(), 'a:psql', { type: 'spawn', script: 'psql' }, []);

  it('does NOT call async spawn (no tmux new-window)', () => {
    eq(spawnCalls.length, 0, 'async spawn unused outside tmux');
  });
  it('creates exactly one ephemeral terminal tab', () => {
    const keys = Object.keys(getComponentSlice('detail').ephemeralTerminals.g1 || {});
    eq(keys.length, 1, `one new ephemeral tab (got ${JSON.stringify(keys)})`);
    assert(keys[0].startsWith('spawn-a:psql-'),
      `tab key prefixed with spawn-<actionKey>- (got ${keys[0]})`);
  });
  it('sets runtime.getModel().viewMode = "full" for auto-zoom', () => {
    eq(runtime.getModel().viewMode, 'full', 'viewMode flipped to full');
  });
  it('focuses the detail panel (set by addEphemeralTab)', () => {
    eq(getModel().focus, 'detail', 'focus moved to detail');
  });
  it('history records detached:false (child runs in our process)', () => {
    const last = historyStarts[historyStarts.length - 1];
    eq(last.opts.detached, false, 'history.start { detached: false }');
  });
});

describe('[2] spawn inside tmux → tmux new-window path (opt-in tier)', () => {
  resetState();
  process.env.TMUX = '/tmp/mock-tmux';
  runAction(runtime.getModel(), 'a:vim', { type: 'spawn', script: 'vim' }, []);

  it('calls async spawn with tmux new-window', () => {
    eq(spawnCalls.length, 1, 'spawn called once');
    eq(spawnCalls[0][0], 'tmux', 'binary is tmux');
    eq(spawnCalls[0][1][0], 'new-window', 'subcommand is new-window');
  });
  it('does NOT create an ephemeral tab (tmux owns the window)', () => {
    const eph = getComponentSlice('detail').ephemeralTerminals.g1 || {};
    eq(Object.keys(eph).length, 0, 'no ephemeral tab on tmux path');
  });
  it('does NOT flip viewMode (no auto-zoom in tmux)', () => {
    eq(runtime.getModel().viewMode, 'normal', 'viewMode unchanged on tmux path');
  });
  it('history records detached:true (sibling tmux window)', () => {
    const last = historyStarts[historyStarts.length - 1];
    eq(last.opts.detached, true, 'history.start { detached: true }');
  });
});

describe('[3] _onSessionExit: clean exit (0) on the active tab', () => {
  resetState();
  runAction(runtime.getModel(), 'a:less', { type: 'spawn', script: 'less /etc/hosts' }, []);
  const ephKey = Object.keys(getComponentSlice('detail').ephemeralTerminals.g1)[0];
  const sessionId = `g1_${ephKey}`;

  it('precondition — pre-exit: viewMode=full, tab exists', () => {
    eq(runtime.getModel().viewMode, 'full', 'pre: viewMode=full');
    assert(getComponentSlice('detail').ephemeralTerminals.g1[ephKey] != null, 'pre: tab exists');
  });

  // forceFullRepaintCalls captures the spawn-time repaint above;
  // reset so the assertion below isolates the onExit-time repaint.
  forceFullRepaintCalls = 0;
  _onSessionExit(sessionId, 0);

  it('drops viewMode to "normal" (user lands in normal layout)', () => {
    eq(runtime.getModel().viewMode, 'normal', 'viewMode reset on clean exit');
  });
  it('auto-removes the ephemeral tab (clean exit only)', () => {
    eq(getComponentSlice('detail').ephemeralTerminals.g1, undefined,
      'tab gone (group entry also collapses when last tab removed)');
  });
  it('calls forceFullRepaint (active session — PTY painted cells need reclaim)', () => {
    assert(forceFullRepaintCalls >= 1,
      'forceFullRepaint fired so chrome behind the PTY redraws');
  });
});

describe('[4] _onSessionExit: non-zero exit on the active tab', () => {
  resetState();
  runAction(runtime.getModel(), 'a:badcmd', { type: 'spawn', script: 'false' }, []);
  const ephKey = Object.keys(getComponentSlice('detail').ephemeralTerminals.g1)[0];
  const sessionId = `g1_${ephKey}`;

  forceFullRepaintCalls = 0;
  _onSessionExit(sessionId, 1);

  it('drops viewMode (rest of TUI reachable for navigation)', () => {
    eq(runtime.getModel().viewMode, 'normal', 'viewMode reset even on non-zero exit');
  });
  it('keeps the ephemeral tab (user can read error output)', () => {
    assert(getComponentSlice('detail').ephemeralTerminals.g1 && getComponentSlice('detail').ephemeralTerminals.g1[ephKey] != null,
      'tab still present after non-zero exit');
  });
  it('calls forceFullRepaint — fixes the Ctrl+\\ stuck-frame bug', () => {
    assert(forceFullRepaintCalls >= 1,
      'forceFullRepaint fired even on non-zero exit (SIGQUIT, ENOENT, etc)');
  });
});

describe('[5] _onSessionExit: clean exit on a NON-active session', () => {
  resetState();
  runAction(runtime.getModel(), 'a:vim', { type: 'spawn', script: 'vim' }, []);
  const activeEphKey = Object.keys(getComponentSlice('detail').ephemeralTerminals.g1)[0];
  getComponentSlice('detail').ephemeralTerminals.g1.orphan = { cmd: 'true', label: 'orphan' };

  forceFullRepaintCalls = 0;
  _onSessionExit('g1_orphan', 0);

  it('does NOT touch viewMode (orphan was not the focused tab)', () => {
    eq(runtime.getModel().viewMode, 'full', 'viewMode untouched for non-active exit');
  });
  it('still cleans up the orphan tab (handleSessionCleanExit fires)', () => {
    assert(!getComponentSlice('detail').ephemeralTerminals.g1 || getComponentSlice('detail').ephemeralTerminals.g1.orphan === undefined,
      'orphan removed');
  });
  it('leaves the active tab intact', () => {
    assert(getComponentSlice('detail').ephemeralTerminals.g1 && getComponentSlice('detail').ephemeralTerminals.g1[activeEphKey] != null,
      'active tab still there');
  });
  it('does NOT forceFullRepaint (orphan PTY never painted to current view)', () => {
    eq(forceFullRepaintCalls, 0,
      'no chrome reclaim needed for a background-tab exit');
  });
});

describe('[6] tab-key uses monotonic counter — no ms-collision', () => {
  resetState();
  // Two spawns of the same action — without the counter, Date.now()
  // could produce the same value on a hot path and addEphemeralTab
  // would silently reuse the first tab.
  runAction(runtime.getModel(), 'a:dup', { type: 'spawn', script: 'sleep 1' }, []);
  runAction(runtime.getModel(), 'a:dup', { type: 'spawn', script: 'sleep 1' }, []);

  it('two spawns of the same action produce two distinct tab keys', () => {
    const keys = Object.keys(getComponentSlice('detail').ephemeralTerminals.g1 || {});
    eq(keys.length, 2,
      `two tabs created (got ${keys.length}: ${JSON.stringify(keys)})`);
  });
});

describe('[7] _handleTerminalModeData: Ctrl+\\ from zoom drops full+terminalMode', () => {
  resetState();
  // Bootstrap into the spawn-and-zoom state
  runAction(runtime.getModel(), 'a:vim', { type: 'spawn', script: 'vim' }, []);
  forceFullRepaintCalls = 0;
  getModel().modes.terminalMode = true;  // simulate having focused the PTY

  const handled = _handleTerminalModeData('\x1c');

  it('returns true (chunk consumed)', () => assert(handled === true, 'returned true'));
  it('flips getModel().modes.terminalMode = false', () => eq(getModel().modes.terminalMode, false, 'terminalMode off'));
  it('drops runtime.getModel().viewMode = "normal"', () => eq(runtime.getModel().viewMode, 'normal', 'viewMode reset'));
  it('calls forceFullRepaint', () => {
    assert(forceFullRepaintCalls >= 1, 'forceFullRepaint fired so chrome reclaims');
  });
  it('does NOT forward Ctrl+\\ to the PTY', () => {
    eq(writeToSessionCalls.length, 0,
      'Ctrl+\\ is the exit key, never reaches the child');
  });
});

describe('[8] _handleTerminalModeData: Ctrl+\\ without zoom only flips terminalMode', () => {
  resetState();
  runtime.getModel().viewMode = 'normal';
  getModel().modes.terminalMode = true;

  _handleTerminalModeData('\x1c');

  it('flips terminalMode = false', () => eq(getModel().modes.terminalMode, false));
  it('leaves viewMode = "normal"', () => eq(runtime.getModel().viewMode, 'normal',
    'no spurious viewMode mutation when not in zoom'));
  it('does NOT call forceFullRepaint (no chrome was hidden)', () => {
    eq(forceFullRepaintCalls, 0, 'no need to force repaint when chrome was already visible');
  });
});

describe('[9] _handleTerminalModeData: dead session also exits + drops zoom', () => {
  resetState();
  runAction(runtime.getModel(), 'a:dead', { type: 'spawn', script: 'true' }, []);
  forceFullRepaintCalls = 0;
  getModel().modes.terminalMode = true;
  mockSessionDead = true;  // pretend the PTY exited under our feet

  _handleTerminalModeData('x');  // any non-Ctrl+\ key

  it('flips terminalMode = false (no point staying — session is gone)', () => {
    eq(getModel().modes.terminalMode, false, 'terminalMode off on dead session');
  });
  it('drops viewMode = "normal"', () => eq(runtime.getModel().viewMode, 'normal',
    'zoom dropped so user is reachable'));
  it('calls forceFullRepaint', () => {
    assert(forceFullRepaintCalls >= 1, 'forceFullRepaint fired');
  });
  it('does NOT forward the keystroke (session is dead)', () => {
    eq(writeToSessionCalls.length, 0,
      'no point writing into a dead PTY');
  });
});

describe('[10] _handleTerminalModeData: live session forwards bytes to PTY', () => {
  resetState();
  runAction(runtime.getModel(), 'a:live', { type: 'spawn', script: 'cat' }, []);
  getModel().modes.terminalMode = true;
  mockSessionDead = false;

  const beforeForce = forceFullRepaintCalls;
  _handleTerminalModeData('hello');

  it('does NOT flip terminalMode (PTY is live)', () => {
    eq(getModel().modes.terminalMode, true, 'terminalMode stays on');
  });
  it('does NOT change viewMode', () => {
    eq(runtime.getModel().viewMode, 'full', 'viewMode unchanged on data-forward path');
  });
  it('does NOT force a repaint (data-forward doesn\'t need it)', () => {
    eq(forceFullRepaintCalls, beforeForce, 'no extra repaint on each keystroke');
  });
  it('writes the bytes to the PTY session', () => {
    eq(writeToSessionCalls.length, 1, 'writeToSession called exactly once');
    eq(writeToSessionCalls[0].data, 'hello', 'forwarded the exact bytes');
  });
});

report();
