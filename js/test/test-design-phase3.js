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

const { S, rebuildLayoutFromConfig } = require('../state');
const {
  enterDesign, handleDesignKey, handleDesignTitleEditKey, titleEditText,
  onMouseEvent, pointToResizeTarget,
  _clearUndoStacks, _getUndoDepth, _getRedoDepth,
} = require('../design');
const { describe, it, assert, eq, report } = require('./test-runner');

// ----- Fixture -----
// Same shape as test-design-drag.js fixture. Reset before every it().

function setupFixture() {
  S.layout = {
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
  S.panelBounds = {
    containers: { x:  0, y:  0, w: 30, h: 10 },
    groups:     { x:  0, y: 10, w: 30, h: 10 },
    actions:    { x: 30, y:  0, w: 90, h:  5 },
    stats:      { x: 30, y:  5, w: 90, h: 10 },
    detail:     { x: 30, y: 15, w: 90, h: 25 },
  };
  S.designMode = false;
  S.designTitleEditMode = false;
  S.layoutDirty = false;
  _clearUndoStacks();
  enterDesign(S.layout, '/dev/null', () => {});
}

// ===============================================================
describe('[1] pointToResizeTarget — separator hit-tests', () => {
  it('column separator at exactly x=leftWidth → edge=col', () => {
    setupFixture();
    eq(pointToResizeTarget(30, 5).edge, 'col');
  });
  it('column separator at x=leftWidth-1 → edge=col (tolerance)', () => {
    setupFixture();
    eq(pointToResizeTarget(29, 5).edge, 'col');
  });
  it('column separator at x=leftWidth+1 → edge=col (tolerance)', () => {
    setupFixture();
    eq(pointToResizeTarget(31, 5).edge, 'col');
  });
  it('out of tolerance (x=27 or x=33) → not col', () => {
    setupFixture();
    const t27 = pointToResizeTarget(27, 5);
    eq(t27, null, 'x=27 → null');
    const t33 = pointToResizeTarget(33, 5);
    assert(t33 === null || t33.edge !== 'col', `x=33 → not col (got ${JSON.stringify(t33)})`);
  });
  it('detail-top row inside right column → edge=detail', () => {
    setupFixture();
    // detail.y === 15, inside right column (mx > leftWidth+1 = 31)
    eq(pointToResizeTarget(50, 15).edge, 'detail');
  });
  it('detail-top row but at column separator → col wins (priority)', () => {
    setupFixture();
    // mx=30 is inside col-tolerance (29..31) — should be 'col' not 'detail'
    eq(pointToResizeTarget(30, 15).edge, 'col');
  });
  it('detail-top at non-top y → no hit', () => {
    setupFixture();
    eq(pointToResizeTarget(50, 16), null);
  });
});

// ===============================================================
describe('[2] drag-to-resize — column separator', () => {
  it('press on col separator then motion shrinks leftWidth', () => {
    setupFixture();
    onMouseEvent('press',  30, 5);
    onMouseEvent('motion', 24, 5);
    eq(S.layout.leftWidth, 25, 'leftWidth = mx + 1 = 25');
    eq(S.layoutDirty, true);
  });
  it('motion clamps at lower bound (20)', () => {
    setupFixture();
    onMouseEvent('press',  30, 5);
    onMouseEvent('motion',  5, 5);
    eq(S.layout.leftWidth, 20);
  });
  it('motion clamps at upper bound (60)', () => {
    setupFixture();
    onMouseEvent('press',  30, 5);
    onMouseEvent('motion', 99, 5);
    eq(S.layout.leftWidth, 60);
  });
  it('release ends resize gesture', () => {
    setupFixture();
    onMouseEvent('press',   30, 5);
    onMouseEvent('motion',  40, 5);
    onMouseEvent('release', 40, 5);
    // Further motion should NOT change leftWidth (drag is over)
    onMouseEvent('motion', 20, 5);
    eq(S.layout.leftWidth, 41, 'leftWidth unchanged after release');
  });
  it('single undo entry pushed for the whole drag', () => {
    setupFixture();
    const depthBefore = _getUndoDepth();
    onMouseEvent('press',   30, 5);
    // Multiple motions during the drag
    onMouseEvent('motion',  35, 5);
    onMouseEvent('motion',  40, 5);
    onMouseEvent('motion',  45, 5);
    onMouseEvent('release', 45, 5);
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
    eq(S.layout.detailHeightPct, 75);
    eq(S.layoutDirty, true);
  });
  it('drag down shrinks detailHeightPct, clamped at 20', () => {
    setupFixture();
    onMouseEvent('press',  50, 15);
    onMouseEvent('motion', 50, 36);  // newDetailH = 4 → 10% but clamped to 20
    eq(S.layout.detailHeightPct, 20);
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
    eq(S.layout.leftPanels[0].type, 'groups');
    eq(_getUndoDepth(), 1);

    handleDesignKey('u');  // undo
    eq(S.layout.leftPanels[0].type, 'containers');
    eq(_getUndoDepth(), 0);
    eq(_getRedoDepth(), 1);

    handleDesignKey('ctrl-r');  // redo
    eq(S.layout.leftPanels[0].type, 'groups');
    eq(_getUndoDepth(), 1);
    eq(_getRedoDepth(), 0);
  });

  it('drop is undoable', () => {
    setupFixture();
    // Drag containers from left to bottom of left col
    onMouseEvent('press',   5, 2);
    onMouseEvent('motion',  5, 17);
    onMouseEvent('release', 5, 17);
    eq(S.layout.leftPanels[0].type, 'groups');
    eq(_getUndoDepth(), 1);

    handleDesignKey('u');
    eq(S.layout.leftPanels[0].type, 'containers');
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
    eq(S.designTitleEditMode, true);
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

    eq(S.designTitleEditMode, false);
    eq(S.layout.leftPanels[0].title, 'Containerz');
    eq(S.layoutDirty, true);
    eq(_getUndoDepth(), depthBefore + 1);
  });

  it('Esc cancels — no commit, no undo entry, sub-mode cleared', () => {
    setupFixture();
    const depthBefore = _getUndoDepth();
    handleDesignKey('t');
    handleDesignTitleEditKey('q', 'q');
    handleDesignTitleEditKey('escape');

    eq(S.designTitleEditMode, false);
    eq(S.layout.leftPanels[0].title, 'Containers', 'title NOT changed');
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
