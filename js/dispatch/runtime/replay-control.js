/**
 * Interactive replay controller — the scrubber behind `:record-load`.
 *
 * A META-tool that drives reconstruction of the recorded session: enter loads a
 * WAL, snapshots the user's LIVE session aside, and reconstructs the recorded
 * model; the user then scrubs (checkpoint cursor), plays / pauses /
 * fast-forwards / reverses; exit restores the live session.
 *
 * It lives OUTSIDE the reconstructed model on purpose. Every reconstruction
 * (`replay.replayTo` / `advance` / `reverseTo`) REPLACES the whole model — so
 * the controller's state (loaded WAL, position, clock, playing, ratio, pane
 * visibility) and even its active flag CANNOT live in the model. It's
 * module-held here; input early-routes to it (`dispatch/control/dispatch`) and
 * render reads it via an injected seam (`render/paint.setReplaySource`) — so the
 * reconstructed model stays pure and there's no render→dispatch import. This is
 * a documented deviation in the spirit of the foreign-component exception: the
 * replay *controller* is non-TEA because it drives the TEA model.
 *
 * PLAYBACK ENGINE (v0.6.6 robust-playback arc — docs/v0.6.6-replay.md):
 *   - PRESENTATION CLOCK — playback position is a virtual clock ANCHORED to a
 *     real monotonic source (`performance.now()`): each frame the position is
 *     recomputed from elapsed real time (`anchorClock + dir*scale*(now-anchor)`),
 *     so it is drift-free and self-correcting (a slow/late frame never
 *     accumulates speed error). Speed lives ENTIRELY in the clock; the scheduler
 *     wakes at a steady cadence independent of it.
 *   - TIMELINE (`leaves/replay/timeline`, pure) — maps the clock to a WAL index.
 *     'realtime' runs over an effective-time axis with idle gaps capped (no
 *     freeze on dead air); 'even' runs over entry-index (fixed entries/sec).
 *   - FORWARD — `replay.advance` applies only the new entries (O(n) total, not
 *     the re-fold-from-checkpoint sawtooth). REVERSE — a bounded model base
 *     ladder per checkpoint interval + terminal anchored on checkpoint grids
 *     (`replay.reverseTo`) ⇒ flat per-frame cost.
 *
 * Top level is require-free (lazy deps) so importers (dispatch.js) can't cycle.
 */
'use strict';

const WAKE_MS = 33;                            // steady scheduler cadence (~30fps)
const RATIOS = [0.125, 0.25, 0.5, 1, 2, 4, 8, 16];  // speed multipliers (slow ⅛× … 16× fast)
const IDLE_CAPS = [250, 500, 1000, 2000, Infinity];  // realtime idle-gap caps (ms)
const REVERSE_BASES = 8;                        // model snapshots per checkpoint interval

// --- injectable clock/timer (test seam; production uses the real clock) -------
let _now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
let _setTimer = (fn, ms) => setTimeout(fn, ms);
let _clearTimer = (h) => clearTimeout(h);
/** Override the clock/timer for deterministic tests. Pass any subset. */
function _setClock(o = {}) {
  if (o.now) _now = o.now;
  if (o.setTimer) _setTimer = o.setTimer;
  if (o.clearTimer) _clearTimer = o.clearTimer;
}

let S = null;  // active session, or null when not replaying

const _replay = () => require('./replay');
const _sessionLog = () => require('../../io/session-log');
const _timeline = () => require('../../leaves/replay/timeline');
const _render = () => require('../../panel/api').scheduleRender();
const _diag = (m) => { try { require('../../io/diag-log').error('replay', m); } catch (_) {} };

function active() { return S !== null; }

// Pane visibility cycles full → mini → hidden. 'full' = status + checkpoint list
// + legend (checkpoint navigation); 'mini' = a compact bottom bar (seq / ts /
// progress only) so playback is watchable without the box covering the view;
// 'hidden' = nothing (only `p` to cycle back / `q`,esc to exit still act).
const PANE_CYCLE = { full: 'mini', mini: 'hidden', hidden: 'full' };

