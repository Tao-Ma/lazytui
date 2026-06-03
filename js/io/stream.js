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
// v0.6.2 Phase 3 — remember the tabKey/groupName the active stream is
// writing into, so the close-by-preempt path can stamp the re-run
// footer into the preempted buffer. The natural close handler reads
// its own closure (tabKey, groupName locals at streamCommand entry)
// and gates on proc===currentProc — so this target only feeds the
// preempt path (a new streamCommand → killCurrentProc → next).
let currentStreamTarget = null;

/** Kill any running streamed action (e.g., a new run preempting, or
 *  the TUI shutting down). */
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
    if (currentStreamTarget) {
      const { tabKey, groupName } = currentStreamTarget;
      appendDetailLine('[yellow]Killed by next run.[/]', tabKey, groupName);
      appendDetailLine('[dim]Press Enter to run again.[/]', tabKey, groupName);
    }
    currentProc = null;
  }
  currentStreamTarget = null;
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
//
// v0.6.2 Phase 2 — when tabKey + groupName are set, the append is routed
// into actionTabBuffers[group][tabKey] in the viewer reducer (and mirrored
// to slice.lines iff that action's tab is the active one). Unrouted appends
// land on slice.lines directly (no buffer; legacy path).
function appendDetailLine(line, tabKey, groupName) {
  const route = require('../leaves/route');
  const target = route.resolveTarget('viewer');
  if (target == null) return;
  const api = require('../panel/api');
  const msg = tabKey && groupName
    ? { type: 'viewer_append', line, tabKey, groupName }
    : { type: 'viewer_append', line };
  api.dispatchMsg(api.wrap(target, msg));
}

/**
 * Stream a shell command's stdout/stderr to the detail panel.
 * Replaces detail content with `$ headerLabel` and appends lines as they
 * arrive. Used by runAction (type:run) and action-tab activation.
 *
 * opts.tabKey + opts.groupName route the stream into a per-action-tab
 * buffer (Phase 2). When unset, output flows directly into slice.lines
 * (legacy / no-tab actions).
 */
function streamCommand(headerLabel, cmd, args = [], opts = {}) {
  killCurrentProc();
  const route = require('../leaves/route');
  const target = route.resolveTarget('viewer');
  if (target == null) return;     // no viewer registered — nothing to stream into
  const api = require('../panel/api');
  const tabKey = opts.tabKey || null;
  const groupName = opts.groupName || null;
  // T32 — esc the dynamic header. Callers pass `actionKey` (YAML key) or
  // `verb <container>` strings; a `[` or `\t` in either would corrupt
  // the markup parse / panel padding (same class as the postgresql.conf
  // tab bug).
  // v0.6.1 Phase 6 — stream_start (and every appendDetailLine below)
  // flows to resolveTarget's destination, not the singleton 'detail'.
  const startMsg = tabKey && groupName
    ? { type: 'stream_start', header: `[dim]$ ${esc(headerLabel)}[/]`, tabKey, groupName }
    : { type: 'stream_start', header: `[dim]$ ${esc(headerLabel)}[/]` };
  api.dispatchMsg(api.wrap(target, startMsg));
  scheduleRender();

  // -- delimiter so $0 = "--", $1 = first arg, $@ = arg list (POSIX).
  const proc = spawn('sh', ['-c', cmd, '--', ...args], { cwd: getModel().projectDir });
  currentProc = proc;
  currentStreamTarget = (tabKey && groupName) ? { tabKey, groupName } : null;
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
      appendDetailLine(esc(line), tabKey, groupName);
      rec.append(line);
    }
    scheduleRender();
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);

  proc.on('close', (code, signal) => {
    if (proc !== currentProc) return;  // superseded
    currentProc = null;
    currentStreamTarget = null;
    currentRecord = null;
    // Flush any dangling bytes the decoder is still holding (rare —
    // means the stream closed mid-codepoint, which is a malformed
    // sender; emit U+FFFD per Node's standard behavior).
    const tail = decoder.end();
    if (tail) buffer += tail;
    if (buffer) { appendDetailLine(esc(buffer), tabKey, groupName); rec.append(buffer); buffer = ''; }
    if (signal) { appendDetailLine(`[yellow]Killed (${signal})[/]`, tabKey, groupName); rec.end(`signal:${signal}`); }
    else if (code === 0) { appendDetailLine('[green]Done.[/]', tabKey, groupName); rec.end(0); }
    else { appendDetailLine(`[red]Exit ${code}[/]`, tabKey, groupName); rec.end(code); }
    // v0.6.2 Phase 2 — surface the re-run affordance for action-tab
    // streams. Without this, a finished tab looks like a frozen log and
    // the user has no hint that Enter restarts it. Tabless streams keep
    // their bare "Done." / "Exit N" footer.
    if (tabKey && groupName) appendDetailLine('[dim]Press Enter to run again.[/]', tabKey, groupName);
    scheduleRender();
  });

  proc.on('error', (err) => {
    if (proc !== currentProc) return;
    currentProc = null;
    currentStreamTarget = null;
    currentRecord = null;
    appendDetailLine(`[red]Error: ${esc(err.message)}[/]`, tabKey, groupName);
    rec.append(`Error: ${err.message}`);
    if (tabKey && groupName) appendDetailLine('[dim]Press Enter to run again.[/]', tabKey, groupName);
    rec.end('error');
    scheduleRender();
  });
}

/** True while a streamed command is producing output into getModel().viewer.lines. */
function isStreaming() { return currentProc !== null; }

module.exports = { streamCommand, killCurrentProc, isStreaming };
