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
const { StringDecoder } = require('string_decoder');
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
//
// v0.6.1 Phase 6 — destination resolves via route.resolveTarget('viewer'); a
// null result (no viewer registered) drops the line silently. Producer-side
// write: stream output flows toward "the viewer," not a specific pane.
function appendDetailLine(line) {
  const route = require('../leaves/route');
  const target = route.resolveTarget('viewer');
  if (target == null) return;
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap(target, { type: 'viewer_append', line }));
}

/**
 * Stream a shell command's stdout/stderr to the detail panel.
 * Replaces detail content with `$ headerLabel` and appends lines as they
 * arrive. Used by runAction (type:run) and action-tab activation.
 */
function streamCommand(headerLabel, cmd, args = []) {
  killCurrentProc();
  const route = require('../leaves/route');
  const target = route.resolveTarget('viewer');
  if (target == null) return;     // no viewer registered — nothing to stream into
  const api = require('../panel/api');
  // T32 — esc the dynamic header. Callers pass `actionKey` (YAML key) or
  // `verb <container>` strings; a `[` or `\t` in either would corrupt
  // the markup parse / panel padding (same class as the postgresql.conf
  // tab bug).
  // v0.6.1 Phase 6 — stream_start (and every appendDetailLine below)
  // flows to resolveTarget's destination, not the singleton 'detail'.
  api.dispatchMsg(api.wrap(target, { type: 'stream_start', header: `[dim]$ ${esc(headerLabel)}[/]` }));
  scheduleRender();

  // -- delimiter so $0 = "--", $1 = first arg, $@ = arg list (POSIX).
  const proc = spawn('sh', ['-c', cmd, '--', ...args], { cwd: getModel().projectDir });
  currentProc = proc;
  const rec = history.start(headerLabel, cmd);
  currentRecord = rec;

  let buffer = '';
  // T24 — StringDecoder buffers partial UTF-8 sequences across chunks.
  // Pre-fix `data.toString('utf8')` decoded each chunk independently,
  // so multi-byte codepoints split at chunk boundaries (extremely
  // common: any docker log / shell output with non-ASCII text +
  // chunked I/O) became U+FFFD replacement-char pairs. Verified by
  // repro: `'café'` arriving split at byte 4 became `'caf��'`.
  const decoder = new StringDecoder('utf8');
  const onData = (data) => {
    buffer += decoder.write(data);
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
    // Flush any dangling bytes the decoder is still holding (rare —
    // means the stream closed mid-codepoint, which is a malformed
    // sender; emit U+FFFD per Node's standard behavior).
    const tail = decoder.end();
    if (tail) buffer += tail;
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
