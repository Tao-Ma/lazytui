/**
 * Replay mode — the runtime flag + (Phase C) the replay driver.
 *
 * v0.6.6 replay arc. When replaying a recorded session, the dispatch loop
 * re-applies the recorded Msg stream through the SAME pure reducers, but the
 * two side-effecting tiers must be suppressed so nothing touches live external
 * state a second time:
 *
 *   - `dispatch/runtime/effects.runEffects` no-ops ENTIRELY (skip ALL effects).
 *     No effect writes model/slice state directly — each either re-dispatches a
 *     Msg (itself recorded) or does IO whose RESULT returns as a recorded Msg —
 *     so re-running any effect would double-apply a Msg already in the log.
 *   - `dispatch/runtime/finalize.finalizeDispatch` runs the per-pane instance
 *     reconcile ONLY (deterministic slice creation, regenerated from the
 *     recorded layout Msgs); it skips the scroll-clamp (its `set_scroll` Msgs
 *     are in the log), the subscription reconcile (live IO), and the PTY
 *     ensure/resize (live IO, the #D14 island).
 *
 * This module owns nothing but the boolean: it has NO upward requires, so the
 * effects/finalize tiers can import it without a load-time cycle. The replay
 * DRIVER (Phase C) lazy-requires the loop, mirroring `effects._effectHost`.
 *
 * See docs/v0.6.6-replay-readiness.md + the approved plan.
 */
'use strict';

let _replaying = false;

/** Is the runtime currently re-applying a recorded session? */
function isReplaying() { return _replaying; }

/** Enter/leave replay mode. The driver brackets a fold with set(true)/set(false). */
function setReplaying(on) { _replaying = !!on; }

// --- Checkpoint primitive (a resumable point) ----------------------------
//
// The whole replayable state is `{ model, slices }`. It is ALMOST plain JSON,
// but not quite — nav slices hold a `multiSel` Set (and possibly other
// structured-clonable types), so an in-process checkpoint clones with
// `structuredClone` (preserves Set/Map/Date) rather than a JSON round-trip
// (which would degrade a Set to `{}` and lose `.has`). FILE persistence
// (Phase D/E) handles those via a Set-aware codec — the on-disk Msg stream
// itself is plain JSON (the recorded Msgs carry no Sets). Phase D extends a
// checkpoint with per-terminal grid snapshots + WAL cursors; here it is the
// in-process reset mechanism that makes the fold proof clean. All deps are
// lazy-required so this module's TOP LEVEL stays require-free — effects/finalize
// import it, so a top-level upward require would cycle.

function _clone(o) { return o == null ? o : structuredClone(o); }

/** Snapshot the full replayable state: the root model + every Component slice. */
function snapshotState() {
  const route = require('../../panel/route');
  const { getModel } = require('../../model/store');
  const slices = {};
  route.eachInstance(inst => { slices[inst.id] = _clone(inst.slice); });
  return { model: _clone(getModel()), slices };
}

/** Restore a snapshot into the live stores. Mint-on-restore: the layout (service)
 *  slice is restored first so the instance reconcile can read the restored
 *  arrange, the per-pane instance set is then recreated to match, and finally
 *  every slice is written into the now-existing instances. This makes checkpoint
 *  restore work from a BARE registry (the --replay CLI), not only an
 *  already-booted app; minting is a no-op when the instances already exist (the
 *  in-process case). */
function restoreState(snap) {
  const route = require('../../panel/route');
  const finalize = require('./finalize');
  const { setModel } = require('../../model/store');
  const slices = snap.slices || {};
  setModel(_clone(snap.model));
  if (slices.layout !== undefined) route.setInstanceSlice('layout', _clone(slices.layout));
  finalize.reconcileInstancesNow();
  for (const id of Object.keys(slices)) route.setInstanceSlice(id, _clone(slices[id]));
}

// --- The fold driver -----------------------------------------------------
//
// Re-apply recorded WAL entries in seq order through the SAME loop entry points.
// Effects are suppressed (./replay flag → effects no-op + finalizer mint-only),
// and recording is disabled for the duration so the replayed stream is not
// re-recorded. `term` entries drive the off-model headless xterm side-channel.

