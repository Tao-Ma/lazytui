/**
 * Streamed shell-command output → detail panel.
 *
 * Lives separately from actions.js / layout.js to break what would
 * otherwise be a layout → detail → actions → layout cycle. Both detail
 * (action-tab streaming) and actions (type: run) need this; only this
 * module owns the child process and the detail-line append logic.
 *
 * No dependency on layout — uses scheduleRender from render-queue, which
 * has zero deps. Initial header is painted on the next scheduled tick;
 * the caller is expected to render() afterward for user-driven flow.
 */
'use strict';

const { spawn } = require('child_process');
const { esc } = require('./ansi');
const { getModel } = require('../app/runtime');
const { scheduleRender } = require('../render/render-queue');
const history = require('../feature/history');

let currentProc = null;  // streaming child process, if any
let currentRecord = null; // history record handle for the active stream

/** Kill any running streamed action (e.g., on tab switch / new action). */
function killCurrentProc() {
  if (currentProc) {
    // T17 — detach the data listeners FIRST. SIGTERM doesn't flush
    // kernel pipe buffers atomically; the dying child can fire one
    // more `data` event between kill() and pipe close. Without the
    // detach, those tail bytes call appendDetailLine — which now
    // dispatches into the NEW stream's tab. Symptom: starting a
    // second run-action shows the previous action's last few lines
    // mixed into the new tab. The `close` handler is already gated
    // by `proc !== currentProc`, but data listeners weren't.
    try { currentProc.stdout.removeAllListeners('data'); } catch {}
    try { currentProc.stderr.removeAllListeners('data'); } catch {}
    try { currentProc.kill('SIGTERM'); } catch {}
    currentProc = null;
  }
  if (currentRecord) {
    currentRecord.kill();
    currentRecord = null;
  }
}

// Append a line to detail through the reducer (the viewer_append Msg owns the
// push + bottom-stick scroll). stream.js is an async producer with no threaded
// model, so it bridges via getModel(); dispatch is lazy-required to dodge the
// stream → dispatch → actions → stream load cycle. These Msgs emit no Cmds.
function appendDetailLine(line) {
  require('../panel/api').dispatchMsg(require('../panel/api').wrap('detail', { type: 'viewer_append', line }));
}

/**
 * Stream a shell command's stdout/stderr to the detail panel.
 * Replaces detail content with `$ headerLabel` and appends lines as they
 * arrive. Used by runAction (type:run) and action-tab activation.
 */
function streamCommand(headerLabel, cmd, args = []) {
  killCurrentProc();
  require('../panel/api').dispatchMsg(require('../panel/api').wrap('detail', { type: 'stream_start', header: `[dim]$ ${headerLabel}[/]` }));
  scheduleRender();

  // -- delimiter so $0 = "--", $1 = first arg, $@ = arg list (POSIX).
  const proc = spawn('sh', ['-c', cmd, '--', ...args], { cwd: getModel().projectDir });
  currentProc = proc;
  const rec = history.start(headerLabel, cmd);
  currentRecord = rec;

  let buffer = '';
  const onData = (data) => {
    buffer += data.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      appendDetailLine(esc(line));
      rec.append(line);
    }
    scheduleRender();
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code, signal) => {
    if (proc !== currentProc) return;  // superseded
    currentProc = null;
    currentRecord = null;
    if (buffer) { appendDetailLine(esc(buffer)); rec.append(buffer); buffer = ''; }
    if (signal) { appendDetailLine(`[yellow]Killed (${signal})[/]`); rec.end(`signal:${signal}`); }
    else if (code === 0) { appendDetailLine('[green]Done.[/]'); rec.end(0); }
    else { appendDetailLine(`[red]Exit ${code}[/]`); rec.end(code); }
    scheduleRender();
  });

  proc.on('error', (err) => {
    if (proc !== currentProc) return;
    currentProc = null;
    currentRecord = null;
    appendDetailLine(`[red]Error: ${esc(err.message)}[/]`);
    rec.append(`Error: ${err.message}`);
    rec.end('error');
    scheduleRender();
  });
}

/** True while a streamed command is producing output into getModel().viewer.lines. */
function isStreaming() { return currentProc !== null; }

module.exports = { streamCommand, killCurrentProc, isStreaming };
