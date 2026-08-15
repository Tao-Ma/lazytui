/**
 * Streamed shell-command output → detail panel.
 *
 * v0.6.2 R8 — moved from io/ to dispatch/. This module is primarily a
 * Msg-dispatcher facade (tv_stream_start / tv_append / tv_append_lines / tv_status
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
 * Slot semantics (U2c P1):
 *   Routed   (opts.slotKey — the action's stable per-action id) → one slot per
 *     action. Different slots run concurrently; same-slot replays preempt the
 *     previous run (re-Entering `make-check` kills its previous; running Test
 *     alongside Server log does NOT). opts.tabInstId is the DISPLAY target (the
 *     action's text-view instance), streamed the tv_* Cmds below.
 *   Unrouted (no slotKey) → slotKey = 'unrouted'. Singleton slot — a new
 *     docker-logs preempts the previous. Streams the tv_* Cmds into the
 *     Transcript text-view instance (U2e P1b; was the viewer's viewerStreamBuffer
 *     accumulator).
 *
 * Lifecycle Cmds dispatched at boundaries:
 *   routed   → tv_stream_start {header} / tv_append {line} / tv_append_lines {lines}
 *              / tv_status {line} (the permanent completion chip) to
 *              wrap(tabInstId) (the text-view instance)
 *   unrouted → tv_stream_start {header} / tv_append {line} / tv_append_lines
 *              {lines} / tv_status {line} to the Transcript text-view instance
 *              (resolveTarget('viewer_transcript'))
 *
 * No layout dependency — uses scheduleRender from render-queue. Lazy-
 * requires dispatch.applyMsg / panel/api to dodge the
 * stream → dispatch → actions → stream load cycle at module-load time.
 */
'use strict';

const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { esc } = require('../../leaves/text/ansi');
const astatus = require('../../leaves/text/action-status');
const { getModel } = require('../../model/store');
const { scheduleRender } = require('../../leaves/infra/render-queue');
const history = require('../../feature/history');
const jobs = require('../../feature/jobs');

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

// Async producer-side writes. Dispatch is lazy-required to dodge the
// stream→dispatch→actions cycle.
//   Routed (tabInstId set) → the action's text-view instance (U2c P1): tv_append /
//     tv_append_lines dispatched to wrap(tabInstId). The instance owns its own
//     scroll (bottom-stick lives in its update), so no per-line bundle is needed
//     — a simplification over the retired actionTabBuffers routing.
//   Unrouted (no tabInstId) → the Transcript text-view instance
//     (resolveTarget('viewer_transcript')) via tv_append / tv_append_lines
//     (U2e P1b; was viewer_append to the viewer's viewerStreamBuffer accumulator).
//
// appendDetailLine: single-line (the onData hot path — one Msg per line).
// appendDetailLines: bulk variant for producer-event footers (one atomic Msg).
function appendDetailLine(line, tabInstId) {
  const api = require('../../panel/api');
  if (tabInstId) {
    require('./loop').dispatchMsg(api.wrap(tabInstId, { type: 'tv_append', line }));
    return;
  }
  // U2e P1b — unrouted output goes to the Transcript, now a `text-view` instance
  // (hint:'transcript') of the content slot, via tv_* (was viewer_append to the
  // detail viewer's viewerStreamBuffer accumulator).
  const target = require('../../panel/route').resolveTarget('viewer_transcript');
  if (target == null) return;
  require('./loop').dispatchMsg(api.wrap(target, { type: 'tv_append', line }));
}

function appendDetailLines(lines, tabInstId) {
  if (!lines || lines.length === 0) return;
  const api = require('../../panel/api');
  if (tabInstId) {
    require('./loop').dispatchMsg(api.wrap(tabInstId, { type: 'tv_append_lines', lines }));
    return;
  }
  const target = require('../../panel/route').resolveTarget('viewer_transcript');
  if (target == null) return;
  require('./loop').dispatchMsg(api.wrap(target, { type: 'tv_append_lines', lines }));
}

// Append the permanent completion-status line (`tv_status`) — same routing as
// appendDetailLine, but the arm records the line as a right-aligned status row.
function appendStatusLine(line, tabInstId) {
  const api = require('../../panel/api');
  if (tabInstId) {
    require('./loop').dispatchMsg(api.wrap(tabInstId, { type: 'tv_status', line }));
    return;
  }
  const target = require('../../panel/route').resolveTarget('viewer_transcript');
  if (target == null) return;
  require('./loop').dispatchMsg(api.wrap(target, { type: 'tv_status', line }));
}

