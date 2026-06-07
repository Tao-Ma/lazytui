/**
 * Streamed shell-command output → detail panel.
 *
 * v0.6.2 R8 — moved from io/ to dispatch/. This module is primarily a
 * Msg-dispatcher facade (stream_start / viewer_append / viewer_append_lines
 * wrapped via panel/api + route, slot map for preempt semantics,
 * confirm-overlay for cross-label unrouted preempt) that happens to wrap
 * child_process.spawn underneath. Its lazy requires reach dispatch/,
 * panel/, leaves/ — i.e. dispatch-layer modules — which is the wrong
 * layering when filed under io/ (sibling io/ files like ansi/term/
 * file-loader are pure leaves). Reclassifying restores the layer
 * invariant.
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
 *
 * No layout dependency — uses scheduleRender from render-queue. Lazy-
 * requires dispatch.applyMsg / panel/api to dodge the
 * stream → dispatch → actions → stream load cycle at module-load time.
 */
'use strict';

const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { esc } = require('../io/ansi');
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

// Async producer-side writes. Destination resolves via route.resolveTarget;
// dispatch is lazy-required to dodge the stream→dispatch→actions cycle.
// tabKey+groupName route into actionTabBuffers; unset → legacy slice.lines.
//
// appendDetailLine: single-line (the onData hot path — one Msg per line).
// appendDetailLines: bulk variant for producer-event footers (one Msg for
// the whole tail+status+rerun-hint batch — atomic reducer pass).
// v0.6.3 Phase D1 — routed-branch arms read msg.currentGroup +
// msg.activeActionTabKey (when groupName === currentGroup); the
// dispatcher precomputes both so the reducer arm stays pure of
// getModel(). For unrouted dispatches (no tabKey/groupName) no
// threading is needed — the reducer arm's unrouted path doesn't
// read model.
function _routedBundle(slice, model, groupName) {
  if (groupName !== model.currentGroup) {
    return { currentGroup: model.currentGroup };
  }
  // Compute the active action tab key once at dispatch time. Saves
  // the reducer the 71µs pt.activeActionTabIn (getMergedActions
  // iteration) per streamed line.
  const pt = require('../leaves/pane-tabs');
  const active = pt.activeActionTabIn(slice, model, groupName);
  return {
    currentGroup: model.currentGroup,
    activeActionTabKey: active ? active[0] : null,
  };
}

function appendDetailLine(line, tabKey, groupName) {
  const route = require('../leaves/route');
  const target = route.resolveTarget('viewer');
  if (target == null) return;
  const api = require('../panel/api');
  let msg;
  if (tabKey && groupName) {
    const slice = api.getInstanceSlice(target) || { tab: 0 };
    const model = require('../app/runtime').getModel();
    msg = { type: 'viewer_append', line, tabKey, groupName, ..._routedBundle(slice, model, groupName) };
  } else {
    msg = { type: 'viewer_append', line };
  }
  api.dispatchMsg(api.wrap(target, msg));
}

function appendDetailLines(lines, tabKey, groupName) {
  if (!lines || lines.length === 0) return;
  const route = require('../leaves/route');
  const target = route.resolveTarget('viewer');
  if (target == null) return;
  const api = require('../panel/api');
  let msg;
  if (tabKey && groupName) {
    const slice = api.getInstanceSlice(target) || { tab: 0 };
    const model = require('../app/runtime').getModel();
    msg = { type: 'viewer_append_lines', lines, tabKey, groupName, ..._routedBundle(slice, model, groupName) };
  } else {
    msg = { type: 'viewer_append_lines', lines };
  }
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
  if (!opts.silent) {
    const batch = [];
    if (ctx.flushTail) {
      const tail = ctx.flushTail();
      if (tail) batch.push(esc(tail));
    }
    if (ctx.target) {
      // Routed: re-run-on-same-slot footer. Goes to the action's buffer.
      batch.push('[yellow]Killed by next run.[/]');
      batch.push('[dim]Press Enter to run again.[/]');
      appendDetailLines(batch, ctx.target.tabKey, ctx.target.groupName);
    } else {
      // Unrouted: identify what was killed (the next stream is a
      // different command, so "Killed by next run" reads oddly here).
      // Goes to viewerStreamBuffer (no tabKey on the dispatch).
      batch.push(`[yellow]Killed previous: ${esc(ctx.headerLabel || '<stream>')}.[/]`);
      appendDetailLines(batch);
    }
  }
  jobs.close(jobId, { status: 'killed' });
  if (ctx.record) ctx.record.kill();
  procs.delete(jobId);
  if (slotIndex.get(ctx.slotKey) === jobId) slotIndex.delete(ctx.slotKey);
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

  // Confirm-before-preempt for the unrouted slot — protects the live
  // viewer transcript from being wiped by an *unrelated* command. Same
  // label = silent restart (matches the routed same-slot behavior; the
  // user's gesture is "re-run this thing," not "kill something
  // different"). Different label = confirm overlay; default reject so
  // a stray cmd doesn't clobber a live transcript.
  if (slotKey === 'unrouted' && slotIndex.has('unrouted')) {
    const existingId = slotIndex.get('unrouted');
    const existing = procs.get(existingId);
    const existingLabel = (existing && existing.headerLabel) || '<previous>';
    if (existingLabel !== headerLabel) {
      // Phase 3d: thread targetKey + currentGroup so the tab_switch
      // arm stays pure of getModel(). idx=0 is always Info; targetKey
      // is the static 'info'. currentGroup read at dispatch time.
      api.dispatchMsg(api.wrap(target, {
        type: 'tab_switch', idx: 0,
        targetKey: 'info',
        currentGroup: require('../app/runtime').getModel().currentGroup,
      }));
      require('./dispatch').applyMsg({
        type: 'confirm_enter',
        message: `Kill running '${existingLabel}'?`,
        cmd: { type: 'unrouted_preempt_and_run', existingId, headerLabel, cmd, args, opts },
      });
      return;
    }
    // Same-label rerun → fall through to silent preempt below.
  }

  // Same-slot routed preempt — silent (same-slot re-runs are
  // intentional; user explicitly re-Entered on the action).
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
    flushTail, slotKey, decoder, headerLabel,
  };
  procs.set(jobId, ctx);
  slotIndex.set(slotKey, jobId);

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
      const batch = [`[red]Error: ${esc(err.message)}[/]`];
    rec.append(`Error: ${err.message}`);
    if (tabKey && groupName) batch.push('[dim]Press Enter to run again.[/]');
    appendDetailLines(batch, tabKey, groupName);
    rec.end('error');
    scheduleRender();
  });
}

module.exports = { streamCommand, killJob, killAll };
