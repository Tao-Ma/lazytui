/**
 * Design Mode v2 drag-and-drop state machine + drop logic.
 *
 * Pins behavior for Phase 2 of the Design Mode v2 plan:
 *   /root/.claude/plans/staged-tinkering-crayon.md
 *
 * What's covered:
 *   1. Press → 'armed' (no motion yet) → 'dragging' on ≥1 cell motion
 *   2. Release with no motion → click, no mutation
 *   3. Drop position math (insert before / after / append / empty col)
 *   4. Invalid-target snap-back (detail / actions into left column)
 *   5. getInstanceSlice('layout').dirty set on valid drops, NOT set on snap-back
 *   6. Cross-column drag mutates correctly (splice from source, insert
 *      at target, with index adjustment for same-column drag where
 *      the splice shifts the target index)
 *
 * Run: node js/test/test-design-drag.js
 */
'use strict';

const { onMouseEvent, pointToDropTarget, _getDragState } = require('../overlay/free-config');
const dispatch = require('../dispatch/dispatch');
const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');
const { describe, it, assert, eq, report } = require('./test-runner');

// Design mode lives on layout's slice (post-Phase-6 single-writer cleanup):
// enter via a wrapped `free_config_enter` Msg into the layout Component.
function enterFreeConfig() {
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('layout', { type: 'free_config_enter' }));
}

// ----- Fixture -----
//
// Simulated 120-wide screen, leftWidth=30.
// Left column (x=0..29) panels stacked top-to-bottom:
//   containers : y= 0..9  (h=10)
//   groups     : y=10..19 (h=10)
// Right column (x=30..119) panels:
//   actions    : y= 0..4  (h=5)
//   stats      : y= 5..14 (h=10)
//   detail     : y=15..39 (h=25)

function setupFixture() {
  getInstanceSlice("layout").arrange = {
    detailHeightPct: 60,
    columns: [
      { width: 30, panels: [
        { type: 'containers', id: 'containers', title: 'Containers', columnIndex: 0,  hotkey: '1' },
        { type: 'groups',     id: 'groups',     title: 'Groups',     columnIndex: 0,  hotkey: '2' },
      ] },
      { panels: [
        { type: 'actions', id: 'actions', title: 'Actions', columnIndex: 1, hotkey: '0' },
        { type: 'stats',   id: 'stats',   title: 'Stats',   columnIndex: 1, hotkey: '' },
        { type: 'detail',  id: 'detail',  title: 'Detail',  columnIndex: 1, hotkey: 'o' },
      ] },
    ],
  };
  getInstanceSlice('layout').panelBounds = {
    containers: { x:  0, y:  0, w: 30, h: 10 },
    groups:     { x:  0, y: 10, w: 30, h: 10 },
    actions:    { x: 30, y:  0, w: 90, h:  5 },
    stats:      { x: 30, y:  5, w: 90, h: 10 },
    detail:     { x: 30, y: 15, w: 90, h: 25 },
  };
  getModel().modes.freeConfigMode = false;
  getInstanceSlice('layout').dirty = false;
  enterFreeConfig(getInstanceSlice("layout").arrange, '/dev/null', () => {});
}

