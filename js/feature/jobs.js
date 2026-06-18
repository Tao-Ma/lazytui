/**
 * v0.6.2 Phase 4 — live-jobs registry.
 *
 * Module-local Map mirroring the feature/history pattern (no slice,
 * no Msgs — same out-of-TEA store rationale; see docs/PRINCIPLES.md §12).
 * Producers (dispatch/runtime/stream.js, io/terminal.js, dispatch/runtime/action-runner.js)
 * call register / update / close at spawn lifecycle boundaries.
 * The Running overlay (Phase 4.2) reads list() at render time.
 *
 * Job kinds:
 *   stream-routed    type:run with action.tab set; writes to actionTabBuffers
 *   stream-unrouted  type:run w/o tab + docker logs/inspect verbs; writes to the unrouted Transcript accumulator
 *   pty              ensureSession in io/terminal (ephemeral terminals + docker shells)
 *   background       type:background — detached `sh -c` spawn, fire-and-forget
 *   tmux             type:spawn under $TMUX — detached `tmux new-window` spawn
 *
 * background + tmux entries don't auto-close in Phase 4.1; they stay
 * 'running' until lazytui restart. Phase 4.3+ adds pid liveness polling.
 */
'use strict';

const { scheduleRender } = require('../leaves/infra/render-queue');

const _jobs = new Map();   // id → JobInfo
let _seq = 0;

function _genId(startedAt) {
  _seq += 1;
  return `job-${startedAt}-${_seq}`;
}

/**
 * Register a new live job. Returns the generated jobId.
 *   kind:  one of the 5 strings above.
 *   label: human-readable string (action key, docker verb, cmd).
 *   pid:   number or null (tmux client exits immediately — pid stale).
 *   owner: arbitrary metadata for kind-specific jump behavior
 *          (tabKey/groupName for streams, ptyId for pty, etc.).
 */
function register({ kind, label, pid, owner }) {
  const startedAt = Date.now();
  const id = _genId(startedAt);
  _jobs.set(id, {
    id,
    kind,
    label: String(label || ''),
    startedAt,
    pid: pid == null ? null : (pid | 0),
    owner: owner || {},
    status: 'running',
    exitCode: null,
    endedAt: null,
  });
  scheduleRender();
  return id;
}

/** Shallow-merge a patch into a job. No-op if id is unknown. */
function update(id, patch) {
  const j = _jobs.get(id);
  if (!j || !patch) return;
  Object.assign(j, patch);
  scheduleRender();
}

/**
 * Mark a running job closed.
 *   status: 'exited' (default) | 'killed'
 *   exitCode: number | null
 * Idempotent — closing an already-closed (or unknown) job is a no-op.
 */
function close(id, { status = 'exited', exitCode = null } = {}) {
  const j = _jobs.get(id);
  if (!j || j.status !== 'running') return;
  j.status = status;
  j.exitCode = exitCode;
  j.endedAt = Date.now();
  scheduleRender();
}

/** All jobs, newest-first. */
function list() {
  return [..._jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Drop all completed (exited/killed) jobs; keep running. */
function clearCompleted() {
  for (const [id, j] of _jobs) {
    if (j.status !== 'running') _jobs.delete(id);
  }
  scheduleRender();
}

/** Test-only — wipe registry + reset seq counter. */
function _reset() {
  _jobs.clear();
  _seq = 0;
}

module.exports = { register, update, close, list, clearCompleted, _reset };