// The ONE job-termination status seam (pre-release review). The reverse-filled `✓/✗/⊗
// + dur + time` stamp was originally wired only into the normal `close` path, so a spawn
// `error` and a preempt (`killJob`) exit were left silently unmarked. Routing
// all three through here keeps them consistent — and a future exit point is one
// call, not a re-discovered gap. Returns true when a chip was appended, so the
// close path can fall back to its plain Done./Exit N footer when the chip is
// disabled; error/killJob keep their own detail footers regardless.
function emitStatusChip(outcome, tabInstId) {
  // statusLine emits SEMANTIC theme tokens, so the stored chip line tracks :theme
  // at paint (ansi._expandThemeKeys) — no palette read, no render-side re-derivation.
  const chip = astatus.statusLine(outcome, null, (getModel().config || {}).action_status);
  if (!chip) return false;
  appendStatusLine(chip, tabInstId);
  return true;
}

/** The one-line preempt notice for an unrouted job about to be killed by a
 *  DIFFERENT unrouted run — seeded as a `preamble` into the new stream's
 *  reseeded Transcript so the "what did I just kill" record SURVIVES the
 *  tv_stream_start reset (killJob's own footer/chip would be wiped by it). Read
 *  BEFORE killJob removes the job from `procs`. '' if it's already gone. */