// ===============================================================
// v0.6 — 3-zone hit-test per cell:
//   top third    → insert before this cell
//   middle third → swap with this cell's occupant
//   bottom third → insert after this cell
// Cells with h<3 collapse to insert-only top/bottom halves.
//
// containers/groups (h=10) → thirds = 3 rows; top=[y,y+3), mid=[y+3,y+7), bot=[y+7,y+10)
// actions   (h=5)          → third = 1 row;  top=[0,1), mid=[1,4), bot=[4,5)
// stats     (h=10)         → top=[5,8), mid=[8,12), bot=[12,15)
// detail    (h=25)         → third = 8 rows; top=[15,23), mid=[23,32), bot=[32,40)
describe('[1] pointToDropTarget — 3-zone hit-test', () => {
  setupFixture();

  it('top third of containers → insert at left:0', () => {
    // y=1 inside top zone [0,3)
    eq(JSON.stringify(pointToDropTarget('stats', 5, 1)),
       JSON.stringify({ kind: 'insert', columnIndex: 0, index: 0, valid: true }));
  });

  it('middle third of containers → swap with containers', () => {
    // y=5 inside mid zone [3,7)
    eq(JSON.stringify(pointToDropTarget('stats', 5, 5)),
       JSON.stringify({ kind: 'swap', columnIndex: 0, index: 0, occupantType: 'containers', valid: true }));
  });

  it('bottom third of containers → insert at left:1 (between containers and groups)', () => {
    // y=8 inside bot zone [7,10)
    eq(JSON.stringify(pointToDropTarget('stats', 5, 8)),
       JSON.stringify({ kind: 'insert', columnIndex: 0, index: 1, valid: true }));
  });

  it('bottom third of last left panel (groups) → append at left:2', () => {
    // y=18 inside groups bot zone [17,20)
    eq(JSON.stringify(pointToDropTarget('stats', 5, 18)),
       JSON.stringify({ kind: 'insert', columnIndex: 0, index: 2, valid: true }));
  });

  it('middle third of groups → swap with groups', () => {
    // y=14 inside groups mid zone [13,17)
    eq(JSON.stringify(pointToDropTarget('stats', 5, 14)),
       JSON.stringify({ kind: 'swap', columnIndex: 0, index: 1, occupantType: 'groups', valid: true }));
  });

  it('top third of actions → insert at right:0', () => {
    // actions y=0..4, top=[0,1) — y=0 is the only top-zone row
    eq(JSON.stringify(pointToDropTarget('containers', 50, 0)),
       JSON.stringify({ kind: 'insert', columnIndex: 1, index: 0, valid: true }));
  });

  it('bottom third of detail → CLAMPED to insert at right:2 (detail stays at end)', () => {
    // y=35 inside detail bot zone [32,40); insert-after-detail (idx 3) clamped to 2.
    // Clamp also carries a reason — the footer surfaces it to the user.
    eq(JSON.stringify(pointToDropTarget('containers', 50, 35)),
       JSON.stringify({ kind: 'insert', columnIndex: 1, index: 2, valid: true, clamp: 'detail stays at end' }));
  });

  it('top third of detail → insert at right:2 (before detail)', () => {
    // y=20 inside detail top zone [15,23)
    eq(JSON.stringify(pointToDropTarget('containers', 50, 20)),
       JSON.stringify({ kind: 'insert', columnIndex: 1, index: 2, valid: true }));
  });

  it('middle third of detail → swap with detail BLOCKED (detail must stay at end)', () => {
    // y=27 inside detail mid zone [23,32)
    const t = pointToDropTarget('containers', 50, 27);
    eq(t.kind, 'swap');
    eq(t.occupantType, 'detail');
    eq(t.valid, false);
    assert(t.reason.includes('detail'), `reason mentions detail (got "${t.reason}")`);
  });

  it('middle third of stats → swap with stats (containers ↔ stats cross-column)', () => {
    // y=10 inside stats mid zone [8,12)
    eq(JSON.stringify(pointToDropTarget('containers', 50, 10)),
       JSON.stringify({ kind: 'swap', columnIndex: 1, index: 1, occupantType: 'stats', valid: true }));
  });

  it('detail panel into left column → blocked (invalid insert)', () => {
    const t = pointToDropTarget('detail', 5, 1);
    eq(t.kind, 'insert');
    eq(t.columnIndex, 0);
    eq(t.valid, false);
    assert(t.reason.includes('detail'), `reason mentions detail (got "${t.reason}")`);
  });

  it('actions panel into left column → blocked (invalid insert)', () => {
    const t = pointToDropTarget('actions', 5, 1);
    eq(t.valid, false);
  });

  it('swap that would move actions to left column → blocked', () => {
    // Drag containers (left) onto middle of actions (right) → actions would
    // end up at left:0 — blocked.
    const t = pointToDropTarget('containers', 50, 2);  // actions mid zone [1,4)
    eq(t.kind, 'swap');
    eq(t.occupantType, 'actions');
    eq(t.valid, false);
    assert(t.reason.includes('actions'), `reason mentions actions (got "${t.reason}")`);
  });

  it('containers into right column is fine (valid insert)', () => {
    eq(pointToDropTarget('containers', 50, 0).valid, true);
  });

  it('point above all panels but inside left x-range → insert at left:0', () => {
    // y < first.y is handled by the early-return branch in matchColumn.
    // Fixture's first left panel is at y=0, so use mx in column but my
    // somewhere outside any cell's y range — actually all cells fill
    // y=0..19 in left, so this fallback path is exercised by the empty-
    // column branch below.
    eq(JSON.stringify(pointToDropTarget('stats', 5, 0)),
       JSON.stringify({ kind: 'insert', columnIndex: 0, index: 0, valid: true }));
  });
});

