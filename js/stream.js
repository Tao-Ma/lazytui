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
const { S } = require('./state');
const { scheduleRender } = require('./render-queue');
const history = require('./history');

let currentProc = null;  // streaming child process, if any
let currentRecord = null; // history record handle for the active stream

/** Kill any running streamed action (e.g., on tab switch / new action). */
function killCurrentProc() {
  if (currentProc) {
    try { currentProc.kill('SIGTERM'); } catch {}
    currentProc = null;
  }
  if (currentRecord) {
    currentRecord.kill();
    currentRecord = null;
  }
}

/** Append a line to detail; auto-scroll to bottom only if already at bottom. */
function appendDetailLine(line) {
  const innerH = Math.max(1, (S.panelHeights.detail || 10) - 2);
  const maxScroll = Math.max(0, S.detailLines.length - innerH);
  const wasAtBottom = S.detailScroll >= maxScroll;
  S.detailLines.push(line);
  if (wasAtBottom) {
    S.detailScroll = Math.max(0, S.detailLines.length - innerH);
  }
}

/**
 * Stream a shell command's stdout/stderr to the detail panel.
 * Replaces detail content with `$ headerLabel` and appends lines as they
 * arrive. Used by runAction (type:run) and action-tab activation.
 */
function streamCommand(headerLabel, cmd, args = []) {
  killCurrentProc();
  S.detailLines = [`[dim]$ ${headerLabel}[/]`];
  S.detailScroll = 0;
  scheduleRender();

  // -- delimiter so $0 = "--", $1 = first arg, $@ = arg list (POSIX).
  const proc = spawn('sh', ['-c', cmd, '--', ...args], { cwd: S.projectDir });
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

/** True while a streamed command is producing output into S.detailLines. */
function isStreaming() { return currentProc !== null; }

module.exports = { streamCommand, killCurrentProc, isStreaming };
