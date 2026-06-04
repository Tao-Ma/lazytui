/**
 * Streamed shell-command output → detail panel.
 *
 * v0.6.2 Large — multi-job. The singleton currentProc retires; each
 * spawn lives in its own ProcCtx in the `procs` Map keyed by jobId.
 *
 * Slot semantics:
 *   Routed   (opts.tabKey + opts.groupName) → slotKey =
 *     `routed:${groupName}:${tabKey}`. One slot per action tab.
 *     Different slots run concurrently; same-slot replays preempt
 *     the previous run (e.g., re-Entering `make-check` while it's
 *     alive still kills the previous; running Test alongside
 *     Server log does NOT).
 *   Unrouted (no tabKey) → slotKey = 'unrouted'. Singleton slot —
 *     a new docker-logs preempts the previous (the legacy verb-
 *     verb behavior). One unrouted at a time is enough; multiple
 *     would interleave into slice.lines anyway.
 *
 * Lifecycle Cmds dispatched at boundaries:
 *   stream_start  { header, tabKey?, groupName? }   — at spawn
 *   viewer_append { line, tabKey?, groupName? }     — per output line
 *   viewer_append_lines { lines, … }                — preempt + close batches
 *   set_unrouted_streaming { active }               — when the
 *     unrouted-slot occupancy flips
 *
 * No layout dependency — uses scheduleRender from render-queue. Lazy-
 * requires dispatch.applyMsg / panel/api to dodge the
 * stream → dispatch → actions → stream load cycle at module-load time.
 */
'use strict';

const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { esc } = require('./ansi');
const { getModel } = require('../app/runtime');
const { scheduleRender } = require('../render/render-queue');
const history = require('../feature/history');
const jobs = require('../feature/jobs');

/** ProcCtx fields:
 *    proc       — spawned ChildProcess
 *    record     — feature/history handle
 *    target     — {tabKey, groupName} | null  (the routed buffer destination)
 *    flushTail  — () → string (drains decoder + partial-line buffer on kill)
 *    slotKey    — string (for slotIndex bookkeeping)
 *    decoder    — StringDecoder (for the close-time flush)
 *    headerCmd  — { headerLabel } stored only for completeness
 */
const procs = new Map();         // jobId → ProcCtx
const slotIndex = new Map();      // slotKey → jobId

function _slotKey(tabKey, groupName) {
  return tabKey && groupName ? `routed:${groupName}:${tabKey}` : 'unrouted';
}

/** Recompute and dispatch model.unroutedStreaming based on slotIndex.
 *  Lazy require — module-load time cycle: stream → dispatch → actions →
 *  stream. Silent no-op in test/CLI when dispatch isn't loaded. */
function _refreshUnroutedFlag() {
  const active = slotIndex.has('unrouted');
  try {
    require('../dispatch/dispatch').applyMsg({ type: 'set_unrouted_streaming', active });
  } catch (_) { /* dispatch not loaded */ }
}

// Async producer-side writes. Destination resolves via route.resolveTarget;
// dispatch is lazy-required to dodge the stream→dispatch→actions cycle.
// tabKey+groupName route into actionTabBuffers; unset → legacy slice.lines.
//
// appendDetailLine: single-line (the onData hot path — one Msg per line).
// appendDetailLines: bulk variant for producer-event footers (one Msg for
// the whole tail+status+rerun-hint batch — atomic reducer pass).
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

function appendDetailLines(lines, tabKey, groupName) {
  if (!lines || lines.length === 0) return;
  const route = require('../leaves/route');
  const target = route.resolveTarget('viewer');
  if (target == null) return;
  const api = require('../panel/api');
  const msg = tabKey && groupName
    ? { type: 'viewer_append_lines', lines, tabKey, groupName }
    : { type: 'viewer_append_lines', lines };
  api.dispatchMsg(api.wrap(target, msg));
}

/** Kill a single job. Removes it from procs + slotIndex, SIGTERMs the
 *  proc, emits the preempt footer to its buffer unless opts.silent,
 *  closes the registry entry, and refreshes the unrouted flag.
 *  No-op if jobId isn't in the procs map (already finished). */
function killJob(jobId, opts = {}) {
  const ctx = procs.get(jobId);
  if (!ctx) return;
  // T17 — detach data listeners FIRST so SIGTERM's tail bytes don't
  // re-enter appendDetailLine after the proc is already considered dead.
  try { ctx.proc.stdout.removeAllListeners('data'); } catch {}
  try { ctx.proc.stderr.removeAllListeners('data'); } catch {}
  try { ctx.proc.kill('SIGTERM'); } catch {}
  if (ctx.target && !opts.silent) {
    const { tabKey, groupName } = ctx.target;
    const batch = [];
    if (ctx.flushTail) {
      const tail = ctx.flushTail();
      if (tail) batch.push(esc(tail));
    }
    batch.push('[yellow]Killed by next run.[/]');
    batch.push('[dim]Press Enter to run again.[/]');
    appendDetailLines(batch, tabKey, groupName);
  }
  jobs.close(jobId, { status: 'killed' });
  if (ctx.record) ctx.record.kill();
  procs.delete(jobId);
  if (slotIndex.get(ctx.slotKey) === jobId) slotIndex.delete(ctx.slotKey);
  _refreshUnroutedFlag();
}