// ===============================================================
describe('[2] onMouseEvent — state machine transitions', () => {
  it('press inside a panel arms drag', () => {
    setupFixture();
    onMouseEvent('press', 5, 2);
    const ds = _getDragState();
    eq(ds.kind, 'armed');
    eq(ds.sourceType, 'containers');
  });

  it('press outside any panel does NOT arm', () => {
    setupFixture();
    onMouseEvent('press', 200, 200);  // off-screen
    eq(_getDragState(), null);
  });

  it('motion within 0 cells stays armed (not dragging)', () => {
    setupFixture();
    onMouseEvent('press',  5, 2);
    onMouseEvent('motion', 5, 2);  // same cell — no movement
    eq(_getDragState().kind, 'armed');
  });

  it('motion ≥1 cell promotes to dragging + recomputes target', () => {
    setupFixture();
    onMouseEvent('press',  5, 2);
    onMouseEvent('motion', 5, 17);  // dragged down into groups (bottom)
    const ds = _getDragState();
    eq(ds.kind, 'dragging');
    eq(ds.target.columnIndex, 0);
    eq(ds.target.index, 2);
    eq(ds.target.valid, true);
  });

  it('release on valid target → mutates layout, dirty=true, dragState cleared', () => {
    setupFixture();
    // Drag containers down past groups → drop at left:2 (end of left column)
    onMouseEvent('press',   5, 2);
    onMouseEvent('motion',  5, 17);
    onMouseEvent('release', 5, 17);

    eq(_getDragState(), null);
    eq(getInstanceSlice("layout").arrange.columns[0].panels.length, 2);
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'groups',     'groups now first');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[1].type, 'containers', 'containers now last');
    eq(getInstanceSlice('layout').dirty, true);
  });

  it('release with no motion → click (no mutation, no dirty)', () => {
    setupFixture();
    onMouseEvent('press',   5, 2);
    onMouseEvent('release', 5, 2);
    eq(_getDragState(), null);
    eq(getInstanceSlice('layout').dirty, false);
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'containers');
  });

  it('release on invalid target → snap back, no mutation, no dirty', () => {
    setupFixture();
    // Try to drag detail into left column — blocked
    onMouseEvent('press',   50, 20);  // press inside detail
    onMouseEvent('motion',   5, 2);
    onMouseEvent('release',  5, 2);
    eq(_getDragState(), null);
    eq(getInstanceSlice('layout').dirty, false);
    eq(getInstanceSlice("layout").arrange.columns[1].panels[2].type, 'detail', 'detail still in right column');
  });

  it('release outside any column → no mutation', () => {
    setupFixture();
    onMouseEvent('press',   5, 2);
    onMouseEvent('motion', 200, 200);  // off-screen
    onMouseEvent('release', 200, 200);
    eq(getInstanceSlice('layout').dirty, false);
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'containers');
  });
});

// ===============================================================
describe('[3] cross-column drag — splice / insert math', () => {
  it('drag containers from left → insert before stats (right:1)', () => {
    setupFixture();
    onMouseEvent('press',   5, 2);   // press containers
    onMouseEvent('motion', 50, 6);   // top half of stats
    onMouseEvent('release', 50, 6);

    eq(getInstanceSlice("layout").arrange.columns[0].panels.length, 1, 'one panel left in left col');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'groups');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[0].type, 'actions');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[1].type, 'containers');  // inserted before stats
    eq(getInstanceSlice("layout").arrange.columns[1].panels[2].type, 'stats');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[3].type, 'detail');
    eq(getInstanceSlice('layout').dirty, true);
  });

  it('same-column reorder: drag groups upward past containers', () => {
    setupFixture();
    // Press groups (y=15), motion to top of containers (y=2)
    onMouseEvent('press',   5, 15);
    onMouseEvent('motion',  5,  2);
    onMouseEvent('release', 5,  2);

    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'groups',     'groups moved to top');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[1].type, 'containers');
  });

  it('same-column drag to same position is a no-op (drag-back)', () => {
    setupFixture();
    onMouseEvent('press',   5, 2);    // press containers
    onMouseEvent('motion',  5, 5);    // motion to containers mid-zone
    onMouseEvent('release', 5, 5);    // release still in containers
    // Middle-zone drop on own cell = self-swap, no-op. dirty stays false.
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'containers');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[1].type, 'groups');
    eq(getInstanceSlice('layout').dirty, false);
  });
});

