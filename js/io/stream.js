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
const jobs = require('../feature/jobs');

let currentProc = null;     // streaming child process, if any
let currentRecord = null;    // history record handle for the active stream
let currentStreamTarget = null;  // {tabKey, groupName} of the routed buffer, if any
let currentJobId = null;    // jobs registry handle for the active stream
// F5 — closure that flushes the StringDecoder + the pending-line buffer
// at kill time. The close handler bails on SIGTERM'd procs, so without
// this any partial multi-byte tail (or unterminated last line) is
// dropped on preempt.
let currentFlushTail = null;

/** Dispatch the model flag. Kept inline so producers stay sync-safe
 *  and the require cycle (dispatch → action-runner → stream) stays
 *  broken at the leaf. */
function _setUnroutedStreaming(active) {
  try {
    require('../dispatch/dispatch').applyMsg({ type: 'set_unrouted_streaming', active });
  } catch (_) { /* dispatch not loaded — CLI / test edge */ }
}

/** Kill any running streamed action.
 *  opts.silent = true suppresses the "Killed by next run." + re-run
 *  footer (TUI shutdown — slice is being torn down anyway, and the
 *  label would be wrong). Default emits both. */
function killCurrentProc(opts = {}) {
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
    if (currentStreamTarget && !opts.silent) {
      const { tabKey, groupName } = currentStreamTarget;
      if (currentFlushTail) {
        const tail = currentFlushTail();
        if (tail) appendDetailLine(esc(tail), tabKey, groupName);
      }
      appendDetailLine('[yellow]Killed by next run.[/]', tabKey, groupName);
      appendDetailLine('[dim]Press Enter to run again.[/]', tabKey, groupName);
    }
    if (currentJobId) {
      jobs.close(currentJobId, { status: 'killed' });
      currentJobId = null;
    }
    currentProc = null;
    _setUnroutedStreaming(false);
  }
  currentStreamTarget = null;
  currentFlushTail = null;
  if (currentRecord) {
    currentRecord.kill();
    currentRecord = null;
  }
}

// Async producer-side write. Destination resolves via route.resolveTarget;
// dispatch is lazy-required to dodge the stream→dispatch→actions cycle.
// tabKey+groupName route into actionTabBuffers (see viewer.js#viewer_append);
// unset → legacy slice.lines write.
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
 *
 * opts.tabKey + opts.groupName route into actionTabBuffers (buffer per
 * tabbed action, see viewer.js); unset → legacy slice.lines write.
 */
function streamCommand(headerLabel, cmd, args = [], opts = {}) {
  killCurrentProc();
  const route = require('../leaves/route');
  const target = route.resolveTarget('viewer');
  if (target == null) return;     // no viewer registered — nothing to stream into
  const api = require('../panel/api');
  const tabKey = opts.tabKey || null;
  const groupName = opts.groupName || null;
  // T32 — esc the dynamic header to prevent markup corruption from
  // user-supplied actionKey / verb strings.
  const startMsg = tabKey && groupName
    ? { type: 'stream_start', header: `[dim]$ ${esc(headerLabel)}[/]`, tabKey, groupName }
    : { type: 'stream_start', header: `[dim]$ ${esc(headerLabel)}[/]` };
  api.dispatchMsg(api.wrap(target, startMsg));
  scheduleRender();

  // -- delimiter so $0 = "--", $1 = first arg, $@ = arg list (POSIX).
  const proc = spawn('sh', ['-c', cmd, '--', ...args], { cwd: getModel().projectDir });
  currentProc = proc;
  currentStreamTarget = (tabKey && groupName) ? { tabKey, groupName } : null;
  currentJobId = jobs.register({
    kind: tabKey ? 'stream-routed' : 'stream-unrouted',
    label: headerLabel,
    pid: proc.pid,
    owner: tabKey ? { tabKey, groupName, cmd } : { cmd },
  });
  _setUnroutedStreaming(!tabKey);
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
  // F5 — close handler bails for SIGTERM'd procs; this is the only
  // place that drains the decoder + partial-line buffer on preempt.
  currentFlushTail = () => {
    const tail = decoder.end() || '';
    const combined = buffer + tail;
    buffer = '';
    return combined;
  };
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
    if (currentJobId) {
      jobs.close(currentJobId, {
        status: signal ? 'killed' : 'exited',
        exitCode: signal ? null : (code == null ? null : (code | 0)),
      });
      currentJobId = null;
    }
    currentProc = null;
    currentStreamTarget = null;
    currentFlushTail = null;
    currentRecord = null;
    _setUnroutedStreaming(false);
    // Flush any dangling bytes the decoder is still holding (rare —
    // means the stream closed mid-codepoint, which is a malformed
    // sender; emit U+FFFD per Node's standard behavior).
    const tail = decoder.end();
    if (tail) buffer += tail;
    if (buffer) { appendDetailLine(esc(buffer), tabKey, groupName); rec.append(buffer); buffer = ''; }
    if (signal) { appendDetailLine(`[yellow]Killed (${signal})[/]`, tabKey, groupName); rec.end(`signal:${signal}`); }
    else if (code === 0) { appendDetailLine('[green]Done.[/]', tabKey, groupName); rec.end(0); }
    else { appendDetailLine(`[red]Exit ${code}[/]`, tabKey, groupName); rec.end(code); }
    if (tabKey && groupName) appendDetailLine('[dim]Press Enter to run again.[/]', tabKey, groupName);
    scheduleRender();
  });

  proc.on('error', (err) => {
    if (proc !== currentProc) return;
    if (currentJobId) {
      jobs.close(currentJobId, { status: 'killed' });
      currentJobId = null;
    }
    currentProc = null;
    currentStreamTarget = null;
    currentFlushTail = null;
    currentRecord = null;
    _setUnroutedStreaming(false);
    appendDetailLine(`[red]Error: ${esc(err.message)}[/]`, tabKey, groupName);
    rec.append(`Error: ${err.message}`);
    if (tabKey && groupName) appendDetailLine('[dim]Press Enter to run again.[/]', tabKey, groupName);
    rec.end('error');
    scheduleRender();
  });
}

module.exports = { streamCommand, killCurrentProc };