function preemptNotice(jobId) {
  const ctx = procs.get(jobId);
  if (!ctx) return '';
  // Semantic [warning] (not a resolved color) so the stored preamble tracks :theme.
  return `[warning]⊗[/] [dim]killed previous: ${esc(ctx.headerLabel || '<stream>')}[/]`;
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
  // Close the history record first so the status chip below reads its stamped
  // endedAt (the duration/time segments).
  if (ctx.record) ctx.record.kill();
  if (!opts.silent) {
    // Semantic theme tokens ([warning]/[error]) — NOT resolved colors — so these
    // stored footers re-color on a :theme change (ansi._expandThemeKeys, paint).
    const batch = [];
    if (ctx.flushTail) {
      const tail = ctx.flushTail();
      if (tail) batch.push(esc(tail));
    }
    if (opts.userCancel) {
      // The user clicked the chip's ✗ cancel — not a preempt, so the "next run"
      // / "previous" wording reads wrong. One neutral footer, routed to the job's
      // own instance (routed) or the Transcript (unrouted).
      batch.push('[warning]Cancelled.[/]');
      appendDetailLines(batch, ctx.target ? ctx.target.tabInstId : undefined);
    } else if (ctx.target) {
      // Routed: re-run-on-same-slot footer → the action's text-view instance.
      batch.push('[warning]Killed by next run.[/]');
      appendDetailLines(batch, ctx.target.tabInstId);
    } else {
      // Unrouted: identify what was killed (the next stream is a
      // different command, so "Killed by next run" reads oddly here).
      // Goes to the Transcript text-view instance (no tabInstId on the dispatch).
      batch.push(`[warning]Killed previous: ${esc(ctx.headerLabel || '<stream>')}.[/]`);
      appendDetailLines(batch);
    }
    // Powerline stamp for the preempt outcome (pre-release review) — a killed job is a
    // ⊗; routes to the job's own instance (routed) or the Transcript (unrouted),
    // so all three termination seams (close/error/killJob) mark consistently.
    // Emitted after the footer text, before the routed re-run hint (mirrors the
    // close path's tail → chip → hint order).
    if (ctx.record) {
      emitStatusChip(
        // killJob SIGTERMs (above), so stamp the signal — the chip shows `⊗ SIGTERM`
        // rather than a bare `⊗` (matches a real signal death's `⊗ SIG`).
        { status: 'killed', signal: 'SIGTERM', startedAt: ctx.record.entry.startedAt, endedAt: ctx.record.entry.endedAt },
        ctx.target ? ctx.target.tabInstId : undefined,
      );
    }
    if (ctx.target) appendDetailLine('[dim]Press Enter to run again.[/]', ctx.target.tabInstId);
  }
  jobs.close(jobId, { status: 'killed' });
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
 * opts.tabInstId (+ opts.slotKey) route into a text-view instance (U2c P1 —
 * the action's minted position-tab); unset → the unrouted Transcript
 * accumulator (singleton unrouted slot — new unrouted preempts previous).
 */
function streamCommand(headerLabel, cmd, args = [], opts = {}) {
  const route = require('../../panel/route');
  const api = require('../../panel/api');
  // U2c P1 — routed action output targets a text-view instance by its tabInstId
  // (opts.tabInstId, the DISPLAY target set by action-runner.ensureActionTab when
  // the instance exists; null → the display falls back to the Transcript). The
  // concurrency/preempt slot is opts.slotKey (a distinct per-action id) — kept
  // separate from the display so distinct actions run concurrently even when no
  // display could be minted. Unrouted (tabless) → the singleton 'unrouted' slot.
  // opts.tabKey/groupName ride along for the jobs owner (overlay + running-glyph).
  const tabInstId = opts.tabInstId || null;
  // U2e P1b — only an UNROUTED stream needs a place to land (the Transcript
  // instance); a routed stream carries its own display target (or none) and runs
  // regardless. (Pre-P1b this guarded on any viewer-kind instance existing;
  // resolveTarget is content-slot-anchored now, so a bare model with no placed
  // content slot would otherwise drop every routed job.)
  if ((opts.slotKey || 'unrouted') === 'unrouted' && route.resolveTarget('viewer_transcript') == null) return;
  const slotKey = opts.slotKey || 'unrouted';
  const routed = slotKey !== 'unrouted';
  // Fabric run (docs/ports-and-wires.md): capture RAW stdout (un-esc'd, no
  // chrome) so output ports parse clean text, separate from the chrome/esc'd
  // display buffer. Flushed to model.fabric.output on close/error.
  const fab = opts.fabric || null;
  const rawLines = [];
  const flushFabric = () => {
    if (fab) require('../control/dispatch').applyMsg({
      type: 'fabric_output_set', group: fab.group, name: fab.name, lines: rawLines.slice(),
    });
  };

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
      // U2e P1b — the pre-confirm flat-strip switch-to-Info (tab_switch idx:0) is
      // retired: Transcript is its own position-tab instance now, not a flat tab of
      // the detail viewer, so there's no idx-0 Info tab to switch to here.
      require('../control/dispatch').applyMsg({
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

  // T32 — esc the dynamic header to prevent markup corruption from user-supplied
  // actionKey / verb strings. Routed → the action's text-view instance seeds its
  // buffer with the header (tv_stream_start also reseeds on re-run; the mint/
  // reuse already made the tab the visible one). Unrouted → the viewer's
  // Transcript accumulator (stream_start).
  const header = `[dim]$ ${esc(headerLabel)}[/]`;
  // C — an unrouted preempt threads a `preamble` (the "⊗ killed previous: X"
  // notice) so it survives the reseed ahead of this run's header; absent on
  // ordinary runs, so routed re-runs stay clean. Truthiness (not `!= null`):
  // preemptNotice() returns '' when the preempted job is already gone, and an
  // empty string must NOT seed a blank leading line above the header.
  // `append` (per-action `output: append`) makes the reducer keep prior runs and
  // add this one below, instead of reseeding.
  const startMsg = { type: 'tv_stream_start', header };
  if (opts.preamble) startMsg.preamble = opts.preamble;
  if (opts.append) startMsg.append = true;
  if (tabInstId) {
    require('./loop').dispatchMsg(api.wrap(tabInstId, startMsg));
  } else {
    // U2e P1b — unrouted header seeds the Transcript text-view instance (tv_stream_start),
    // not the detail viewer's stream_start accumulator.
    const transcript = route.resolveTarget('viewer_transcript');
    if (transcript) require('./loop').dispatchMsg(api.wrap(transcript, startMsg));
    // U2e P1b regression fix — restore the v0.6.7 unrouted auto-jump: make the
    // Transcript the content slot's active tab so the user SEES the new stream
    // (e.g. docker `Status`/`Logs`). The flat-strip `stream_start` reducer did
    // this via `tab: transcriptTabIdx`; the position-tab migration seeded the
    // header but dropped the switch. Routed runs get it free from the tab mint;
    // the always-present Transcript needs an explicit set_active_tab (idempotent
    // when already active — no churn if the user is already on Transcript).
    const tj = route.resolveTranscriptTab();
    if (tj) require('./loop').dispatchMsg(api.wrap('layout', {
      type: 'set_active_tab', paneId: tj.paneId, tabPoolId: tj.poolId,
    }));
  }
  scheduleRender();

  // Fabric no-shell path (docs/ports-and-wires.md): opts.argv is a fully-resolved
  // argv vector run via execve — spawn(prog, rest, {shell:false}) so a bound
  // value never touches a shell parser. Otherwise the legacy shell path: `-- `
  // delimiter so $0 = "--", $1 = first arg, $@ = arg list (POSIX).
  const proc = Array.isArray(opts.argv) && opts.argv.length
    ? spawn(opts.argv[0], opts.argv.slice(1), { cwd: getModel().projectDir, shell: false })
    : spawn('sh', ['-c', cmd, '--', ...args], { cwd: getModel().projectDir });
  const jobId = jobs.register({
    kind: routed ? 'stream-routed' : 'stream-unrouted',
    label: headerLabel,
    pid: proc.pid,
    // owner keeps tabKey/groupName (jobs overlay + the viewer strip running-glyph
    // read them) and the display tabInstId (the U2c-P1 routing target; may be null
    // for a routed run whose display couldn't be minted).
    owner: routed ? { tabKey: opts.tabKey, groupName: opts.groupName, tabInstId, cmd } : { cmd },
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
    target: routed ? { tabInstId } : null,
    flushTail, slotKey, decoder, headerLabel,
  };
  procs.set(jobId, ctx);
  slotIndex.set(slotKey, jobId);

  const onData = (data) => {
    buffer += decoder.write(data);
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      appendDetailLine(esc(line), tabInstId);
      rec.append(line);
      if (fab) rawLines.push(line);
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
    // Completion appends: the decoder tail (if any), then the status line (a
    // right-aligned `tv_status` row), then the routed re-run hint — separate
    // dispatches (the status row must be recorded distinctly for right-align).
    const tail = decoder.end();
    if (tail) buffer += tail;
    if (buffer) { appendDetailLine(esc(buffer), tabInstId); rec.append(buffer); if (fab) rawLines.push(buffer); buffer = ''; }
    if (signal) rec.end(`signal:${signal}`);
    else rec.end(code);
    // Completion status line — the reverse-filled ` ✓ 0  dur  time ` (` ✗ N ` /
    // ` ⊗ SIG `) stamp, appended as a right-aligned status row (docs/global-
    // config.md §action_status). It REPLACES the classic plain `Done.`/`Exit N`
    // footer; when the chip is disabled we fall back to that plain footer (the
    // only place the "Done."/"Exit N" words appear) so completion is never silent.
    const outcome = signal
      ? { status: 'killed', signal, startedAt: rec.entry.startedAt, endedAt: rec.entry.endedAt }
      : { status: 'exited', exitCode: (code == null ? null : (code | 0)), startedAt: rec.entry.startedAt, endedAt: rec.entry.endedAt };
    if (!emitStatusChip(outcome, tabInstId)) {
      // Chip disabled → the classic plain footer, so completion is never silent.
      const plain = signal ? `[warning]Killed (${signal})[/]`
        : code === 0 ? '[success]Done.[/]' : `[error]Exit ${code}[/]`;
      appendDetailLine(plain, tabInstId);
    }
    if (routed) appendDetailLine('[dim]Press Enter to run again.[/]', tabInstId);
    flushFabric();   // publish the producer's raw output for parsing
    scheduleRender();
  });

  proc.on('error', (err) => {
    if (!procs.has(jobId)) return;
    jobs.close(jobId, { status: 'killed' });
    procs.delete(jobId);
    if (slotIndex.get(slotKey) === jobId) slotIndex.delete(slotKey);
    rec.append(`Error: ${err.message}`);
    rec.end('error');   // stamp endedAt so the chip's duration/time resolve
    appendDetailLine(`[error]Error: ${esc(err.message)}[/]`, tabInstId);
    // Same powerline stamp as the normal close path (pre-release review) so a spawn
    // failure is marked like every other outcome. A spawn error carries no exit
    // code/signal → renders `✗ ?`; the Error: line above carries the detail.
    emitStatusChip(
      { status: 'exited', exitCode: null, startedAt: rec.entry.startedAt, endedAt: rec.entry.endedAt },
      tabInstId,
    );
    if (routed) appendDetailLine('[dim]Press Enter to run again.[/]', tabInstId);
    flushFabric();   // publish whatever raw output streamed before the error (may be empty)
    scheduleRender();
  });
}

module.exports = { streamCommand, killJob, killAll, preemptNotice };