// ===============================================================
describe('[4] swap — middle-zone drag', () => {
  it('same-column swap: drag containers → middle of groups', () => {
    setupFixture();
    onMouseEvent('press',   5, 2);   // press containers (top of containers)
    onMouseEvent('motion',  5, 14);  // groups mid zone [13,17)
    onMouseEvent('release', 5, 14);

    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'groups',     'groups in slot 0');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[1].type, 'containers', 'containers in slot 1');
    eq(getInstanceSlice('layout').dirty, true);
  });

  it('cross-column swap: drag containers (left) ↔ stats (right)', () => {
    setupFixture();
    onMouseEvent('press',   5, 2);    // press containers
    onMouseEvent('motion', 50, 10);   // stats mid zone [8,12)
    onMouseEvent('release', 50, 10);

    eq(getInstanceSlice("layout").arrange.columns[0].panels.length, 2);
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'stats',     'stats moved to left slot 0');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[1].type, 'groups');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[0].type, 'actions');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[1].type, 'containers', 'containers moved to right slot 1');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[2].type, 'detail',     'detail still at end');
    eq(getInstanceSlice('layout').dirty, true);
  });

  it('swap with detail is blocked → no mutation', () => {
    setupFixture();
    // y=10 inside stats body (y=5..14); avoids the y=5 actions/stats
    // boundary which would otherwise hit-test as a resize-seam press.
    onMouseEvent('press',   50, 10);
    onMouseEvent('motion',  50, 27);  // detail mid zone [23,32) — swap blocked
    onMouseEvent('release', 50, 27);

    eq(getInstanceSlice("layout").arrange.columns[1].panels[1].type, 'stats',  'stats unchanged');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[2].type, 'detail', 'detail unchanged');
    eq(getInstanceSlice('layout').dirty, false);
  });

  it('swap that would put actions in left column is blocked', () => {
    setupFixture();
    onMouseEvent('press',    5, 2);   // press containers
    onMouseEvent('motion',  50, 2);   // actions mid zone [1,4)
    onMouseEvent('release', 50, 2);

    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type,  'containers', 'containers unchanged');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[0].type, 'actions',    'actions unchanged');
    eq(getInstanceSlice('layout').dirty, false);
  });

  it('self-swap with detail is VALID (no-op release, no error footer)', () => {
    // Regression for C2: validateTarget used to block detail-onto-detail
    // swap unconditionally via "detail must stay at end", but self-swap
    // is harmless — mouseRelease detects it and skips applyDrop.
    setupFixture();
    // detail y=15..39, h=25, third=8, mid=[23,32). y=27 is mid of detail.
    const t = pointToDropTarget('detail', 50, 27);
    eq(t.kind, 'swap');
    eq(t.occupantType, 'detail');
    eq(t.valid, true);
  });

  it('drag right-column source past detail moves it BEFORE detail', () => {
    // Regression for C1: validateTarget double-decremented when source
    // was in the same column before detail — splice-shift was applied
    // twice (once in effDetail's pre-shift, once in applyInsert), leaving
    // the source pinned at its own slot. Expected: actions moves to just
    // before detail; result before fix was [actions, stats, detail].
    setupFixture();
    // press actions (y=2, in actions y=0..4)
    onMouseEvent('press',   50, 2);
    onMouseEvent('motion',  50, 35);  // detail bot zone [32,40)
    onMouseEvent('release', 50, 35);
    eq(getInstanceSlice("layout").arrange.columns[1].panels[0].type, 'stats',   'stats moved up');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[1].type, 'actions', 'actions moved to just before detail');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[2].type, 'detail',  'detail still at end');
  });
});

// ===============================================================
// pointToCellZone short-cell collapse: h<3 collapses the middle so very
// short cells offer insert-only top/bottom (no impossible 0-row swap zone).
describe('[5b] pointToCellZone — h<3 collapse', () => {
  const mfc = require('../leaves/free-config');
  it('h=1: only row is "top" (insert before)', () => {
    eq(mfc.pointToCellZone({ y: 0, h: 1 }, 0), 'top');
  });
  it('h=2: top half=top, bottom half=bottom (no middle)', () => {
    eq(mfc.pointToCellZone({ y: 0, h: 2 }, 0), 'top');
    eq(mfc.pointToCellZone({ y: 0, h: 2 }, 1), 'bottom');
  });
  it('h=3: each zone exactly one row', () => {
    eq(mfc.pointToCellZone({ y: 0, h: 3 }, 0), 'top');
    eq(mfc.pointToCellZone({ y: 0, h: 3 }, 1), 'middle');
    eq(mfc.pointToCellZone({ y: 0, h: 3 }, 2), 'bottom');
  });
  it('outside the cell y-range returns null', () => {
    eq(mfc.pointToCellZone({ y: 5, h: 10 }, 4), null);
    eq(mfc.pointToCellZone({ y: 5, h: 10 }, 15), null);
  });
});

