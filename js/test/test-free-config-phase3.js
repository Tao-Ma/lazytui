/**
 * Design Mode v2 Phase 3 — undo/redo, drag-to-resize, title edit,
 * and `:restore-layout` (via rebuildLayoutFromConfig).
 *
 * Pins behavior for Phase 3 of the Design Mode v2 plan:
 *   /root/.claude/plans/staged-tinkering-crayon.md
 *
 * What's covered:
 *   1. pointToResizeTarget hit-test math (col separator ±1 tolerance,
 *      detail-top exact row, priority of col over detail-top).
 *   2. Undo/redo state-machine round-trip across key-driven mutations,
 *      drag-resize, drag-and-drop, and title-edit commit.
 *   3. Title-edit buffer: append printable, backspace, Esc cancel,
 *      Enter commit. Pushes one undo entry.
 *   4. rebuildLayoutFromConfig: pure fn, takes a parsed config,
 *      returns a fresh layout struct. The :restore-layout cmdline
 *      builds on this.
 *
 * Run: node js/test/test-design-phase3.js
 */
'use strict';

const { rebuildLayoutFromConfig } = require('../leaves/arrange');
const {
  titleEditText,
  onMouseEvent, pointToResizeTarget,
  _clearUndoStacks, _getUndoDepth, _getRedoDepth,
} = require('../render/free-config-view');
const dispatch = require('../dispatch/dispatch');
const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');
const { describe, it, assert, eq, report } = require('./test-runner');

// Design mode lives on layout's slice (post-Phase-6 single-writer cleanup):
// entry is a wrapped `free_config_enter` Msg into layout; keys route through the
// modeChain handler (freeConfigMode / freeConfigTitleEditMode). These shims keep
// the existing call sites driving the REAL path.
function enterFreeConfig() {
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('layout', { type: 'free_config_enter' }));
}
function press(key, seq) { dispatch._dispatchActiveMode(key, seq); }
function handleFreeConfigKey(key) { press(key, key); }
function handleFreeConfigTitleEditKey(key, seq) { press(key, seq); }

// ----- Fixture -----
// Same shape as test-design-drag.js fixture. Reset before every it().

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
  getModel().modes.freeConfigTitleEditMode = false;
  getInstanceSlice('layout').dirty = false;
  // Pin focus to the first placed panel before entering design — every
  // it() in this file is written from the assumption that selectedIdx=0
  // = containers on entry, and `free_config_enter` now preserves focus when
  // it points at a placed panel (no longer resets to all[0]), so a
  // leftover focus from a prior test would otherwise leak in.
  getInstanceSlice('layout').focus = 'containers';
  _clearUndoStacks();
  enterFreeConfig(getInstanceSlice("layout").arrange, '/dev/null', () => {});
}

// ===============================================================
describe('[1] pointToResizeTarget — separator hit-tests', () => {
  // y=2 is inside actions (y=0,h=5), not on any boundary (boundaries
  // sit at y=5, y=10, y=15). Used wherever we want to isolate
  // col-separator hit-tests from the boundary hit-tests.
  it('column separator at exactly x=leftWidth → edge=col', () => {
    setupFixture();
    eq(pointToResizeTarget(30, 2).edge, 'col');
  });
  it('column separator at x=leftWidth-1 → edge=col (tolerance)', () => {
    setupFixture();
    eq(pointToResizeTarget(29, 2).edge, 'col');
  });
  it('column separator at x=leftWidth+1 → edge=col (tolerance)', () => {
    setupFixture();
    eq(pointToResizeTarget(31, 2).edge, 'col');
  });
  it('out of tolerance (x=27 or x=33) → not col', () => {
    setupFixture();
    const t27 = pointToResizeTarget(27, 2);
    eq(t27, null, 'x=27 → null');
    const t33 = pointToResizeTarget(33, 2);
    assert(t33 === null || t33.edge !== 'col', `x=33 → not col (got ${JSON.stringify(t33)})`);
  });
  it('detail-top row inside last column → edge=panel-boundary with detail as lower', () => {
    setupFixture();
    const t = pointToResizeTarget(50, 15);
    eq(t.edge, 'panel-boundary');
    eq(t.columnIndex, 1);
    eq(t.boundary.lower.type, 'detail');
  });
  it('detail-top row at column separator → corner (both axes drag)', () => {
    setupFixture();
    const t = pointToResizeTarget(30, 15);
    eq(t.edge, 'corner');
    eq(t.boundary.lower.type, 'detail');
  });
  it('row well inside a panel (no boundary near) → no hit outside col-sep', () => {
    setupFixture();
    eq(pointToResizeTarget(50, 12), null, 'mx=50 my=12 (inside stats) → null');
  });
  it('within-column boundary in last col (stats/actions seam, y=5) → panel-boundary', () => {
    setupFixture();
    const t = pointToResizeTarget(60, 5);
    eq(t.edge, 'panel-boundary');
    eq(t.columnIndex, 1);
    eq(t.boundary.upper.type, 'actions');
    eq(t.boundary.lower.type, 'stats');
  });
  it('within-column boundary in first col (containers/groups seam, y=10) → panel-boundary', () => {
    setupFixture();
    const t = pointToResizeTarget(10, 10);
    eq(t.edge, 'panel-boundary');
    eq(t.columnIndex, 0);
    eq(t.boundary.upper.type, 'containers');
    eq(t.boundary.lower.type, 'groups');
  });
});