// Apply one WAL entry through the live runtime. `msg` lanes go through the loop
// (effects suppressed by the replay flag); `term` events drive the headless
// xterm side-channel; `checkpoint` entries are the seek index, skipped here.
function _applyEntry(e) {
  const loop = require('./loop');
  const terminal = require('../../io/terminal');
  if (e.kind === 'msg') {
    if (e.lane === 'root') loop.applyMsg(e.msg);
    else if (e.lane === 'comp') loop.dispatchMsg(e.msg);
    else if (e.lane === 'key') loop.dispatchKeyToFocused(e.key, e.keySeq);
  } else if (e.kind === 'term') {
    if (e.ev === 'spawn') terminal.ensureReplaySession(e.id, e.cols, e.rows);
    else if (e.ev === 'out') terminal.feedReplay(e.id, e.d);
    else if (e.ev === 'resize') terminal.resizeSession(e.id, e.cols, e.rows);
    else if (e.ev === 'exit') terminal.markReplayExit(e.id, e.code);
  }
}

/** Linear fold of a WAL (Phase C). Optionally restore `fromState` first. */
function replayEntries(entries, opts = {}) {
  const sessionLog = require('../../io/session-log');
  if (opts.fromState) restoreState(opts.fromState);
  const wasEnabled = sessionLog.isEnabled();
  sessionLog.enable(false);
  setReplaying(true);
  try { for (const e of entries) _applyEntry(e); }
  finally { setReplaying(false); sessionLog.enable(wasEnabled); }
}

/** Record a checkpoint into the live WAL: the full {model, slices} state,
 *  Set-encoded to plain JSON. Its `seq` marks the resumable point. (Terminal
 *  grids: a checkpoint marks the seq; replayTo reconstructs post-checkpoint
 *  terminal output by folding forward. Pre-checkpoint terminal grid
 *  materialization is the pending dependency decision — see the arc memory.) */
function checkpointNow() {
  const sessionLog = require('../../io/session-log');
  const terminal = require('../../io/terminal');
  return sessionLog.recordCheckpoint({
    state: sessionLog.encodeJson(snapshotState()),
    grids: terminal.snapshotAllSessions(),   // materialized terminal text grids
  });
}

/**
 * Replay a WAL up to `targetSeq` (default: the whole log). Seeks to the latest
 * checkpoint at or before the target (the resume optimization), restores it,
 * then folds the remaining entries forward. `opts.useCheckpoints:false` forces
 * a full fold from the start (used to prove seek == full-fold); `opts.fromState`
 * seeds the start state when no checkpoint is used.
 */
function replayTo(log, targetSeq = Infinity, opts = {}) {
  const sessionLog = require('../../io/session-log');
  const useCp = opts.useCheckpoints !== false;
  let cpIdx = -1;
  for (let i = 0; i < log.length; i++) {
    if (log[i].seq > targetSeq) break;
    if (useCp && log[i].kind === 'checkpoint') cpIdx = i;
  }
  const wasEnabled = sessionLog.isEnabled();
  sessionLog.enable(false);
  setReplaying(true);
  try {
    let startIdx = 0;
    if (cpIdx >= 0) {
      const cp = log[cpIdx];
      restoreState(sessionLog.decodeJson(cp.state));
      // Materialized terminal grids: restore each into a PTY-less screen so the
      // region paints instantly without re-feeding from spawn (the WAL byte
      // stream remains the exact fallback). Forward-fold `out` entries append.
      if (cp.grids) {
        const terminal = require('../../io/terminal');
        for (const id of Object.keys(cp.grids)) terminal.restoreReplaySession(id, cp.grids[id]);
      }
      startIdx = cpIdx + 1;
    } else if (opts.fromState) {
      restoreState(opts.fromState);
    }
    for (let i = startIdx; i < log.length; i++) {
      if (log[i].seq > targetSeq) break;
      _applyEntry(log[i]);
    }
  } finally {
    setReplaying(false);
    sessionLog.enable(wasEnabled);
  }
}

module.exports = {
  isReplaying, setReplaying,
  snapshotState, restoreState, replayEntries,
  checkpointNow, replayTo,
};
