/**
 * Action execution — type: run | spawn | background.
 *
 * Streamed output (type: run) lives in stream.js; this module just owns
 * the dispatch and the spawn/background path side effects. Importing
 * stream avoids touching layout, which keeps actions.js cycle-free.
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const { setViewerContent } = require('../app/state');
const { streamCommand, killCurrentProc } = require('../io/stream');
const { getInstanceSlice, dispatchMsg, wrap } = require('../panel/api');
const { getModel } = require('../app/runtime');
const { esc } = require('../io/ansi');
const history = require('../feature/history');
const jobs = require('../feature/jobs');

function runAction(actionKey, action, args = []) {
  // Event log (PRINCIPLES.md §11 + CHANGELOG v0.2.0). Record the user
  // invocation here — at the entry point, before confirm gating —
  // so the log captures "user pressed Enter on action X" once. The
  // doRun() path is the response.
  require('./event-log').record('action', { actionKey, args, type: action.type });
  // Component Msg dispatch (v0.3.0). Action invocations fan out to
  // every Component's update() as an 'action' Msg.
  require('../panel/api').dispatchMsg({ type: 'action', actionKey, args, actionType: action.type });
  // Gate on action.confirm — show modal y/N overlay; user-confirmed
  // execution re-enters this fn through doRun(). Cancel is a no-op
  // (lastRunAction stays whatever it was, no '>' marker drift).
  // Re-read getModel() AFTER the dispatchMsg above so a Component
  // action-handler that flipped confirmMode (or any future cross-layer
  // apply_msg) is visible here. Same hazard class as 2be348a.
  if (action.confirm && !getModel().modes.confirmMode) {
    // Stage the confirm through the reducer — `y` re-emits the do_run Cmd
    // (a DATA descriptor, not a closure). Lazy require breaks the
    // dispatch↔actions load cycle; this is "an effect dispatches a Msg".
    require('./dispatch').applyMsg({
      type: 'confirm_enter',
      message: action.confirm,
      cmd: { type: 'do_run', actionKey, action, args },
    });
    return;
  }
  doRun(actionKey, action, args);
}

/**
 * POSIX single-quote escape for embedding a string into a shell command
 * line — used only on the tmux-spawn path where we have to interpolate
 * args into a single string handed to `tmux new-window`.
 */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// Monotonic per-process counter for ephemeral spawn tab keys.
// Date.now() alone collides if the user double-fires the same action
// faster than 1ms — addEphemeralTab silently reuses the existing tab
// (and its dead PTY session) instead of starting a fresh child.
let _spawnSeq = 0;

