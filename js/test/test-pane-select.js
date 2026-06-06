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

  it('hitTest returns null when overlay closed', () => {
    setup();
    eq(paneSelect.hitTest(20, 10), null);
  });

  it('hitTest resolves row idx at 80x24 with 3 items', () => {
    // Geometry at 80x24, 3 items, vh=12 → menuW=50, menuH=5,
    // offY=9, offX=15. Content rows y=10,11,12.
    const layout = route.getInstanceSlice('layout');
    layout.paneSelect = null;
    layout.tabListOwnerPaneId = null;
    layout.freeConfig = { drag: null, undo: [], redo: [], titleEdit: { text: '' }, notice: null, noticeKind: null };
    layout.arrange = {
      columns: [
        { width: 24, panels: [
          { type: 'groups',  id: 'groups',  paneId: 'pane-groups',  tabs: [{ id: 'groups',  poolId: 'groups'  }] },
          { type: 'actions', id: 'actions', paneId: 'pane-actions', tabs: [{ id: 'actions', poolId: 'actions' }] },
        ] },
        { panels: [
          { type: 'detail', id: 'detail', paneId: 'pane-detail', tabs: [{ id: 'detail', poolId: 'detail' }] },
        ] },
      ],
      pool: {
        'groups':  { id: 'groups',  type: 'groups',  title: 'Groups' },
        'actions': { id: 'actions', type: 'actions', title: 'Actions' },
        'detail':  { id: 'detail',  type: 'detail',  title: 'Detail' },
        'stats':   { id: 'stats',   type: 'stats',   title: 'Stats' },
      },
    };
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'pane-groups' }));
    // Force COLS/ROWS for deterministic geometry (test env may differ).
    const term = require('../io/term');
    const origCols = term.cols(), origRows = term.rows();
    // Monkey-patch by reassigning the module's exported fns is fragile;
    // we rely on stdout.columns/rows defaulting to 80x24 when undefined.
    // If the harness reports a real size, just verify the borders are inert.
    const g0 = paneSelect.hitTest(0, 0);
    eq(g0, null, 'outside overlay returns null');
    if (origCols === 80 && origRows === 24) {
      const hitRow0 = paneSelect.hitTest(20, 10);
      assert(hitRow0 && hitRow0.idx === 0 && hitRow0.item.id === 'groups', 'row 0 = groups');
      const hitRow1 = paneSelect.hitTest(20, 11);
      assert(hitRow1 && hitRow1.idx === 1, 'row 1 hit');
      eq(paneSelect.hitTest(20, 9),  null, 'top border inert');
      eq(paneSelect.hitTest(20, 13), null, 'bottom border inert');
    }
  });
});

describe('[5] paneSelectItems — pure list build', () => {
  const mpool = require('../leaves/pool');
  function buildArrange() {
    return {
      columns: [
        { width: 24, panels: [
          { type: 'groups', id: 'groups', paneId: 'pane-groups' },
          { type: 'actions', id: 'actions', paneId: 'pane-actions' },
        ] },
        { panels: [
          { type: 'detail', id: 'detail', paneId: 'pane-detail' },
        ] },
      ],
      pool: {
        'groups':  { id: 'groups',  type: 'groups',  title: 'Groups' },
        'actions': { id: 'actions', type: 'actions', title: 'Actions' },
        'detail':  { id: 'detail',  type: 'detail',  title: 'Detail' },
        'stats':   { id: 'stats',   type: 'stats',   title: 'Stats' },
      },
    };
  }
  it('target = pane-groups → groups tagged here, actions placed, stats hidden, detail excluded', () => {
    const arr = buildArrange();
    const list = mpool.paneSelectItems(arr, 'pane-groups');
    eq(list.length, 3);
    eq(list[0].id, 'groups');
    eq(list[0].status, 'here');
    eq(list[1].id, 'actions');
    eq(list[1].status, 'placed');
    eq(list[1].columnIndex, 0);
    eq(list[2].id, 'stats');
    eq(list[2].status, 'hidden');
    // detail must NOT appear (spec invariant)
    assert(!list.some(x => x.id === 'detail'), 'detail excluded from pane-select list');
  });
  it('hidden entry remains hidden no matter the target', () => {
    const arr = buildArrange();
    const list = mpool.paneSelectItems(arr, 'pane-actions');
    eq(list[0].status, 'placed', 'groups now elsewhere');
    eq(list[1].status, 'here',   'actions is current target');
    eq(list[2].status, 'hidden', 'stats still hidden');
  });
  it('empty arrange returns empty list', () => {
    eq(mpool.paneSelectItems({ columns: [], pool: {} }, 'pane-x').length, 0);
    eq(mpool.paneSelectItems(null, 'pane-x').length, 0);
  });
});

