/**
 * v0.6.4 Theme F Phase 1 — intent-layer identity.
 *
 * The intent layer is meant to be a transparent seam: routing a keyboard
 * key through `intent.realize(intent.X())` must produce the SAME dispatch
 * the key produced before (a direct `handleAction(verb)` / `applyMsg`).
 * This test pins that mapping by spying on the realizer's delegate
 * targets — `actions.handleAction`, `dispatch.applyMsg`/`navSelect`, and
 * `api.dispatchMsg` — and asserting each intent fires exactly the expected
 * downstream call. If a future edit changes what an intent realizes, this
 * fails.
 *
 *   node js/test/test-intent.js
 */
'use strict';

const intent   = require('../dispatch/control/intent');
const actions  = require('../dispatch/control/actions');
const dispatch = require('../dispatch/control/dispatch');
const input    = require('../dispatch/control/input');
const api      = require('../panel/api');
const fanout   = require('../dispatch/runtime/loop');   // B/S6 — dispatchMsg relocated here
const { describe, it, eq, assert, report } = require('./test-runner');

// Swap a method on a module object for a recorder, run fn, restore. The
// intent layer reads `actions().handleAction` (property access at call
// time) through its memoized module ref, so patching the property here is
// seen even after the ref is memoized.
function spy(obj, name, fn) {
  const calls = [];
  const real = obj[name];
  obj[name] = (...args) => { calls.push(args); };
  try { fn(); } finally { obj[name] = real; }
  return calls;
}

describe('[Theme F P1] keyboard intents delegate to the prior verbs', () => {
  it('selectBy(±1) → nav_up / nav_down', () => {
    eq(spy(actions, 'handleAction', () => intent.realize(intent.selectBy(-1))),
       [['nav_up']], 'selectBy(-1) → nav_up');
    eq(spy(actions, 'handleAction', () => intent.realize(intent.selectBy(+1))),
       [['nav_down']], 'selectBy(+1) → nav_down');
  });

  it('focusDir(left/right) → focus_left / focus_right', () => {
    eq(spy(actions, 'handleAction', () => intent.realize(intent.focusDir('left'))),
       [['focus_left']], 'focusDir(left) → focus_left');
    eq(spy(actions, 'handleAction', () => intent.realize(intent.focusDir('right'))),
       [['focus_right']], 'focusDir(right) → focus_right');
  });

  it('focusHotkey(k) → focus_panel with the key arg', () => {
    eq(spy(actions, 'handleAction', () => intent.realize(intent.focusHotkey('3'))),
       [['focus_panel', '3']], 'focusHotkey(3) → focus_panel:3');
  });

  it('activate() → run_selected', () => {
    eq(spy(actions, 'handleAction', () => intent.realize(intent.activate())),
       [['run_selected']], 'activate → run_selected');
  });

  it('context() → menu_open with a built items list, null anchor (keyboard)', () => {
    const calls = spy(dispatch, 'applyMsg', () => intent.realize(intent.context()));
    eq(calls.length, 1, 'one applyMsg');
    const msg = calls[0][0];
    eq(msg.type, 'menu_open', 'menu_open');
    assert(Array.isArray(msg.items), 'items is an array');
    eq(msg.anchor, null, 'no anchor → centered (keyboard `x`)');
  });
});

describe('[Theme F P3] context anchor threads through to menu_open', () => {
  it('context({x,y}) → menu_open carrying the cursor anchor', () => {
    const calls = spy(dispatch, 'applyMsg', () => intent.realize(intent.context({ x: 12, y: 4 })));
    eq(calls.length, 1, 'one applyMsg');
    const msg = calls[0][0];
    eq(msg.type, 'menu_open', 'menu_open');
    eq(msg.anchor, { x: 12, y: 4 }, 'anchor threaded (right-click opens at cursor)');
  });
});

describe('[Theme F P2] mouse intents realize to the prior dispatch', () => {
  it('focusPane(id) → dispatchMsg(focus_set), skipInfo defaults false', () => {
    const calls = spy(fanout, 'dispatchMsg', () => intent.realize(intent.focusPane('pane-d2')));
    eq(calls.length, 1, 'one dispatchMsg');
    const s = JSON.stringify(calls[0][0]);  // wrap('layout', msg)
    assert(s.includes('focus_set'), 'wraps a focus_set');
    assert(s.includes('pane-d2'), 'targets pane-d2');
    assert(s.includes('"skipInfo":false'), 'skipInfo:false by default');
  });

  it('focusPane(id, {skipInfo:true}) carries the flag through', () => {
    const calls = spy(fanout, 'dispatchMsg', () => intent.realize(intent.focusPane('pane-d2', { skipInfo: true })));
    assert(JSON.stringify(calls[0][0]).includes('"skipInfo":true'), 'skipInfo:true threaded');
  });

  it('selectAt(id, idx) → navSelect(id, idx)', () => {
    const calls = spy(dispatch, 'navSelect', () => intent.realize(intent.selectAt('pane-d2', 7)));
    eq(calls, [['pane-d2', 7]], 'navSelect(pane-d2, 7)');
  });

  it('scrollAt(mx,my,delta) → _handleWheel passthrough, returns its result', () => {
    let ret;
    const calls = spy(input, '_handleWheel', () => { ret = intent.realize(intent.scrollAt(5, 9, +1)); });
    // spy() swaps in a recorder returning undefined; assert the delegate
    // call shape. A separate check pins the return-value passthrough.
    eq(calls, [[5, 9, 1]], '_handleWheel(5, 9, +1)');
    const real = input._handleWheel;
    input._handleWheel = () => true;
    assert(intent.realize(intent.scrollAt(0, 0, -1)) === true, 'returns _handleWheel result for paint gating');
    input._handleWheel = real;
  });
});

describe('[Theme F P1] realizer guards', () => {
  it('throws on an unknown intent kind', () => {
    let threw = false;
    try { intent.realize({ kind: 'nope' }); } catch (_) { threw = true; }
    assert(threw, 'unknown kind throws');
  });
});

report();