// ===============================================================
describe('[2] drag-to-resize — column separator', () => {
  // y=2 keeps these pure col-separator hits (no boundary nearby).
  it('press on col separator then motion shrinks first column width', () => {
    setupFixture();
    onMouseEvent('press',  30, 2);
    onMouseEvent('motion', 24, 2);
    eq(getInstanceSlice("layout").arrange.columns[0].width, 25, 'col0.width = mx + 1 = 25');
    eq(getInstanceSlice('layout').dirty, true);
  });
  it('motion clamps at lower bound (20)', () => {
    setupFixture();
    onMouseEvent('press',  30, 2);
    onMouseEvent('motion',  5, 2);
    eq(getInstanceSlice("layout").arrange.columns[0].width, 20);
  });
  it('motion clamps at upper bound (60)', () => {
    setupFixture();
    onMouseEvent('press',  30, 2);
    onMouseEvent('motion', 99, 2);
    eq(getInstanceSlice("layout").arrange.columns[0].width, 60);
  });
  it('release ends resize gesture', () => {
    setupFixture();
    onMouseEvent('press',   30, 2);
    onMouseEvent('motion',  40, 2);
    onMouseEvent('release', 40, 2);
    // Further motion should NOT change column width (drag is over)
    onMouseEvent('motion', 20, 2);
    eq(getInstanceSlice("layout").arrange.columns[0].width, 41, 'col0.width unchanged after release');
  });
  it('single undo entry pushed for the whole drag', () => {
    setupFixture();
    const depthBefore = _getUndoDepth();
    onMouseEvent('press',   30, 2);
    // Multiple motions during the drag
    onMouseEvent('motion',  35, 2);
    onMouseEvent('motion',  40, 2);
    onMouseEvent('motion',  45, 2);
    onMouseEvent('release', 45, 2);
    eq(_getUndoDepth(), depthBefore + 1, 'only one undo entry pushed for the gesture');
  });
});

// ===============================================================
describe('[3] drag-to-resize — detail-panel top edge', () => {
  it('press on detail-top, drag up grows detailHeightPct', () => {
    setupFixture();
    // detail.y=15, bottomY=40, rightColTotal=40 (rightTop=0)
    // Drag from y=15 up to y=10 → newDetailH = 40-10 = 30
    // pct = 30/40 * 100 = 75
    onMouseEvent('press',  50, 15);
    onMouseEvent('motion', 50, 10);
    eq(getInstanceSlice("layout").arrange.detailHeightPct, 75);
    eq(getInstanceSlice('layout').dirty, true);
  });
  it('drag down shrinks detailHeightPct, clamped at dynamic min (13% on availH=40)', () => {
    setupFixture();
    const { detailMinPct } = require('../leaves/free-config');
    onMouseEvent('press',  50, 15);
    onMouseEvent('motion', 50, 36);  // newDetailH = 4 rows; clamps to DETAIL_MIN_ROWS=5
    // detailMinPct(40) = max(5, ceil(5/40*100)) = 13 — five rows is the
    // physical floor (legible viewer slice); the dynamic % follows.
    eq(getInstanceSlice("layout").arrange.detailHeightPct, detailMinPct(40));
  });
});