describe('[6] pane_select_nav cursor + scroll math', () => {
  it('dir +1 advances cursor; clamps at n-1', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'pane-groups' }));
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_nav', dir: +1, n: 3, vh: 8 }));
    eq(route.getInstanceSlice('layout').paneSelect.cursor, 1);
    // overshoot — clamps
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_nav', dir: +99, n: 3, vh: 8 }));
    eq(route.getInstanceSlice('layout').paneSelect.cursor, 2);
  });
  it('to=top resets cursor + scroll', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'pane-groups' }));
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_nav', dir: +2, n: 5, vh: 8 }));
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_nav', to: 'top', n: 5, vh: 8 }));
    eq(route.getInstanceSlice('layout').paneSelect.cursor, 0);
    eq(route.getInstanceSlice('layout').paneSelect.scroll, 0);
  });
  it('nav with n=0 is a no-op (returns same ref)', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'pane-groups' }));
    const before = route.getInstanceSlice('layout').paneSelect;
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_nav', dir: +1, n: 0, vh: 8 }));
    const after = route.getInstanceSlice('layout').paneSelect;
    eq(before, after, 'identity preserved');
  });
});

describe('[7] pool_swap_by_id — SWAP / REPLACE / invariants', () => {
  function setupRich() {
    const layout = route.getInstanceSlice('layout');
    layout.paneSelect = null;
    layout.tabListOwnerPaneId = null;
    layout.freeConfig = { drag: null, undo: [], redo: [], titleEdit: { text: '' }, notice: null, noticeKind: null };
    layout.arrange = {
      columns: [
        { width: 24, panels: [
          { type: 'groups',  id: 'groups',  paneId: 'pane-groups',  tabs: [{ id: 'groups',  poolId: 'groups'  }] },
          { type: 'stats',   id: 'stats',   paneId: 'pane-stats',   tabs: [{ id: 'stats',   poolId: 'stats'   }] },
        ] },
        { panels: [
          { type: 'detail',  id: 'detail',  paneId: 'pane-detail',  tabs: [{ id: 'detail',  poolId: 'detail'  }] },
          { type: 'actions', id: 'actions', paneId: 'pane-actions', tabs: [{ id: 'actions', poolId: 'actions' }] },
        ] },
      ],
      pool: {
        'groups':  { id: 'groups',  type: 'groups',  title: 'Groups' },
        'stats':   { id: 'stats',   type: 'stats',   title: 'Stats' },
        'detail':  { id: 'detail',  type: 'detail',  title: 'Detail' },
        'actions': { id: 'actions', type: 'actions', title: 'Actions' },
        'extra':   { id: 'extra',   type: 'extra',   title: 'Extra' },
      },
      detailHeightPct: 60,
    };
    getModel().modes.paneSelectMode = false;
  }
  function paneIdsByCol() {
    const arr = route.getInstanceSlice('layout').arrange;
    return arr.columns.map(c => (c.panels || []).map(p => p.id));
  }

  it('REPLACE — picked is hidden; target old occupant becomes hidden', () => {
    setupRich();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'pane-groups' }));
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'extra',
    }));
    eq(paneIdsByCol()[0][0], 'extra', 'extra now at pane-groups slot');
    assert(!paneIdsByCol()[0].includes('groups'), 'groups no longer placed');
    // Overlay closes via emitted Cmd.
    eq(getModel().modes.paneSelectMode, false);
  });

  it('SWAP — both placed; trade slots', () => {
    setupRich();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'pane-groups' }));
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'stats',
    }));
    // groups + stats swap within column 0 (paneIndex 0 ↔ 1).
    eq(paneIdsByCol()[0][0], 'stats');
    eq(paneIdsByCol()[0][1], 'groups');
  });

  it('GUARD — detail can\'t be picked anywhere (defensive)', () => {
    setupRich();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'pane-groups' }));
    const before = JSON.stringify(paneIdsByCol());
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'detail',
    }));
    eq(JSON.stringify(paneIdsByCol()), before, 'arrange unchanged');
    eq(getModel().modes.paneSelectMode, false, 'overlay still closes');
  });

  it('GUARD — actions can\'t end up in non-last column', () => {
    setupRich();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'pane-groups' }));
    const before = JSON.stringify(paneIdsByCol());
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'actions',
    }));
    eq(JSON.stringify(paneIdsByCol()), before, 'arrange unchanged (actions can\'t go to col 0)');
  });

  it('GUARD — actions slot can\'t be replaced', () => {
    setupRich();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'pane-actions' }));
    const before = JSON.stringify(paneIdsByCol());
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-actions', pickedId: 'extra',
    }));
    eq(JSON.stringify(paneIdsByCol()), before, 'arrange unchanged (actions is reserved)');
  });

  it('NO-OP — picked === target current occupant just closes', () => {
    setupRich();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'pane-groups' }));
    eq(getModel().modes.paneSelectMode, true, 'overlay open');
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'groups',
    }));
    eq(getModel().modes.paneSelectMode, false, 'overlay closed');
    eq(paneIdsByCol()[0][0], 'groups', 'arrange unchanged');
  });

  // Multi-tab pane fixtures — T1.1 + T1.2 regression coverage.
  // A multi-tab `pane-multi` carries [tab-a (active), tab-b] in col 0.
  function setupMultiTab() {
    const layout = route.getInstanceSlice('layout');
    layout.paneSelect = null;
    layout.tabListOwnerPaneId = null;
    layout.freeConfig = { drag: null, undo: [], redo: [], titleEdit: { text: '' }, notice: null, noticeKind: null };
    layout.arrange = {
      columns: [
        { width: 24, panels: [
          {
            type: 'tab-a', id: 'tab-a', paneId: 'pane-multi', columnIndex: 0,
            tabs: [{ id: 'tab-a', poolId: 'tab-a' }, { id: 'tab-b', poolId: 'tab-b' }],
            activeTabId: 'tab-a',
          },
          { type: 'stats', id: 'stats', paneId: 'pane-stats', columnIndex: 0,
            tabs: [{ id: 'stats', poolId: 'stats' }] },
        ] },
        { panels: [
          { type: 'detail', id: 'detail', paneId: 'pane-detail',
            tabs: [{ id: 'detail', poolId: 'detail' }] },
        ] },
      ],
      pool: {
        'tab-a':  { id: 'tab-a',  type: 'tab-a',  title: 'A' },
        'tab-b':  { id: 'tab-b',  type: 'tab-b',  title: 'B' },
        'stats':  { id: 'stats',  type: 'stats',  title: 'Stats' },
        'detail': { id: 'detail', type: 'detail', title: 'Detail' },
        'extra':  { id: 'extra',  type: 'extra',  title: 'Extra' },
      },
      detailHeightPct: 60,
    };
    getModel().modes.paneSelectMode = false;
  }

  it('T1.1 — SWAP preserves multi-tab pane (tabs[] / paneId / activeTabId)', () => {
    setupMultiTab();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_select_open', paneId: 'pane-stats' }));
    // Swap pane-stats with pane-multi (pickedId = 'tab-a', the active id).
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-stats', pickedId: 'tab-a',
    }));
    const arr = route.getInstanceSlice('layout').arrange;
    const movedToStatsSlot = arr.columns[0].panels[1];
    eq(movedToStatsSlot.id, 'tab-a', 'multi-tab pane now at stats slot');
    eq(movedToStatsSlot.paneId, 'pane-multi', 'custom paneId preserved');
    eq(Array.isArray(movedToStatsSlot.tabs) && movedToStatsSlot.tabs.length, 2, 'both tabs preserved');
    eq(movedToStatsSlot.tabs[0].poolId, 'tab-a');
    eq(movedToStatsSlot.tabs[1].poolId, 'tab-b');
    eq(movedToStatsSlot.activeTabId, 'tab-a');
    // Pool invariant: tab-b stays placed (one occurrence via tabs[]).
    const placed = require('../leaves/pool').placedIds(arr);
    eq(placed.filter(id => id === 'tab-b').length, 1, 'tab-b placed exactly once');
  });

  it('T1.2 — non-active multi-tab tabs excluded from paneSelectItems', () => {
    setupMultiTab();
    const list = require('../leaves/pool').paneSelectItems(
      route.getInstanceSlice('layout').arrange, 'pane-stats',
    );
    // tab-b is the non-active tab inside pane-multi. It must NOT
    // appear in the list — picking it would route through REPLACE
    // and double-place the id.
    assert(!list.some(x => x.id === 'tab-b'), 'tab-b absent from list');
    // tab-a is present (active tab, surfaces as the pane).
    assert(list.some(x => x.id === 'tab-a' && x.status === 'placed'), 'tab-a present as placed');
    // extra (genuinely hidden) is still listed.
    assert(list.some(x => x.id === 'extra' && x.status === 'hidden'), 'extra still hidden');
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
