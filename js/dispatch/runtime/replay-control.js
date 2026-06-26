/**
 * Interactive replay controller — the scrubber behind `:record-load`.
 *
 * A META-tool that drives reconstruction of the recorded session: enter loads a
 * WAL, snapshots the user's LIVE session aside, and reconstructs the recorded
 * model; the user then scrubs (checkpoint cursor), plays / pauses /
 * fast-forwards / reverses; exit restores the live session.
 *
 * It lives OUTSIDE the reconstructed model on purpose. Every seek is
 * `replay.replayTo(log, seq)` → `setModel(reconstructed)`, which REPLACES the
 * whole model — so the controller's state (loaded WAL, position, cursor,
 * playing, ratio, pane visibility) and even its active flag CANNOT live in the
 * model (restoreState would clobber them). It's module-held here; input
 * early-routes to it (`dispatch/control/dispatch.handleKey`) and render reads it
 * via an injected seam (`render/paint.setReplaySource`) — so the reconstructed
 * model stays pure and there's no render→dispatch import. The play timer is
 * controller-owned (a self-re-arming, `unref`'d `setTimeout`). This is a
 * documented deviation in the spirit of the foreign-component exception: the
 * replay *controller* is non-TEA because it drives the TEA model.
 *
 * Reverse = seek to the nearest checkpoint ≤ target and fold forward (`replayTo`
 * already does this; bounded by the bytes-primary checkpoint cadence ⇒ ms). True
 * O(1) step-inversion is impossible (reducers aren't invertible).
 *
 * Top level is require-free (lazy deps) so importers (dispatch.js) can't cycle.
 * v0.6.6 replay arc — docs/v0.6.6-replay.md.
 */
'use strict';

const FRAME_MS = 60;                 // play re-render cadence (~16fps)
const RATIOS = [1, 2, 4, 8, 16];     // fast-forward multipliers

let S = null;  // active session, or null when not replaying

const _replay = () => require('./replay');
const _sessionLog = () => require('../../io/session-log');
const _render = () => require('../../panel/api').scheduleRender();
const _diag = (m) => { try { require('../../io/diag-log').error('replay', m); } catch (_) {} };

function active()   { return S !== null; }
function paneOpen() { return !!(S && S.paneOpen); }

function _clampIdx(i) { return Math.max(0, Math.min((S.log.length - 1) | 0, i | 0)); }

