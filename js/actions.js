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
const { setDetail } = require('./state');
const { streamCommand, killCurrentProc } = require('./stream');
const { getComponentSlice, dispatchMsg, wrap } = require('./plugins/api');
const history = require('./history');

function runAction(model, actionKey, action, args = []) {
  // Event log (PRINCIPLES.md §11 + CHANGELOG v0.2.0). Record the user
  // invocation here — at the entry point, before confirm gating —
  // so the log captures "user pressed Enter on action X" once. The
  // doRun() path is the response.
  require('./event-log').record('action', { actionKey, args, type: action.type });
  // Component Msg dispatch (v0.3.0). Action invocations fan out to
  // every Component's update() as an 'action' Msg.
  require('./plugins/api').dispatchMsg({ type: 'action', actionKey, args, actionType: action.type });
  // Gate on action.confirm — show modal y/N overlay; user-confirmed
  // execution re-enters this fn through doRun(). Cancel is a no-op
  // (lastRunAction stays whatever it was, no '>' marker drift). The
  // confirm callback closes over the threaded model.
  if (action.confirm && !model.modes.confirmMode) {
    // Stage the confirm through the reducer — `y` re-emits the do_run Cmd
    // (a DATA descriptor, not a closure). Lazy require breaks the
    // dispatch↔actions load cycle; this is "an effect dispatches a Msg".
    require('./dispatch').applyMsg(model, {
      type: 'confirm_enter',
      message: action.confirm,
      cmd: { type: 'do_run', actionKey, action, args },
    });
    return;
  }
  doRun(model, actionKey, action, args);
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

function doRun(model, actionKey, action, args = []) {
  // Routes through update (set_last_run_action Msg) so the reducer remains the
  // single writer of model state — see docs/v0.5-layering.md. The marker the
  // actions panel paints (`>` on the last-run row) reads model.lastRunAction.
  require('./dispatch').applyMsg(model, { type: 'set_last_run_action', action: actionKey });
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
    const body = `#!/bin/sh\nrm -- "$0"\ncd ${model.projectDir} && ${cmd}\n`;
    fs.writeFileSync(tmp, body, { mode: 0o700 });
    if (process.env.TMUX) {
      setDetail(`[dim]$ ${actionKey}[/]\n[yellow]Spawned in new tmux window.[/]`);
      const argStr = args.length ? ' ' + args.map(shQuote).join(' ') : '';
      spawn('tmux', ['new-window', '-n', actionKey, `${tmp}${argStr}; read`], { detached: true, stdio: 'ignore' });
      history.start(actionKey, cmd, { detached: true });
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
      const { addEphemeralTab } = require('./tabs');
      const argStr = args.length ? ' ' + args.map(shQuote).join(' ') : '';
      const tabKey = `spawn-${actionKey}-${Date.now()}-${++_spawnSeq}`;
      // addEphemeralTab side-effects: detail slice's `tab` + ephemeral-
      // Terminals[...][tabKey], getComponentSlice("layout").focus='detail', model.modes.terminalMode.
      addEphemeralTab(model.currentGroup, tabKey, `${tmp}${argStr}`, actionKey);
      dispatchMsg(wrap('layout', { type: 'view_set', mode: 'full' }));
      require('./layout').forceFullRepaint();
      history.start(actionKey, cmd, { detached: false });
    }
    return;
  }

  if (actionType === 'background') {
    setDetail(`[dim]$ ${actionKey}[/]\n[yellow]Started in background.[/]`);
    // -- delimiter so $0 = "--", $1 = first arg, $@ = arg list (POSIX).
    spawn('sh', ['-c', cmd, '--', ...args], { cwd: model.projectDir, detached: true, stdio: 'ignore' });
    history.start(actionKey, cmd, { detached: true });
    return;
  }

  // type: run — stream stdout/stderr to detail panel (history recorded inside)
  streamCommand(actionKey, cmd, args);
}

// Re-export streaming helpers so existing import sites
// (dispatch.js, plugins/docker.js, cleanup.js) keep working.
module.exports = { runAction, doRun, killCurrentProc, streamCommand };