// ===============================================================
describe('[3a] drag-to-resize — within-column boundary (left col)', () => {
  // Boundary between containers (y=0..9) and groups (y=10..19) at y=10.
  // availH for left col = 20. press at (10, 10) → left-boundary drag.
  it('press + motion redistributes containers/groups heightPct', () => {
    setupFixture();
    onMouseEvent('press',  10, 10);
    onMouseEvent('motion', 10,  6);  // drag boundary up to y=6
    // upperStartY=0, combinedH=20, availH=20.
    // proposedUpperH = max(3, min(17, 6)) = 6. proposedLowerH = 14.
    // containers.heightPct = round(6/20*100) = 30. groups = round(14/20*100) = 70.
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].heightPct, 30, 'containers anchored');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[1].heightPct, 70, 'groups anchored');
    eq(getInstanceSlice('layout').dirty, true);
  });
  it('drag clamps so each side stays ≥ MIN_PANEL_H (3 rows)', () => {
    setupFixture();
    onMouseEvent('press',  10, 10);
    onMouseEvent('motion', 10,  0);  // drag boundary to row 0 (would zero containers)
    // proposedUpperH = max(3, min(17, 0)) = 3. proposedLowerH = 17.
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].heightPct, 15, 'containers floored at minH=3 (3/20=15)');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[1].heightPct, 85);
  });
});

describe('[3b] drag-to-resize — within-column boundary (right col, non-detail)', () => {
  // Boundary between actions (y=0..4) and stats (y=5..14) at y=5.
  // press at (60, 5) → right-boundary, both non-detail.
  it('press + motion redistributes actions/stats heightPct, detail untouched', () => {
    setupFixture();
    const prevDetail = getInstanceSlice("layout").arrange.detailHeightPct;
    onMouseEvent('press',  60, 5);
    onMouseEvent('motion', 60, 8);  // boundary moves down → actions grows
    // upperStartY=0, combinedH=actions.h(5)+stats.h(10)=15, availH=40.
    // proposedUpperH = max(3, min(12, 8)) = 8. proposedLowerH = 7.
    // actions.heightPct = round(8/40*100) = 20. stats = round(7/40*100) = 18.
    eq(getInstanceSlice("layout").arrange.columns[1].panels[0].heightPct, 20, 'actions anchored');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[1].heightPct, 18, 'stats anchored');
    eq(getInstanceSlice("layout").arrange.detailHeightPct, prevDetail, 'detailHeightPct untouched');
  });
});

describe('[3c] drag-to-resize — corner (col-separator × right boundary)', () => {
  // Intersection: x=leftWidth(30) AND y=detail.y(15). press at (30, 15) → corner.
  it('single gesture adjusts both leftWidth and detailHeightPct', () => {
    setupFixture();
    onMouseEvent('press',  30, 15);
    onMouseEvent('motion', 35, 12);  // diagonal NE → leftW grows, detail grows
    // Col axis: leftW = 35+1 = 36.
    // Height axis: upper=stats (y=5,h=10), lower=detail (y=15,h=25).
    //   upperStartY=5, combinedH=35, availH=40, detailIsLower.
    //   proposedUpperH = max(3, min(32, 12-5)) = 7. proposedLowerH = 28.
    //   detailHeightPct = round(28/40*100) = 70. stats.heightPct = round(7/40*100) = 18.
    eq(getInstanceSlice("layout").arrange.columns[0].width, 36, 'col0.width follows mx');
    eq(getInstanceSlice("layout").arrange.detailHeightPct, 70, 'detailHeightPct follows my');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[1].heightPct, 18, 'stats anchored from the height axis');
  });
});