function _clampIdx(i) { return Math.max(0, Math.min((S.log.length - 1) | 0, i | 0)); }

// --- presentation clock -------------------------------------------------

// Clock units per real millisecond. realtime: effective-ms per ms (so ratio× is
// ratio× real speed). even: entries per ms (ratio × EVEN_RATE entries/sec).
function _clockScale() {
  return S.mode === 'even' ? (S.ratio * _timeline().EVEN_RATE / 1000) : S.ratio;
}

// The virtual clock NOW: anchored value + elapsed-real × scale (signed by dir).
// When paused, the clock holds its last value.
function _currentClock() {
  if (!S.playing) return S.clock;
  const dir = S.playing === 'rev' ? -1 : 1;
  return S.anchorClock + dir * _clockScale() * (_now() - S.anchorReal);
}

// Re-anchor at the current position WITHOUT changing it (call before mutating
// ratio/mode/idleCap mid-play, else elapsed-since-anchor is retroactively
// rescaled and the clock jumps).
function _reanchor() {
  S.clock = _currentClock();
  S.anchorClock = S.clock;
  S.anchorReal = _now();
}

// Snap the clock to a WAL index (manual seek) + re-anchor.
function _snapClockToIdx(idx) {
  S.clock = _timeline().clockForIdx(S.timeline, idx, S.mode);
  S.anchorClock = S.clock;
  S.anchorReal = _now();
}

// --- reconstruction -----------------------------------------------------

// Highlight the checkpoint at or before the current position.
function _syncCursorToIdx() {
  const cps = S.checkpoints;
  if (!cps.length) { S.cursor = 0; return; }
  let c = 0;
  for (let i = 0; i < cps.length; i++) { if (cps[i].idx <= S.idx) c = i; else break; }
  S.cursor = c;
}

// The checkpoint interval [lo, hi] containing `target` (lo = nearest checkpoint
// index ≤ target or 0; hi = next checkpoint index − 1 or n−1).
function _intervalFor(target) {
  let lo = 0, hi = S.log.length - 1, prev = -1, next = S.log.length;
  for (const cp of S.checkpoints) {
    if (cp.idx <= target) prev = cp.idx;
    else { next = cp.idx; break; }
  }
  if (prev >= 0) lo = prev;
  if (next < S.log.length) hi = next - 1;
  return { lo, hi };
}

// Build the reverse model base ladder for the interval containing `target`:
// fold the model from the interval start, snapshotting {model, slices} (NOT
// grids — they race the async feed) at REVERSE_BASES evenly-spaced indices.
function _buildLadder(target) {
  const { lo, hi } = _intervalFor(target);
  const r = _replay();
  r.replayTo(S.log, S.log[lo].seq, { useCheckpoints: true });  // model at lo
  const bases = [{ idx: lo, state: r.snapshotState() }];
  const step = Math.max(1, Math.ceil((hi - lo) / REVERSE_BASES));
  for (let i = lo; i < hi; ) {
    const next = Math.min(hi, i + step);
    r.foldMsgs(S.log, i, next);
    bases.push({ idx: next, state: r.snapshotState() });
    i = next;
  }
  S.reverseCache = { lo, hi, bases };
}

// Reconstruct frame `target` for reverse playback via the ladder.
function _reverseFrameTo(target) {
  if (!S.reverseCache || target < S.reverseCache.lo || target > S.reverseCache.hi) _buildLadder(target);
  const bases = S.reverseCache.bases;
  let base = bases[0];
  for (const b of bases) { if (b.idx <= target) base = b; else break; }
  _replay().reverseTo(S.log, target, base);
}

// Move the reconstructed frame to `target` during PLAY (forward → advance;
// backward → reverse ladder). Caller updates S.idx after.
function _playMoveTo(target) {
  if (target > S.idx) _replay().advance(S.log, S.idx, target);
  else if (target < S.idx) _reverseFrameTo(target);
}

