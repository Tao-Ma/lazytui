/**
 * Replay playback timeline — the pure mapping between a real (wall-clock-driven)
 * playback clock and a recorded WAL index. v0.6.6 replay arc.
 *
 * The interactive replay player (dispatch/runtime/replay-control) drives a
 * monotonic *presentation clock* (performance.now() anchored at play start) and
 * needs, every frame, the WAL entry that clock has reached. This leaf is that
 * mapping — a pure function of the recorded entry timestamps, with two modes:
 *
 *   - 'realtime' — the clock runs over an EFFECTIVE-TIME axis: cumulative
 *     inter-entry deltas with each idle gap CAPPED at `idleCap` ms. This
 *     reproduces the recording's real pacing (bursts stay fast, normal
 *     interaction stays natural) while collapsing dead air so playback never
 *     freezes for seconds (cf. asciinema's idle_time_limit). The axis is built
 *     from `max(0, t[i]-t[i-1])`, so it is monotonic by construction even though
 *     the recorded `t` is Date.now() (wall time, which can step backward).
 *
 *   - 'even' — the clock IS the entry index: playback advances a fixed number of
 *     entries per second regardless of the recorded timestamps. Good for
 *     reviewing the logic of a session independent of how fast/slow it happened.
 *
 * Pure leaf: array in → number out. No requires, no state — the bottom tier.
 */
'use strict';

// 'even' mode base rate: entries advanced per real second at ratio 1×. The
// controller scales this by the playback ratio. Picked for a readable review
// pace (~20 entries/s) that the 30fps scheduler can step smoothly.
const EVEN_RATE = 20;

const DEFAULT_IDLE_CAP = 1000;

/**
 * Build the effective-time axis for a loaded WAL.
 * @param {Array<{t:number}>} log  WAL entries in seq order (each has `t`).
 * @param {{idleCap?:number}} [opts]  idle-gap cap in ms (Infinity = honor real gaps).
 * @returns {{n:number, effT:Float64Array, total:number, idleCap:number}}
 */
function buildTimeline(log, opts = {}) {
  const idleCap = opts.idleCap == null ? DEFAULT_IDLE_CAP : opts.idleCap;
  const n = log ? log.length : 0;
  const effT = new Float64Array(n > 0 ? n : 0);
  for (let i = 1; i < n; i++) {
    const d = log[i].t - log[i - 1].t;
    // clamp negatives (wall-clock glitch) → monotonic; cap idle gaps → no freeze.
    effT[i] = effT[i - 1] + Math.min(Math.max(0, d), idleCap);
  }
  return { n, effT, total: n > 0 ? effT[n - 1] : 0, idleCap };
}

function _clampIdx(timeline, i) {
  return Math.max(0, Math.min(timeline.n - 1, i | 0));
}

/**
 * The WAL index the playback clock has reached.
 * @param {object} timeline  from buildTimeline.
 * @param {number} clock  current clock value (effective-ms in realtime; entry index in even).
 * @param {'realtime'|'even'} mode
 * @returns {number} index in [0, n-1]
 */
function idxForClock(timeline, clock, mode) {
  if (timeline.n <= 1) return 0;
  if (mode === 'even') return _clampIdx(timeline, Math.floor(clock));
  // realtime: last i with effT[i] <= clock (binary search; effT is non-decreasing).
  const effT = timeline.effT;
  if (clock <= 0) return 0;
  if (clock >= effT[timeline.n - 1]) return timeline.n - 1;
  let lo = 0, hi = timeline.n - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (effT[mid] <= clock) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * The clock value at a WAL index — the inverse of idxForClock, for snapping the
 * clock when the user manually seeks (j/k/g/G/step).
 * @returns {number}
 */
function clockForIdx(timeline, idx, mode) {
  if (timeline.n <= 0) return 0;
  const i = _clampIdx(timeline, idx);
  return mode === 'even' ? i : timeline.effT[i];
}

module.exports = { buildTimeline, idxForClock, clockForIdx, EVEN_RATE, DEFAULT_IDLE_CAP };
