/**
 * v0.6.6 replay arc — the pure playback-timeline leaf (leaves/replay/timeline).
 *
 * The mapping between the presentation clock and a WAL index: effective-time
 * with idle-gap compression (realtime mode) or entry-index (even mode).
 *
 * Run: node js/test/test-replay-timeline.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { buildTimeline, idxForClock, clockForIdx } = require('../leaves/replay/timeline');

// A WAL is just entries with a `t` for this leaf; kind/seq are irrelevant here.
const mk = (...ts) => ts.map((t, i) => ({ t, seq: i + 1, kind: 'msg' }));

describe('buildTimeline — effective-time axis', () => {
  it('accumulates raw deltas when under the cap', () => {
    const tl = buildTimeline(mk(1000, 1100, 1300, 1320), { idleCap: 1000 });
    eq(Array.from(tl.effT), [0, 100, 300, 320], 'effT = cumulative deltas');
    eq(tl.total, 320, 'total = last effT');
    eq(tl.n, 4, 'n');
  });

  it('caps an idle gap to idleCap', () => {
    // 60s gap between entry 1 and 2 → contributes exactly idleCap (1000), not 60000.
    const tl = buildTimeline(mk(0, 60000, 60100), { idleCap: 1000 });
    eq(Array.from(tl.effT), [0, 1000, 1100], 'idle gap compressed to cap');
  });

  it('Infinity cap honors real gaps', () => {
    const tl = buildTimeline(mk(0, 60000, 60100), { idleCap: Infinity });
    eq(Array.from(tl.effT), [0, 60000, 60100], 'no compression');
  });

  it('effT is monotonic even with a backward wall-clock glitch', () => {
    // entry 2 timestamps EARLIER than entry 1 (NTP step). delta clamped to 0.
    const tl = buildTimeline(mk(5000, 4000, 4200), { idleCap: 1000 });
    eq(Array.from(tl.effT), [0, 0, 200], 'negative delta clamped to 0');
    for (let i = 1; i < tl.n; i++) assert(tl.effT[i] >= tl.effT[i - 1], 'non-decreasing');
  });

  it('handles empty and singleton logs', () => {
    const e = buildTimeline([], {});
    eq(e.n, 0); eq(e.total, 0);
    eq(idxForClock(e, 123, 'realtime'), 0, 'empty → idx 0');
    const s = buildTimeline(mk(42), {});
    eq(s.n, 1); eq(s.total, 0);
    eq(idxForClock(s, 999, 'realtime'), 0, 'singleton → idx 0');
  });
});

describe('idxForClock — realtime mode', () => {
  const tl = buildTimeline(mk(0, 100, 300, 320), { idleCap: 1000 }); // effT [0,100,300,320]

  it('maps clock to the last entry at or before it', () => {
    eq(idxForClock(tl, 0, 'realtime'), 0);
    eq(idxForClock(tl, 50, 'realtime'), 0, 'midpoint maps to lower index');
    eq(idxForClock(tl, 100, 'realtime'), 1, 'exact boundary');
    eq(idxForClock(tl, 299, 'realtime'), 1);
    eq(idxForClock(tl, 300, 'realtime'), 2);
    eq(idxForClock(tl, 320, 'realtime'), 3);
  });

  it('clamps out-of-range clocks', () => {
    eq(idxForClock(tl, -50, 'realtime'), 0, 'before start');
    eq(idxForClock(tl, 99999, 'realtime'), 3, 'past end');
  });
});

describe('idxForClock / clockForIdx — even mode', () => {
  const tl = buildTimeline(mk(0, 100, 300, 320), { idleCap: 1000 });

  it('clock axis is the entry index', () => {
    eq(idxForClock(tl, 0, 'even'), 0);
    eq(idxForClock(tl, 1.9, 'even'), 1, 'floor');
    eq(idxForClock(tl, 3, 'even'), 3);
    eq(idxForClock(tl, 10, 'even'), 3, 'clamps at end');
  });
});

describe('clockForIdx — inverse of idxForClock', () => {
  const tl = buildTimeline(mk(0, 100, 300, 320), { idleCap: 1000 });

  it('round-trips at entry boundaries (realtime)', () => {
    for (let i = 0; i < tl.n; i++) {
      eq(idxForClock(tl, clockForIdx(tl, i, 'realtime'), 'realtime'), i, `idx ${i}`);
    }
  });

  it('round-trips (even)', () => {
    for (let i = 0; i < tl.n; i++) {
      eq(idxForClock(tl, clockForIdx(tl, i, 'even'), 'even'), i, `idx ${i}`);
    }
  });

  it('clamps the index argument', () => {
    eq(clockForIdx(tl, -5, 'realtime'), 0);
    eq(clockForIdx(tl, 99, 'realtime'), 320, 'clamped to last effT');
  });
});

report();
