/**
 * Phase 3 — freeze gate on the dispatch layer.
 *
 * While `model.modes.freeConfigMode` is active, dispatchMsg drops:
 *   - broadcasts (refresh / hub / action) — components stop polling
 *   - wrapped Msgs to non-`layout` components
 *
 * The layout-wrap path stays open (it owns the mode itself: design_*,
 * pool_*, focus_set, view_*, set_arrange all flow). Mode-clear rides
 * an apply_msg Cmd through the root reducer, not dispatchMsg, so it
 * always reaches the modes table regardless of the gate.
 *
 *   node js/test/test-free-config-freeze.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const api = require('../panel/api');
const { getModel } = require('../app/runtime');

function makeRecorder(name) {
  return {
    name,
    init: () => ({ count: 0 }),
    update: (msg, slice) => ({ count: slice.count + 1 }),
  };
}

// Each describe builds its own components against the live registry —
// the previous suite (test-component.js) already proves the registry
// works, so we exercise dispatchMsg directly here.
api.registerComponent(makeRecorder('frz-A'));
api.registerComponent(makeRecorder('frz-B'));

function setFreeConfig(on) {
  // The model itself is mutable for tests (per test-design-drag.js).
  getModel().modes.freeConfigMode = !!on;
}

describe('[gate off] dispatch flows normally when free-config mode is off', () => {
  it('wrapped Msg reaches its target component', () => {
    setFreeConfig(false);
    const before = api.getInstanceSlice('frz-A').count;
    api.dispatchMsg(api.wrap('frz-A', { type: 'poke' }));
    eq(api.getInstanceSlice('frz-A').count, before + 1);
  });
  it('refresh broadcast fans out', () => {
    setFreeConfig(false);
    const beforeA = api.getInstanceSlice('frz-A').count;
    const beforeB = api.getInstanceSlice('frz-B').count;
    api.dispatchMsg({ type: 'refresh' });
    eq(api.getInstanceSlice('frz-A').count, beforeA + 1);
    eq(api.getInstanceSlice('frz-B').count, beforeB + 1);
  });
});

describe('[gate on] dispatchMsg drops non-layout traffic while free-config is active', () => {
  it('wrapped Msg to a non-layout component is dropped', () => {
    setFreeConfig(true);
    const before = api.getInstanceSlice('frz-A').count;
    api.dispatchMsg(api.wrap('frz-A', { type: 'poke' }));
    eq(api.getInstanceSlice('frz-A').count, before, 'slice untouched');
    setFreeConfig(false);
  });
  it('refresh broadcast is dropped — no component update fires', () => {
    setFreeConfig(true);
    const beforeA = api.getInstanceSlice('frz-A').count;
    const beforeB = api.getInstanceSlice('frz-B').count;
    api.dispatchMsg({ type: 'refresh' });
    eq(api.getInstanceSlice('frz-A').count, beforeA, 'A untouched');
    eq(api.getInstanceSlice('frz-B').count, beforeB, 'B untouched');
    setFreeConfig(false);
  });
  it('hub broadcast is dropped', () => {
    setFreeConfig(true);
    const before = api.getInstanceSlice('frz-A').count;
    api.dispatchMsg({ type: 'hub', topic: 't', rowKey: 'r', sample: 1 });
    eq(api.getInstanceSlice('frz-A').count, before);
    setFreeConfig(false);
  });
  it('layout-wrapped Msg still flows (mode-internal)', () => {
    // The layout Component must receive its own Msgs while in
    // free-config — that's how drag, hide, show, focus_set work.
    setFreeConfig(true);
    const layoutBefore = api.getInstanceSlice('layout');
    const focusBefore = layoutBefore.focus;
    api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: 'detail' }));
    eq(api.getInstanceSlice('layout').focus, 'detail',
       'layout slice updates: focus changed despite frozen mode');
    // Restore for downstream tests.
    api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: focusBefore }));
    setFreeConfig(false);
  });
});

report();