// Manual jump (seek / step) to `target`: forward → advance, backward → replayTo
// (checkpoint restore). Snaps the clock so play resumes from here.
function _moveTo(target) {
  target = _clampIdx(target);
  if (target === S.idx) return;
  if (target > S.idx) _replay().advance(S.log, S.idx, target);
  else _replay().replayTo(S.log, S.log[target].seq, { useCheckpoints: true });
  S.idx = target;
  _snapClockToIdx(target);
  _syncCursorToIdx();
  _render();
}

// --- lifecycle ----------------------------------------------------------

/** Enter interactive replay: snapshot the live session, load the WAL,
 *  reconstruct to the end, open the pane. `opts.onExit` (optional) replaces the
 *  default exit behavior (restore the live session) — the `--record-load` boot
 *  passes a quit callback since there's no live session to return to. Returns
 *  the path or null. */
function enter(file, opts = {}) {
  let log;
  try { log = _sessionLog().load(file); }
  catch (e) { _diag(`record-load: ${e.message}`); return null; }
  if (!log.length) { _diag(`record-load: empty session ${file}`); return null; }
  const checkpoints = [];
  for (let i = 0; i < log.length; i++) if (log[i].kind === 'checkpoint') checkpoints.push({ seq: log[i].seq, t: log[i].t, idx: i });
  const tl = _timeline();
  const idleCap = tl.DEFAULT_IDLE_CAP;
  const timeline = tl.buildTimeline(log, { idleCap });
  const idx = log.length - 1;
  S = {
    file, log, checkpoints, timeline,
    idx,
    mode: 'realtime', idleCap,
    clock: tl.clockForIdx(timeline, idx, 'realtime'),
    anchorClock: 0, anchorReal: 0,
    cursor: Math.max(0, checkpoints.length - 1),
    playing: null, ratio: 1, paneView: 'full',
    liveSnapshot: _replay().snapshotState(),
    timer: null, reverseCache: null,
    onExit: typeof opts.onExit === 'function' ? opts.onExit : null,
  };
  S.anchorClock = S.clock; S.anchorReal = _now();
  // Reconstruct off the current dispatch tick (this runs inside the cmdline
  // effect; fold at depth-0 so finalizers land cleanly).
  setImmediate(() => {
    if (S && S.file === file) {
      _replay().replayTo(S.log, S.log[S.idx].seq, { useCheckpoints: true });
      _syncCursorToIdx();
      _render();
    }
  });
  _render();   // show the pane immediately (over the still-live frame)
  return file;
}

/** Exit replay: stop the timer, deactivate, then either run the onExit hook
 *  (boot-replay → quit) or restore the live session (`:record-load`). */
function exit() {
  if (!S) return;
  _stopTimer();
  const { onExit, liveSnapshot } = S;
  S = null;
  if (onExit) { onExit(); return; }
  _replay().restoreState(liveSnapshot);
  _render();
}

// --- navigation ---------------------------------------------------------

function seekToCheckpoint(i) {
  if (!S || !S.checkpoints.length) return;
  S.cursor = Math.max(0, Math.min(S.checkpoints.length - 1, i | 0));
  _moveTo(S.checkpoints[S.cursor].idx);
}
function stepSeq(dir) { if (S) _moveTo(S.idx + (dir | 0)); }
function seekToEnd(which) { if (S) _moveTo(which < 0 ? 0 : S.log.length - 1); }

// --- playback -----------------------------------------------------------

function play(dir) {
  if (!S) return;
  if (S.playing === dir) { pause(); return; }   // same direction toggles off
  S.playing = dir;
  if (dir === 'fwd') S.reverseCache = null;      // forward uses advance; free the ladder
  // Anchor from the DISPLAYED frame, not a stale clock — a previous play may
  // have overshot the range (clamped at an end), which would otherwise freeze
  // playback until the clock drifted back in.
  S.clock = _timeline().clockForIdx(S.timeline, S.idx, S.mode);
  S.anchorClock = S.clock; S.anchorReal = _now();
  _startTimer();
  _render();
}
function pause() { if (!S) return; S.clock = _currentClock(); S.playing = null; _stopTimer(); _render(); }

