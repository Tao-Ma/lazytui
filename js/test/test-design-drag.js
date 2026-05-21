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
 *   5. S.layoutDirty set on valid drops, NOT set on snap-back
 *   6. Cross-column drag mutates correctly (splice from source, insert
 *      at target, with index adjustment for same-column drag where
 *      the splice shifts the target index)
 *
 * Run: node js/test/test-design-drag.js
 */
'use strict';

const { S } = require('../state');
const { enterDesign, onMouseEvent, pointToDropTarget, _getDragState } = require('../design');
const { describe, it, assert, eq, report } = require('./test-runner');

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
  S.layout = {
    leftWidth: 30,
    detailHeightPct: 60,
    leftPanels: [
      { type: 'containers', title: 'Containers', column: 'left',  hotkey: '1' },
      { type: 'groups',     title: 'Groups',     column: 'left',  hotkey: '2' },
    ],
    rightPanels: [
      { type: 'actions', title: 'Actions', column: 'right', hotkey: '0' },
      { type: 'stats',   title: 'Stats',   column: 'right', hotkey: '' },
      { type: 'detail',  title: 'Detail',  column: 'right', hotkey: 'o' },
    ],
  };
  S.panelBounds = {
    containers: { x:  0, y:  0, w: 30, h: 10 },
    groups:     { x:  0, y: 10, w: 30, h: 10 },
    actions:    { x: 30, y:  0, w: 90, h:  5 },
    stats:      { x: 30, y:  5, w: 90, h: 10 },
    detail:     { x: 30, y: 15, w: 90, h: 25 },
  };
  S.designMode = false;
  S.layoutDirty = false;
  enterDesign(S.layout, '/dev/null', () => {});
}

// ===============================================================
describe('[1] pointToDropTarget — drop position math', () => {
  setupFixture();

  it('top half of containers → insert at left:0', () => {
    // (5, 2) — well inside containers, top half
    eq(JSON.stringify(pointToDropTarget('stats', 5, 2)),
       JSON.stringify({ column: 'left', index: 0, valid: true }));
  });

  it('bottom half of containers → insert at left:1 (between containers and groups)', () => {
    // (5, 7) — bottom half of containers
    eq(JSON.stringify(pointToDropTarget('stats', 5, 7)),
       JSON.stringify({ column: 'left', index: 1, valid: true }));
  });

  it('bottom half of last left panel (groups) → append at left:2', () => {
    eq(JSON.stringify(pointToDropTarget('stats', 5, 17)),
       JSON.stringify({ column: 'left', index: 2, valid: true }));
  });

  it('top half of actions → insert at right:0', () => {
    eq(JSON.stringify(pointToDropTarget('containers', 50, 1)),
       JSON.stringify({ column: 'right', index: 0, valid: true }));
  });

  it('bottom half of detail → append at right:3', () => {
    eq(JSON.stringify(pointToDropTarget('containers', 50, 35)),
       JSON.stringify({ column: 'right', index: 3, valid: true }));
  });

  it('between stats and detail (top half of detail) → right:2', () => {
    // detail.y=15, h=25 → top half is y in [15, 27.5)
    eq(JSON.stringify(pointToDropTarget('containers', 50, 16)),
       JSON.stringify({ column: 'right', index: 2, valid: true }));
  });

  it('detail panel into left column → blocked (invalid)', () => {
    const t = pointToDropTarget('detail', 5, 2);
    eq(t.column, 'left');
    eq(t.valid, false);
    assert(t.reason.includes('detail'), `reason mentions detail (got "${t.reason}")`);
  });

  it('actions panel into left column → blocked (invalid)', () => {
    const t = pointToDropTarget('actions', 5, 2);
    eq(t.valid, false);
  });

  it('containers into right column is fine (valid)', () => {
    eq(pointToDropTarget('containers', 50, 2).valid, true);
  });

  it('point above all panels but inside left x-range → insert at left:0', () => {
    // Position outside left x is null; inside x but above first panel
    // is handled by "my < b.y" branch.
    eq(JSON.stringify(pointToDropTarget('stats', 5, 0)),
       JSON.stringify({ column: 'left', index: 0, valid: true }));
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
    eq(ds.target.column, 'left');
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
    eq(S.layout.leftPanels.length, 2);
    eq(S.layout.leftPanels[0].type, 'groups',     'groups now first');
    eq(S.layout.leftPanels[1].type, 'containers', 'containers now last');
    eq(S.layoutDirty, true);
  });

  it('release with no motion → click (no mutation, no dirty)', () => {
    setupFixture();
    onMouseEvent('press',   5, 2);
    onMouseEvent('release', 5, 2);
    eq(_getDragState(), null);
    eq(S.layoutDirty, false);
    eq(S.layout.leftPanels[0].type, 'containers');
  });

  it('release on invalid target → snap back, no mutation, no dirty', () => {
    setupFixture();
    // Try to drag detail into left column — blocked
    onMouseEvent('press',   50, 20);  // press inside detail
    onMouseEvent('motion',   5, 2);
    onMouseEvent('release',  5, 2);
    eq(_getDragState(), null);
    eq(S.layoutDirty, false);
    eq(S.layout.rightPanels[2].type, 'detail', 'detail still in right column');
  });

  it('release outside any column → no mutation', () => {
    setupFixture();
    onMouseEvent('press',   5, 2);
    onMouseEvent('motion', 200, 200);  // off-screen
    onMouseEvent('release', 200, 200);
    eq(S.layoutDirty, false);
    eq(S.layout.leftPanels[0].type, 'containers');
  });
});

// ===============================================================
describe('[3] cross-column drag — splice / insert math', () => {
  it('drag containers from left → insert before stats (right:1)', () => {
    setupFixture();
    onMouseEvent('press',   5, 2);   // press containers
    onMouseEvent('motion', 50, 6);   // top half of stats
    onMouseEvent('release', 50, 6);

    eq(S.layout.leftPanels.length, 1, 'one panel left in left col');
    eq(S.layout.leftPanels[0].type, 'groups');
    eq(S.layout.rightPanels[0].type, 'actions');
    eq(S.layout.rightPanels[1].type, 'containers');  // inserted before stats
    eq(S.layout.rightPanels[2].type, 'stats');
    eq(S.layout.rightPanels[3].type, 'detail');
    eq(S.layoutDirty, true);
  });

  it('same-column reorder: drag groups upward past containers', () => {
    setupFixture();
    // Press groups (y=15), motion to top of containers (y=2)
    onMouseEvent('press',   5, 15);
    onMouseEvent('motion',  5,  2);
    onMouseEvent('release', 5,  2);

    eq(S.layout.leftPanels[0].type, 'groups',     'groups moved to top');
    eq(S.layout.leftPanels[1].type, 'containers');
  });

  it('same-column drag to same position is a no-op (drag-back)', () => {
    setupFixture();
    onMouseEvent('press',   5, 2);    // press containers
    onMouseEvent('motion',  5, 4);    // motion within containers
    onMouseEvent('release', 5, 4);    // release still in containers
    // Top half of containers = drop before containers = inserts where it
    // already is → no order change but dirty flag DOES flip (the splice
    // happens). That's acceptable — same shape applied to same shape.
    // Order assertion is what matters:
    eq(S.layout.leftPanels[0].type, 'containers');
    eq(S.layout.leftPanels[1].type, 'groups');
  });
});

report();
