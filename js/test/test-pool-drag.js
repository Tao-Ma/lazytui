/**
 * Phase 5 — pool drag from the panel-list overlay onto the layout grid.
 *
 * Pins the `poolDragStart` → `poolDragMotion` → `poolDragRelease` state
 * machine on `leaves/design`. Release returns [next, cmds]; the cmds
 * are dispatch_msg Cmds that re-emit pool_hide / pool_show Msgs back
 * into layout.update — Phase 2's handlers do the actual mutation.
 *
 *   node js/test/test-pool-drag.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const mdesign = require('../leaves/design');
const layout = require('../panel/layout');

// Build a slice with panelBounds populated so pool-drop hit-tests have
// something to read. Bounds mirror what render/layout writes at paint.
function buildSlice() {
  const arrange = {
    leftWidth: 30,
    detailHeightPct: 60,
    leftPanels: [
      { id: 'groups',  type: 'groups',  title: 'Groups',  hotkey: '1', column: 'left' },
      { id: 'files',   type: 'files',   title: 'Files',   hotkey: '2', column: 'left' },
    ],
    rightPanels: [
      { id: 'actions', type: 'actions', title: 'Actions', hotkey: '7', column: 'right' },
      { id: 'detail',  type: 'detail',  title: 'Detail',  hotkey: '8', column: 'right' },
    ],
    pool: {
      groups:  { id: 'groups',  type: 'groups',  title: 'Groups',  config: {} },
      files:   { id: 'files',   type: 'files',   title: 'Files',   config: {} },
      actions: { id: 'actions', type: 'actions', title: 'Actions', config: {} },
      detail:  { id: 'detail',  type: 'detail',  title: 'Detail',  config: {} },
      notes:   { id: 'notes',   type: 'viewer', title: 'Notes',   config: {} },
    },
  };
  return {
    ...layout.init(),
    arrange,
    panelBounds: {
      groups:  { x: 0,  y: 0,  w: 30, h: 10 },
      files:   { x: 0,  y: 10, w: 30, h: 10 },
      actions: { x: 30, y: 0,  w: 50, h: 8  },
      detail:  { x: 30, y: 8,  w: 50, h: 12 },
    },
    panelList: { open: true, cursor: 4 }, // 'notes' is at index 4 in the panel list
  };
}

describe('[poolDragStart] sets drag.kind = pool-armed with sourceId', () => {
  it('captures source id + anchor coordinates', () => {
    const s = mdesign.poolDragStart(buildSlice(), 'notes', 50, 5);
    const d = s.design.drag;
    eq(d.kind, 'pool-armed');
    eq(d.sourceId, 'notes');
    eq(d.startX, 50);
    eq(d.startY, 5);
    eq(d.target, null);
  });
});

describe('[poolDragMotion] promotes armed→dragging and computes drop target', () => {
  it('no movement leaves kind=pool-armed but updates curX/Y', () => {
    let s = mdesign.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mdesign.poolDragMotion(s, 50, 5);
    eq(s.design.drag.kind, 'pool-armed', 'still armed without motion');
  });
  it('motion promotes to pool-dragging', () => {
    let s = mdesign.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mdesign.poolDragMotion(s, 52, 6);
    eq(s.design.drag.kind, 'pool-dragging');
  });
  it('drop on an actions cell → replace target', () => {
    let s = mdesign.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mdesign.poolDragMotion(s, 50, 4); // inside actions (x:30-79, y:0-7)
    const t = s.design.drag.target;
    eq(t.kind, 'replace');
    eq(t.column, 'right');
    eq(t.occupantId, 'actions');
    assert(t.valid, 'replace on actions is valid');
  });
  it('drop on detail → replace target marked invalid (detail is essential)', () => {
    let s = mdesign.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mdesign.poolDragMotion(s, 50, 15); // inside detail (x:30-79, y:8-19)
    const t = s.design.drag.target;
    eq(t.kind, 'replace');
    eq(t.occupantId, 'detail');
    eq(t.valid, false, 'detail replace refused');
  });
  it('drop in a column gap → append target', () => {
    let s = mdesign.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mdesign.poolDragMotion(s, 50, 30); // below all right-column cells
    const t = s.design.drag.target;
    eq(t.kind, 'append');
    eq(t.column, 'right');
    assert(t.valid);
  });
  it('drop on left column gap → append left', () => {
    let s = mdesign.poolDragStart(buildSlice(), 'notes', 5, 5);
    s = mdesign.poolDragMotion(s, 5, 25); // below groups + files
    eq(s.design.drag.target.kind, 'append');
    eq(s.design.drag.target.column, 'left');
  });
});

describe('[poolDragRelease] emits Cmds + clears drag', () => {
  it('valid append drop → pool_show dispatch_msg + force_full_repaint; drag cleared, overlay closes', () => {
    let s = mdesign.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mdesign.poolDragMotion(s, 50, 30);
    const [next, cmds] = mdesign.poolDragRelease(s);
    eq(next.design.drag, null, 'drag cleared');
    eq(next.panelList.open, false, 'overlay closed on successful drop');
    eq(cmds.length, 2);
    eq(cmds[0].type, 'dispatch_msg');
    eq(cmds[0].msg.kind, 'layout');
    eq(cmds[0].msg.msg.type, 'pool_show');
    eq(cmds[0].msg.msg.id, 'notes');
    eq(cmds[0].msg.msg.column, 'right');
    eq(cmds[1].type, 'force_full_repaint');
  });
  it('valid replace drop → pool_hide(occupant) + pool_show(source) + force_full_repaint', () => {
    let s = mdesign.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mdesign.poolDragMotion(s, 50, 4); // on actions
    const [next, cmds] = mdesign.poolDragRelease(s);
    eq(cmds.length, 3);
    eq(cmds[0].msg.msg.type, 'pool_hide');
    eq(cmds[0].msg.msg.id, 'actions');
    eq(cmds[1].msg.msg.type, 'pool_show');
    eq(cmds[1].msg.msg.id, 'notes');
    eq(cmds[1].msg.msg.column, 'right');
    eq(cmds[2].type, 'force_full_repaint');
  });
  it('invalid target (detail replace) → no Cmds, drag still cleared', () => {
    let s = mdesign.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mdesign.poolDragMotion(s, 50, 15); // on detail (invalid)
    const [next, cmds] = mdesign.poolDragRelease(s);
    eq(next.design.drag, null);
    eq(cmds.length, 0);
  });
  it('release without motion (no target) → no Cmds, drag cleared', () => {
    const s = mdesign.poolDragStart(buildSlice(), 'notes', 50, 5);
    const [next, cmds] = mdesign.poolDragRelease(s);
    eq(next.design.drag, null);
    eq(cmds.length, 0);
  });
});

describe('[end-to-end] layout.update threads pool_drag_* Msgs to the leaf', () => {
  it('pool_drag_start sets the drag', () => {
    const s = layout.update({ type: 'pool_drag_start', id: 'notes', mx: 50, my: 5 }, buildSlice());
    eq(s.design.drag.kind, 'pool-armed');
  });
  it('pool_drag_motion computes target', () => {
    let s = layout.update({ type: 'pool_drag_start', id: 'notes', mx: 50, my: 5 }, buildSlice());
    s = layout.update({ type: 'pool_drag_motion', mx: 50, my: 30 }, s);
    eq(s.design.drag.target.kind, 'append');
  });
  it('pool_drag_release returns the [next, cmds] tuple', () => {
    let s = layout.update({ type: 'pool_drag_start', id: 'notes', mx: 50, my: 5 }, buildSlice());
    s = layout.update({ type: 'pool_drag_motion', mx: 50, my: 30 }, s);
    const result = layout.update({ type: 'pool_drag_release' }, s);
    assert(Array.isArray(result), 'returns tuple');
    const [next, cmds] = result;
    eq(next.design.drag, null);
    eq(cmds[0].msg.msg.type, 'pool_show');
  });
});

report();
