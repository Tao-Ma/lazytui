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
const { S, setDetail } = require('./state');
const { streamCommand, killCurrentProc } = require('./stream');
const { enterConfirm } = require('./confirm');
const history = require('./history');

function runAction(actionKey, action, args = []) {
  // Event log (PRINCIPLES.md §11 + CHANGELOG v0.2.0). Record the user
  // invocation here — at the entry point, before confirm gating —
  // so the log captures "user pressed Enter on action X" once. The
  // doRun() path is the response.
  require('./event-log').record('action', { actionKey, args, type: action.type });
  // Gate on action.confirm — show modal y/N overlay; user-confirmed
  // execution re-enters this fn through doRun(). Cancel is a no-op
  // (lastRunAction stays whatever it was, no '>' marker drift).
  if (action.confirm && !S.confirmMode) {
    enterConfirm(action.confirm, () => doRun(actionKey, action, args));
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

function doRun(actionKey, action, args = []) {
  S.lastRunAction = actionKey;
  // Parser normalizes both YAML `cmd:` and `script:` into `action.script`
  const cmd = action.script || '';
  const actionType = action.type || 'run';

  if (actionType === 'spawn') {
    setDetail(`[dim]$ ${actionKey}[/]\n[yellow]Spawning...[/]`);
    // Wrap so the temp script removes itself before running the command —
    // works for both the tmux and bare-spawn paths, and survives crashes
    // (the rm runs even if cmd later fails). Args reach the script body
    // as positional params: bare-spawn passes them via argv, tmux path
    // shell-escapes them into the new-window command string.
    const tmp = `/tmp/tui-${process.pid}-${Date.now()}.sh`;
    const body = `#!/bin/sh\nrm -- "$0"\ncd ${S.projectDir} && ${cmd}\n`;
    fs.writeFileSync(tmp, body, { mode: 0o700 });
    if (process.env.TMUX) {
      const argStr = args.length ? ' ' + args.map(shQuote).join(' ') : '';
      spawn('tmux', ['new-window', '-n', actionKey, `${tmp}${argStr}; read`], { detached: true, stdio: 'ignore' });
    } else {
      spawn('sh', [tmp, ...args], { detached: true, stdio: 'ignore' });
    }
    history.start(actionKey, cmd, { detached: true });
    return;
  }

  if (actionType === 'background') {
    setDetail(`[dim]$ ${actionKey}[/]\n[yellow]Started in background.[/]`);
    // -- delimiter so $0 = "--", $1 = first arg, $@ = arg list (POSIX).
    spawn('sh', ['-c', cmd, '--', ...args], { cwd: S.projectDir, detached: true, stdio: 'ignore' });
    history.start(actionKey, cmd, { detached: true });
    return;
  }

  // type: run — stream stdout/stderr to detail panel (history recorded inside)
  streamCommand(actionKey, cmd, args);
}

// Re-export streaming helpers so existing import sites
// (dispatch.js, plugins/docker.js, cleanup.js) keep working.
module.exports = { runAction, killCurrentProc, streamCommand };
