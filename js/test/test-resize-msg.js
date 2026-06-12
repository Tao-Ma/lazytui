/**
 * test-resize-msg.js — resize-as-Msg (docs/resize-as-msg.md).
 *
 * P1: terminal dimensions are MODEL state. `layoutSlice.dims` is seeded
 * at boot (initState) and written only by the layout reducer's
 * `term_resized` arm; geometry reads the model's dims, never the live
 * terminal. Mutating process.stdout alone changes NOTHING until the
 * Msg lands — that's the contract (production's stdout 'resize'
 * listener always dispatches the Msg; tests use sm.resize()).
 *
 * P2 (added in that phase): the post-dispatch finalizer clamps nav
 * scroll at dispatch time — no render needed.
 *
 * Run: node js/test/test-resize-msg.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getInstanceSlice } = require('../panel/api');
const geo = require('../leaves/geometry');

function boot(cols, rows) {
  process.stdout.columns = cols;
  process.stdout.rows = rows;
  sm.bootFresh();
}

describe('[1] boot seeds layoutSlice.dims from the terminal', () => {
  it('initState lands the live size in the model', () => {
    boot(120, 35);
    const dims = getInstanceSlice('layout').dims;
    eq(dims.cols, 120, 'cols seeded');
    eq(dims.rows, 35, 'rows seeded');
  });
});

describe('[2] term_resized is the single writer', () => {
  it('the Msg updates dims; identity preserved on no-change', () => {
    boot(120, 35);
    const slice0 = getInstanceSlice('layout');
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'term_resized', cols: 90, rows: 28 }));
    const slice1 = getInstanceSlice('layout');
    eq(slice1.dims.cols, 90, 'cols updated');
    eq(slice1.dims.rows, 28, 'rows updated');
    assert(slice1 !== slice0, 'slice ref changed on a real resize');
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'term_resized', cols: 90, rows: 28 }));
    assert(getInstanceSlice('layout') === slice1, 'same-size Msg preserves the slice ref');
  });
  it('zero/garbage payload is rejected', () => {
    boot(120, 35);
    const before = getInstanceSlice('layout').dims;
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'term_resized', cols: 0, rows: 28 }));
    eq(getInstanceSlice('layout').dims, before, 'cols=0 dropped');
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'term_resized', cols: 90 }));
    eq(getInstanceSlice('layout').dims, before, 'missing rows dropped');
  });
});

describe('[3] geometry reads the model clock, not the terminal', () => {
  it('stdout mutation alone changes nothing; the Msg changes layout without a render', () => {
    boot(100, 40);
    const layoutSlice = getInstanceSlice('layout');
    const availBefore = geo.calcLayout(layoutSlice, layoutSlice.dims).availH;
    eq(availBefore, 39, 'layout reflects boot size');

    process.stdout.rows = 18;        // live terminal changed, no Msg
    const sliceAfterMutate = getInstanceSlice('layout');
    eq(sliceAfterMutate.dims.rows, 40, 'model dims untouched by a bare stdout mutation');

    sm.resize(100, 18);              // the production path: mutate + Msg
    const layoutSlice2 = getInstanceSlice('layout');
    eq(layoutSlice2.dims.rows, 18, 'Msg landed the new size');
    const availAfter = geo.calcLayout(layoutSlice2, layoutSlice2.dims).availH;
    eq(availAfter, 17, 'pure layout sees the new size with NO render in between');
  });
});

process.stdout.columns = 100;
process.stdout.rows = 40;
report();
