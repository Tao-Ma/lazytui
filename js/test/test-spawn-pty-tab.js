/**
 * `type: spawn` outside tmux mints a `terminal` PANE (U2d P1b — was an ephemeral
 * viewer content-tab up to v0.6.7). See docs/one-tab-system.md.
 *
 * This file pins the SPAWN PRODUCER (action-runner.doRun's spawn branch):
 *   1. Outside tmux → mint a `terminal` pane into the viewer's slot, auto-zoom
 *      (viewMode='full'), enter terminalMode, focus it — no async spawn.
 *   2. Inside tmux → the tmux new-window path still wins (opt-in tier); no pane.
 *   3. Two spawns of one action → two DISTINCT terminal panes (reducer-derived
 *      poolId, not a Date.now() key that could collide+reuse).
 *
 * The generic terminal-pane lifecycle (clean-exit auto-close, non-zero-stays,
 * input routing via focusedTerminalId, the remove_tab teardown) is pinned by
 * test-terminal-pane.js; this file only pins the producer.
 *
 * Run: node js/test/test-spawn-pty-tab.js
 */
'use strict';

// Mock child_process.spawn BEFORE the runtime loads (action-runner destructures
// it at module-load). The bare-PTY path uses node-pty (unaffected); only the tmux
// branch calls child_process.spawn, so this records the tmux new-window invocation
// without actually launching tmux.
const child_process = require('child_process');
const spawnCalls = [];
child_process.spawn = (...args) => { spawnCalls.push(args); return { on() {}, kill() {} }; };

const { describe, it, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const mpane = require('../leaves/wm/pane');
const terminal = require('../io/terminal');
const { getModel } = require('../model/store');
const { runAction } = require('../dispatch/runtime/action-runner');

const history = require('../feature/history');
const historyStarts = [];
history.start = (key, cmd, opts) => { historyStarts.push({ key, cmd, opts }); };

const api = sm.api;
if (!api.getComponent('terminal')) api.registerComponent(require('../panel/terminal/terminal'));

function layoutSlice() { return route.getInstanceSlice('layout'); }
function viewerPane() {
  const v = route.resolveViewerPaneId();
  for (const col of layoutSlice().arrange.columns) for (const p of col.panels) if (p.paneId === v) return p;
  return null;
}
function isTerminalTab(t) {
  const e = layoutSlice().arrange.pool[t.poolId];
  return !!(e && e.type === 'terminal');
}
// Kill every spawned PTY so a `sleep 30` doesn't linger past the test.
function cleanupTerminals() {
  for (const col of layoutSlice().arrange.columns) for (const p of col.panels) {
    for (const t of (p.tabs || [])) {
      if (isTerminalTab(t)) { try { terminal.destroySession(mpane.newPaneId(t.poolId)); } catch (_) {} }
    }
  }
}

describe('[1] spawn outside tmux → terminal PANE + viewMode=full + terminalMode', () => {
  sm.bootFresh();
  getModel().projectDir = '/tmp';
  spawnCalls.length = 0; historyStarts.length = 0;
  delete process.env.TMUX;
  runAction('a:sh', { type: 'spawn', script: 'sleep 30' }, []);
  const vp = viewerPane();

  it('does NOT call async (tmux) spawn outside tmux', () => eq(spawnCalls.length, 0));
  it('mints a `terminal` pane as the viewer slot active tab', () => {
    eq(route.instanceKind(vp.paneId), 'terminal', 'viewer slot active tab is a terminal');
    const entry = layoutSlice().arrange.pool[vp.activeTabId];
    assert(entry && entry.type === 'terminal', 'active tab entry is a terminal');
    assert(entry.hint && entry.hint.origin === 'spawn', 'stamped a spawn-origin hint');
    eq(entry.config.cmd.includes('/tmp/tui-'), true, 'cmd runs the temp spawn script');
  });
  it('the finalizer spawned the PTY (keyed by the tab-instance id)', () => {
    assert(terminal.getSession(mpane.newPaneId(vp.activeTabId)), 'PTY spawned');
  });
  it('sets viewMode="full" for auto-zoom', () => eq(layoutSlice().viewMode, 'full'));
  it('enters terminalMode', () => eq(getModel().modes.terminalMode, true));
  it('focuses the terminal (its slot)', () => eq(route.getFocus(), vp.paneId));
  it('history records detached:true', () => {
    eq(historyStarts[historyStarts.length - 1].opts.detached, true);
  });
  cleanupTerminals();
});

describe('[2] spawn inside tmux → tmux new-window path (unchanged; no pane)', () => {
  sm.bootFresh();
  layoutSlice().viewMode = 'normal';   // bootFresh preserves viewMode; clear [1]'s 'full'
  spawnCalls.length = 0; historyStarts.length = 0;
  process.env.TMUX = '/tmp/mock-tmux';
  runAction('a:vim', { type: 'spawn', script: 'vim' }, []);
  const vp = viewerPane();

  it('calls async spawn with tmux new-window', () => {
    eq(spawnCalls.length, 1, 'spawn called once');
    eq(spawnCalls[0][0], 'tmux', 'binary is tmux');
    eq(spawnCalls[0][1][0], 'new-window', 'subcommand is new-window');
  });
  it('does NOT mint a terminal pane (tmux owns the window)', () => {
    assert(route.instanceKind(vp.paneId) !== 'terminal', 'no terminal pane on the tmux path');
  });
  it('does NOT flip viewMode', () => eq(layoutSlice().viewMode, 'normal'));
  it('history records detached:true', () => {
    eq(historyStarts[historyStarts.length - 1].opts.detached, true);
  });
  delete process.env.TMUX;
});

describe('[3] two spawns of one action → two DISTINCT terminal panes', () => {
  sm.bootFresh();
  getModel().projectDir = '/tmp';
  delete process.env.TMUX;
  // Without a reducer-derived (incrementing) poolId, a Date.now() key could
  // collide on a hot double-fire and the mint would id-collision-no-op (reuse).
  runAction('a:dup', { type: 'spawn', script: 'sleep 30' }, []);
  runAction('a:dup', { type: 'spawn', script: 'sleep 30' }, []);
  const vp = viewerPane();

  it('opens two distinct terminal tabs in the viewer slot', () => {
    const termTabs = (vp.tabs || []).filter(isTerminalTab);
    eq(termTabs.length, 2, `two distinct terminal panes (got ${termTabs.length})`);
  });
  cleanupTerminals();
});

report();