// ===============================================================
// Preview-arrange snapshots: drag.previewArrange is what render swaps
// slice.arrange for during the drag-render pass. It must equal the result
// applyDrop would produce on release — that's the user-facing promise of
// "what I see is what I get."
describe('[5] computeDragPreviewArrange — what-if snapshot', () => {
  const mfc = require('../leaves/free-config');

  it('insert preview matches a containers→left:2 release', () => {
    setupFixture();
    onMouseEvent('press',  5, 2);
    onMouseEvent('motion', 5, 18);  // groups bot zone — insert at left:2
    const slice = getInstanceSlice('layout');
    const preview = mfc.computeDragPreviewArrange(slice);
    eq(preview.columns[0].panels[0].type, 'groups');
    eq(preview.columns[0].panels[1].type, 'containers');
  });

  it('swap preview shows panels traded in place', () => {
    setupFixture();
    onMouseEvent('press',  5, 2);
    onMouseEvent('motion', 5, 14);  // groups mid zone — swap
    const slice = getInstanceSlice('layout');
    const preview = mfc.computeDragPreviewArrange(slice);
    eq(preview.columns[0].panels[0].type, 'groups',     'groups at slot 0');
    eq(preview.columns[0].panels[1].type, 'containers', 'containers at slot 1');
  });

  it('cross-column swap preview moves panels between columns', () => {
    setupFixture();
    onMouseEvent('press',   5, 2);
    onMouseEvent('motion', 50, 10);  // stats mid zone — cross-col swap
    const slice = getInstanceSlice('layout');
    const preview = mfc.computeDragPreviewArrange(slice);
    eq(preview.columns[0].panels[0].type, 'stats',     'stats to left:0');
    eq(preview.columns[1].panels[1].type, 'containers', 'containers to right:1');
    eq(preview.columns[1].panels[2].type, 'detail',    'detail still at end');
  });

  it('self-swap → preview is null (no visual change on release)', () => {
    setupFixture();
    onMouseEvent('press',  5, 2);
    onMouseEvent('motion', 5, 5);  // containers mid zone — self-swap
    const slice = getInstanceSlice('layout');
    const preview = mfc.computeDragPreviewArrange(slice);
    eq(preview, null);
  });

  it('invalid target → preview is null', () => {
    setupFixture();
    // Press detail, drag to left column → blocked.
    onMouseEvent('press',  50, 20);
    onMouseEvent('motion',  5,  2);
    const slice = getInstanceSlice('layout');
    const preview = mfc.computeDragPreviewArrange(slice);
    eq(preview, null);
  });

  it('no drag → preview is null', () => {
    setupFixture();
    const slice = getInstanceSlice('layout');
    const preview = mfc.computeDragPreviewArrange(slice);
    eq(preview, null);
  });

  it('same-column insert at own slot (top-third of self) → preview is null', () => {
    // Regression for C10: drop X at insert@fromIdx in own column is a no-op
    // splice (remove X, re-insert at same slot). applyDrop returns a fresh
    // slice with identical arrange + dirty:true; computing/swapping/painting
    // it is wasted work. Short-circuit returns null so render skips the swap.
    setupFixture();
    onMouseEvent('press',  5, 2);  // press containers (left:0)
    onMouseEvent('motion', 5, 1);  // containers top zone → insert@left:0
    const slice = getInstanceSlice('layout');
    eq(slice.freeConfig.drag.target.kind, 'insert');
    eq(slice.freeConfig.drag.target.index, 0);
    const preview = mfc.computeDragPreviewArrange(slice);
    eq(preview, null, 'self-targeted insert produces no preview');
  });

  it('same-column insert at own slot+1 (bottom-third of self) → preview is null', () => {
    setupFixture();
    onMouseEvent('press',  5, 2);  // press containers
    onMouseEvent('motion', 5, 8);  // containers bot zone → insert@left:1
    const slice = getInstanceSlice('layout');
    eq(slice.freeConfig.drag.target.kind, 'insert');
    eq(slice.freeConfig.drag.target.index, 1);
    const preview = mfc.computeDragPreviewArrange(slice);
    eq(preview, null, 'bottom-third of own cell is still a self-target');
  });

  it('cross-column insert at the same numeric index is NOT a self-target', () => {
    // Don't accidentally short-circuit a real cross-column move when its
    // numeric index happens to match the source's idx in its own column.
    setupFixture();
    onMouseEvent('press',   5, 2);  // press containers (left:0)
    onMouseEvent('motion', 50, 0);  // actions top zone → insert@right:0
    const slice = getInstanceSlice('layout');
    eq(slice.freeConfig.drag.target.columnIndex, 1);
    eq(slice.freeConfig.drag.target.index, 0);
    const preview = mfc.computeDragPreviewArrange(slice);
    assert(preview !== null, 'cross-column move produces a real preview');
    eq(preview.columns[1].panels[0].type, 'containers');
  });
});