describe('[3c2] drag-to-resize — corner (col-separator × first-col boundary)', () => {
  // Intersection: x=col0.width(30) AND y=containers/groups boundary(10) →
  // corner. The boundary at x=30 falls equidistant between col0 and col1;
  // with col1 having no panel boundary at y=10, the hit-test falls back
  // to col0's containers/groups seam so a corner-resize at the LEFT col's
  // boundary stays reachable from the column separator.
  it('press at col0 boundary y engages corner-resize for col0', () => {
    setupFixture();
    onMouseEvent('press',  30, 10);
    onMouseEvent('motion', 26, 14);  // diagonal SW → col0 width shrinks, containers heightPct grows
    eq(getInstanceSlice("layout").arrange.columns[0].width, 27, 'col0.width follows mx');
    // boundary axis: upper=containers, lower=groups, combinedH=20.
    // proposedUpperH = max(3, min(17, 14-0)) = 14. proposedLowerH = 6.
    // containers heightPct = round(14/20*100) = 70.
    // groups heightPct = round(6/20*100) = 30.
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].heightPct, 70, 'containers heightPct grew');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[1].heightPct, 30, 'groups heightPct shrank');
  });
});

describe('[3d] press freezes flex panels in the dragged column', () => {
  it('pressing right-col boundary anchors actions even though only stats/detail dragged', () => {
    setupFixture();
    eq(getInstanceSlice("layout").arrange.columns[1].panels[0].heightPct, undefined, 'actions starts flex');
    onMouseEvent('press', 60, 15);  // press on stats/detail boundary
    // freezeColumnFlex runs on press — actions (not in the drag pair,
    // not detail, no existing heightPct) gets anchored to its current
    // rendered share: round(5/40*100) = 13.
    eq(getInstanceSlice("layout").arrange.columns[1].panels[0].heightPct, 13, 'actions frozen at its rendered pct');
  });
});

describe('[3f] keyboard `]` / `[` — focused panel heightPct', () => {
  it('] grows focused left panel, steals from neighbor below', () => {
    setupFixture();
    // selectedIdx=0 (containers). availH=20 (left col).
    // containers starts flex (h=10 → 50%). groups also flex (h=10 → 50%).
    handleFreeConfigKey(']');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].heightPct, 55, 'containers +5');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[1].heightPct, 45, 'groups -5 (stolen from)');
  });
  it('[ shrinks focused panel, gives to neighbor below', () => {
    setupFixture();
    handleFreeConfigKey('[');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].heightPct, 45);
    eq(getInstanceSlice("layout").arrange.columns[0].panels[1].heightPct, 55);
  });
  it('detail focused → ] / [ are no-ops (use +/- instead)', () => {
    setupFixture();
    // Fixture has 5 panels total; idx=4 (last) is detail.
    handleFreeConfigKey('j'); handleFreeConfigKey('j'); handleFreeConfigKey('j'); handleFreeConfigKey('j');
    eq(getInstanceSlice("layout").arrange.columns[1].panels[2].type, 'detail');
    const prevDetail = getInstanceSlice("layout").arrange.detailHeightPct;
    handleFreeConfigKey(']');
    eq(getInstanceSlice("layout").arrange.detailHeightPct, prevDetail, 'detail untouched by `]`');
  });
  it('last panel in column → ] no-op (nothing to steal from)', () => {
    setupFixture();
    handleFreeConfigKey('j');  // → groups (last in left col)
    handleFreeConfigKey(']');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[1].heightPct, undefined, 'no mutation');
  });
  it('] respects detail dynamic-min clamp when stealing from detail', () => {
    setupFixture();
    // Focus stats (right col, idx=3 in all). stats is just above detail.
    // detail starts at 60%. Repeated `]` should stop at detail hitting
    // the dynamic min (detailMinPct(availH) = 13% on availH=40).
    const { detailMinPct } = require('../leaves/free-config');
    handleFreeConfigKey('j'); handleFreeConfigKey('j'); handleFreeConfigKey('j');  // → stats
    eq(getInstanceSlice("layout").arrange.columns[1].panels[1].type, 'stats');
    for (let i = 0; i < 20; i++) handleFreeConfigKey(']');
    const got = getInstanceSlice("layout").arrange.detailHeightPct;
    assert(got >= detailMinPct(40), `detail clamped at dynamic min ${detailMinPct(40)} (got ${got})`);
  });
});

