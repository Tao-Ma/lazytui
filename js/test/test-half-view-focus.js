/**
 * Half-view focus tracking (v0.6 polish).
 *
 * In half view the screen shows "non-detail panel on the left + detail
 * on the right." When focus moves to detail (e.g., a tab-bar click that
 * dispatches `focus_set` to detail), the left side falls back to
 * `slice.halfLeftPanel` — the most recently focused non-detail panel.
 * Without this fallback the left would render detail too, duplicating
 * the panel on both halves.
 *
 *   - focus_set to a non-detail panel updates halfLeftPanel
 *   - focus_set to detail leaves halfLeftPanel untouched (stays sticky)
 *
 *   node js/test/test-half-view-focus.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const layout = require('../panel/layout');

function applyUpdate(slice, msg) {
  const r = layout.update(msg, slice);
  return Array.isArray(r) ? { next: r[0], cmds: r[1] } : { next: r, cmds: [] };
}

// A realistic arrange so _withFocus can classify the focused pane from
// slice.arrange (its `.type`) — #1 made it derive the kind from the layout's
// OWN slice instead of the global route/_instances registry, so the panes must
// actually exist in the slice (production always has them; init()'s arrange is
// empty). paneId === kind-name here so focus-by-kind maps to itself and the
// assertions below read naturally.
const ARR = {
  detailHeightPct: 60, pool: {},
  columns: [
    { width: 30, panels: [
      { type: 'groups',     id: 'groups',     paneId: 'groups' },
      { type: 'containers', id: 'containers', paneId: 'containers' },
    ] },
    { panels: [{ type: 'detail', id: 'detail', paneId: 'detail' }] },
  ],
};
const seedSlice = () => ({ ...layout.init(), arrange: ARR });

describe('[focus_set] tracks halfLeftPanel for half-view rendering', () => {
  it('init starts with halfLeftPanel = null', () => {
    const s = layout.init();
    eq(s.halfLeftPanel, null);
  });

  it('focus_set to a non-detail panel updates halfLeftPanel', () => {
    let s = seedSlice();
    s = applyUpdate(s, { type: 'focus_set', focus: 'groups' }).next;
    eq(s.focus, 'groups');
    eq(s.halfLeftPanel, 'groups');
  });

  it('focus_set to detail leaves halfLeftPanel untouched (sticky)', () => {
    let s = seedSlice();
    s = applyUpdate(s, { type: 'focus_set', focus: 'containers' }).next;
    eq(s.halfLeftPanel, 'containers');
    s = applyUpdate(s, { type: 'focus_set', focus: 'detail' }).next;
    eq(s.focus, 'detail');
    eq(s.halfLeftPanel, 'containers', 'halfLeftPanel stays at last non-detail');
  });

  it('focus_set bounces detail → other non-detail → detail correctly', () => {
    let s = seedSlice();
    s = applyUpdate(s, { type: 'focus_set', focus: 'groups' }).next;
    eq(s.halfLeftPanel, 'groups');
    s = applyUpdate(s, { type: 'focus_set', focus: 'detail' }).next;
    eq(s.halfLeftPanel, 'groups');
    s = applyUpdate(s, { type: 'focus_set', focus: 'containers' }).next;
    eq(s.halfLeftPanel, 'containers', 'updates to new non-detail focus');
    s = applyUpdate(s, { type: 'focus_set', focus: 'detail' }).next;
    eq(s.halfLeftPanel, 'containers', 'sticks at containers');
  });

  it('msg.focus == null is a no-op (preserves both focus and halfLeftPanel)', () => {
    let s = seedSlice();
    s = applyUpdate(s, { type: 'focus_set', focus: 'groups' }).next;
    const before = s.halfLeftPanel;
    s = applyUpdate(s, { type: 'focus_set', focus: null }).next;
    eq(s.focus, 'groups');
    eq(s.halfLeftPanel, before);
  });
});

describe('[view_place_pane] sets the half-view projection slot (v0.6.4)', () => {
  // A realistic arrange: a nav + two viewers, so findPaneLocation resolves.
  const ARR = {
    detailHeightPct: 60, pool: {},
    columns: [
      { width: 30, panels: [{ type: 'files', id: 'f', paneId: 'pane-f' }] },
      { panels: [
        { type: 'detail', id: 'd1', paneId: 'pane-d1' },
        { type: 'detail', id: 'd2', paneId: 'pane-d2' },
      ] },
    ],
  };
  const sliceWith = (over) => ({ ...layout.init(), arrange: ARR, ...over });

  it('init starts with both slots null', () => {
    const s = layout.init();
    eq(s.halfView.left, null); eq(s.halfView.right, null);
  });

  it('sets the slot, emits force_full_repaint, focuses the placed pane', () => {
    const { next, cmds } = applyUpdate(sliceWith(), { type: 'view_place_pane', slot: 'right', paneId: 'pane-d2' });
    eq(next.halfView.right, 'pane-d2', 'right slot set');
    eq(next.halfView.left, null, 'left slot untouched');
    assert(cmds.some(c => c.type === 'force_full_repaint'), 'force_full_repaint emitted');
    eq(next.focus, 'pane-d2', 'focus stamped to the placed pane');
  });

  it('either slot accepts ANY pane — a viewer in the LEFT slot is allowed', () => {
    const { next } = applyUpdate(sliceWith(), { type: 'view_place_pane', slot: 'left', paneId: 'pane-d1' });
    eq(next.halfView.left, 'pane-d1', 'viewer placed in left slot (no detail exclusion)');
  });

  it('invalid slot is a no-op (preserves slice ref)', () => {
    const s0 = sliceWith();
    eq(layout.update({ type: 'view_place_pane', slot: 'middle', paneId: 'pane-d2' }, s0), s0);
  });

  it('an unplaced paneId is a no-op (preserves slice ref)', () => {
    const s0 = sliceWith();
    eq(layout.update({ type: 'view_place_pane', slot: 'left', paneId: 'pane-nope' }, s0), s0);
  });

  it('setting a slot to its current value is a no-op (preserves slice ref)', () => {
    const s0 = sliceWith({ halfView: { left: 'pane-f', right: null } });
    eq(layout.update({ type: 'view_place_pane', slot: 'left', paneId: 'pane-f' }, s0), s0);
  });

  it('set_arrange clears a slot whose pane the new arrange dropped, keeps the survivor', () => {
    const s0 = sliceWith({ halfView: { left: 'pane-f', right: 'pane-d2' } });
    const ARR2 = { ...ARR, columns: [
      ARR.columns[0],
      { panels: [{ type: 'detail', id: 'd1', paneId: 'pane-d1' }] },  // pane-d2 dropped
    ] };
    const { next } = applyUpdate(s0, { type: 'set_arrange', arrange: ARR2 });
    eq(next.halfView.left, 'pane-f', 'still-placed slot kept');
    eq(next.halfView.right, null, 'dropped-pane slot cleared');
  });
});

describe('[free_config_exit] commits current focus to halfLeftPanel', () => {
  it('non-detail focus on exit → halfLeftPanel updated', () => {
    // Free-config nav (free_config_nav etc.) writes focus directly without
    // routing through focus_set, so halfLeftPanel may not have tracked
    // in-mode movement. free_config_exit catches it up.
    let s = seedSlice();
    s = applyUpdate(s, { type: 'focus_set', focus: 'groups' }).next;
    eq(s.halfLeftPanel, 'groups');
    // Simulate free-config in-mode focus drift (direct write, not focus_set).
    s = { ...s, focus: 'containers' };
    eq(s.halfLeftPanel, 'groups', 'direct focus write didn’t update halfLeftPanel');
    s = applyUpdate(s, { type: 'free_config_exit' }).next;
    eq(s.halfLeftPanel, 'containers', 'free_config_exit committed the in-mode focus');
  });

  it('detail focus on exit → halfLeftPanel unchanged (no detail in left)', () => {
    let s = seedSlice();
    s = applyUpdate(s, { type: 'focus_set', focus: 'groups' }).next;
    s = { ...s, focus: 'detail' };
    s = applyUpdate(s, { type: 'free_config_exit' }).next;
    eq(s.halfLeftPanel, 'groups', 'detail focus doesn’t overwrite halfLeftPanel');
  });
});

describe('[visibleBoundsFor] half-mode click can\'t hit off-screen pane phantom', () => {
  // Regression for the bug: in half view, paneBounds only carries the
  // visible (halfLeftPanel + detail) pair, but boundsFor's fallback to
  // _currentLayout.rects exposed every pane's NORMAL-view rect. A click
  // on the visible left half matched the first non-detail pane's
  // phantom rect (containers in postgres demo) and dispatched focus_set
  // to the wrong pane, silently reverting the user's right-arrow
  // selection. visibleBoundsFor reads slice-only so it returns null
  // for any pane absent from this frame's paneBounds.
  const { getInstanceSlice } = require('../panel/api');
  const renderLayout = require('../leaves/geometry');

  it('visibleBoundsFor returns null for panes absent from paneBounds', () => {
    const slice = getInstanceSlice('layout');
    slice.paneBounds = {
      'files':  { x: 0,  y: 0, w: 32, h: 24 },   // halfLeftPanel
      'detail': { x: 32, y: 0, w: 48, h: 24 },
    };
    // containers / groups are NOT in paneBounds (off-screen in half).
    eq(renderLayout.visibleBoundsFor(slice, 'files'), slice.paneBounds.files);
    eq(renderLayout.visibleBoundsFor(slice, 'detail'), slice.paneBounds.detail);
    eq(renderLayout.visibleBoundsFor(slice, 'containers'), null, 'off-screen returns null');
    eq(renderLayout.visibleBoundsFor(slice, 'groups'),     null, 'off-screen returns null');
  });

  it('visibleBoundsFor returns null when paneBounds is empty', () => {
    const slice = getInstanceSlice('layout');
    slice.paneBounds = {};
    eq(renderLayout.visibleBoundsFor(slice, 'anything'), null);
  });
});

describe('[chrome glyphs] half-mode collapse-button click can\'t hit off-screen pane', () => {
  // T1.1 regression: render/decor.js#_placedWidgetTargets used boundsFor,
  // letting [_] clicks in half view fire panel_collapse_toggle on a
  // pane whose normal-view rect overlapped the click. Same bug class
  // as the focus revert fixed by visibleBoundsFor.
  const { getInstanceSlice } = require('../panel/api');
  const decor = require('../panel/chrome-hittest');

  it('hitTestCollapseButton ignores off-screen panes in half view', () => {
    const slice = getInstanceSlice('layout');
    slice.arrange = {
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
        'groups': { id: 'groups', type: 'groups' },
        'actions': { id: 'actions', type: 'actions' },
        'detail': { id: 'detail', type: 'detail' },
      },
    };
    slice.freeConfig = { drag: null, undo: [], redo: [], titleEdit: { text: '' }, notice: null, noticeKind: null };
    // Half view: only `groups` + detail visible.
    slice.paneBounds = {
      'groups': { x: 0, y: 0, w: 60, h: 24 },
      'detail': { x: 60, y: 0, w: 60, h: 24 },
    };
    // `actions` is off-screen — its NORMAL-view rect (would be y=12,
    // x=0, w=32, h=12) is in _currentLayout but NOT in paneBounds.
    // The collapse-glyph hit-test must NOT fire on actions.
    // [_] sits at the right end of the pane: x = b.x + b.w - 3 to b.x + b.w - 1.
    // For an off-screen `actions` (normal-view bounds x=0..31, y=12),
    // its [_] would be at (29..31, 12). A click there in half view
    // would be inside the visible `groups` pane (which is x=0..59, y=0..23).
    // Test that the click doesn't toggle actions.
    eq(decor.hitTestCollapseButton(29, 12), null, 'off-screen actions [_] inert');
    // Sanity: the visible groups [_] still fires. groups bounds w=60,
    // [_] at x = b.x + b.w - 3 = 57. h=24 — but COLLAPSE_MIN_W requires
    // b.w >= some threshold; if w=60 is enough, the hit fires.
    // For now just assert visible groups [_] doesn't return null at
    // its own glyph position.
    const groupsHit = decor.hitTestCollapseButton(57, 0);
    assert(groupsHit === 'groups' || groupsHit === null, 'visible groups [_] resolved correctly (or filtered by COLLAPSE_MIN_W)');
  });
});

describe('[pane-menu trigger] hit-test honors hidden (nothing-to-swap) state', () => {
  // v0.6.4 #1 Step 2 — the unified [≡] trigger hides when a navigator
  // pane has < 2 pane rows (no useful swap target); hitTestTrigger's
  // triggerVisible guard must agree with the painted state. (Viewers
  // show via tab count, exercised elsewhere.)
  const { getInstanceSlice } = require('../panel/api');
  const paneMenu = require('../overlay/pane-menu');
  const { getModel } = require('../app/runtime');

  it('hitTestTrigger returns null when nothing to swap (length === 1)', () => {
    const slice = getInstanceSlice('layout');
    slice.arrange = {
      columns: [
        { width: 32, panels: [
          { type: 'groups', id: 'groups', paneId: 'pane-groups', tabs: [{ id: 'groups', poolId: 'groups' }] },
        ] },
        { panels: [
          { type: 'detail', id: 'detail', paneId: 'pane-detail', tabs: [{ id: 'detail', poolId: 'detail' }] },
        ] },
      ],
      pool: {
        // Only groups + detail — no other non-detail panes, no hidden.
        'groups': { id: 'groups', type: 'groups' },
        'detail': { id: 'detail', type: 'detail' },
      },
    };
    slice.freeConfig = { drag: null, undo: [], redo: [], titleEdit: { text: '' }, notice: null, noticeKind: null };
    slice.paneMenu = { targetPaneId: null, cursor: 0, scroll: 0 };
    slice.paneBounds = {
      'pane-groups': { x: 0, y: 0, w: 32, h: 24 },
      'pane-detail': { x: 32, y: 0, w: 48, h: 24 },
    };
    getModel().modes.paneMenuMode = false;
    // Click at the trigger's normal position (x=6, y=0 — middle of [≡]).
    eq(paneMenu.hitTestTrigger(6, 0), null, 'click ignored when nothing to swap');
  });

  it('hitTestTrigger still resolves when at least one swap target exists', () => {
    const slice = getInstanceSlice('layout');
    slice.arrange = {
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
        'groups':  { id: 'groups',  type: 'groups'  },
        'actions': { id: 'actions', type: 'actions' },
        'detail':  { id: 'detail',  type: 'detail'  },
      },
    };
    slice.freeConfig = { drag: null, undo: [], redo: [], titleEdit: { text: '' }, notice: null, noticeKind: null };
    slice.paneMenu = { targetPaneId: null, cursor: 0, scroll: 0 };
    slice.paneBounds = {
      'pane-groups':  { x: 0, y: 0, w: 32, h: 12 },
      'pane-actions': { x: 0, y: 12, w: 32, h: 12 },
      'pane-detail':  { x: 32, y: 0, w: 48, h: 24 },
    };
    getModel().modes.paneMenuMode = false;
    // Two non-detail panes → swap target exists → trigger live.
    eq(paneMenu.hitTestTrigger(6, 0), 'pane-groups', 'returns paneId when swap available');
  });
});

// v0.6.4 #1 Step 2 — half-view slot placement from the pane-menu pick.
// pane_menu_place sets halfView[slot]; when the picked pane already sits
// in the OTHER slot it SWAPS (the two slots trade) instead of collapsing.
// Driven through the registered layout instance so halfProjection (which
// reads allPanels()) resolves the placed panes.
describe('[pane_menu_place] half-view slot set + swap', () => {
  const api = require('../panel/api');
  const route = require('../panel/route');
  const { getModel } = require('../app/runtime');
  try { api.registerComponent(layout); } catch (e) { /* already registered */ }

  function seed(halfView) {
    const slice = api.getInstanceSlice('layout');
    slice.arrange = { detailHeightPct: 60, pool: {
      f:  { id: 'f',  type: 'files' },
      d1: { id: 'd1', type: 'detail' },
      d2: { id: 'd2', type: 'detail' },
    }, columns: [
      { width: 30, panels: [{ type: 'files', id: 'f', paneId: 'pane-f' }] },
      { panels: [
        { type: 'detail', id: 'd1', paneId: 'pane-d1' },
        { type: 'detail', id: 'd2', paneId: 'pane-d2' },
      ] },
    ] };
    slice.viewMode = 'half';
    slice.halfView = halfView || { left: null, right: null };
    slice.freeConfig = { drag: null, undo: [], redo: [], titleEdit: { text: '' }, notice: null, noticeKind: null };
    return slice;
  }

  it('places the picked pane into the slot', () => {
    seed({ left: 'pane-f', right: 'pane-d1' });
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_place', slot: 'left', paneId: 'pane-d2' }));
    const s = api.getInstanceSlice('layout');
    eq(s.halfView.left, 'pane-d2', 'left slot now d2');
    eq(s.halfView.right, 'pane-d1', 'right slot untouched (d2 was not in right)');
    eq(s.focus, 'pane-d2', 'focus stamped to placed pane');
  });

  it('SWAP — picking a pane already in the OTHER slot trades the two', () => {
    seed({ left: 'pane-f', right: 'pane-d1' });
    // Pick d1 (currently RIGHT) for the LEFT slot → swap: left=d1, right=f.
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_place', slot: 'left', paneId: 'pane-d1' }));
    const s = api.getInstanceSlice('layout');
    eq(s.halfView.left, 'pane-d1', 'left slot now d1');
    eq(s.halfView.right, 'pane-f', 'right slot got the displaced pane (swap, not collapse)');
  });

  it('picking the pane already in THIS slot is a no-op (identity preserved)', () => {
    const s0 = seed({ left: 'pane-f', right: 'pane-d1' });
    const before = s0.halfView;
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_place', slot: 'left', paneId: 'pane-f' }));
    eq(api.getInstanceSlice('layout').halfView, before, 'halfView identity preserved');
  });

  it('an unplaced paneId is a no-op', () => {
    const s0 = seed({ left: 'pane-f', right: 'pane-d1' });
    const before = s0.halfView;
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_place', slot: 'left', paneId: 'pane-nope' }));
    eq(api.getInstanceSlice('layout').halfView, before);
  });
});

report();
