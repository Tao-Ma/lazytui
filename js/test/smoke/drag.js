/**
 * Smoke — free-config in-grid drag through the real dispatch path.
 *
 * test-free-config-drag.js covers the drag state machine, drop math,
 * and arrange mutations at the unit level (calling `onMouseEvent` and
 * `pointToDropTarget` directly). This smoke goes one layer up: drives
 * the same drag through `dispatchMsg(wrap('layout', free_config_mouse_*))`
 * — the path SGR mouse events take in production via
 * `_mouseHandleFreeConfigMode`. That's the surface most at risk from
 * the v0.6.3 paneId migration: the wrap('layout', ...) routing went
 * through several rewrites (root reducer → component update → layout
 * arm) where a Msg-type or arg drift would silently mis-route.
 *
 * What this pins:
 *   - free_config_mouse_press → mouseMotion → mouseRelease MUST
 *     compose into a coherent arrange change.
 *   - The post-release render reflects the new column shape.
 *   - Invalid drops snap back without mutating arrange OR setting dirty.
 *
 * Run: node js/test/smoke/drag.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('../test-runner');
const sm = require('./_helpers/smoke');
const api = sm.api;
const { getModel } = require('../../app/runtime');

// Match test-free-config-drag.js's fixture (120-wide screen).
//   Left  (x= 0..29):  containers y=0..9, groups y=10..19
//   Right (x=30..119): actions y=0..4, stats y=5..14, detail y=15..39

function setupFixture() {
  sm.bootFresh();
  const layout = api.getInstanceSlice('layout');
  layout.arrange = {
    detailHeightPct: 60,
    columns: [
      { width: 30, panels: [
        { type: 'containers', id: 'containers', title: 'Containers', columnIndex: 0, hotkey: '1' },
        { type: 'groups',     id: 'groups',     title: 'Groups',     columnIndex: 0, hotkey: '2' },
      ] },
      { panels: [
        { type: 'actions', id: 'actions', title: 'Actions', columnIndex: 1, hotkey: '0' },
        { type: 'stats',   id: 'stats',   title: 'Stats',   columnIndex: 1, hotkey: '' },
        { type: 'detail',  id: 'detail',  title: 'Detail',  columnIndex: 1, hotkey: 'o' },
      ] },
    ],
  };
  layout.paneBounds = {
    containers: { x:  0, y:  0, w: 30, h: 10 },
    groups:     { x:  0, y: 10, w: 30, h: 10 },
    actions:    { x: 30, y:  0, w: 90, h:  5 },
    stats:      { x: 30, y:  5, w: 90, h: 10 },
    detail:     { x: 30, y: 15, w: 90, h: 25 },
  };
  layout.dirty = false;
  // Enter free-config mode through the real Msg path (sets up
  // slice.freeConfig.* state the drag arms read).
  api.dispatchMsg(api.wrap('layout', { type: 'free_config_enter' }));
}

const COLS = 120;

function press(mx, my)   { return api.dispatchMsg(api.wrap('layout', { type: 'free_config_mouse_press',   mx, my, cols: COLS })); }
function motion(mx, my)  { return api.dispatchMsg(api.wrap('layout', { type: 'free_config_mouse_motion',  mx, my, cols: COLS })); }
function release(mx, my) { return api.dispatchMsg(api.wrap('layout', { type: 'free_config_mouse_release', mx, my, cols: COLS })); }

// --- [1] Same-column reorder: containers → after groups ----------------

describe('[1] same-column reorder via dispatchMsg path', () => {
  it('press containers → motion to bottom of groups → release → containers is last', () => {
    setupFixture();
    press(5, 2);
    motion(5, 17);   // groups bottom-zone → insert after groups
    release(5, 17);

    const cols = api.getInstanceSlice('layout').arrange.columns;
    eq(cols[0].panels.length, 2, 'left column still has two panels');
    eq(cols[0].panels[0].type, 'groups',     'groups now first');
    eq(cols[0].panels[1].type, 'containers', 'containers now last');
    eq(api.getInstanceSlice('layout').dirty, true, 'dirty=true on valid drop');
    eq(api.getInstanceSlice('layout').freeConfig.drag, null, 'drag state cleared');
  });
});

// --- [2] Cross-column drag: containers → before stats (right column) ---

describe('[2] cross-column drag via dispatchMsg path', () => {
  it('press containers → motion into stats top → release → containers in right col', () => {
    setupFixture();
    press(5, 2);
    motion(50, 6);   // stats top-zone → insert before stats
    release(50, 6);

    const cols = api.getInstanceSlice('layout').arrange.columns;
    eq(cols[0].panels.length, 1, 'left column emptied to one');
    eq(cols[0].panels[0].type, 'groups');
    eq(cols[1].panels[0].type, 'actions');
    eq(cols[1].panels[1].type, 'containers', 'containers inserted before stats');
    eq(cols[1].panels[2].type, 'stats');
    eq(cols[1].panels[3].type, 'detail');
    eq(api.getInstanceSlice('layout').dirty, true);
  });
});

// --- [3] Invalid drop snap-back: detail → left column ------------------

describe('[3] invalid drop snaps back, no arrange mutation, no dirty', () => {
  it('press detail → motion into left col → release → detail still in right col', () => {
    setupFixture();
    press(50, 20);   // detail
    motion(5, 2);    // left column — invalid for detail
    release(5, 2);

    const cols = api.getInstanceSlice('layout').arrange.columns;
    eq(cols[1].panels[2].type, 'detail', 'detail still in right column slot 2');
    eq(cols[0].panels.length, 2, 'left column unchanged');
    eq(api.getInstanceSlice('layout').dirty, false, 'dirty stays false on snap-back');
    eq(api.getInstanceSlice('layout').freeConfig.drag, null, 'drag state cleared either way');
  });
});

// --- [4] Drag state machine: motion before release is dragging ---------

describe('[4] drag state machine — press → motion arms dragging with target', () => {
  it('after press+motion (no release), freeConfig.drag is dragging with a target', () => {
    setupFixture();
    press(5, 2);
    motion(5, 17);
    const drag = api.getInstanceSlice('layout').freeConfig.drag;
    assert(drag, 'drag state set');
    eq(drag.kind, 'dragging', `kind=dragging (got '${drag && drag.kind}')`);
    eq(drag.sourceType, 'containers');
    assert(drag.target, 'target set after movement');
    eq(drag.target.columnIndex, 0);
    assert(drag.target.valid, 'left-column drop is valid for containers');
  });
});

// --- [5] no-motion press → click → release: no arrange mutation -------
//
// The drag/click distinction: pressing and releasing without any
// motion between is treated as a click, not a drag. arrange MUST NOT
// mutate and dirty stays false. This is the gate on a regression
// where any press inside a panel arms a drag whose subsequent release
// — even at the same coords — committed a self-swap.

describe('[5] press + release at the same coords → click, not drag', () => {
  it('press(5,2) → release(5,2) leaves arrange + dirty untouched', () => {
    setupFixture();
    const before = JSON.stringify(api.getInstanceSlice('layout').arrange);
    press(5, 2);
    release(5, 2);
    const after = JSON.stringify(api.getInstanceSlice('layout').arrange);
    eq(after, before, 'arrange unchanged on click (no motion between press/release)');
    eq(api.getInstanceSlice('layout').dirty, false, 'dirty stays false');
  });
});

report();