// Last log index whose entry timestamp is ≤ t (binary search; t is monotonic
// non-decreasing — Date.now() at record time).
function _idxForT(t) {
  const log = S.log;
  let lo = 0, hi = log.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (log[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

// Reconstruct the model at log index `idx` (does NOT touch virtualT — play
// advances that itself; manual seeks snap it via _seekIdx).
function _applyIdx(idx) {
  S.idx = _clampIdx(idx);
  _replay().replayTo(S.log, S.log[S.idx].seq, { useCheckpoints: true });
  _syncCursorToIdx();
  _render();
}

// Manual seek: snap the playback clock to the entry, then reconstruct.
function _seekIdx(idx) {
  S.virtualT = S.log[_clampIdx(idx)].t;
  _applyIdx(idx);
}

// Highlight the checkpoint at or before the current position.
function _syncCursorToIdx() {
  const cps = S.checkpoints;
  if (!cps.length) { S.cursor = 0; return; }
  let c = 0;
  for (let i = 0; i < cps.length; i++) { if (cps[i].idx <= S.idx) c = i; else break; }
  S.cursor = c;
}

// --- lifecycle ----------------------------------------------------------

/** Enter interactive replay: snapshot the live session, load the WAL,
 *  reconstruct to the end, open the pane. Returns the path or null. */
function enter(file) {
  let log;
  try { log = _sessionLog().load(file); }
  catch (e) { _diag(`record-load: ${e.message}`); return null; }
  if (!log.length) { _diag(`record-load: empty session ${file}`); return null; }
  const checkpoints = [];
  for (let i = 0; i < log.length; i++) if (log[i].kind === 'checkpoint') checkpoints.push({ seq: log[i].seq, t: log[i].t, idx: i });
  S = {
    file, log, checkpoints,
    idx: log.length - 1,
    virtualT: log[log.length - 1].t,
    cursor: Math.max(0, checkpoints.length - 1),
    playing: null, ratio: 1, paneOpen: true,
    liveSnapshot: _replay().snapshotState(),
    timer: null,
  };
  // Reconstruct off the current dispatch tick (this runs inside the cmdline
  // effect; fold at depth-0 so finalizers land cleanly).
  setImmediate(() => { if (S && S.file === file) { _applyIdx(S.idx); } });
  _render();   // show the pane immediately (over the still-live frame)
  return file;
}

/** Exit replay: stop the timer, restore the live session, deactivate. */
function exit() {
  if (!S) return;
  _stopTimer();
  const snap = S.liveSnapshot;
  S = null;
  _replay().restoreState(snap);
  _render();
}

// --- navigation ---------------------------------------------------------

function seekToCheckpoint(i) {
  if (!S || !S.checkpoints.length) return;
  S.cursor = Math.max(0, Math.min(S.checkpoints.length - 1, i | 0));
  _seekIdx(S.checkpoints[S.cursor].idx);
}
function stepSeq(dir) { if (S) _seekIdx(S.idx + (dir | 0)); }

// --- playback -----------------------------------------------------------

function play(dir) {
  if (!S) return;
  if (S.playing === dir) { pause(); return; }   // same direction toggles off
  S.playing = dir;
  _startTimer();
  _render();
}
function pause() { if (!S) return; S.playing = null; _stopTimer(); _render(); }

function setRatio(d) {
  if (!S) return;
  let i = RATIOS.indexOf(S.ratio); if (i < 0) i = 0;
  S.ratio = RATIOS[Math.max(0, Math.min(RATIOS.length - 1, i + (d | 0)))];
  _render();
}

function _tick() {
  if (!S || !S.playing) return;
  const dir = S.playing === 'rev' ? -1 : 1;
  S.virtualT += FRAME_MS * S.ratio * dir;
  const idx = _idxForT(S.virtualT);
  if (dir > 0 && idx >= S.log.length - 1) { _applyIdx(S.log.length - 1); pause(); return; }
  if (dir < 0 && idx <= 0)                { _applyIdx(0); pause(); return; }
  _applyIdx(idx);
  _rearm();
}
function _startTimer() { _stopTimer(); _rearm(); }
function _rearm() {
  if (!S || !S.playing) return;
  S.timer = setTimeout(_tick, FRAME_MS);
  if (S.timer && S.timer.unref) S.timer.unref();
}
function _stopTimer() { if (S && S.timer) { clearTimeout(S.timer); S.timer = null; } }

function togglePane() { if (S) { S.paneOpen = !S.paneOpen; _render(); } }

// --- input --------------------------------------------------------------

function handleKey(key, seq) {
  if (!S) return;
  if (key === 'escape' || seq === 'q') { exit(); return; }
  if (seq === 'p') { togglePane(); return; }
  if (!S.paneOpen) return;   // pane hidden: only p (show) / q,esc (exit) act
  if (key === 'up'   || seq === 'k') { seekToCheckpoint(S.cursor - 1); return; }
  if (key === 'down' || seq === 'j') { seekToCheckpoint(S.cursor + 1); return; }
  if (seq === 'g') { seekToCheckpoint(0); return; }
  if (seq === 'G') { seekToCheckpoint(S.checkpoints.length - 1); return; }
  if (seq === ' ') { play('fwd'); return; }
  if (seq === 'b') { play('rev'); return; }
  if (seq === '+' || seq === '=') { setRatio(+1); return; }
  if (seq === '-' || seq === '_') { setRatio(-1); return; }
  if (seq === ']' || key === 'right') { pause(); stepSeq(+1); return; }
  if (seq === '[' || key === 'left')  { pause(); stepSeq(-1); return; }
}

// --- render data (read via the injected paint seam) ---------------------

function renderData() {
  if (!S) return null;
  return {
    paneOpen: S.paneOpen,
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
  };
}

module.exports = {
  active, paneOpen, enter, exit,
  seekToCheckpoint, stepSeq, play, pause, setRatio, togglePane,
  handleKey, renderData,
  // test seam
  _state: () => S,
};
