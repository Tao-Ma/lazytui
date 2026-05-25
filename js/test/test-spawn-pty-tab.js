/**
 * `type: spawn` outside tmux runs in an embedded PTY tab (v0.3.1).
 *
 * Replaces the prior test-spawn-bare.js, which pinned the
 * suspend/spawnSync/resume bare-spawn dance — that path was deleted
 * in favor of an in-process node-pty session living in an ephemeral
 * detail-panel tab with `S.viewMode = 'full'` for auto-zoom.
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
const { S } = require('../state');
S.projectDir = '/tmp/spawn-test-cwd';
S.currentGroup = 'g1';
S.config = { groups: { g1: { actions: {}, terminals: {} } } };
S.ephemeralTerminals = {};
S.viewMode = 'normal';

const { runAction } = require('../actions');
const { _onSessionExit } = require('../terminal');
const { describe, it, assert, eq, report } = require('./test-runner');

function resetState() {
  S.ephemeralTerminals = {};
  S.viewMode = 'normal';
  S.activeTab = 0;
  S.focus = null;
  S.terminalMode = false;
  spawnCalls.length = 0;
  historyStarts.length = 0;
  forceFullRepaintCalls = 0;
  delete process.env.TMUX;
}

describe('[1] spawn outside tmux → embedded PTY tab + viewMode=full', () => {
  resetState();
  runAction('a:psql', { type: 'spawn', script: 'psql' }, []);

  it('does NOT call async spawn (no tmux new-window)', () => {
    eq(spawnCalls.length, 0, 'async spawn unused outside tmux');
  });
  it('creates exactly one ephemeral terminal tab', () => {
    const keys = Object.keys(S.ephemeralTerminals.g1 || {});
    eq(keys.length, 1, `one new ephemeral tab (got ${JSON.stringify(keys)})`);
    assert(keys[0].startsWith('spawn-a:psql-'),
      `tab key prefixed with spawn-<actionKey>- (got ${keys[0]})`);
  });
  it('sets S.viewMode = "full" for auto-zoom', () => {
    eq(S.viewMode, 'full', 'viewMode flipped to full');
  });
  it('focuses the detail panel (set by addEphemeralTab)', () => {
    eq(S.focus, 'detail', 'focus moved to detail');
  });
  it('history records detached:false (child runs in our process)', () => {
    const last = historyStarts[historyStarts.length - 1];
    eq(last.opts.detached, false, 'history.start { detached: false }');
  });
});

describe('[2] spawn inside tmux → tmux new-window path (opt-in tier)', () => {
  resetState();
  process.env.TMUX = '/tmp/mock-tmux';
  runAction('a:vim', { type: 'spawn', script: 'vim' }, []);

  it('calls async spawn with tmux new-window', () => {
    eq(spawnCalls.length, 1, 'spawn called once');
    eq(spawnCalls[0][0], 'tmux', 'binary is tmux');
    eq(spawnCalls[0][1][0], 'new-window', 'subcommand is new-window');
  });
  it('does NOT create an ephemeral tab (tmux owns the window)', () => {
    const eph = S.ephemeralTerminals.g1 || {};
    eq(Object.keys(eph).length, 0, 'no ephemeral tab on tmux path');
  });
  it('does NOT flip viewMode (no auto-zoom in tmux)', () => {
    eq(S.viewMode, 'normal', 'viewMode unchanged on tmux path');
  });
  it('history records detached:true (sibling tmux window)', () => {
    const last = historyStarts[historyStarts.length - 1];
    eq(last.opts.detached, true, 'history.start { detached: true }');
  });
});

describe('[3] _onSessionExit: clean exit (0) on the active tab', () => {
  resetState();
  runAction('a:less', { type: 'spawn', script: 'less /etc/hosts' }, []);
  const ephKey = Object.keys(S.ephemeralTerminals.g1)[0];
  const sessionId = `g1_${ephKey}`;

  it('precondition — pre-exit: viewMode=full, tab exists', () => {
    eq(S.viewMode, 'full', 'pre: viewMode=full');
    assert(S.ephemeralTerminals.g1[ephKey] != null, 'pre: tab exists');
  });

  // forceFullRepaintCalls captures the spawn-time repaint above;
  // reset so the assertion below isolates the onExit-time repaint.
  forceFullRepaintCalls = 0;
  _onSessionExit(sessionId, 0);

  it('drops viewMode to "normal" (user lands in normal layout)', () => {
    eq(S.viewMode, 'normal', 'viewMode reset on clean exit');
  });
  it('auto-removes the ephemeral tab (clean exit only)', () => {
    eq(S.ephemeralTerminals.g1, undefined,
      'tab gone (group entry also collapses when last tab removed)');
  });
  it('calls forceFullRepaint (active session — PTY painted cells need reclaim)', () => {
    assert(forceFullRepaintCalls >= 1,
      'forceFullRepaint fired so chrome behind the PTY redraws');
  });
});

describe('[4] _onSessionExit: non-zero exit on the active tab', () => {
  resetState();
  runAction('a:badcmd', { type: 'spawn', script: 'false' }, []);
  const ephKey = Object.keys(S.ephemeralTerminals.g1)[0];
  const sessionId = `g1_${ephKey}`;

  forceFullRepaintCalls = 0;
  _onSessionExit(sessionId, 1);

  it('drops viewMode (rest of TUI reachable for navigation)', () => {
    eq(S.viewMode, 'normal', 'viewMode reset even on non-zero exit');
  });
  it('keeps the ephemeral tab (user can read error output)', () => {
    assert(S.ephemeralTerminals.g1 && S.ephemeralTerminals.g1[ephKey] != null,
      'tab still present after non-zero exit');
  });
  it('calls forceFullRepaint — fixes the Ctrl+\\ stuck-frame bug', () => {
    assert(forceFullRepaintCalls >= 1,
      'forceFullRepaint fired even on non-zero exit (SIGQUIT, ENOENT, etc)');
  });
});

describe('[5] _onSessionExit: clean exit on a NON-active session', () => {
  resetState();
  runAction('a:vim', { type: 'spawn', script: 'vim' }, []);
  const activeEphKey = Object.keys(S.ephemeralTerminals.g1)[0];
  S.ephemeralTerminals.g1.orphan = { cmd: 'true', label: 'orphan' };

  forceFullRepaintCalls = 0;
  _onSessionExit('g1_orphan', 0);

  it('does NOT touch viewMode (orphan was not the focused tab)', () => {
    eq(S.viewMode, 'full', 'viewMode untouched for non-active exit');
  });
  it('still cleans up the orphan tab (handleSessionCleanExit fires)', () => {
    assert(!S.ephemeralTerminals.g1 || S.ephemeralTerminals.g1.orphan === undefined,
      'orphan removed');
  });
  it('leaves the active tab intact', () => {
    assert(S.ephemeralTerminals.g1 && S.ephemeralTerminals.g1[activeEphKey] != null,
      'active tab still there');
  });
  it('does NOT forceFullRepaint (orphan PTY never painted to current view)', () => {
    eq(forceFullRepaintCalls, 0,
      'no chrome reclaim needed for a background-tab exit');
  });
});

report();
