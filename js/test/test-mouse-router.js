/**
 * Mouse router (dispatch/control/mouse-router) — docs/mouse-hit-map.md.
 *
 *   [1] realize: each handler form reaches the right dispatch seam
 *   [2] route: discrete-only, stale-frame abstain, hit → consumed
 *   [3] press→double continuation guard
 *   [4] a throwing handler is consumed + logged, never escapes
 *
 * The dispatch seams are spied by swapping the module exports the router
 * resolves lazily at call time (dispatch.handleKey / applyMsg, loop.dispatchMsg).
 *
 * Run: node js/test/test-mouse-router.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const hm = require('../panel/hit-map');
const router = require('../dispatch/control/mouse-router');
const dispatch = require('../dispatch/control/dispatch');
const loop = require('../dispatch/runtime/loop');

const R = (x, y, w, h) => ({ x, y, w, h });
const MODEL = { modes: {} };                    // chainStamp → ''
const CONFIRM = { modes: { confirmMode: true } };  // chainStamp → 'confirmMode'

function withSpies(fn) {
  const calls = [];
  const real = { handleKey: dispatch.handleKey, applyMsg: dispatch.applyMsg, dispatchMsg: loop.dispatchMsg };
  dispatch.handleKey = (k, s) => calls.push(['key', k, s]);
  dispatch.applyMsg = (m) => calls.push(['applyMsg', m]);
  loop.dispatchMsg = (m) => calls.push(['dispatchMsg', m]);
  try { fn(calls); } finally { Object.assign(dispatch, { handleKey: real.handleKey, applyMsg: real.applyMsg }); loop.dispatchMsg = real.dispatchMsg; }
  return calls;
}

describe('[1] realize', () => {
  it('{ key } → handleKey(key, seq ?? key)', () => {
    const calls = withSpies(() => { router.realize({ key: 'y' }); router.realize({ key: 'return', seq: '\r' }); });
    eq(calls, [['key', 'y', 'y'], ['key', 'return', '\r']]);
  });
  it('{ msg } → applyMsg; { msg, owner } → dispatchMsg(wrap(owner, msg))', () => {
    const calls = withSpies(() => {
      router.realize({ msg: { type: 'menu_activate', idx: 2 } });
      router.realize({ msg: { type: 'tree_toggle', id: 'n1' }, owner: 'pane-x' });
    });
    eq(calls[0], ['applyMsg', { type: 'menu_activate', idx: 2 }]);
    eq(calls[1][0], 'dispatchMsg');
    eq(calls[1][1], { kind: 'pane-x', msg: { type: 'tree_toggle', id: 'n1' } }, 'wrapped for the owner');
  });
  it('arrays realize in order; swallow / null do nothing', () => {
    const calls = withSpies(() => {
      router.realize([{ msg: { type: 'jobs_nav', to: 3 } }, { key: 'return' }]);
      router.realize('swallow');
      router.realize(null);
    });
    eq(calls, [['applyMsg', { type: 'jobs_nav', to: 3 }], ['key', 'return', 'return']]);
  });
});

describe('[2] route', () => {
  it('non-discrete gestures always fall through (motion/release stay legacy)', () => {
    router._reset();
    hm.clear('');
    hm.publish({ id: 'b', rect: R(0, 0, 10, 10), z: 1, opaque: true, on: {} });
    for (const k of ['motion', 'release', 'hover']) eq(router.route(k, 1, 1, MODEL), false, k);
  });
  it('a hit is realized and consumed', () => {
    router._reset();
    hm.clear('');
    hm.publish({ id: 'chip', rect: R(0, 0, 3, 1), z: 3, owner: 'confirm', on: { press: { key: 'y' } } });
    let r;
    const calls = withSpies(() => { r = router.route('press', 1, 0, MODEL); });
    eq(r, true);
    eq(calls, [['key', 'y', 'y']]);
  });
  it('a miss falls through', () => {
    router._reset();
    hm.clear('');
    eq(router.route('press', 5, 5, MODEL), false);
  });
  it('stale frame: the current modes differ from the stamp → abstain', () => {
    router._reset();
    hm.clear('');   // painted with NO modal…
    hm.publish({ id: 'pane', rect: R(0, 0, 10, 10), z: 1, owner: 'p', on: { press: { key: 'x' } } });
    let r;
    const calls = withSpies(() => { r = router.route('press', 1, 1, CONFIRM); });   // …but confirm is open now
    eq(r, false, 'legacy decides (its T13 gate swallows)');
    eq(calls, [], 'the stale pane region did not fire');
  });
  it('never painted (null stamp) → abstain', () => {
    router._reset();
    hm.clear(null);
    hm.publish({ id: 'x', rect: R(0, 0, 10, 10), z: 1, on: { press: 'swallow' } });
    eq(router.route('press', 1, 1, MODEL), false);
  });
});

describe('[3] press→double continuation', () => {
  it('the press owner gone at the cell → the double is swallowed', () => {
    router._reset();
    hm.clear('');
    hm.publish({ id: 'row', rect: R(0, 0, 10, 1), z: 1012, owner: 'menu', on: { press: { msg: { type: 'menu_activate', idx: 0 } } } });
    withSpies(() => router.route('press', 2, 0, MODEL));
    // The pick closed the menu; next frame has only the pane underneath.
    hm.clear('');
    hm.publish({ id: 'pane', rect: R(0, 0, 10, 10), z: 10, owner: 'pane-actions', on: { double: { intent: { kind: 'activate' } } } });
    let r;
    const calls = withSpies(() => { r = router.route('double', 2, 0, MODEL); });
    eq(r, true, 'consumed');
    eq(calls, [], 'the pane activate did NOT fire');
  });
  it('the double is swallowed even when the frame is stale (batched chunk)', () => {
    router._reset();
    hm.clear('confirmMode');
    hm.publish({ id: 'chip', rect: R(0, 0, 5, 1), z: 1013, owner: 'confirm', on: { press: { key: 'y' } } });
    withSpies(() => router.route('press', 1, 0, CONFIRM));
    // `y` closed confirm, but the batch deferred the repaint: stamp still 'confirmMode'.
    let r;
    const calls = withSpies(() => { r = router.route('double', 1, 0, MODEL); });
    eq(r, true, 'consumed, not handed to the legacy pane path');
    eq(calls, []);
  });
  it('the same owner still holds the cell → its double handler runs', () => {
    router._reset();
    hm.clear('');
    const on = { press: { msg: { type: 'jobs_nav', to: 1 } }, double: [{ msg: { type: 'jobs_nav', to: 1 } }, { key: 'return' }] };
    hm.publish({ id: 'row:1', rect: R(0, 3, 10, 1), z: 1062, owner: 'jobs', on });
    withSpies(() => router.route('press', 4, 3, MODEL));
    const calls = withSpies(() => router.route('double', 4, 3, MODEL));
    eq(calls, [['applyMsg', { type: 'jobs_nav', to: 1 }], ['key', 'return', 'return']]);
  });
  it('a double with no hit-map press before it takes the normal path', () => {
    router._reset();
    hm.clear('');
    eq(router.route('double', 1, 1, MODEL), false, 'falls through to legacy');
  });
});

describe('[4] throwing handler', () => {
  it('is consumed and does not escape', () => {
    router._reset();
    hm.clear('');
    hm.publish({ id: 'boom', rect: R(0, 0, 3, 1), z: 1, owner: 'x', on: { press: { key: 'y' } } });
    const realKey = dispatch.handleKey;
    const realErr = console.error;
    dispatch.handleKey = () => { throw new Error('kaboom'); };
    console.error = () => {};
    let r, threw = false;
    try { r = router.route('press', 0, 0, MODEL); } catch (_) { threw = true; } finally {
      dispatch.handleKey = realKey; console.error = realErr;
    }
    eq(threw, false);
    eq(r, true);
  });
});

report();