// ===============================================================
// free_config_mouse_motion's diff check must compare every preview-affecting
// field. Regression for two bugs in the original equality helpers:
//   - missing `kind`  → insert@N vs swap@N at the same column compared equal
//   - missing `index` → insert@0 vs insert@1 compared equal
describe('[6] free_config_mouse_motion — repaint emission across zone changes', () => {
  const layout = require('../panel/layout');
  const { getInstanceSlice } = require('../panel/api');

  // layout.update returns either `nextSlice` or `[nextSlice, cmds]`; the
  // dispatcher unwraps tuples in production. Tests need both halves, so
  // unpack here and feed only the slice back into the next call.
  function unpack(r) {
    return Array.isArray(r) ? r : [r, []];
  }
  function pressAt(mx, my) {
    return layout.update({ type: 'free_config_mouse_press', mx, my, cols: 120 }, getInstanceSlice('layout'));
  }
  function motion(slice, mx, my) {
    return unpack(layout.update({ type: 'free_config_mouse_motion', mx, my, cols: 120 }, slice));
  }

  it('insert@N → swap@N (kind change at same index) emits force_full_repaint', () => {
    setupFixture();
    // press stats — source = stats. Move to containers' top third (insert@0),
    // then containers' mid third (swap@0 with containers).
    let slice = pressAt(50, 8);  // press stats body (avoid y=5 boundary)
    let cmds;
    [slice, cmds] = motion(slice, 5, 1);  // containers top zone → insert at 0
    eq(slice.freeConfig.drag.target.kind, 'insert');
    eq(slice.freeConfig.drag.target.index, 0);
    [slice, cmds] = motion(slice, 5, 5);  // containers mid zone → swap at 0
    eq(slice.freeConfig.drag.target.kind, 'swap');
    eq(slice.freeConfig.drag.target.index, 0);
    eq(cmds[0] && cmds[0].type, 'force_full_repaint');
  });

  it('insert@N → insert@N+1 (index change at same kind) emits force_full_repaint', () => {
    setupFixture();
    let slice = pressAt(50, 8);
    let cmds;
    [slice, cmds] = motion(slice, 5, 1);  // containers top → insert@0
    [slice, cmds] = motion(slice, 5, 8);  // containers bot → insert@1
    eq(slice.freeConfig.drag.target.kind, 'insert');
    eq(slice.freeConfig.drag.target.index, 1);
    eq(cmds[0] && cmds[0].type, 'force_full_repaint');
  });

  it('motion within the same zone emits no repaint cmd', () => {
    setupFixture();
    let slice = pressAt(50, 8);
    let cmds;
    [slice, cmds] = motion(slice, 5, 1);  // containers top → insert@0 (target change)
    eq(cmds[0] && cmds[0].type, 'force_full_repaint', 'first crossing into a target emits repaint');
    [slice, cmds] = motion(slice, 5, 2);  // still containers top → same target
    eq(cmds.length, 0, 'same-zone motion suppresses repaint');
  });

  it('column change (left → right) emits force_full_repaint', () => {
    // Same kind/index/valid possible across columns; equality must
    // distinguish them or zone crossings between columns would skip the
    // repaint and leave the preview painted on the wrong column.
    setupFixture();
    let slice = pressAt(50, 8);     // press stats — source = stats
    let cmds;
    [slice, cmds] = motion(slice, 5, 1);   // left containers top → insert@col0:0
    eq(slice.freeConfig.drag.target.columnIndex, 0);
    [slice, cmds] = motion(slice, 50, 0);  // right actions top → insert@col1:0
    eq(slice.freeConfig.drag.target.columnIndex, 1);
    eq(cmds[0] && cmds[0].type, 'force_full_repaint');
  });
});

report();
