/**
 * Phase 3 — freeze gate on the dispatch layer.
 *
 * While `model.modes.freeConfigMode` is active, dispatchMsg drops:
 *   - broadcasts (refresh / hub / action) — components stop polling
 *   - wrapped Msgs to non-`layout` components
 *
 * The layout-wrap path stays open (it owns the mode itself: free_config_*,
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

describe('[gate exception] tab reorder passes for a MOUNTED viewer paneId', () => {
  // Split-arc P2.2 regression pin: the exception used to match
  // `msg.kind === 'detail'` literally, but the free-config tab-drag
  // emits the resolveTarget result — a mounted instance id
  // ('pane-detail') post-P2.1 — so live tab reorder was silently
  // dropped by the gate. The exception now matches isViewerKind.
  it('wrap(<viewer paneId>, viewer_reorder_content_tab) reaches the instance under the gate', () => {
    const route = require('../panel/route');
    const viewer = require('../panel/viewer/viewer');
    getModel().config = { groups: { g1: { actions: {}, terminals: {} } } };
    getModel().currentGroup = 'g1';
    // Real-boot shape: a per-pane viewer instance — the tab-drag Cmd
    // targets the resolveTarget result, which is a paneId, not the
    // 'detail' kind-keyed seed.
    route.setInstance('pane-frz-v', 'detail', {
      ...viewer._init('pane-frz-v'),
      contentTabs: { g1: {
        'file:a': { label: 'a', lines: [] },
        'file:b': { label: 'b', lines: [] },
      } },
    });
    setFreeConfig(true);
    api.dispatchMsg(api.wrap('pane-frz-v', {
      type: 'viewer_reorder_content_tab',
      groupName: 'g1', fromIdx: 0, toIdx: 1,
      currentGroup: 'g1', groupExists: true, yamlTerminals: {}, actionCount: 0,
    }));
    eq(Object.keys(route.getInstanceSlice('pane-frz-v').contentTabs.g1).join(','),
       'file:b,file:a',
       'reorder applied through the gate (pre-fix the paneId form was dropped)');
    setFreeConfig(false);
    route.disposeInstance('pane-frz-v');
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