// ===============================================================
describe('[3e] calcLayout — heightPct distribution', () => {
  const { calcLayout } = require('../render/layout');
  function freshLayout() {
    getInstanceSlice("layout").arrange = {
      detailHeightPct: 60,
      columns: [
        { width: 30, panels: [
          { type: 'containers', id: 'containers', title: 'C', columnIndex: 0, hotkey: '1' },
          { type: 'groups',     id: 'groups',     title: 'G', columnIndex: 0, hotkey: '2' },
        ] },
        { panels: [
          { type: 'actions', id: 'actions', title: 'A', columnIndex: 1, hotkey: '0' },
          { type: 'stats',   id: 'stats',   title: 'S', columnIndex: 1, hotkey: '' },
          { type: 'detail',  id: 'detail',  title: 'D', columnIndex: 1, hotkey: 'o' },
        ] },
      ],
    };
  }
  // ROWS=30 with empty register → strip suppressed → availH = ROWS - 1 = 29.
  // (v0.6 switched the strip from always-reserved to active-only.)
  it('all-flex left col splits equally', () => {
    freshLayout();
    process.stdout.columns = 100; process.stdout.rows = 30; // availH = 29
    calcLayout();
    eq(require('../render/layout')._getPanelHeights().containers, 14);
    eq(require('../render/layout')._getPanelHeights().groups, 15, 'two flex split 29: 14 + 15 (last gets leftover)');
  });
  it('anchored heightPct claims its share, flex absorbs remainder', () => {
    freshLayout();
    getInstanceSlice("layout").arrange.columns[0].panels[0].heightPct = 70;  // containers fixed at 70%
    process.stdout.columns = 100; process.stdout.rows = 30; // availH = 29
    calcLayout();
    eq(require('../render/layout')._getPanelHeights().containers, 20, 'floor(29 * 0.7) = 20');
    eq(require('../render/layout')._getPanelHeights().groups, 9, 'flex remainder');
  });
  it('oversubscribed anchored values scale proportionally', () => {
    freshLayout();
    getInstanceSlice("layout").arrange.columns[0].panels[0].heightPct = 90;
    getInstanceSlice("layout").arrange.columns[0].panels[1].heightPct = 90;
    process.stdout.columns = 100; process.stdout.rows = 30; // availH = 29
    calcLayout();
    eq(require('../render/layout')._getPanelHeights().containers + require('../render/layout')._getPanelHeights().groups, 29, 'column fills availH after scaling');
    assert(require('../render/layout')._getPanelHeights().containers >= 3, 'containers ≥ minH');
    assert(require('../render/layout')._getPanelHeights().groups >= 3, 'groups ≥ minH');
  });
});

// ===============================================================
describe('[4] undo / redo — round-trip across mutation types', () => {
  it('key reorder is undoable and redoable', () => {
    setupFixture();
    // Move groups to top via 'K' on the focused panel (selectedIdx=0 = containers).
    // Easier: focus groups (idx=1) then K to swap up.
    handleFreeConfigKey('j');  // sel: containers → groups
    handleFreeConfigKey('K');  // swap groups up
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'groups');
    eq(_getUndoDepth(), 1);

    handleFreeConfigKey('u');  // undo
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'containers');
    eq(_getUndoDepth(), 0);
    eq(_getRedoDepth(), 1);

    handleFreeConfigKey('ctrl-r');  // redo
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'groups');
    eq(_getUndoDepth(), 1);
    eq(_getRedoDepth(), 0);
  });

  it('drop is undoable', () => {
    setupFixture();
    // Drag containers from left to bottom of left col
    onMouseEvent('press',   5, 2);
    onMouseEvent('motion',  5, 17);
    onMouseEvent('release', 5, 17);
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'groups');
    eq(_getUndoDepth(), 1);

    handleFreeConfigKey('u');
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].type, 'containers');
    eq(_getRedoDepth(), 1);
  });

  it('new mutation after undo invalidates redo history', () => {
    setupFixture();
    handleFreeConfigKey('j');
    handleFreeConfigKey('K');                    // mutation 1 (undoDepth=1)
    handleFreeConfigKey('u');                    // undo (redoDepth=1)
    eq(_getRedoDepth(), 1);
    // Post-v0.6.x: focus follows the PANEL (not the slot), so after
    // `K u` focus is still on 'groups'. Reorder it again to make a
    // new mutation that should invalidate redo.
    handleFreeConfigKey('K');                    // mutation 2 (a different timeline)
    eq(_getRedoDepth(), 0, 'redo cleared by new mutation');
  });

  it('undo on empty stack is a no-op', () => {
    setupFixture();
    handleFreeConfigKey('u');
    eq(_getUndoDepth(), 0);
    eq(_getRedoDepth(), 0);
  });

  it('redo on empty stack is a no-op', () => {
    setupFixture();
    handleFreeConfigKey('ctrl-r');
    eq(_getRedoDepth(), 0);
  });
});

