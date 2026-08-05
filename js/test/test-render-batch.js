/**
 * Render-queue batch window (network-lag fix, 2026-08-05) — unit battery.
 *
 * paintNow inside a beginBatch/endBatch window defers: the call marks the
 * batch dirty and endBatch at depth 0 runs ONE trailing paint. Pins the
 * mechanics the input-burst smoke only covers indirectly: depth counting
 * (reemit re-entry nests), dirty preservation across inner endBatch, the
 * try/finally recovery pattern (a throw mid-batch must not wedge depth and
 * swallow every future paint), the stray-endBatch guard, and the
 * forceFullRepaint deferral (a force-full inside the window upgrades the
 * trailing paint to the full non-diff form — one frame serves both).
 *
 * Run: node js/test/test-render-batch.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const rq = require('../leaves/infra/render-queue');

let paints = 0;
let fulls = 0;
rq.setRenderers({
  render: () => { paints++; },
  forceFull: () => { fulls++; },
});
const reset = () => { paints = 0; fulls = 0; };

describe('batch window defers paintNow', () => {
  it('3 paintNow in a batch → 1 trailing paint', () => {
    reset();
    rq.beginBatch(); rq.paintNow(); rq.paintNow(); rq.paintNow(); rq.endBatch();
    eq(paints, 1);
  });
  it('a clean batch (no paintNow) paints nothing', () => {
    reset();
    rq.beginBatch(); rq.endBatch();
    eq(paints, 0);
  });
  it('paintNow outside a batch stays synchronous', () => {
    reset();
    rq.paintNow();
    eq(paints, 1);
  });
});

describe('nesting (reemit re-entry)', () => {
  it('inner endBatch neither paints nor clears the dirty flag', () => {
    reset();
    rq.beginBatch();            // depth 1
    rq.paintNow();              // dirty
    rq.beginBatch();            // depth 2
    rq.paintNow();
    rq.endBatch();              // depth 1 — must not paint
    eq(paints, 0, 'inner endBatch painted');
    rq.endBatch();              // depth 0 — the ONE trailing paint
    eq(paints, 1, 'dirty flag survived the inner endBatch');
  });
});

describe('recovery and guards', () => {
  it('the try/finally call-site pattern paints the dirty batch and restores depth', () => {
    reset();
    try {
      rq.beginBatch();
      try { rq.paintNow(); throw new Error('token dispatch threw'); }
      finally { rq.endBatch(); }
    } catch (_) { /* propagates like an uncaught handler error */ }
    eq(paints, 1, 'finally endBatch painted the dirty batch');
    rq.paintNow();
    eq(paints, 2, 'depth recovered — paintNow synchronous again');
  });
  it('a stray endBatch does not underflow the depth', () => {
    reset();
    rq.endBatch(); rq.endBatch();
    rq.beginBatch(); rq.paintNow(); rq.endBatch();
    eq(paints, 1);
  });
  it('dirty does not leak into the next batch', () => {
    reset();
    rq.beginBatch(); rq.endBatch();
    eq(paints, 0);
  });
});

describe('forceFullRepaint vs the window', () => {
  it('is an invalidation, not a paint — immediate outside a batch, no render', () => {
    reset();
    rq.forceFullRepaint();
    eq(fulls, 1);
    eq(paints, 0);
  });
  it('inside a batch it invalidates IMMEDIATELY; the one trailing paint repaints in full', () => {
    // paint.js registers forceFull as a diff-cache reset (prevRows=[]) —
    // it paints NOTHING itself. Deferring it in place of the trailing
    // paint swallowed the frame entirely (the stale-screen flicker after
    // a batched terminal-exit click, user-found 2026-08-05). Invalidate
    // now, paint once at endBatch.
    reset();
    rq.beginBatch();
    rq.forceFullRepaint();
    eq(fulls, 1, 'invalidation is not deferred');
    rq.paintNow();              // the paired render request in the same window
    eq(paints, 0, 'the PAINT defers');
    rq.endBatch();
    eq(paints, 1, 'ONE trailing paint (which sees the invalidated cache → full)');
    eq(fulls, 1, 'no second invalidation');
  });
});

report();
