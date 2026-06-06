/**
 * Pane-select overlay D1 smoke test.
 *
 * Run: node js/test/test-pane-select.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const route = require('../leaves/route');
const api = require('../panel/api');

function setup() {
  // Reset layout slice + modes for each test (lazy isolation since
  // the test runner spawns a fresh Node per file).
  const layout = route.getInstanceSlice('layout');
  layout.paneSelect = null;
  layout.tabListOwnerPaneId = null;
  layout.freeConfig = { drag: null, undo: [], redo: [], titleEdit: { text: '' }, notice: null, noticeKind: null };
  layout.arrange = {
    columns: [
      { width: 24, panels: [{ type: 'groups', tabs: [{ id: 'groups', poolId: 'groups' }] }] },
      { panels: [{ type: 'detail', tabs: [{ id: 'detail', poolId: 'detail' }] }] },
    ],
    pool: {
      'groups': { type: 'groups' },
      'detail': { type: 'detail' },
    },
    detailHeightPct: 60,
  };
  const m = getModel();
  m.modes.paneSelectMode = false;
}

describe('[1] reducer arms', () => {
  it('pane_select_open writes targetPaneId + arms mode via Cmd', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'p-groups' }));
    const layout = route.getInstanceSlice('layout');
    eq(layout.paneSelect && layout.paneSelect.targetPaneId, 'p-groups');
    eq(getModel().modes.paneSelectMode, true, 'mode armed by Cmd');
  });

  it('pane_select_close clears target + Cmd disarms mode', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'p-groups' }));
    eq(getModel().modes.paneSelectMode, true);
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_close' }));
    const layout = route.getInstanceSlice('layout');
    eq(layout.paneSelect, null);
    eq(getModel().modes.paneSelectMode, false, 'mode disarmed by Cmd');
  });

  it('pane_select_open with no paneId is a no-op', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open' }));
    const layout = route.getInstanceSlice('layout');
    eq(layout.paneSelect, null);
    eq(getModel().modes.paneSelectMode, false);
  });
});

describe('[2] chromeFor — non-detail [≡] is pane-select trigger', () => {
  const { chromeFor } = require('../render/decor');
  it('non-detail singleton-tab pane gets pane-select [≡]', () => {
    const p = { type: 'groups', tabs: [{ id: 'groups' }] };
    eq(chromeFor(p, {}).tabTrigger, 'available');
  });
  it('open state surfaces when paneSelectTriggerState=open', () => {
    const p = { type: 'groups', tabs: [{ id: 'groups' }] };
    eq(chromeFor(p, { paneSelectTriggerState: 'open' }).tabTrigger, 'open');
  });
  it('disabled state surfaces when paneSelectTriggerState=disabled', () => {
    const p = { type: 'groups', tabs: [{ id: 'groups' }] };
    eq(chromeFor(p, { paneSelectTriggerState: 'disabled' }).tabTrigger, 'disabled');
  });
  it('detail still uses tabTriggerState + viewerTabCount path', () => {
    const detail = { type: 'detail' };
    // viewerTabCount<2 → no trigger even with paneSelectTriggerState
    // (detail's [≡] is tab-list, not pane-select).
    eq(chromeFor(detail, { viewerTabCount: 1, paneSelectTriggerState: 'available' }).tabTrigger, null);
    eq(chromeFor(detail, { viewerTabCount: 3, tabTriggerState: 'available' }).tabTrigger, 'available');
  });
});

describe('[3] hit-test', () => {
  const paneSelect = require('../overlay/pane-select');
  it('returns null when no layout/bounds yet', () => {
    setup();
    // No render has run, so boundsFor returns null. Hit-test bails.
    eq(paneSelect.hitTestTrigger(5, 0), null);
  });
});

describe('[4] modes registry has paneSelectMode', () => {
  const modes = require('../dispatch/modes');
  it('paneSelectMode is in CHAIN_MODES', () => {
    assert(modes.CHAIN_MODES.includes('paneSelectMode'));
  });
  it('paneSelectMode is an overlay mode (full-repaint on close)', () => {
    const s = { paneSelectMode: true };
    eq(modes.isOverlayActive(s), true);
  });
  it('paneSelectMode is NOT modal (footer not owned)', () => {
    const s = { paneSelectMode: true };
    eq(modes.isModal(s), false);
  });
});

report();
