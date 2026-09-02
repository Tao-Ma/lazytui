/**
 * metrics_synced WAL replay determinism — the `ts` capture timestamp (and the whole
 * windowed series) rides the recorded root-lane Msg, so folding the WAL reconstructs
 * `model.metrics[topic]` byte-for-byte, `ts` included. This is what makes the stats
 * time-axis (docs/STATS.md §10) reproducible on replay: the labels are a pure function
 * of `sample.ts`, and `ts` is recorded DATA (event-time-into-the-Msg), never a
 * render-side clock read. The mirror suppresses live sampling during replay, so no
 * divergent samples are injected. Locks the determinism the hard-review verified by
 * inspection. Mirrors test-fabric-replay.js's synthetic-WAL fold through the REAL path.
 *
 * Run: node js/test/test-metrics-replay.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { init, setModel, getModel } = require('../app/runtime');
const replay = require('../dispatch/runtime/replay');

const BASE = 1_700_000_000_000;
const STEP = 2000;
// A two-row topic, each row a short windowed series with a `ts` per sample.
const series = {
  n1: [{ cpu: 10, ts: BASE }, { cpu: 20, ts: BASE + STEP }, { cpu: 30, ts: BASE + 2 * STEP }],
  n2: [{ cpu: 5, ts: BASE }, { cpu: 6, ts: BASE + STEP }, { cpu: 7, ts: BASE + 2 * STEP }],
};
const schema = { columns: { cpu: { type: 'percent' } } };

function seed() {
  const m = init();
  m.metrics = {};
  setModel(m);
}

// The recorded session as WAL msg entries (lane:'root' — the metrics-mirror Sub
// applyMsg's `metrics_synced`, so this is exactly what the recorder captures).
const WAL = [
  { kind: 'msg', lane: 'root', msg: { type: 'metrics_synced', topic: 'r.cpu', series, schema } },
];

describe('[metrics-replay] metrics_synced (incl. ts) reconstructs verbatim from the WAL', () => {
  it('frame 0 (nothing recorded yet): topic absent', () => {
    seed();
    eq(getModel().metrics['r.cpu'], undefined, 'no metrics topic before the fold');
  });

  it('after the metrics_synced frame: series + ts are folded byte-identically', () => {
    seed();
    replay.replayEntries(WAL.slice(0, 1));   // real replay fold (effects suppressed)
    const got = getModel().metrics['r.cpu'];
    assert(got && got.series, 'topic reconstructed');
    eq(got.series.n1.length, 3, 'row n1 window length preserved');
    eq(got.series.n1[0].ts, BASE, 'oldest ts preserved');
    eq(got.series.n1[2].ts, BASE + 2 * STEP, 'newest ts preserved');
    eq(got.series.n1[2].cpu, 30, 'value preserved alongside ts');
    // The exact span the time-axis would label is reproduced from recorded data.
    eq(got.series.n1[2].ts - got.series.n1[0].ts, 2 * STEP, 'span (newest-oldest) is deterministic');
  });

  it('seeking BACK (re-fold a shorter prefix from base) drops the topic again', () => {
    seed();
    const base = replay.snapshotState();
    replay.replayEntries(WAL.slice(0, 1));
    assert(getModel().metrics['r.cpu'], 'present after the fold');
    replay.replayEntries(WAL.slice(0, 0), { fromState: base });   // reverse-seek to frame 0
    eq(getModel().metrics['r.cpu'], undefined, 'topic gone after seeking back before its frame');
  });
});

report();