/** Kill every active stream. cleanup.js on TUI shutdown; opts.silent
 *  suppresses the per-buffer footer since the slice is being torn
 *  down anyway. */
function killAll(opts = {}) {
  // Snapshot ids — killJob mutates procs during iteration.
  for (const jobId of [...procs.keys()]) killJob(jobId, opts);
}

/**
 * Stream a shell command's stdout/stderr to the detail panel.
 *
 * opts.tabKey + opts.groupName route into actionTabBuffers (buffer per
 * tabbed action, see viewer.js); unset → legacy slice.lines write
 * (singleton unrouted slot — new unrouted preempts previous).
 */
function streamCommand(headerLabel, cmd, args = [], opts = {}) {
  const route = require('../leaves/route');
  const target = route.resolveTarget('viewer');
  if (target == null) return;     // no viewer registered
  const api = require('../panel/api');
  const tabKey = opts.tabKey || null;
  const groupName = opts.groupName || null;
  const slotKey = _slotKey(tabKey, groupName);

  // Same-slot preempt — kill any existing run in this slot before
  // starting a fresh one. Cross-slot runs are independent.
  const occupying = slotIndex.get(slotKey);
  if (occupying != null) killJob(occupying);

  // T32 — esc the dynamic header to prevent markup corruption from
  // user-supplied actionKey / verb strings.
  const startMsg = tabKey && groupName
    ? { type: 'stream_start', header: `[dim]$ ${esc(headerLabel)}[/]`, tabKey, groupName }
    : { type: 'stream_start', header: `[dim]$ ${esc(headerLabel)}[/]` };
  api.dispatchMsg(api.wrap(target, startMsg));
  scheduleRender();

  // -- delimiter so $0 = "--", $1 = first arg, $@ = arg list (POSIX).
  const proc = spawn('sh', ['-c', cmd, '--', ...args], { cwd: getModel().projectDir });
  const jobId = jobs.register({
    kind: tabKey ? 'stream-routed' : 'stream-unrouted',
    label: headerLabel,
    pid: proc.pid,
    owner: tabKey ? { tabKey, groupName, cmd } : { cmd },
  });
  const rec = history.start(headerLabel, cmd);

  let buffer = '';
  // T24 — StringDecoder buffers partial UTF-8 sequences across chunks.
  // Without it, multi-byte codepoints split at chunk boundaries become
  // U+FFFD pairs (`'café'` → `'caf��'`).
  const decoder = new StringDecoder('utf8');
  const flushTail = () => {
    const tail = decoder.end() || '';
    const combined = buffer + tail;
    buffer = '';
    return combined;
  };

  const ctx = {
    proc, record: rec,
    target: tabKey && groupName ? { tabKey, groupName } : null,
    flushTail, slotKey, decoder,
  };
  procs.set(jobId, ctx);
  slotIndex.set(slotKey, jobId);
  _refreshUnroutedFlag();

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
    // If the slot was preempted, killJob already removed jobId from
    // procs — bail to avoid double-close.
    if (!procs.has(jobId)) return;
    jobs.close(jobId, {
      status: signal ? 'killed' : 'exited',
      exitCode: signal ? null : (code == null ? null : (code | 0)),
    });
    procs.delete(jobId);
    if (slotIndex.get(slotKey) === jobId) slotIndex.delete(slotKey);
    _refreshUnroutedFlag();
    // Coalesce decoder tail + status + re-run hint into one batched
    // append — atomic reducer pass instead of 2-3 sequential
    // viewer_append dispatches.
    const batch = [];
    const tail = decoder.end();
    if (tail) buffer += tail;
    if (buffer) { batch.push(esc(buffer)); rec.append(buffer); buffer = ''; }
    if (signal)            { batch.push(`[yellow]Killed (${signal})[/]`); rec.end(`signal:${signal}`); }
    else if (code === 0)    { batch.push('[green]Done.[/]'); rec.end(0); }
    else                    { batch.push(`[red]Exit ${code}[/]`); rec.end(code); }
    if (tabKey && groupName) batch.push('[dim]Press Enter to run again.[/]');
    appendDetailLines(batch, tabKey, groupName);
    scheduleRender();
  });

  proc.on('error', (err) => {
    if (!procs.has(jobId)) return;
    jobs.close(jobId, { status: 'killed' });
    procs.delete(jobId);
    if (slotIndex.get(slotKey) === jobId) slotIndex.delete(slotKey);
    _refreshUnroutedFlag();
    const batch = [`[red]Error: ${esc(err.message)}[/]`];
    rec.append(`Error: ${err.message}`);
    if (tabKey && groupName) batch.push('[dim]Press Enter to run again.[/]');
    appendDetailLines(batch, tabKey, groupName);
    rec.end('error');
    scheduleRender();
  });
}

module.exports = { streamCommand, killJob, killAll };
