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

const { describe, section, it, assert, eq, report } = require('./test-runner');
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
    const cmd = entry.config.cmd;
    eq([Array.isArray(cmd), cmd[0], cmd[1]], [true, '/bin/sh', '-c'], 'cmd: an argv running the body under /bin/sh');
    eq(JSON.stringify(cmd).includes('/tmp/tui-'), false, 'no temp script (it deleted itself: no restart)');
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
  // The mocked tmux never runs the self-deleting script — remove it here.
  try { require('fs').unlinkSync(spawnCalls[0][1][3].split(/[ ;]/)[0]); } catch (_) {}
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

describe('[4] the tmux temp-script shQuotes projectDir (a path with a space still cd\'s)', () => {
  // #4: the temp script (run by the tmux window) did `cd ${projectDir}`
  // unquoted, so a projectDir with a space passed `cd` two args and failed. Capture
  // the written body and assert the path is single-quoted.
  sm.bootFresh();
  process.env.TMUX = '/tmp/mock-tmux';
  const fsmod = require('fs');
  const realWrite = fsmod.writeFileSync;
  let body = null;
  fsmod.writeFileSync = (p, data, opts) => {
    if (String(p).includes('/tui-')) body = String(data);   // capture, then still write
    return realWrite(p, data, opts);
  };
  getModel().projectDir = '/tmp/has a space';
  try { runAction('a:q', { type: 'spawn', script: 'echo hi' }, []); }
  finally { fsmod.writeFileSync = realWrite; delete process.env.TMUX; }

  it('interpolates cd with a single-quoted projectDir', () => {
    assert(body, 'the temp-script body was written');
    assert(body.includes("cd '/tmp/has a space'"),
      `projectDir is shQuoted in the cd (body: ${JSON.stringify(body)})`);
    assert(!/cd \/tmp\/has a space/.test(body), 'not the old unquoted form');
  });
  try { fsmod.unlinkSync(spawnCalls[spawnCalls.length - 1][1][3].split(/[ ;]/)[0]); } catch (_) {}
});

// The embedded terminal's command, run as its PTY runs it (the argv, no shell
// around it): in the project dir (a path with a space), the action's args as
// $1.. — quotes and all.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
describe('[5] the embedded command runs in the project dir with the args', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui spawn '));
  sm.bootFresh();
  getModel().projectDir = dir;
  runAction('a:args', { type: 'spawn', script: 'printf "%s|%s|%s" "$(pwd)" "$1" "$2"' }, ['a b', "it's"]);
  const entry = layoutSlice().arrange.pool[viewerPane().activeTabId];
  cleanupTerminals();
  const r = spawnSync(entry.config.cmd[0], entry.config.cmd.slice(1), { encoding: 'utf8' });
  it('cwd, $1 and $2 as given', () => eq(r.stdout, `${fs.realpathSync(dir)}|a b|it's`));
  fs.rmSync(dir, { recursive: true, force: true });
});

// Enter on a spawn tab whose program exited (or a replay stopped) restarts it:
// the same command runs again — it ran a self-deleting temp script, so the
// restart found nothing (`No such file or directory`, exit 127; round-3 review).
(async () => {
  sm.bootFresh();
  getModel().projectDir = '/tmp';
  runAction('a:again', { type: 'spawn', script: 'echo "RAN-$1"; exit 3' }, ['x']);
  const id = mpane.newPaneId(viewerPane().activeTabId);
  const settle = async (pred) => { for (let i = 0; i < 100 && !pred(); i++) await new Promise(r => setTimeout(r, 30)); };
  const exited = () => { const s = terminal.getSession(id); return !!(s && s.exited); };
  const screen = () => terminal.sessionViewportRows(id, 5, 60).rows.join('|');
  await settle(exited);
  const first = [terminal.getSession(id).exitCode, /RAN-x/.test(screen())];
  terminal.restartSession(id, 60, 5);
  await settle(exited);
  await settle(() => /RAN-x|No such file/.test(screen()));
  const second = [terminal.getSession(id).exitCode, /RAN-x/.test(screen()), /No such file/.test(screen())];
  section('[6] a spawn tab restarts with its command');
  eq(first, [3, true], 'first run: printed, exited 3');
  eq(second, [3, true, false], 'restart: the same command ran again');
  cleanupTerminals();

  // [7] The body is the action's /bin/sh script: the user's shell never parses
  // it (wrapped in a `$SHELL -c` string, fish read `\\` and `\'` inside the
  // quotes as escapes — round-4 review). A $SHELL that can't run at all
  // doesn't matter to it.
  const savedShell = process.env.SHELL;
  process.env.SHELL = '/nonexistent/shell';
  sm.bootFresh();
  getModel().projectDir = '/tmp';
  runAction('a:noshell', { type: 'spawn', script: "printf '%s|%s\\n' 'back\\\\slash' \"$1\"" }, ['y']);
  const id7 = mpane.newPaneId(viewerPane().activeTabId);
  const exited7 = () => { const s = terminal.getSession(id7); return !!(s && s.exited); };
  await settle(exited7);
  await settle(() => /back/.test(terminal.sessionViewportRows(id7, 5, 60).rows.join('|')));
  process.env.SHELL = savedShell;
  const s7 = terminal.getSession(id7);
  const text7 = terminal.sessionViewportRows(id7, 5, 60).rows.join('|');
  section('[7] the spawn body runs under /bin/sh whatever $SHELL is');
  eq([s7 && s7.exitCode, /back\\\\slash\|y/.test(text7)], [0, true], `ran, backslashes intact: ${JSON.stringify(text7.trim().slice(0, 60))}`);
  cleanupTerminals();
  report();
})();