// ===============================================================
describe('[5] title-edit sub-mode', () => {
  it('typing builds the buffer, backspace edits', () => {
    setupFixture();
    handleFreeConfigKey('t');
    eq(getModel().modes.freeConfigTitleEditMode, true);
    eq(titleEditText(), 'Containers', 'pre-filled with current title');

    handleFreeConfigTitleEditKey('backspace');
    handleFreeConfigTitleEditKey('backspace');
    eq(titleEditText(), 'Containe');

    handleFreeConfigTitleEditKey('x', 'x');
    handleFreeConfigTitleEditKey('y', 'y');
    eq(titleEditText(), 'Containexy');
  });

  it('Enter commits + clears sub-mode + pushes undo', () => {
    setupFixture();
    const depthBefore = _getUndoDepth();
    handleFreeConfigKey('t');
    handleFreeConfigTitleEditKey('backspace');
    handleFreeConfigTitleEditKey('z', 'z');
    handleFreeConfigTitleEditKey('return');

    eq(getModel().modes.freeConfigTitleEditMode, false);
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].title, 'Containerz');
    eq(getInstanceSlice('layout').dirty, true);
    eq(_getUndoDepth(), depthBefore + 1);
  });

  it('Esc cancels — no commit, no undo entry, sub-mode cleared', () => {
    setupFixture();
    const depthBefore = _getUndoDepth();
    handleFreeConfigKey('t');
    handleFreeConfigTitleEditKey('q', 'q');
    handleFreeConfigTitleEditKey('escape');

    eq(getModel().modes.freeConfigTitleEditMode, false);
    eq(getInstanceSlice("layout").arrange.columns[0].panels[0].title, 'Containers', 'title NOT changed');
    eq(_getUndoDepth(), depthBefore, 'no undo entry pushed on cancel');
  });

  it('Enter with unchanged title is a no-op (no undo entry)', () => {
    setupFixture();
    const depthBefore = _getUndoDepth();
    handleFreeConfigKey('t');
    // No editing — Enter with title === panel.title
    handleFreeConfigTitleEditKey('return');

    eq(_getUndoDepth(), depthBefore, 'no undo entry for no-op commit');
  });
});

// ===============================================================
describe('[6] rebuildLayoutFromConfig — pure fn for :restore-layout', () => {
  it('builds a fresh layout from a parsed config', () => {
    const cfg = {
      groups: { g1: { containers: ['c1'] } },
      layout: {
        columns: [
          { width: 35, panels: [{ id: 'containers', type: 'containers', title: 'Containers' }] },
          { panels: [
            { id: 'stats', type: 'stats', title: 'Stats', config: { topic: 'docker.stats' } },
            { id: 'detail', type: 'detail', title: 'Detail' },
          ] },
        ],
        detail_height_pct: 70,
      },
    };
    const ly = rebuildLayoutFromConfig(cfg);
    eq(ly.columns[0].width, 35);
    eq(ly.detailHeightPct, 70);
    eq(ly.columns[0].panels.length, 1);
    eq(ly.columns[0].panels[0].type, 'containers');
    eq(ly.columns[0].panels[0].columnIndex, 0);
    eq(ly.columns[0].panels[0].hotkey, '1');
    eq(ly.columns[1].panels.length, 2);
    eq(ly.columns[1].panels[0].topic, 'docker.stats', 'plugin config keys spread onto panel');
  });

  it('returns a fresh object on each call (no mutation across calls)', () => {
    const cfg = {
      groups: { g1: { containers: ['c1'] } },
      layout: {
        columns: [
          { panels: [{ id: 'containers', type: 'containers', title: 'Containers' }] },
          { panels: [{ id: 'detail', type: 'detail', title: 'Detail' }] },
        ],
      },
    };
    const a = rebuildLayoutFromConfig(cfg);
    const b = rebuildLayoutFromConfig(cfg);
    assert(a !== b, 'distinct outer object');
    assert(a.columns !== b.columns, 'distinct columns array');
    assert(a.columns[0].panels[0] !== b.columns[0].panels[0], 'distinct panel objects');
  });
});

report();
