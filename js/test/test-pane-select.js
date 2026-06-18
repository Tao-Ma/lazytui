/**
 * Pane-select overlay D1 smoke test.
 *
 * Run: node js/test/test-pane-select.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const route = require('../panel/route');
const api = require('../panel/api');

function setup() {
  // Reset layout slice + modes for each test (lazy isolation since
  // the test runner spawns a fresh Node per file).
  const layout = route.getInstanceSlice('layout');
  layout.paneMenu = { targetPaneId: null, cursor: 0, scroll: 0 };
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
  m.modes.paneMenuMode = false;
}

describe('[1] reducer arms', () => {
  it('pane_menu_open writes targetPaneId + arms mode via Cmd', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'p-groups' }));
    const layout = route.getInstanceSlice('layout');
    eq(layout.paneMenu && layout.paneMenu.targetPaneId, 'p-groups');
    eq(getModel().modes.paneMenuMode, true, 'mode armed by Cmd');
  });

  it('pane_menu_close clears target + Cmd disarms mode', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'p-groups' }));
    eq(getModel().modes.paneMenuMode, true);
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_close' }));
    const layout = route.getInstanceSlice('layout');
    eq(layout.paneMenu.targetPaneId, null);
    eq(getModel().modes.paneMenuMode, false, 'mode disarmed by Cmd');
  });

  it('pane_menu_open with no paneId is a no-op', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open' }));
    const layout = route.getInstanceSlice('layout');
    eq(layout.paneMenu.targetPaneId, null);
    eq(getModel().modes.paneMenuMode, false);
  });

  it('T3.2 — pane_menu_open is idempotent on same target (cursor/scroll preserved)', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-x' }));
    // Move cursor + scroll.
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_nav', dir: +3, n: 6, vh: 2 }));
    const before = route.getInstanceSlice('layout').paneMenu;
    eq(before.cursor, 3);
    eq(before.scroll, 2);
    // Re-open on the SAME paneId — must NOT reset cursor/scroll.
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-x' }));
    const after = route.getInstanceSlice('layout').paneMenu;
    eq(after.cursor, 3, 'cursor preserved on repeat open');
    eq(after.scroll, 2, 'scroll preserved on repeat open');
    eq(after, before, 'slice identity preserved (no-op)');
  });

  it('T3.1 — set_arrange clears paneMenuMode flag when paneSelect was non-null', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    eq(getModel().modes.paneMenuMode, true, 'mode armed');
    // Replace arrange — defensive close should fire mode_clear Cmd.
    api.dispatchMsg(api.wrap('layout', {
      type: 'set_arrange',
      arrange: {
        columns: [
          { width: 24, panels: [{ type: 'stats', tabs: [{ id: 'stats', poolId: 'stats' }] }] },
          { panels: [{ type: 'detail', tabs: [{ id: 'detail', poolId: 'detail' }] }] },
        ],
        pool: { 'stats': { type: 'stats' }, 'detail': { type: 'detail' } },
      },
    }));
    eq(route.getInstanceSlice('layout').paneMenu.targetPaneId, null, 'pane-menu target cleared');
    eq(getModel().modes.paneMenuMode, false, 'paneMenuMode cleared in lockstep');
  });
});

describe('[2] chromeFor — [≡] surfaces the unified pane-menu trigger state', () => {
  const { chromeFor } = require('../leaves/render/draw');
  it('default (no ctx) → available', () => {
    const p = { type: 'groups', tabs: [{ id: 'groups' }] };
    eq(chromeFor(p, {}).tabTrigger, 'available');
  });
  it('paneMenuTriggerState=hidden suppresses [≡] (nothing to show)', () => {
    const p = { type: 'groups', tabs: [{ id: 'groups' }] };
    eq(chromeFor(p, { paneMenuTriggerState: 'hidden' }).tabTrigger, null);
  });
  it('open / disabled states pass through', () => {
    const p = { type: 'groups', tabs: [{ id: 'groups' }] };
    eq(chromeFor(p, { paneMenuTriggerState: 'open' }).tabTrigger, 'open');
    eq(chromeFor(p, { paneMenuTriggerState: 'disabled' }).tabTrigger, 'disabled');
  });
  it('detail surfaces the same unified state (no special tab-count gate in chromeFor)', () => {
    const detail = { type: 'detail' };
    eq(chromeFor(detail, { paneMenuTriggerState: 'hidden' }).tabTrigger, null);
    eq(chromeFor(detail, { paneMenuTriggerState: 'available' }).tabTrigger, 'available');
  });
});

describe('[3] hit-test', () => {
  const paneSelect = require('../overlay/pane-menu');
  it('returns null when no layout/bounds yet', () => {
    setup();
    // No render has run, so boundsFor returns null. Hit-test bails.
    eq(paneSelect.hitTestTrigger(5, 0), null);
  });

  it('hitTest returns null when overlay closed', () => {
    setup();
    eq(paneSelect.hitTest(20, 10), null);
  });

  it('hitTest resolves row idx for anchored dropdown', () => {
    // Anchored dropdown drops down from the target pane's top row
    // (paneB.y + 1). Width clamps to pane.w (or MAX_W=50). Borders
    // at y=top and y=top+h-1 are inert; content rows at y=top+1..top+h-2.
    const layout = route.getInstanceSlice('layout');
    layout.paneMenu = { targetPaneId: null, cursor: 0, scroll: 0 };
    layout.freeConfig = { drag: null, undo: [], redo: [], titleEdit: { text: '' }, notice: null, noticeKind: null };
    layout.arrange = {
      columns: [
        { width: 32, panels: [
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
    // Seed paneBounds (renders skipped in tests).
    layout.paneBounds = {
      'pane-groups':  { x: 0, y: 0, w: 32, h: 12 },
      'pane-actions': { x: 0, y: 12, w: 32, h: 12 },
      'pane-detail':  { x: 32, y: 0, w: 48, h: 24 },
    };
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    // Dropdown anchors at pane-groups (x=0, y=0) — drops down to y=1.
    // 3 items (groups[here] + actions[placed] + stats[hidden]),
    // viewport caps innerH=3. Geometry: x=0, y=1, w=32, innerH=3, h=5.
    // Content rows: y=2,3,4. Borders at y=1 and y=5 inert.
    eq(paneSelect.hitTest(-1, 2), null, 'left of dropdown returns null');
    eq(paneSelect.hitTest(40, 2), null, 'right of dropdown returns null');
    eq(paneSelect.hitTest(5, 1),  null, 'top border inert');
    eq(paneSelect.hitTest(5, 5),  null, 'bottom border inert');
    const row0 = paneSelect.hitTest(5, 2);
    assert(row0 && row0.idx === 0 && row0.item.id === 'groups', 'row 0 = groups');
    const row1 = paneSelect.hitTest(5, 3);
    assert(row1 && row1.idx === 1, 'row 1 hit');
    const row2 = paneSelect.hitTest(5, 4);
    assert(row2 && row2.idx === 2, 'row 2 hit');
    eq(paneSelect.hitTest(5, 6),  null, 'past last row returns null');
  });
});

describe('[5] paneSelectItems — pure list build', () => {
  const mpool = require('../leaves/wm/pool');
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

  it('lone non-detail pane + no hidden = items.length === 1 (only `here`)', () => {
    // Drives the "hide [≡] when nothing to swap" rule: trigger paints
    // only when items.length >= 2 (current + at least one swap target).
    const arr = {
      columns: [
        { width: 24, panels: [
          { type: 'groups', id: 'groups', paneId: 'pane-groups' },
        ] },
        { panels: [{ type: 'detail', id: 'detail', paneId: 'pane-detail' }] },
      ],
      pool: {
        'groups': { id: 'groups', type: 'groups' },
        'detail': { id: 'detail', type: 'detail' },
      },
    };
    eq(mpool.paneSelectItems(arr, 'pane-groups').length, 1, 'only `here`');
  });

  it('one placed + one hidden = items.length === 2 (here + hidden swap target)', () => {
    const arr = {
      columns: [
        { width: 24, panels: [
          { type: 'groups', id: 'groups', paneId: 'pane-groups' },
        ] },
        { panels: [{ type: 'detail', id: 'detail', paneId: 'pane-detail' }] },
      ],
      pool: {
        'groups': { id: 'groups', type: 'groups' },
        'detail': { id: 'detail', type: 'detail' },
        'extra':  { id: 'extra',  type: 'extra'  },
      },
    };
    eq(mpool.paneSelectItems(arr, 'pane-groups').length, 2);
  });
});

describe('[6] pane_menu_nav cursor + scroll math', () => {
  it('dir +1 advances cursor; clamps at n-1', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_nav', dir: +1, n: 3, vh: 8 }));
    eq(route.getInstanceSlice('layout').paneMenu.cursor, 1);
    // overshoot — clamps
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_nav', dir: +99, n: 3, vh: 8 }));
    eq(route.getInstanceSlice('layout').paneMenu.cursor, 2);
  });
  it('to=top resets cursor + scroll', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_nav', dir: +2, n: 5, vh: 8 }));
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_nav', to: 'top', n: 5, vh: 8 }));
    eq(route.getInstanceSlice('layout').paneMenu.cursor, 0);
    eq(route.getInstanceSlice('layout').paneMenu.scroll, 0);
  });
  it('nav with n=0 is a no-op (returns same ref)', () => {
    setup();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    const before = route.getInstanceSlice('layout').paneMenu;
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_nav', dir: +1, n: 0, vh: 8 }));
    const after = route.getInstanceSlice('layout').paneMenu;
    eq(before, after, 'identity preserved');
  });
});

describe('[7] pool_swap_by_id — SWAP / REPLACE / invariants', () => {
  function setupRich() {
    const layout = route.getInstanceSlice('layout');
    layout.paneMenu = { targetPaneId: null, cursor: 0, scroll: 0 };
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
    getModel().modes.paneMenuMode = false;
  }
  function paneIdsByCol() {
    const arr = route.getInstanceSlice('layout').arrange;
    return arr.columns.map(c => (c.panels || []).map(p => p.id));
  }

  it('REPLACE — picked is hidden; target old occupant becomes hidden', () => {
    setupRich();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'extra',
    }));
    eq(paneIdsByCol()[0][0], 'extra', 'extra now at pane-groups slot');
    assert(!paneIdsByCol()[0].includes('groups'), 'groups no longer placed');
    // Overlay closes via emitted Cmd.
    eq(getModel().modes.paneMenuMode, false);
  });

  it('SWAP — both placed; trade slots', () => {
    setupRich();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'stats',
    }));
    // groups + stats swap within column 0 (paneIndex 0 ↔ 1).
    eq(paneIdsByCol()[0][0], 'stats');
    eq(paneIdsByCol()[0][1], 'groups');
  });

  it('GUARD — detail can\'t be picked anywhere (defensive)', () => {
    setupRich();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    const before = JSON.stringify(paneIdsByCol());
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'detail',
    }));
    eq(JSON.stringify(paneIdsByCol()), before, 'arrange unchanged');
    eq(getModel().modes.paneMenuMode, false, 'overlay still closes');
  });

  it('GUARD — actions can\'t end up in non-last column', () => {
    setupRich();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    const before = JSON.stringify(paneIdsByCol());
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'actions',
    }));
    eq(JSON.stringify(paneIdsByCol()), before, 'arrange unchanged (actions can\'t go to col 0)');
  });

  it('GUARD — actions slot can\'t be replaced', () => {
    setupRich();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-actions' }));
    const before = JSON.stringify(paneIdsByCol());
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-actions', pickedId: 'extra',
    }));
    eq(JSON.stringify(paneIdsByCol()), before, 'arrange unchanged (actions is reserved)');
  });

  it('NO-OP — picked === target current occupant just closes', () => {
    setupRich();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    eq(getModel().modes.paneMenuMode, true, 'overlay open');
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'groups',
    }));
    eq(getModel().modes.paneMenuMode, false, 'overlay closed');
    eq(paneIdsByCol()[0][0], 'groups', 'arrange unchanged');
  });

  // Multi-tab pane fixtures — T1.1 + T1.2 regression coverage.
  // A multi-tab `pane-multi` carries [tab-a (active), tab-b] in col 0.
  function setupMultiTab() {
    const layout = route.getInstanceSlice('layout');
    layout.paneMenu = { targetPaneId: null, cursor: 0, scroll: 0 };
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
    getModel().modes.paneMenuMode = false;
  }

  it('T1.1 — SWAP preserves multi-tab pane (tabs[] / paneId / activeTabId)', () => {
    setupMultiTab();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-stats' }));
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
    const placed = require('../leaves/wm/pool').placedIds(arr);
    eq(placed.filter(id => id === 'tab-b').length, 1, 'tab-b placed exactly once');
  });

  it('T1.2 — non-active multi-tab tabs excluded from paneSelectItems', () => {
    setupMultiTab();
    const list = require('../leaves/wm/pool').paneSelectItems(
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

  it('T2-b — REPLACE on multi-tab target refuses (preserves grouping)', () => {
    setupMultiTab();
    // pane-multi carries [tab-a, tab-b]. Open pane-select on it,
    // pick `extra` (hidden) — REPLACE would decompose the multi-tab
    // pane; refuse instead.
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-multi' }));
    const before = JSON.stringify(route.getInstanceSlice('layout').arrange.columns
      .map(c => (c.panels || []).map(p => ({ id: p.id, tabs: (p.tabs || []).map(t => t.poolId) }))));
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-multi', pickedId: 'extra',
    }));
    const after = JSON.stringify(route.getInstanceSlice('layout').arrange.columns
      .map(c => (c.panels || []).map(p => ({ id: p.id, tabs: (p.tabs || []).map(t => t.poolId) }))));
    eq(after, before, 'multi-tab pane unchanged (REPLACE refused)');
    eq(getModel().modes.paneMenuMode, false, 'overlay still closes on refuse');
  });

  it('T2-b — REPLACE on single-tab target still works', () => {
    setupRich();
    // pane-groups is single-tab. REPLACE with hidden `extra` should
    // succeed as before — the refuse-guard only fires for multi-tab.
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'extra',
    }));
    eq(paneIdsByCol()[0][0], 'extra', 'REPLACE succeeded on single-tab target');
  });

  it('T2-a — SWAP across columns strips heightPct (column-local share)', () => {
    const layout = route.getInstanceSlice('layout');
    layout.paneMenu = { targetPaneId: null, cursor: 0, scroll: 0 };
    layout.freeConfig = { drag: null, undo: [], redo: [], titleEdit: { text: '' }, notice: null, noticeKind: null };
    layout.arrange = {
      columns: [
        { width: 24, panels: [
          { type: 'groups', id: 'groups', paneId: 'pane-groups', columnIndex: 0,
            heightPct: 60, tabs: [{ id: 'groups', poolId: 'groups' }] },
          { type: 'stats',  id: 'stats',  paneId: 'pane-stats',  columnIndex: 0,
            heightPct: 40, tabs: [{ id: 'stats', poolId: 'stats' }] },
        ] },
        { panels: [
          { type: 'extra',  id: 'extra',  paneId: 'pane-extra',  columnIndex: 1,
            heightPct: 70, tabs: [{ id: 'extra', poolId: 'extra' }] },
          { type: 'detail', id: 'detail', paneId: 'pane-detail', columnIndex: 1,
            tabs: [{ id: 'detail', poolId: 'detail' }] },
        ] },
      ],
      pool: {
        'groups': { id: 'groups', type: 'groups', title: 'Groups' },
        'stats':  { id: 'stats',  type: 'stats',  title: 'Stats' },
        'extra':  { id: 'extra',  type: 'extra',  title: 'Extra' },
        'detail': { id: 'detail', type: 'detail', title: 'Detail' },
      },
      detailHeightPct: 60,
    };
    getModel().modes.paneMenuMode = false;
    // SWAP groups (col 0, heightPct=60) with extra (col 1, heightPct=70).
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'extra',
    }));
    const arr = route.getInstanceSlice('layout').arrange;
    const movedExtra = arr.columns[0].panels[0];   // extra now in col 0
    const movedGroups = arr.columns[1].panels[0];  // groups now in col 1
    eq(movedExtra.id, 'extra', 'extra moved to col 0');
    eq(movedGroups.id, 'groups', 'groups moved to col 1');
    // Cross-column SWAP must strip heightPct on both moving panes —
    // their old share is column-local.
    eq(movedExtra.heightPct, undefined, 'extra heightPct stripped on cross-col move');
    eq(movedGroups.heightPct, undefined, 'groups heightPct stripped on cross-col move');
    // Sibling panes (stats in col 0, detail in col 1) untouched.
    eq(arr.columns[0].panels[1].heightPct, 40, 'stats heightPct preserved');
  });

  it('T2-a — SWAP within same column preserves heightPct', () => {
    setupRich();
    // setupRich has groups + stats in col 0, both heightPct undefined.
    // Inject heightPct to test in-column SWAP preserves them.
    const arr = route.getInstanceSlice('layout').arrange;
    arr.columns[0].panels[0].heightPct = 60;
    arr.columns[0].panels[1].heightPct = 40;
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups' }));
    api.dispatchMsg(api.wrap('layout', {
      type: 'pool_swap_by_id', targetPaneId: 'pane-groups', pickedId: 'stats',
    }));
    const after = route.getInstanceSlice('layout').arrange;
    // After SWAP within col 0, slot 0 holds stats (with its 40) and
    // slot 1 holds groups (with its 60). Same-column = pure
    // rearrangement, heightPcts ride along.
    eq(after.columns[0].panels[0].id, 'stats');
    eq(after.columns[0].panels[0].heightPct, 40, 'stats keeps its heightPct (same-col SWAP)');
    eq(after.columns[0].panels[1].id, 'groups');
    eq(after.columns[0].panels[1].heightPct, 60, 'groups keeps its heightPct (same-col SWAP)');
  });
});

describe('[4] modes registry has paneMenuMode', () => {
  const modes = require('../leaves/input/modes');
  it('paneMenuMode is in CHAIN_MODES', () => {
    assert(modes.CHAIN_MODES.includes('paneMenuMode'));
  });
  it('paneMenuMode is an overlay mode (full-repaint on close)', () => {
    const s = { paneMenuMode: true };
    eq(modes.isOverlayActive(s), true);
  });
  it('paneMenuMode is NOT modal (footer not owned)', () => {
    const s = { paneMenuMode: true };
    eq(modes.isModal(s), false);
  });
  // Regression: runtime.js#init must include every MODES entry, or
  // mode_set/mode_clear refuses to flip the flag (the `in modes`
  // guard short-circuits). Pre-fix, paneMenuMode was missing from
  // init's hardcoded list — overlay never painted in production
  // (tests masked it by writing m.modes.paneMenuMode = false in
  // setup). Derived-init prevents the regression.
  it('runtime model exposes every MODES flag (no init drift)', () => {
    const fresh = require('../app/runtime').init();
    for (const md of modes.MODES) {
      assert(md.flag in fresh.modes, `${md.flag} missing from runtime init`);
      eq(fresh.modes[md.flag], false, `${md.flag} not false on init`);
    }
  });
});

describe('[8] paneMenuPanes — viewer-inclusive, mode-aware (v0.6.4 #1 Step 2)', () => {
  const mpool = require('../leaves/wm/pool');
  function arr() {
    return {
      columns: [
        { width: 24, panels: [
          { type: 'groups', id: 'groups', paneId: 'pane-groups' },
        ] },
        { panels: [
          { type: 'detail', id: 'd1', paneId: 'pane-d1' },
          { type: 'detail', id: 'd2', paneId: 'pane-d2' },
        ] },
      ],
      pool: {
        groups: { id: 'groups', type: 'groups', title: 'Groups' },
        d1: { id: 'd1', type: 'detail', title: 'V1' },
        d2: { id: 'd2', type: 'detail', title: 'V2' },
        hid: { id: 'hid', type: 'stats', title: 'Hidden' },
      },
    };
  }
  it('INCLUDES viewers (unlike paneSelectItems) + carries paneId', () => {
    const list = mpool.paneMenuPanes(arr(), 'pane-d1', 'half');
    const ids = list.map(x => x.id);
    assert(ids.includes('d1') && ids.includes('d2'), 'both viewers listed');
    assert(ids.includes('groups'), 'navigator listed');
    const d1 = list.find(x => x.id === 'd1');
    eq(d1.paneId, 'pane-d1', 'paneId carried for placed entries');
    eq(d1.status, 'here', 'target tagged here');
    eq(list.find(x => x.id === 'd2').status, 'placed');
  });
  it('half/full = placed only (hidden pool entries excluded)', () => {
    const half = mpool.paneMenuPanes(arr(), 'pane-d1', 'half');
    assert(!half.some(x => x.id === 'hid'), 'hidden excluded in half');
    const full = mpool.paneMenuPanes(arr(), 'pane-d1', 'full');
    assert(!full.some(x => x.id === 'hid'), 'hidden excluded in full');
  });
  it('normal = placed + hidden (pool_swap can place a hidden entry)', () => {
    const normal = mpool.paneMenuPanes(arr(), 'pane-groups', 'normal');
    const hid = normal.find(x => x.id === 'hid');
    assert(hid && hid.status === 'hidden' && hid.paneId === null, 'hidden listed with null paneId');
  });
});

report();
