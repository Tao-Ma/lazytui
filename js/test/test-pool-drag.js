/**
 * Phase 5 — pool drag from the panel-list overlay onto the layout grid.
 *
 * Pins the `poolDragStart` → `poolDragMotion` → `poolDragRelease` state
 * machine on `leaves/free-config-pool-drag`. Release returns [next, cmds]; the cmds
 * are dispatch_msg Cmds that re-emit pool_hide / pool_show Msgs back
 * into layout.update — Phase 2's handlers do the actual mutation.
 *
 *   node js/test/test-pool-drag.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const mpoolDrag = require('../leaves/free-config-pool-drag');
const layout = require('../panel/layout');

// Unwrap Component.update's optional [slice, cmds] tuple — R1.3 made
// pool_hide/show/remove_column emit Cmds when focus changes; tests
// that only assert on slice fields use this helper. Existing tests
// that DO want cmds keep the raw destructure (`const [next, cmds] = ...`).
const applyUpdate = (msg, slice) => {
  const r = layout.update(msg, slice);
  return Array.isArray(r) ? r[0] : r;
};

// Build a slice with panelBounds populated so pool-drop hit-tests have
// something to read. Bounds mirror what render/layout writes at paint.
function buildSlice() {
  const arrange = {
    detailHeightPct: 60,
    columns: [
      { width: 30, panels: [
        { id: 'groups',  type: 'groups',  title: 'Groups',  hotkey: '1', columnIndex: 0 },
        { id: 'files',   type: 'files',   title: 'Files',   hotkey: '2', columnIndex: 0 },
      ] },
      { panels: [
        { id: 'actions', type: 'actions', title: 'Actions', hotkey: '7', columnIndex: 1 },
        { id: 'detail',  type: 'detail',  title: 'Detail',  hotkey: '8', columnIndex: 1 },
      ] },
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
    const s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    const d = s.freeConfig.drag;
    eq(d.kind, 'pool-armed');
    eq(d.sourceId, 'notes');
    eq(d.startX, 50);
    eq(d.startY, 5);
    eq(d.target, null);
  });
});

// 3-zone pool-drag hit-test (v0.6) — top third inserts before the cell,
// middle third replaces the occupant, bottom third inserts after.
//
// Fixture cells (heights → thirds):
//   groups   y=0..9   (h=10) → top=[0,3),  mid=[3,7),   bot=[7,10)
//   files    y=10..19 (h=10) → top=[10,13), mid=[13,17), bot=[17,20)
//   actions  y=0..7   (h=8)  → top=[0,2),  mid=[2,6),   bot=[6,8)
//   detail   y=8..19  (h=12) → top=[8,12), mid=[12,16), bot=[16,20)
describe('[poolDragMotion] promotes armed→dragging and computes drop target', () => {
  it('no movement leaves kind=pool-armed but updates curX/Y', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 5);
    eq(s.freeConfig.drag.kind, 'pool-armed', 'still armed without motion');
  });
  it('motion promotes to pool-dragging', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 52, 6);
    eq(s.freeConfig.drag.kind, 'pool-dragging');
  });
  it('top third of actions → insert at right:0 (before actions)', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 1);  // actions top zone [0,2)
    const t = s.freeConfig.drag.target;
    eq(t.kind, 'insert');
    eq(t.columnIndex, 1);
    eq(t.index, 0);
    eq(t.valid, true);
  });
  it('middle third of actions → replace actions', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 4);  // actions mid zone [2,6)
    const t = s.freeConfig.drag.target;
    eq(t.kind, 'replace');
    eq(t.columnIndex, 1);
    eq(t.occupantId, 'actions');
    assert(t.valid, 'replace on actions is valid');
  });
  it('bottom third of actions → insert at right:1 (between actions and detail)', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 6);  // actions bot zone [6,8)
    const t = s.freeConfig.drag.target;
    eq(t.kind, 'insert');
    eq(t.columnIndex, 1);
    eq(t.index, 1);
    eq(t.valid, true);
  });
  it('middle third of detail → replace target marked invalid (detail is essential)', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 14);  // detail mid zone [12,16)
    const t = s.freeConfig.drag.target;
    eq(t.kind, 'replace');
    eq(t.occupantId, 'detail');
    eq(t.valid, false, 'detail replace refused');
  });
  it('top third of detail → insert clamped to right:1 (before detail)', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 9);  // detail top zone [8,12)
    const t = s.freeConfig.drag.target;
    eq(t.kind, 'insert');
    eq(t.index, 1);  // detail is at idx 1
    eq(t.valid, true);
  });
  it('bottom third of detail → insert CLAMPED to detail position (detail-at-end)', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 18);  // detail bot zone [16,20)
    const t = s.freeConfig.drag.target;
    eq(t.kind, 'insert');
    eq(t.index, 1);  // would be 2, clamped to detail's idx (1)
    eq(t.valid, true);
    eq(t.clamp, 'detail stays at end', 'clamp reason surfaces to footer');
  });
  it('top third of detail → no clamp marker (target lands where cursor says)', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 9);  // detail top zone [8,12) → insert@1
    const t = s.freeConfig.drag.target;
    eq(t.index, 1);
    eq(t.clamp, undefined, 'no rewrite happened, no clamp marker');
  });
  it('drop in dead zone below all right cells → append at right tail (clamped)', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 30);  // below detail
    const t = s.freeConfig.drag.target;
    eq(t.kind, 'insert');
    eq(t.columnIndex, 1);
    // detail is at idx 1, append (idx 2) clamps to 1.
    eq(t.index, 1);
    eq(t.valid, true);
  });
  it('top third of groups (left) → insert at left:0', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 5, 5);
    s = mpoolDrag.poolDragMotion(s, 5, 1);   // groups top zone [0,3)
    const t = s.freeConfig.drag.target;
    eq(t.kind, 'insert');
    eq(t.columnIndex, 0);
    eq(t.index, 0);
  });
  it('drop below all left cells → append at left tail (idx 2)', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 5, 5);
    s = mpoolDrag.poolDragMotion(s, 5, 25);  // below files
    const t = s.freeConfig.drag.target;
    eq(t.kind, 'insert');
    eq(t.columnIndex, 0);
    eq(t.index, 2);
  });
  it('empty left column → insert at left:0 (fallback for "no cells matched")', () => {
    const base = buildSlice();
    // Clear column 0 panels — pool-drag should still allow inserting at idx 0
    // anywhere in the left column area via the scan fallback.
    base.arrange.columns[0] = { ...base.arrange.columns[0], panels: [] };
    base.panelBounds.groups = undefined;
    base.panelBounds.files  = undefined;
    let s = mpoolDrag.poolDragStart(base, 'notes', 5, 5);
    s = mpoolDrag.poolDragMotion(s, 5, 12);
    const t = s.freeConfig.drag.target;
    eq(t.kind, 'insert');
    eq(t.columnIndex, 0);
    eq(t.index, 0);
    eq(t.valid, true);
  });
  it('actions → left column: insert is INVALID (same rule as in-grid drag)', () => {
    // Regression for Code-1 finding: pool-drag let the user land the
    // actions panel in the left column, while in-grid drag blocked the
    // same move. Now both block, with the same reason text.
    const base = buildSlice();
    const next = layout.update({ type: 'pool_hide', id: 'actions' }, base);
    let s = mpoolDrag.poolDragStart(next, 'actions', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 5, 5);  // groups mid-third (left column)
    const t = s.freeConfig.drag.target;
    eq(t.valid, false);
    assert(t.reason && t.reason.includes('actions'),
      `reason mentions actions (got "${t.reason}")`);
  });
  it('actions → left column on a top-third (insert) zone: also INVALID', () => {
    const base = buildSlice();
    const next = layout.update({ type: 'pool_hide', id: 'actions' }, base);
    let s = mpoolDrag.poolDragStart(next, 'actions', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 5, 1);  // groups top-third → would insert@0
    const t = s.freeConfig.drag.target;
    eq(t.kind, 'insert');
    eq(t.columnIndex, 0);
    eq(t.valid, false);
  });
  it('pool_show with column:left + actions is refused by reducer too', () => {
    // Defense-in-depth: even if a caller bypasses the validator and
    // dispatches pool_show with column='left' for actions directly,
    // the reducer must refuse.
    const base = buildSlice();
    const hidden = layout.update({ type: 'pool_hide', id: 'actions' }, base);
    eq(hidden.arrange.columns[1].panels.some(p => p.type === 'actions'), false);
    const tried = applyUpdate({ type: 'pool_show', id: 'actions', columnIndex: 0 }, hidden);
    eq(tried.arrange.columns[0].panels.some(p => p.type === 'actions'), false,
      'actions did NOT land in first column');
    eq(tried, hidden, 'reducer returns the slice unchanged');
  });
});

describe('[poolDragRelease] emits Cmds + clears drag', () => {
  it('valid insert drop → pool_show with index + force_full_repaint', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 1);  // actions top → insert at right:0
    const [next, cmds] = mpoolDrag.poolDragRelease(s);
    eq(next.freeConfig.drag, null, 'drag cleared');
    eq(next.panelList.open, false, 'overlay closed on successful drop');
    eq(cmds.length, 2);
    eq(cmds[0].type, 'msg');
    eq(cmds[0].msg.kind, 'layout');
    eq(cmds[0].msg.msg.type, 'pool_show');
    eq(cmds[0].msg.msg.id, 'notes');
    eq(cmds[0].msg.msg.columnIndex, 1);
    eq(cmds[0].msg.msg.index, 0);
    eq(cmds[1].type, 'force_full_repaint');
  });
  it('valid replace drop → pool_hide(occupant) + pool_show(source) + force_full_repaint', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 4);  // actions mid → replace
    const [next, cmds] = mpoolDrag.poolDragRelease(s);
    eq(cmds.length, 3);
    eq(cmds[0].msg.msg.type, 'pool_hide');
    eq(cmds[0].msg.msg.id, 'actions');
    eq(cmds[1].msg.msg.type, 'pool_show');
    eq(cmds[1].msg.msg.id, 'notes');
    eq(cmds[1].msg.msg.columnIndex, 1);
    // R2.1 — second hop carries _skipUndo so the compound op produces
    // a single undo entry (the pool_hide's snapshot). Without this,
    // `u` after a replace-drag would land on the half-state (occupant
    // hidden, source not yet placed) instead of pre-drag.
    eq(cmds[1].msg.msg._skipUndo, true, 'pool_show in replace skips its own undo push');
    eq(cmds[2].type, 'force_full_repaint');
  });
  it('invalid target (detail replace) → only force_full_repaint, drag cleared, overlay resumes', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 14);  // detail mid → replace (invalid)
    const [next, cmds] = mpoolDrag.poolDragRelease(s);
    eq(next.freeConfig.drag, null);
    eq(next.panelList.open, true, 'overlay reopened (was open at drag start)');
    eq(cmds.length, 1);
    eq(cmds[0].type, 'force_full_repaint');
  });
  it('release without motion (no target) → only force_full_repaint, drag cleared', () => {
    const s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    const [next, cmds] = mpoolDrag.poolDragRelease(s);
    eq(next.freeConfig.drag, null);
    eq(cmds.length, 1);
    eq(cmds[0].type, 'force_full_repaint');
  });
});

describe('[end-to-end] layout.update threads pool_drag_* Msgs to the leaf', () => {
  it('pool_drag_start sets the drag + emits force_full_repaint, hides overlay', () => {
    const [next, cmds] = layout.update({ type: 'pool_drag_start', id: 'notes', mx: 50, my: 5 }, buildSlice());
    eq(next.freeConfig.drag.kind, 'pool-armed');
    eq(next.panelList.open, false, 'overlay closed for drop-target visibility');
    eq(cmds[0].type, 'force_full_repaint');
  });
  it('pool_drag_motion computes target + force_full_repaint Cmd', () => {
    const [armed] = layout.update({ type: 'pool_drag_start', id: 'notes', mx: 50, my: 5 }, buildSlice());
    const result = layout.update({ type: 'pool_drag_motion', mx: 50, my: 30 }, armed);
    assert(Array.isArray(result), 'motion now returns [slice, cmds] (overlay repaint)');
    const [moving, cmds] = result;
    eq(moving.freeConfig.drag.target.kind, 'insert');
    eq(cmds[0].type, 'force_full_repaint');
  });
  it('pool_drag_release returns the [next, cmds] tuple', () => {
    const [armed] = layout.update({ type: 'pool_drag_start', id: 'notes', mx: 50, my: 5 }, buildSlice());
    const [moving] = layout.update({ type: 'pool_drag_motion', mx: 50, my: 30 }, armed);
    const result = layout.update({ type: 'pool_drag_release' }, moving);
    assert(Array.isArray(result), 'returns tuple');
    const [next, cmds] = result;
    eq(next.freeConfig.drag, null);
    eq(cmds[0].msg.msg.type, 'pool_show');
  });
  it('motion between two distinct insert indices emits force_full_repaint', () => {
    // Regression: a prior _dropTargetsEqual missed `index`, so moving from
    // insert@0 to insert@1 (same column, same kind, both undefined occupant)
    // returned "equal" → no repaint, stale preview.
    const [armed] = layout.update({ type: 'pool_drag_start', id: 'notes', mx: 50, my: 5 }, buildSlice());
    const [atTop] = layout.update({ type: 'pool_drag_motion', mx: 50, my: 1 }, armed);     // actions top → insert@0
    eq(atTop.freeConfig.drag.target.kind, 'insert');
    eq(atTop.freeConfig.drag.target.index, 0);
    const result = layout.update({ type: 'pool_drag_motion', mx: 50, my: 6 }, atTop);      // actions bot → insert@1
    assert(Array.isArray(result), 'index change → tuple with repaint cmd');
    const [moved, cmds] = result;
    eq(moved.freeConfig.drag.target.index, 1);
    eq(cmds[0].type, 'force_full_repaint');
  });
});

describe('[pool_show with index] reducer splices at position', () => {
  it('pool_show with index=0 prepends to right column (before actions), clamped before detail', () => {
    const s = buildSlice();
    const next = applyUpdate({ type: 'pool_show', id: 'notes', columnIndex: 1, index: 0 }, s);
    eq(next.arrange.columns[1].panels.length, 3);
    eq(next.arrange.columns[1].panels[0].type, 'viewer', 'notes (viewer-type) prepended');
    eq(next.arrange.columns[1].panels[1].type, 'actions');
    eq(next.arrange.columns[1].panels[2].type, 'detail', 'detail still at end');
  });
  it('pool_show with index=1 inserts between actions and detail (allowed)', () => {
    const s = buildSlice();
    const next = applyUpdate({ type: 'pool_show', id: 'notes', columnIndex: 1, index: 1 }, s);
    eq(next.arrange.columns[1].panels[0].type, 'actions');
    eq(next.arrange.columns[1].panels[1].type, 'viewer');
    eq(next.arrange.columns[1].panels[2].type, 'detail', 'detail still at end');
  });
  it('pool_show with index=99 (past detail) clamps to detail position', () => {
    const s = buildSlice();
    const next = applyUpdate({ type: 'pool_show', id: 'notes', columnIndex: 1, index: 99 }, s);
    // index clamped to length=2, then clamped to detailIdx=1 → notes lands before detail
    eq(next.arrange.columns[1].panels[1].type, 'viewer');
    eq(next.arrange.columns[1].panels[2].type, 'detail');
  });
  it('pool_show without index appends (existing behavior preserved)', () => {
    const s = buildSlice();
    const next = applyUpdate({ type: 'pool_show', id: 'notes', columnIndex: 0 }, s);
    eq(next.arrange.columns[0].panels[next.arrange.columns[0].panels.length - 1].type, 'viewer');
  });
  it('pool_show with index for left column splices at position', () => {
    const s = buildSlice();
    const next = applyUpdate({ type: 'pool_show', id: 'notes', columnIndex: 0, index: 1 }, s);
    eq(next.arrange.columns[0].panels[0].type, 'groups');
    eq(next.arrange.columns[0].panels[1].type, 'viewer');
    eq(next.arrange.columns[0].panels[2].type, 'files');
  });
});

// Pool-drag preview-arrange snapshots: drag.previewArrange is what render
// swaps slice.arrange for during the drag-render pass. Must match what
// pool_show / pool_hide would do on release.
describe('[computePoolDragPreviewArrange] what-if snapshot', () => {
  it('insert preview adds the source panel at the target index', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 6);  // actions bot → insert at right:1
    const preview = mpoolDrag.computePoolDragPreviewArrange(s);
    eq(preview.columns[1].panels[0].type, 'actions');
    eq(preview.columns[1].panels[1].type, 'viewer',  'notes (viewer-type) inserted');
    eq(preview.columns[1].panels[2].type, 'detail',  'detail still at end');
  });
  it('replace preview swaps the source for the occupant', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 4);  // actions mid → replace
    const preview = mpoolDrag.computePoolDragPreviewArrange(s);
    eq(preview.columns[1].panels.length, 2, 'occupant out, source in — same length');
    eq(preview.columns[1].panels[0].type, 'viewer', 'notes replaces actions');
    eq(preview.columns[1].panels[1].type, 'detail');
  });
  it('insert into left column splices at the target index', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 5, 5);
    s = mpoolDrag.poolDragMotion(s, 5, 1);  // groups top → insert at left:0
    const preview = mpoolDrag.computePoolDragPreviewArrange(s);
    eq(preview.columns[0].panels[0].type, 'viewer');
    eq(preview.columns[0].panels[1].type, 'groups');
    eq(preview.columns[0].panels[2].type, 'files');
  });
  it('invalid target → preview is null', () => {
    let s = mpoolDrag.poolDragStart(buildSlice(), 'notes', 50, 5);
    s = mpoolDrag.poolDragMotion(s, 50, 14);  // detail mid → invalid replace
    const preview = mpoolDrag.computePoolDragPreviewArrange(s);
    eq(preview, null);
  });
  it('no drag → preview is null', () => {
    const s = buildSlice();
    const preview = mpoolDrag.computePoolDragPreviewArrange(s);
    eq(preview, null);
  });
});

report();
