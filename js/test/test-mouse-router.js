/**
 * Mouse router (dispatch/control/mouse-router) — docs/mouse-hit-map.md.
 *
 *   [1] realize: each handler form reaches the right dispatch seam
 *   [2] route: discrete-only, stale-frame abstain, hit → consumed
 *   [3] press→double continuation guard
 *   [4] a throwing handler is consumed + logged, never escapes
 *   [5] one paint per click; each routed click is event-logged
 *
 * The dispatch seams are spied by swapping the module exports the router
 * resolves lazily at call time (dispatch.handleKey / applyMsg, loop.dispatchMsg).
 *
 * Run: node js/test/test-mouse-router.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const hm = require('../panel/hit-map');
const router = require('../dispatch/control/mouse-router');
const dispatch = require('../dispatch/control/dispatch');
const loop = require('../dispatch/runtime/loop');

const R = (x, y, w, h) => ({ x, y, w, h });
const MODEL = { modes: {} };
const CONFIRM = { modes: { confirmMode: true } };
// The frame stamp the router compares against (hit-map.stampOf) for a model.
const api = require('../panel/api');
const STAMP = (m) => hm.stampOf(m, api.getInstanceSlice('layout'));

function withSpies(fn) {
  const calls = [];
  const real = { handleKey: dispatch.handleKey, applyMsg: dispatch.applyMsg, dispatchMsg: loop.dispatchMsg };
  dispatch.handleKey = (k, s) => calls.push(['key', k, s]);
  dispatch.applyMsg = (m) => calls.push(['applyMsg', m]);
  loop.dispatchMsg = (m) => calls.push(['dispatchMsg', m]);
  try { fn(calls); } finally { Object.assign(dispatch, { handleKey: real.handleKey, applyMsg: real.applyMsg }); loop.dispatchMsg = real.dispatchMsg; }
  return calls;
}

describe('[1] realizeHandler', () => {
  it('{ key } → handleKey(key, seq) with the seq a REAL keystroke carries', () => {
    const calls = withSpies(() => {
      router.realizeHandler({ key: 'y' });
      router.realizeHandler({ key: '\t' });
      router.realizeHandler({ key: 'return', seq: '\r' });
    });
    eq(calls, [['key', 'y', 'y'], ['key', '\t', '\t'], ['key', 'return', '\r']]);
  });
  it('named keys carry NO seq (as input._dispatchToken sends them) — never their name as text', () => {
    const calls = withSpies(() => {
      for (const k of ['return', 'escape', 'backtab', 'up', 'down']) router.realizeHandler({ key: k });
    });
    eq(calls.map(c => c[2]), [undefined, undefined, undefined, undefined, undefined]);
  });
  it('{ msg } → applyMsg; { msg, owner } → dispatchMsg(wrap(owner, msg))', () => {
    const calls = withSpies(() => {
      router.realizeHandler({ msg: { type: 'menu_activate', idx: 2 } });
      router.realizeHandler({ msg: { type: 'tree_toggle', id: 'n1' }, owner: 'pane-x' });
    });
    eq(calls[0], ['applyMsg', { type: 'menu_activate', idx: 2 }]);
    eq(calls[1][0], 'dispatchMsg');
    eq(calls[1][1], { kind: 'pane-x', msg: { type: 'tree_toggle', id: 'n1' } }, 'wrapped for the owner');
  });
  it('arrays realize in order; swallow / null do nothing', () => {
    const calls = withSpies(() => {
      router.realizeHandler([{ msg: { type: 'jobs_nav', to: 3 } }, { key: 'return' }]);
      router.realizeHandler('swallow');
      router.realizeHandler(null);
    });
    eq(calls, [['applyMsg', { type: 'jobs_nav', to: 3 }], ['key', 'return', undefined]]);
  });
});

describe('[2] route', () => {
  it('non-discrete gestures fall through when no capture is held (motion/release → legacy arms)', () => {
    router._reset();
    hm.clear(STAMP(MODEL));
    hm.publish({ id: 'b', rect: R(0, 0, 10, 10), z: 1, opaque: true, on: {} });
    for (const k of ['motion', 'release', 'hover']) eq(router.route(k, 1, 1, MODEL), false, k);
  });
  it('a hit is realized and consumed', () => {
    router._reset();
    hm.clear(STAMP(MODEL));
    hm.publish({ id: 'chip', rect: R(0, 0, 3, 1), z: 3, owner: 'confirm', on: { press: { key: 'y' } } });
    let r;
    const calls = withSpies(() => { r = router.route('press', 1, 0, MODEL); });
    eq(r, true);
    eq(calls, [['key', 'y', 'y']]);
  });
  it('a miss falls through', () => {
    router._reset();
    hm.clear(STAMP(MODEL));
    eq(router.route('press', 5, 5, MODEL), false);
  });
  it('stale frame, the old frame drew something here → SWALLOWED, nothing fires', () => {
    router._reset();
    hm.clear(STAMP(CONFIRM));   // painted WITH confirm…
    hm.publish({ id: 'chip:y', rect: R(0, 0, 10, 10), z: 1013, owner: 'confirm', on: { press: { key: 'y' } } });
    let r;
    const calls = withSpies(() => { r = router.route('press', 1, 1, MODEL); });   // …closed since (batched `n`)
    eq(r, true, 'consumed — not handed to the pane the popup covered');
    eq(calls, [], 'the stale chip did not fire either');
  });
  it('stale frame, nothing drawn at the point → the legacy cascade decides', () => {
    router._reset();
    hm.clear(STAMP(CONFIRM));
    hm.publish({ id: 'box', rect: R(0, 0, 10, 10), z: 1011, owner: 'confirm', opaque: true, on: {} });
    eq(router.route('press', 30, 30, MODEL), false);
  });
  it('same modes but different popup STATE is stale too (modal identity)', () => {
    router._reset();
    const before = { modes: { menuOpen: true }, modal: { menu: { items: ['a'] } } };
    hm.clear(STAMP(before));
    hm.publish({ id: 'row:0', rect: R(0, 0, 10, 1), z: 1102, owner: 'menu', on: { press: { msg: { type: 'menu_activate', idx: 0 } } } });
    const after = { modes: { menuOpen: true }, modal: { menu: { items: ['submenu'] } } };   // replaced in place
    let r;
    const calls = withSpies(() => { r = router.route('press', 1, 0, after); });
    eq(r, true, 'swallowed');
    eq(calls, [], 'menu_activate idx 0 did NOT land on the replacement menu');
  });
  it('never painted (null stamp, empty map) → the legacy cascade decides', () => {
    router._reset();
    hm.clear(null);
    eq(router.route('press', 1, 1, MODEL), false);
  });
});

describe('[3] press→double continuation', () => {
  it('the press owner gone at the cell → the double is swallowed', () => {
    router._reset();
    hm.clear(STAMP(MODEL));
    hm.publish({ id: 'row', rect: R(0, 0, 10, 1), z: 1012, owner: 'menu', on: { press: { msg: { type: 'menu_activate', idx: 0 } } } });
    withSpies(() => router.route('press', 2, 0, MODEL));
    // The pick closed the menu; next frame has only the pane underneath.
    hm.clear(STAMP(MODEL));
    hm.publish({ id: 'pane', rect: R(0, 0, 10, 10), z: 10, owner: 'pane-actions', on: { double: { intent: { kind: 'activate' } } } });
    let r;
    const calls = withSpies(() => { r = router.route('double', 2, 0, MODEL); });
    eq(r, true, 'consumed');
    eq(calls, [], 'the pane activate did NOT fire');
  });
  it('the double is swallowed even when the frame is stale (batched chunk)', () => {
    router._reset();
    hm.clear(STAMP(CONFIRM));
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
    hm.clear(STAMP(MODEL));
    const on = { press: { msg: { type: 'jobs_nav', to: 1 } }, double: [{ msg: { type: 'jobs_nav', to: 1 } }, { key: 'return' }] };
    hm.publish({ id: 'row:1', rect: R(0, 3, 10, 1), z: 1062, owner: 'jobs', on });
    withSpies(() => router.route('press', 4, 3, MODEL));
    const calls = withSpies(() => router.route('double', 4, 3, MODEL));
    eq(calls, [['applyMsg', { type: 'jobs_nav', to: 1 }], ['key', 'return', undefined]]);
  });
  it('a REPEAT chip still under the pointer: the second click presses its key again', () => {
    router._reset();
    hm.clear(STAMP(MODEL));
    const chip = { id: 'chip:\t', rect: R(0, 9, 5, 1), z: 1213, owner: 'fabric-form', repeat: true, on: { press: { key: '\t' } } };
    hm.publish(chip);
    withSpies(() => router.route('press', 1, 9, MODEL));
    const calls = withSpies(() => router.route('double', 1, 9, MODEL));
    eq(calls, [['key', '\t', '\t']], 'Tab again — two fast clicks = two Tabs');
  });
  it('a DIFFERENT chip slid under the pointer: the second click is swallowed', () => {
    router._reset();
    hm.clear(STAMP(MODEL));
    hm.publish({ id: 'chip: ', rect: R(0, 9, 5, 1), z: 1213, owner: 'fabric-form', repeat: true, on: { press: { key: ' ' } } });
    withSpies(() => router.route('press', 1, 9, MODEL));
    hm.clear(STAMP(MODEL));   // the hint changed: [enter] pick now sits there
    hm.publish({ id: 'chip:return', rect: R(0, 9, 5, 1), z: 1213, owner: 'fabric-form', repeat: true, on: { press: { key: 'return' } } });
    const calls = withSpies(() => router.route('double', 1, 9, MODEL));
    eq(calls, [], 'no accidental pick');
  });
  it('a double with no hit-map press before it takes the normal path', () => {
    router._reset();
    hm.clear(STAMP(MODEL));
    eq(router.route('double', 1, 1, MODEL), false, 'falls through to legacy');
  });
});

describe('[4] throwing handler', () => {
  it('is consumed and does not escape', () => {
    router._reset();
    hm.clear(STAMP(MODEL));
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

describe('[5] paint + event-log', () => {
  const rq = require('../leaves/infra/render-queue');
  const eventLog = require('../io/event-log');
  function countPaints(fn) {
    let n = 0;
    rq.setRenderers({ render: () => { n++; } });
    try { fn(); } finally { rq.setRenderers({ render: null }); }
    return n;
  }
  it('a { msg } click paints once (the router paints)', () => {
    router._reset();
    hm.clear(STAMP(MODEL));
    hm.publish({ id: 'row:0', rect: R(0, 0, 5, 1), z: 1, owner: 'x', on: { press: { msg: { type: 'noop_test' } } } });
    const n = countPaints(() => withSpies(() => router.route('press', 1, 0, MODEL)));
    eq(n, 1);
  });
  it('a click ending in { key } does not add a second paint (handleKey paints itself)', () => {
    router._reset();
    hm.clear(STAMP(MODEL));
    hm.publish({ id: 'chip:y', rect: R(0, 0, 5, 1), z: 1, owner: 'x', on: { press: [{ msg: { type: 'noop_test' } }, { key: 'y' }] } });
    const n = countPaints(() => withSpies(() => router.route('press', 1, 0, MODEL)));
    eq(n, 0, 'the spied handleKey stands in for its own paint');
  });
  it('each routed click records { kind: mouse, gesture, owner, id }', () => {
    router._reset();
    eventLog.enable(true);
    eventLog.clear();
    hm.clear(STAMP(MODEL));
    hm.publish({ id: 'chip:n', rect: R(0, 0, 5, 1), z: 1, owner: 'confirm', on: { press: { key: 'n' } } });
    withSpies(() => router.route('press', 1, 0, MODEL));
    const e = eventLog.snapshot().filter(x => x.type === 'input' && x.payload && x.payload.kind === 'mouse');
    eq(e.map(x => x.payload), [{ kind: 'mouse', gesture: 'press', owner: 'confirm', id: 'chip:n' }]);
  });
});

describe('[6] pointer capture', () => {
  const capture = require('../dispatch/control/pointer-capture');
  const acts = require('../dispatch/control/mouse-acts');
  const rq = require('../leaves/infra/render-queue');
  const LOG = [];
  let n = 0;
  const ctl = (name, extra) => {
    try {
      capture.register(name, {
        start: (args, ev) => (args.decline ? null : (LOG.push(`${name}:start:${ev.mx},${ev.my}:${args.tag || ''}`), { tag: args.tag })),
        motion: (st, ev) => { LOG.push(`${name}:motion:${ev.mx},${ev.my}`); return true; },
        release: (st, ev) => { LOG.push(`${name}:release:${ev.mx},${ev.my}`); return true; },
        ...extra,
      });
    } catch (_) { /* registered by an earlier run in this process */ }
  };
  ctl('t-drag', { cancel: () => { LOG.push('t-drag:cancel'); return true; } });
  ctl('t-sticky', { pressWhileHeld: 'swallow' });
  ctl('t-throws', { motion: () => { throw new Error('boom'); } });
  try { acts.register('t-press-act', (h, ev) => { LOG.push(`act:${ev.mx},${ev.my}`); return h.drag ? { capture: 't-drag', tag: 'from-act' } : undefined; }); } catch (_) {}
  function fresh() {
    router._reset(); LOG.length = 0; n = 0;
    hm.clear(STAMP(MODEL));
    rq.setRenderers({ render: () => { n++; } });
  }
  const done = () => rq.setRenderers({ render: null });

  it('a { capture } press starts it; motion/release go to the holder wherever the pointer is; release ends it', () => {
    fresh();
    hm.publish({ id: 'body', rect: R(0, 0, 10, 10), z: 10, owner: 'pane:a', on: { press: { capture: 't-drag', tag: 'x' } } });
    hm.publish({ id: 'box', rect: R(20, 0, 10, 10), z: 1500, owner: 'menu', opaque: true, on: {} });
    eq(router.route('press', 2, 3, MODEL), true);
    eq(capture.held(), { name: 't-drag', owner: 'pane:a' }, 'held, owner recorded');
    eq(router.route('motion', 25, 4, MODEL), true, 'motion over a popup box stays with the drag');
    eq(router.route('release', 26, 5, MODEL), true);
    eq(capture.held(), null, 'release ended it');
    eq(router.route('motion', 3, 3, MODEL), false, 'after release: no capture → legacy');
    eq(LOG, ['t-drag:start:2,3:x', 't-drag:motion:25,4', 't-drag:release:26,5']);
    eq(n, 3, 'press + dirty motion + dirty release each paint');
    done();
  });
  it('a declining controller holds nothing', () => {
    fresh();
    hm.publish({ id: 'body', rect: R(0, 0, 10, 10), z: 10, owner: 'pane:a', on: { press: { capture: 't-drag', decline: true } } });
    eq(router.route('press', 2, 3, MODEL), true, 'the press itself is still consumed');
    eq(capture.held(), null);
    done();
  });
  it('an act gets the event point and may return a capture request; in an array with other handlers', () => {
    fresh();
    hm.publish({ id: 'body', rect: R(0, 0, 10, 10), z: 10, owner: 'pane:b',
      on: { press: [{ act: 't-press-act', drag: true }], right: { act: 't-press-act' } } });
    router.route('press', 4, 5, MODEL);
    eq(capture.held(), { name: 't-drag', owner: 'pane:b' });
    router.route('release', 4, 5, MODEL);
    router.route('right', 6, 7, MODEL);
    eq(capture.held(), null, 'an act returning nothing starts nothing');
    eq(LOG, ['act:4,5', 't-drag:start:4,5:from-act', 't-drag:release:4,5', 'act:6,7']);
    done();
  });
  it('lost release: a press while held drops the capture (cancel runs) and routes normally', () => {
    fresh();
    hm.publish({ id: 'body', rect: R(0, 0, 10, 10), z: 10, owner: 'pane:a', on: { press: { capture: 't-drag', tag: 'one' } } });
    router.route('press', 1, 1, MODEL);
    router.route('press', 2, 2, MODEL);
    eq(LOG, ['t-drag:start:1,1:one', 't-drag:cancel', 't-drag:start:2,2:one'], 'cancel, then the press starts a new drag');
    eq(capture.held(), { name: 't-drag', owner: 'pane:a' });
    done();
  });
  it('lost release: a swallow controller keeps the capture and eats the press', () => {
    fresh();
    hm.publish({ id: 'row', rect: R(0, 0, 10, 1), z: 1602, owner: 'panel-list', on: { press: { capture: 't-sticky' } } });
    hm.publish({ id: 'chip', rect: R(0, 5, 3, 1), z: 1603, owner: 'confirm', on: { press: { key: 'y' } } });
    router.route('press', 1, 0, MODEL);
    let r;
    const calls = withSpies(() => { r = router.route('press', 1, 5, MODEL); });
    eq(r, true); eq(calls, [], 'the chip under the press did not fire');
    eq(capture.held(), { name: 't-sticky', owner: 'panel-list' });
    done();
  });
  it('a throwing controller loses its capture; nothing escapes', () => {
    fresh();
    hm.publish({ id: 'body', rect: R(0, 0, 10, 10), z: 10, owner: 'pane:a', on: { press: { capture: 't-throws' } } });
    router.route('press', 1, 1, MODEL);
    const err = console.error; console.error = () => {};
    let threw = false;
    try { eq(router.route('motion', 2, 2, MODEL), true); } catch (_) { threw = true; } finally { console.error = err; }
    eq(threw, false);
    eq(capture.held(), null);
    done();
  });
  it('controller and act names are unique', () => {
    let a = false, b = false;
    try { capture.register('t-drag', { start: () => ({}) }); } catch (_) { a = true; }
    try { acts.register('border-control', () => {}); } catch (_) { b = true; }
    eq([a, b], [true, true]);
  });
});

report();