function setRatio(d) {
  if (!S) return;
  _reanchor();                                   // re-anchor at the OLD scale first
  let i = RATIOS.indexOf(S.ratio); if (i < 0) i = 0;
  S.ratio = RATIOS[Math.max(0, Math.min(RATIOS.length - 1, i + (d | 0)))];
  _render();
}

function toggleMode() {
  if (!S) return;
  S.mode = S.mode === 'realtime' ? 'even' : 'realtime';
  _snapClockToIdx(S.idx);                         // clock UNIT changes — re-derive from position
  _render();
}

function cycleIdleCap() {
  if (!S) return;
  const i = (IDLE_CAPS.indexOf(S.idleCap) + 1) % IDLE_CAPS.length;
  S.idleCap = IDLE_CAPS[i];
  S.timeline = _timeline().buildTimeline(S.log, { idleCap: S.idleCap });
  _snapClockToIdx(S.idx);                         // axis changed — keep position fixed
  _render();
}

function _tick() {
  if (!S || !S.playing) return;
  const dir = S.playing === 'rev' ? -1 : 1;
  S.clock = _currentClock();
  const target = _clampIdx(_timeline().idxForClock(S.timeline, S.clock, S.mode));
  if (target !== S.idx) {                         // else: no-op frame — render NOTHING
    _playMoveTo(target);
    S.idx = target;
    _syncCursorToIdx();
    _render();
  }
  if ((dir > 0 && S.idx >= S.log.length - 1) || (dir < 0 && S.idx <= 0)) { pause(); return; }
  _rearm();
}
function _startTimer() { _stopTimer(); _rearm(); }
function _rearm() {
  if (!S || !S.playing) return;
  S.timer = _setTimer(_tick, WAKE_MS);
  if (S.timer && S.timer.unref) S.timer.unref();
}
function _stopTimer() { if (S && S.timer) { _clearTimer(S.timer); S.timer = null; } }

function cyclePane() { if (S) { S.paneView = PANE_CYCLE[S.paneView] || 'full'; _render(); } }

// --- input --------------------------------------------------------------

function handleKey(key, seq) {
  if (!S) return;
  if (key === 'escape' || seq === 'q') { exit(); return; }
  if (seq === 'p') { cyclePane(); return; }
  if (S.paneView === 'hidden') return;   // hidden: only p (cycle back) / q,esc act
  // full AND mini both accept the full playback control surface; they differ
  // only in what the pane DRAWS (the checkpoint list vs the compact bar).
  if (key === 'up'   || seq === 'k') { seekToCheckpoint(S.cursor - 1); return; }
  if (key === 'down' || seq === 'j') { seekToCheckpoint(S.cursor + 1); return; }
  if (seq === 'g') { seekToEnd(-1); return; }
  if (seq === 'G') { seekToEnd(+1); return; }
  if (seq === ' ') { play('fwd'); return; }
  if (seq === 'b') { play('rev'); return; }
  if (seq === '+' || seq === '=') { setRatio(+1); return; }
  if (seq === '-' || seq === '_') { setRatio(-1); return; }
  if (seq === 'm') { toggleMode(); return; }
  if (seq === 'i') { cycleIdleCap(); return; }
  if (seq === ']' || key === 'right') { pause(); stepSeq(+1); return; }
  if (seq === '[' || key === 'left')  { pause(); stepSeq(-1); return; }
}

// --- render data (read via the injected paint seam) ---------------------

function renderData() {
  if (!S) return null;
  return {
    paneView: S.paneView,
    checkpoints: S.checkpoints,
    cursor: S.cursor,
    idx: S.idx,
    pos: S.log[S.idx].seq,
    total: S.log.length,
    t: S.log[S.idx].t,
    firstT: S.log[0].t,
    lastT: S.log[S.log.length - 1].t,
    playing: S.playing,
    ratio: S.ratio,
    mode: S.mode,
    idleCap: S.idleCap,
  };
}

module.exports = {
  active, enter, exit,
  seekToCheckpoint, stepSeq, seekToEnd, play, pause, setRatio,
  toggleMode, cycleIdleCap, cyclePane,
  handleKey, renderData,
  // test seams
  _state: () => S,
  _setClock,
  _tick,
};