function doRun(actionKey, action, args = []) {
  // Routes through update (set_last_run_action Msg) so the reducer remains the
  // single writer of model state — see docs/v0.5-layering.md. The marker the
  // actions panel paints (`>` on the last-run row) reads model.lastRunAction.
  require('./dispatch').applyMsg({ type: 'set_last_run_action', action: actionKey });
  // Parser normalizes both YAML `cmd:` and `script:` into `action.script`
  const cmd = action.script || '';
  const actionType = action.type || 'run';

  if (actionType === 'spawn') {
    // Wrap so the temp script removes itself before running the command —
    // works for both the tmux and bare-spawn paths, and survives crashes
    // (the rm runs even if cmd later fails). Args reach the script body
    // as positional params: bare-spawn passes them via argv, tmux path
    // shell-escapes them into the new-window command string.
    const tmp = `/tmp/tui-${process.pid}-${Date.now()}.sh`;
    // T7 — getModel() at the use site (set_last_run_action above already
    // swapped the model ref); reading a captured pre-dispatch local would
    // be the 2be348a hazard class.
    const body = `#!/bin/sh\nrm -- "$0"\ncd ${getModel().projectDir} && ${cmd}\n`;
    fs.writeFileSync(tmp, body, { mode: 0o700 });
    if (process.env.TMUX) {
      setViewerContent(null, `[dim]$ ${esc(actionKey)}[/]\n[yellow]Spawned in new tmux window.[/]`);
      const argStr = args.length ? ' ' + args.map(shQuote).join(' ') : '';
      spawn('tmux', ['new-window', '-n', actionKey, `${tmp}${argStr}; read`], { detached: true, stdio: 'ignore' });
      history.start(actionKey, cmd, { detached: true });
      // Jobs registry — pid=null because the spawn returned is the tmux
      // client which exits immediately after handing off to the server;
      // the actual window lives inside tmux. tmuxWindowName is the
      // durable handle for Phase 4.3+ liveness polling.
      jobs.register({
        kind: 'tmux',
        label: actionKey,
        pid: null,
        owner: { tmuxWindowName: actionKey, cmd },
      });
    } else {
      // Outside tmux: spawn into an embedded PTY tab in the detail
      // panel, auto-zoomed to viewMode='full' so the child gets the
      // whole terminal. Replaces the pre-v0.3.1 suspend/spawnSync/
      // resume dance, which blocked Node's event loop for the
      // child's entire lifetime. The child now runs alongside the
      // TUI: `_` steps back to half/normal layout while the child
      // keeps running; `+` re-zooms; the tab auto-closes on clean
      // exit (terminal.js#onExit → tabs.handleSessionCleanExit).
      // Non-zero exit keeps the tab so the user can read the error,
      // but drops viewMode so the rest of the TUI is reachable.
      // The tmux branch above is still preferred when $TMUX is set —
      // a real OS-level new window beats an in-process tab for
      // long-lived interactive sessions.
      const { addEphemeralTab } = require('../panel/viewer/tabs');
      const argStr = args.length ? ' ' + args.map(shQuote).join(' ') : '';
      const tabKey = `spawn-${actionKey}-${Date.now()}-${++_spawnSeq}`;
      // addEphemeralTab side-effects: detail slice's `tab` + ephemeral-
      // Terminals[...][tabKey], getInstanceSlice("layout").focus='detail', model.modes.terminalMode.
      addEphemeralTab(getModel().currentGroup, tabKey, `${tmp}${argStr}`, actionKey);
      // view_set's reducer arm emits force_full_repaint on viewMode
      // transitions (normal/half → full). When already in full, the
      // arm short-circuits to no-op; the new ephemeral tab's chrome
      // shows up as different row text, which the diff cache catches
      // naturally — no extra invalidate needed (P5.4).
      dispatchMsg(wrap('layout', { type: 'view_set', mode: 'full' }));
      // T27 / B19 — pre-fix `{ detached: false }` returned a live
      // record whose handle the caller discarded; the embedded PTY's
      // exit lives in terminal.js with no link back, so the entry
      // stayed `endedAt=null, exitCode=null` forever in the history
      // panel. Flip to detached (treat like tmux spawn): the entry
      // closes immediately. Cost: history doesn't show the spawn's
      // exit code. Threading the record through addEphemeralTab →
      // terminal session would be the precise fix but invasive — and
      // the user can scroll back through the tab itself for output.
      history.start(actionKey, cmd, { detached: true });
    }
    return;
  }

  if (actionType === 'background') {
    setViewerContent(null, `[dim]$ ${esc(actionKey)}[/]\n[yellow]Started in background.[/]`);
    // -- delimiter so $0 = "--", $1 = first arg, $@ = arg list (POSIX).
    const bgProc = spawn('sh', ['-c', cmd, '--', ...args], { cwd: getModel().projectDir, detached: true, stdio: 'ignore' });
    history.start(actionKey, cmd, { detached: true });
    jobs.register({
      kind: 'background',
      label: actionKey,
      pid: bgProc.pid,
      owner: { cmd },
    });
    return;
  }

  // type: run — stream stdout/stderr to detail panel. action.tab routes
  // into per-action buffer (viewer.js); tabless actions hit slice.lines.
  const opts = action.tab ? { tabKey: actionKey, groupName: getModel().currentGroup } : {};
  streamCommand(actionKey, cmd, args, opts);
}

// Re-export streaming helpers so existing import sites
// (dispatch.js, plugins/docker.js, cleanup.js) keep working.
module.exports = { runAction, doRun, killCurrentProc, streamCommand };
