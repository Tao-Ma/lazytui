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

const { rebuildLayoutFromConfig } = require('../app/state');
const {
  titleEditText,
  onMouseEvent, pointToResizeTarget,
  _clearUndoStacks, _getUndoDepth, _getRedoDepth,
} = require('../overlay/design');
const dispatch = require('../dispatch/dispatch');
const { getModel } = require('../app/runtime');
const { getComponentSlice } = require('../panel/api');
const { describe, it, assert, eq, report } = require('./test-runner');

// Design mode lives on layout's slice (post-Phase-6 single-writer cleanup):
// entry is a wrapped `design_enter` Msg into layout; keys route through the
// modeChain handler (designMode / designTitleEditMode). These shims keep
// the existing call sites driving the REAL path.
function enterDesign() {
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('layout', { type: 'design_enter' }));
}
function press(key, seq) { dispatch._dispatchActiveMode(key, seq); }
function handleDesignKey(key) { press(key, key); }
function handleDesignTitleEditKey(key, seq) { press(key, seq); }

// ----- Fixture -----
// Same shape as test-design-drag.js fixture. Reset before every it().

function setupFixture() {
  getComponentSlice("layout").arrange = {
    leftWidth: 30, detailHeightPct: 60,
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
  getComponentSlice('layout').panelBounds = {
    containers: { x:  0, y:  0, w: 30, h: 10 },
    groups:     { x:  0, y: 10, w: 30, h: 10 },
    actions:    { x: 30, y:  0, w: 90, h:  5 },
    stats:      { x: 30, y:  5, w: 90, h: 10 },
    detail:     { x: 30, y: 15, w: 90, h: 25 },
  };
  getModel().modes.designMode = false;
  getModel().modes.designTitleEditMode = false;
  getComponentSlice('layout').dirty = false;
  _clearUndoStacks();
  enterDesign(getComponentSlice("layout").arrange, '/dev/null', () => {});
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
  it('detail-top row inside right column → edge=right-boundary with detail as lower', () => {
    setupFixture();
    const t = pointToResizeTarget(50, 15);
    eq(t.edge, 'right-boundary');
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
  it('within-column boundary in right col (stats/actions seam, y=5) → right-boundary', () => {
    setupFixture();
    const t = pointToResizeTarget(60, 5);
    eq(t.edge, 'right-boundary');
    eq(t.boundary.upper.type, 'actions');
    eq(t.boundary.lower.type, 'stats');
  });
  it('within-column boundary in left col (containers/groups seam, y=10) → left-boundary', () => {
    setupFixture();
    const t = pointToResizeTarget(10, 10);
    eq(t.edge, 'left-boundary');
    eq(t.boundary.upper.type, 'containers');
    eq(t.boundary.lower.type, 'groups');
  });
});

// ===============================================================
describe('[2] drag-to-resize — column separator', () => {
  // y=2 keeps these pure col-separator hits (no boundary nearby).
  it('press on col separator then motion shrinks leftWidth', () => {
    setupFixture();
    onMouseEvent('press',  30, 2);
    onMouseEvent('motion', 24, 2);
    eq(getComponentSlice("layout").arrange.leftWidth, 25, 'leftWidth = mx + 1 = 25');
    eq(getComponentSlice('layout').dirty, true);
  });
  it('motion clamps at lower bound (20)', () => {
    setupFixture();
    onMouseEvent('press',  30, 2);
    onMouseEvent('motion',  5, 2);
    eq(getComponentSlice("layout").arrange.leftWidth, 20);
  });
  it('motion clamps at upper bound (60)', () => {
    setupFixture();
    onMouseEvent('press',  30, 2);
    onMouseEvent('motion', 99, 2);
    eq(getComponentSlice("layout").arrange.leftWidth, 60);
  });
  it('release ends resize gesture', () => {
    setupFixture();
    onMouseEvent('press',   30, 2);
    onMouseEvent('motion',  40, 2);
    onMouseEvent('release', 40, 2);
    // Further motion should NOT change leftWidth (drag is over)
    onMouseEvent('motion', 20, 2);
    eq(getComponentSlice("layout").arrange.leftWidth, 41, 'leftWidth unchanged after release');
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
    eq(getComponentSlice("layout").arrange.detailHeightPct, 75);
    eq(getComponentSlice('layout').dirty, true);
  });
  it('drag down shrinks detailHeightPct, clamped at 20', () => {
    setupFixture();
    onMouseEvent('press',  50, 15);
    onMouseEvent('motion', 50, 36);  // newDetailH = 4 → 10% but clamped to 20
    eq(getComponentSlice("layout").arrange.detailHeightPct, 20);
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
    eq(getComponentSlice("layout").arrange.leftPanels[0].heightPct, 30, 'containers anchored');
    eq(getComponentSlice("layout").arrange.leftPanels[1].heightPct, 70, 'groups anchored');
    eq(getComponentSlice('layout').dirty, true);
  });
  it('drag clamps so each side stays ≥ MIN_PANEL_H (3 rows)', () => {
    setupFixture();
    onMouseEvent('press',  10, 10);
    onMouseEvent('motion', 10,  0);  // drag boundary to row 0 (would zero containers)
    // proposedUpperH = max(3, min(17, 0)) = 3. proposedLowerH = 17.
    eq(getComponentSlice("layout").arrange.leftPanels[0].heightPct, 15, 'containers floored at minH=3 (3/20=15)');
    eq(getComponentSlice("layout").arrange.leftPanels[1].heightPct, 85);
  });
});

describe('[3b] drag-to-resize — within-column boundary (right col, non-detail)', () => {
  // Boundary between actions (y=0..4) and stats (y=5..14) at y=5.
  // press at (60, 5) → right-boundary, both non-detail.
  it('press + motion redistributes actions/stats heightPct, detail untouched', () => {
    setupFixture();
    const prevDetail = getComponentSlice("layout").arrange.detailHeightPct;
    onMouseEvent('press',  60, 5);
    onMouseEvent('motion', 60, 8);  // boundary moves down → actions grows
    // upperStartY=0, combinedH=actions.h(5)+stats.h(10)=15, availH=40.
    // proposedUpperH = max(3, min(12, 8)) = 8. proposedLowerH = 7.
    // actions.heightPct = round(8/40*100) = 20. stats = round(7/40*100) = 18.
    eq(getComponentSlice("layout").arrange.rightPanels[0].heightPct, 20, 'actions anchored');
    eq(getComponentSlice("layout").arrange.rightPanels[1].heightPct, 18, 'stats anchored');
    eq(getComponentSlice("layout").arrange.detailHeightPct, prevDetail, 'detailHeightPct untouched');
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
    eq(getComponentSlice("layout").arrange.leftWidth, 36, 'leftWidth follows mx');
    eq(getComponentSlice("layout").arrange.detailHeightPct, 70, 'detailHeightPct follows my');
    eq(getComponentSlice("layout").arrange.rightPanels[1].heightPct, 18, 'stats anchored from the height axis');
  });
});

describe('[3c2] drag-to-resize — left-side corner (col-separator × left boundary)', () => {
  // Intersection: x=leftWidth(30) AND y=10 (containers/groups seam).
  // Regression: a previous version only checked colMatch×rightB for the
  // corner, so col-sep × left-boundary fell through to plain 'col' and
  // the boundary axis didn't move.
  it('single gesture adjusts both leftWidth and left-col panel heightPcts', () => {
    setupFixture();
    onMouseEvent('press',  30, 10);
    onMouseEvent('motion', 26, 14);  // diagonal SW → leftW shrinks, boundary down
    // Col axis: leftW = 26+1 = 27.
    // Height axis: upper=containers (y=0,h=10), lower=groups (y=10,h=10).
    //   upperStartY=0, combinedH=20, availH=20.
    //   proposedUpperH = max(3, min(17, 14)) = 14. proposedLowerH = 6.
    //   containers.heightPct = round(14/20*100) = 70.
    //   groups.heightPct = round(6/20*100) = 30.
    eq(getComponentSlice("layout").arrange.leftWidth, 27, 'leftWidth follows mx');
    eq(getComponentSlice("layout").arrange.leftPanels[0].heightPct, 70, 'containers anchored from height axis');
    eq(getComponentSlice("layout").arrange.leftPanels[1].heightPct, 30, 'groups anchored from height axis');
  });
});

describe('[3d] press freezes flex panels in the dragged column', () => {
  it('pressing right-col boundary anchors actions even though only stats/detail dragged', () => {
    setupFixture();
    eq(getComponentSlice("layout").arrange.rightPanels[0].heightPct, undefined, 'actions starts flex');
    onMouseEvent('press', 60, 15);  // press on stats/detail boundary
    // freezeColumnFlex runs on press — actions (not in the drag pair,
    // not detail, no existing heightPct) gets anchored to its current
    // rendered share: round(5/40*100) = 13.
    eq(getComponentSlice("layout").arrange.rightPanels[0].heightPct, 13, 'actions frozen at its rendered pct');
  });
});

describe('[3f] keyboard `]` / `[` — focused panel heightPct', () => {
  it('] grows focused left panel, steals from neighbor below', () => {
    setupFixture();
    // selectedIdx=0 (containers). availH=20 (left col).
    // containers starts flex (h=10 → 50%). groups also flex (h=10 → 50%).
    handleDesignKey(']');
    eq(getComponentSlice("layout").arrange.leftPanels[0].heightPct, 55, 'containers +5');
    eq(getComponentSlice("layout").arrange.leftPanels[1].heightPct, 45, 'groups -5 (stolen from)');
  });
  it('[ shrinks focused panel, gives to neighbor below', () => {
    setupFixture();
    handleDesignKey('[');
    eq(getComponentSlice("layout").arrange.leftPanels[0].heightPct, 45);
    eq(getComponentSlice("layout").arrange.leftPanels[1].heightPct, 55);
  });
  it('detail focused → ] / [ are no-ops (use +/- instead)', () => {
    setupFixture();
    // Fixture has 5 panels total; idx=4 (last) is detail.
    handleDesignKey('j'); handleDesignKey('j'); handleDesignKey('j'); handleDesignKey('j');
    eq(getComponentSlice("layout").arrange.rightPanels[2].type, 'detail');
    const prevDetail = getComponentSlice("layout").arrange.detailHeightPct;
    handleDesignKey(']');
    eq(getComponentSlice("layout").arrange.detailHeightPct, prevDetail, 'detail untouched by `]`');
  });
  it('last panel in column → ] no-op (nothing to steal from)', () => {
    setupFixture();
    handleDesignKey('j');  // → groups (last in left col)
    handleDesignKey(']');
    eq(getComponentSlice("layout").arrange.leftPanels[1].heightPct, undefined, 'no mutation');
  });
  it('] respects detail [20,90] clamp when stealing from detail', () => {
    setupFixture();
    // Focus stats (right col, idx=3 in all). stats is just above detail.
    // detail starts at 60%. Repeated `]` should stop at detail hitting 20%.
    handleDesignKey('j'); handleDesignKey('j'); handleDesignKey('j');  // → stats
    eq(getComponentSlice("layout").arrange.rightPanels[1].type, 'stats');
    for (let i = 0; i < 20; i++) handleDesignKey(']');
    assert(getComponentSlice("layout").arrange.detailHeightPct >= 20, `detail clamped at min 20 (got ${getComponentSlice("layout").arrange.detailHeightPct})`);
  });
});

// ===============================================================
describe('[3e] calcLayout — heightPct distribution', () => {
  const { calcLayout } = require('../render/layout');
  function freshLayout() {
    getComponentSlice("layout").arrange = {
      leftWidth: 30, detailHeightPct: 60,
      leftPanels: [
        { type: 'containers', title: 'C', column: 'left', hotkey: '1' },
        { type: 'groups',     title: 'G', column: 'left', hotkey: '2' },
      ],
      rightPanels: [
        { type: 'actions', title: 'A', column: 'right', hotkey: '0' },
        { type: 'stats',   title: 'S', column: 'right', hotkey: '' },
        { type: 'detail',  title: 'D', column: 'right', hotkey: 'o' },
      ],
    };
  }
  it('all-flex left col splits equally', () => {
    freshLayout();
    process.stdout.columns = 100; process.stdout.rows = 30; // availH = 28 (rows-2: footer + register strip)
    calcLayout();
    eq(getComponentSlice('layout').panelHeights.containers, 14);
    eq(getComponentSlice('layout').panelHeights.groups, 14, 'two flex panels share 28 evenly');
  });
  it('anchored heightPct claims its share, flex absorbs remainder', () => {
    freshLayout();
    getComponentSlice("layout").arrange.leftPanels[0].heightPct = 70;  // containers fixed at 70%
    process.stdout.columns = 100; process.stdout.rows = 30; // availH = 28
    calcLayout();
    eq(getComponentSlice('layout').panelHeights.containers, 19, 'floor(28 * 0.7) = 19');
    eq(getComponentSlice('layout').panelHeights.groups, 9, 'flex remainder');
  });
  it('oversubscribed anchored values scale proportionally', () => {
    freshLayout();
    getComponentSlice("layout").arrange.leftPanels[0].heightPct = 90;
    getComponentSlice("layout").arrange.leftPanels[1].heightPct = 90;
    process.stdout.columns = 100; process.stdout.rows = 30; // availH = 28
    calcLayout();
    eq(getComponentSlice('layout').panelHeights.containers + getComponentSlice('layout').panelHeights.groups, 28, 'column fills availH after scaling');
    assert(getComponentSlice('layout').panelHeights.containers >= 3, 'containers ≥ minH');
    assert(getComponentSlice('layout').panelHeights.groups >= 3, 'groups ≥ minH');
  });
});

// ===============================================================
describe('[4] undo / redo — round-trip across mutation types', () => {
  it('key reorder is undoable and redoable', () => {
    setupFixture();
    // Move groups to top via 'K' on the focused panel (selectedIdx=0 = containers).
    // Easier: focus groups (idx=1) then K to swap up.
    handleDesignKey('j');  // sel: containers → groups
    handleDesignKey('K');  // swap groups up
    eq(getComponentSlice("layout").arrange.leftPanels[0].type, 'groups');
    eq(_getUndoDepth(), 1);

    handleDesignKey('u');  // undo
    eq(getComponentSlice("layout").arrange.leftPanels[0].type, 'containers');
    eq(_getUndoDepth(), 0);
    eq(_getRedoDepth(), 1);

    handleDesignKey('ctrl-r');  // redo
    eq(getComponentSlice("layout").arrange.leftPanels[0].type, 'groups');
    eq(_getUndoDepth(), 1);
    eq(_getRedoDepth(), 0);
  });

  it('drop is undoable', () => {
    setupFixture();
    // Drag containers from left to bottom of left col
    onMouseEvent('press',   5, 2);
    onMouseEvent('motion',  5, 17);
    onMouseEvent('release', 5, 17);
    eq(getComponentSlice("layout").arrange.leftPanels[0].type, 'groups');
    eq(_getUndoDepth(), 1);

    handleDesignKey('u');
    eq(getComponentSlice("layout").arrange.leftPanels[0].type, 'containers');
    eq(_getRedoDepth(), 1);
  });

  it('new mutation after undo invalidates redo history', () => {
    setupFixture();
    handleDesignKey('j');
    handleDesignKey('K');                    // mutation 1 (undoDepth=1)
    handleDesignKey('u');                    // undo (redoDepth=1)
    eq(_getRedoDepth(), 1);
    handleDesignKey('j');
    handleDesignKey('K');                    // mutation 2 (a different timeline)
    eq(_getRedoDepth(), 0, 'redo cleared by new mutation');
  });

  it('undo on empty stack is a no-op', () => {
    setupFixture();
    handleDesignKey('u');
    eq(_getUndoDepth(), 0);
    eq(_getRedoDepth(), 0);
  });

  it('redo on empty stack is a no-op', () => {
    setupFixture();
    handleDesignKey('ctrl-r');
    eq(_getRedoDepth(), 0);
  });
});

// ===============================================================
describe('[5] title-edit sub-mode', () => {
  it('typing builds the buffer, backspace edits', () => {
    setupFixture();
    handleDesignKey('t');
    eq(getModel().modes.designTitleEditMode, true);
    eq(titleEditText(), 'Containers', 'pre-filled with current title');

    handleDesignTitleEditKey('backspace');
    handleDesignTitleEditKey('backspace');
    eq(titleEditText(), 'Containe');

    handleDesignTitleEditKey('x', 'x');
    handleDesignTitleEditKey('y', 'y');
    eq(titleEditText(), 'Containexy');
  });

  it('Enter commits + clears sub-mode + pushes undo', () => {
    setupFixture();
    const depthBefore = _getUndoDepth();
    handleDesignKey('t');
    handleDesignTitleEditKey('backspace');
    handleDesignTitleEditKey('z', 'z');
    handleDesignTitleEditKey('return');

    eq(getModel().modes.designTitleEditMode, false);
    eq(getComponentSlice("layout").arrange.leftPanels[0].title, 'Containerz');
    eq(getComponentSlice('layout').dirty, true);
    eq(_getUndoDepth(), depthBefore + 1);
  });

  it('Esc cancels — no commit, no undo entry, sub-mode cleared', () => {
    setupFixture();
    const depthBefore = _getUndoDepth();
    handleDesignKey('t');
    handleDesignTitleEditKey('q', 'q');
    handleDesignTitleEditKey('escape');

    eq(getModel().modes.designTitleEditMode, false);
    eq(getComponentSlice("layout").arrange.leftPanels[0].title, 'Containers', 'title NOT changed');
    eq(_getUndoDepth(), depthBefore, 'no undo entry pushed on cancel');
  });

  it('Enter with unchanged title is a no-op (no undo entry)', () => {
    setupFixture();
    const depthBefore = _getUndoDepth();
    handleDesignKey('t');
    // No editing — Enter with title === panel.title
    handleDesignTitleEditKey('return');

    eq(_getUndoDepth(), depthBefore, 'no undo entry for no-op commit');
  });
});

// ===============================================================
describe('[6] rebuildLayoutFromConfig — pure fn for :restore-layout', () => {
  it('builds a fresh layout from a parsed config', () => {
    const cfg = {
      groups: { g1: { containers: ['c1'] } },
      layout: {
        left_panels: [{ type: 'containers', title: 'Containers' }],
        right_panels: [
          { type: 'stats', title: 'Stats', config: { topic: 'docker.stats' } },
          { type: 'detail', title: 'Detail' },
        ],
        left_width: 35,
        detail_height_pct: 70,
      },
    };
    const ly = rebuildLayoutFromConfig(cfg);
    eq(ly.leftWidth, 35);
    eq(ly.detailHeightPct, 70);
    eq(ly.leftPanels.length, 1);
    eq(ly.leftPanels[0].type, 'containers');
    eq(ly.leftPanels[0].column, 'left');
    eq(ly.leftPanels[0].hotkey, '1');
    eq(ly.rightPanels.length, 2);
    eq(ly.rightPanels[0].topic, 'docker.stats', 'plugin config keys spread onto panel');
  });

  it('returns a fresh object on each call (no mutation across calls)', () => {
    const cfg = {
      groups: { g1: { containers: ['c1'] } },
      layout: {
        left_panels: [{ type: 'containers', title: 'Containers' }],
        right_panels: [{ type: 'detail', title: 'Detail' }],
      },
    };
    const a = rebuildLayoutFromConfig(cfg);
    const b = rebuildLayoutFromConfig(cfg);
    assert(a !== b, 'distinct outer object');
    assert(a.leftPanels !== b.leftPanels, 'distinct leftPanels array');
    assert(a.leftPanels[0] !== b.leftPanels[0], 'distinct panel objects');
  });
});

report();
