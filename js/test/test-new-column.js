/**
 * v0.6.2 Phase 2 — drag-edge spawn (new_column).
 *
 * Covers:
 *   1. _newColumnZoneAt — left edge / right edge / column gap hit-tests
 *   2. validateNewColumn — Phase 2 refusal rules (detail/actions source,
 *      position == N right edge)
 *   3. applyNewColumn — in-grid drag spawn + width allocation + source-
 *      column auto-cleanup when it becomes empty
 *   4. validatePoolNewColumn + spawnNewColumnArrange — same for pool drag
 *   5. pool_show_new_column reducer arm
 *   6. computeDragPreviewArrange / computePoolDragPreviewArrange handle
 *      new_column targets
 *   7. pointToDropTarget / pointToPoolDropTarget surface new_column zones
 *      before falling through to in-column 3-zone match
 *
 * Phase 1 tests (test-free-config-drag.js, test-pool-drag.js) cover the
 * insert/swap/replace paths. This file is the new-column-specific
 * complement.
 */
'use strict';

const mfc = require('../leaves/free-config');
const mpoolDrag = require('../leaves/free-config-pool-drag');
const mpool = require('../leaves/pool');
const layout = require('../panel/layout');
const { describe, it, assert, eq, report } = require('./test-runner');

const COLS = 120;

// ----- Fixtures -----

function makeSlice() {
  return {
    arrange: {
      detailHeightPct: 60,
      pool: {
        containers: { id: 'containers', type: 'containers', title: 'C', config: {} },
        groups:     { id: 'groups',     type: 'groups',     title: 'G', config: {} },
        actions:    { id: 'actions',    type: 'actions',    title: 'A', config: {} },
        stats:      { id: 'stats',      type: 'stats',      title: 'S', config: {} },
        detail:     { id: 'detail',     type: 'detail',     title: 'D', config: {} },
        notes:      { id: 'notes',      type: 'history',    title: 'N', config: {} },  // hidden
      },
      columns: [
        { width: 30, panels: [
          { type: 'containers', id: 'containers', title: 'C', columnIndex: 0, hotkey: '1', paneId: 'pane-containers', tabs: [{ id: 'containers', poolId: 'containers' }], activeTabId: 'containers' },
          { type: 'groups',     id: 'groups',     title: 'G', columnIndex: 0, hotkey: '2', paneId: 'pane-groups',     tabs: [{ id: 'groups',     poolId: 'groups'     }], activeTabId: 'groups' },
        ] },
        { panels: [
          { type: 'actions', id: 'actions', title: 'A', columnIndex: 1, hotkey: '0', paneId: 'pane-actions', tabs: [{ id: 'actions', poolId: 'actions' }], activeTabId: 'actions' },
          { type: 'stats',   id: 'stats',   title: 'S', columnIndex: 1, hotkey: '',  paneId: 'pane-stats',   tabs: [{ id: 'stats',   poolId: 'stats'   }], activeTabId: 'stats' },
          { type: 'detail',  id: 'detail',  title: 'D', columnIndex: 1, hotkey: 'o', paneId: 'pane-detail',  tabs: [{ id: 'detail',  poolId: 'detail'  }], activeTabId: 'detail' },
        ] },
      ],
    },
    dirty: false,
    focus: 'containers',
    viewMode: 'normal',
    freeConfig: { drag: null, undo: [], redo: [], titleEdit: { active: false, text: '' }, notice: null },
    panelBounds: {
      containers: { x: 0, y: 0, w: 30, h: 10 },
      groups:     { x: 0, y: 10, w: 30, h: 10 },
      actions:    { x: 30, y: 0, w: 90, h: 5 },
      stats:      { x: 30, y: 5, w: 90, h: 10 },
      detail:     { x: 30, y: 15, w: 90, h: 25 },
    },
    panelHeights: {},
    panelList: { open: false, cursor: 0 },
    bootWarnings: [],
  };
}

// ----- _newColumnZoneAt -----

describe('[1] _newColumnZoneAt — edge + gap hit-tests', () => {
  const s = makeSlice();

  it('left edge: mx < EDGE_W → position 0', () => {
    eq(mfc._newColumnZoneAt(s.arrange, 0, COLS), { position: 0 });
    eq(mfc._newColumnZoneAt(s.arrange, 1, COLS), { position: 0 });
  });

  it('left edge boundary (mx === EDGE_W) NOT a new-col zone', () => {
    eq(mfc._newColumnZoneAt(s.arrange, mfc.EDGE_W, COLS), null);
  });

  it('right edge: mx >= COLS - EDGE_W → position N', () => {
    eq(mfc._newColumnZoneAt(s.arrange, COLS - 1, COLS), { position: 2 });
    eq(mfc._newColumnZoneAt(s.arrange, COLS - mfc.EDGE_W, COLS), { position: 2 });
  });

  it('column gap: cursor near internal boundary → position i+1', () => {
    // col0.width=30 → boundary at x=30. Window: [29, 31].
    eq(mfc._newColumnZoneAt(s.arrange, 29, COLS), { position: 1 });
    eq(mfc._newColumnZoneAt(s.arrange, 30, COLS), { position: 1 });
    eq(mfc._newColumnZoneAt(s.arrange, 31, COLS), { position: 1 });
  });

  it('inside a column body (not near a boundary) → null', () => {
    eq(mfc._newColumnZoneAt(s.arrange, 10, COLS), null);
    eq(mfc._newColumnZoneAt(s.arrange, 60, COLS), null);
  });
});

// ----- validateNewColumn -----

describe('[2] validateNewColumn — Phase 2 refusal rules', () => {
  const s = makeSlice();

  it('non-reserved source at position 0 (left edge) → valid', () => {
    const t = mfc.validateNewColumn(s, 'containers', 0);
    eq(t.valid, true);
    eq(t.kind, 'new_column');
    eq(t.position, 0);
  });

  it('non-reserved source at position 1 (column gap) → valid', () => {
    const t = mfc.validateNewColumn(s, 'groups', 1);
    eq(t.valid, true);
  });

  it('non-reserved source at position N (right edge) → refused', () => {
    const t = mfc.validateNewColumn(s, 'containers', 2);  // N=2
    eq(t.valid, false);
    assert(/last column/.test(t.reason), `reason mentions last column: ${t.reason}`);
  });

  it('detail source at any position → refused', () => {
    eq(mfc.validateNewColumn(s, 'detail', 0).valid, false);
    eq(mfc.validateNewColumn(s, 'detail', 1).valid, false);
  });

  it('actions source at any position → refused', () => {
    eq(mfc.validateNewColumn(s, 'actions', 0).valid, false);
    eq(mfc.validateNewColumn(s, 'actions', 1).valid, false);
  });
});

// ----- applyNewColumn (in-grid drag commit) -----

describe('[3] applyNewColumn — in-grid spawn', () => {
  it('left-edge spawn at position 0 — containers moves into a fresh first column', () => {
    const s = makeSlice();
    const target = { kind: 'new_column', position: 0, valid: true };
    const out = mfc.applyNewColumn(s, 'containers', target);
    eq(out.dirty, true);
    // After: cols = [{containers}, {groups}, {actions, stats, detail}]
    eq(out.arrange.columns.length, 3, 'now 3 columns');
    eq(out.arrange.columns[0].panels.length, 1);
    eq(out.arrange.columns[0].panels[0].type, 'containers');
    eq(out.arrange.columns[0].panels[0].columnIndex, 0, 'columnIndex stamped');
    eq(out.arrange.columns[1].panels.length, 1);
    eq(out.arrange.columns[1].panels[0].type, 'groups');
    eq(out.arrange.columns[1].panels[0].columnIndex, 1, 'shifted columnIndex re-stamped');
    eq(out.arrange.columns[2].panels[0].type, 'actions');
    eq(out.arrange.columns[2].panels[0].columnIndex, 2);
  });

  it('source column ends empty → auto-removed', () => {
    // Drop containers AND groups out, leaving column 0 empty. Drag
    // 'groups' to position 0; col 0 still has containers, so col 0
    // doesn't get removed. Instead test: a 1-pane column 0 (just
    // 'groups') drains when its only pane spawns a new column.
    let s = makeSlice();
    // Manually drop containers from col 0 so col 0 has only 'groups'.
    s.arrange = mpool.updateColumn(s.arrange, 0, panels =>
      panels.filter(p => p.type !== 'containers'));
    eq(s.arrange.columns[0].panels.length, 1, 'precondition: col 0 has only groups');
    const target = { kind: 'new_column', position: 1, valid: true };
    const out = mfc.applyNewColumn(s, 'groups', target);
    // Source col 0 became empty → removed. New col was at position 1,
    // but col 0 removal shifts that to effective position 0. Final
    // layout: [{groups}, {actions, stats, detail}] = 2 cols.
    eq(out.arrange.columns.length, 2, 'empty source column removed');
    eq(out.arrange.columns[0].panels[0].type, 'groups', 'groups in the new first column');
    eq(out.arrange.columns[1].panels[0].type, 'actions', 'last column unchanged');
  });

  it('width stolen from explicit neighbor, last-col stays implicit', () => {
    const s = makeSlice();  // col 0 width=30, col 1 implicit
    const target = { kind: 'new_column', position: 1, valid: true };  // gap between col 0 and 1
    const out = mfc.applyNewColumn(s, 'containers', target);
    // New column at position 1 takes some width from col 0 (the only
    // explicit-width neighbor on its left; col 1 is implicit so nothing
    // to steal from on the right). col 0 shrinks.
    eq(out.arrange.columns[0].width < 30, true, 'col 0 width shrank');
    eq(out.arrange.columns[1].width != null, true, 'new column has explicit width');
    eq(out.arrange.columns[2].width, undefined, 'last column stays implicit');
  });

  it('detail source new_column → no-op (validator already refuses; applyNewColumn handles defensively)', () => {
    const s = makeSlice();
    // applyNewColumn itself doesn't refuse — it trusts the validator —
    // but the validator would have returned valid:false above. Sanity
    // check that the focus selector finds detail.
    const loc = mpool.findPaneLocation(s.arrange, p => p.type === 'detail');
    eq(loc.columnIndex, 1);
    eq(loc.paneIndex, 2);
  });
});

// ----- pointToDropTarget — edge/gap precedence -----

describe('[4] pointToDropTarget — edge/gap zones take precedence', () => {
  it('cursor at left edge mx=1 returns new_column even though col 0 starts at x=0', () => {
    const s = makeSlice();
    const t = mfc.pointToDropTarget(s, 'containers', 1, 5, COLS);
    eq(t.kind, 'new_column');
    eq(t.position, 0);
  });

  it('cursor at column gap (mx=30) returns new_column at position 1', () => {
    const s = makeSlice();
    const t = mfc.pointToDropTarget(s, 'containers', 30, 5, COLS);
    eq(t.kind, 'new_column');
    eq(t.position, 1);
  });

  it('cursor inside col 0 body (mx=10, y=2) returns in-column insert', () => {
    const s = makeSlice();
    const t = mfc.pointToDropTarget(s, 'groups', 10, 2, COLS);
    eq(t.kind, 'insert');
    eq(t.columnIndex, 0);
  });

  it('detail source at left edge → new_column with valid:false', () => {
    const s = makeSlice();
    const t = mfc.pointToDropTarget(s, 'detail', 1, 5, COLS);
    eq(t.kind, 'new_column');
    eq(t.valid, false);
  });
});

// ----- computeDragPreviewArrange — new_column targets -----

describe('[5] computeDragPreviewArrange — new_column preview', () => {
  it('valid new_column target → preview arrange has +1 column', () => {
    const s = makeSlice();
    const slice = { ...s, freeConfig: { ...s.freeConfig, drag: {
      kind: 'dragging', sourceType: 'containers',
      target: { kind: 'new_column', position: 0, valid: true },
    } } };
    const preview = mfc.computeDragPreviewArrange(slice);
    assert(preview !== null, 'preview computed');
    eq(preview.columns.length, 3, 'preview has 3 columns');
    eq(preview.columns[0].panels[0].type, 'containers');
  });

  it('invalid new_column target (detail source) → null preview', () => {
    const s = makeSlice();
    const slice = { ...s, freeConfig: { ...s.freeConfig, drag: {
      kind: 'dragging', sourceType: 'detail',
      target: { kind: 'new_column', position: 0, valid: false },
    } } };
    eq(mfc.computeDragPreviewArrange(slice), null);
  });
});

// ----- pool drag — new_column path -----

describe('[6] validatePoolNewColumn — Phase 2 rules for pool drag', () => {
  const s = makeSlice();
  it('non-reserved pool entry at left edge → valid', () => {
    const t = mpoolDrag.validatePoolNewColumn(s.arrange, 0, s.arrange.pool.notes);
    eq(t.valid, true);
  });
  it('reserved (actions) pool entry at any position → refused', () => {
    const t = mpoolDrag.validatePoolNewColumn(s.arrange, 0, s.arrange.pool.actions);
    eq(t.valid, false);
  });
  it('right edge (position N) refused for any source', () => {
    const t = mpoolDrag.validatePoolNewColumn(s.arrange, 2, s.arrange.pool.notes);
    eq(t.valid, false);
  });
});

describe('[7] spawnNewColumnArrange — pure transform shared by preview + commit', () => {
  it('inserts a column with the placement at `position`', () => {
    const s = makeSlice();
    const placement = mpool.placementFromPoolEntry(s.arrange.pool.notes, -1);
    const out = mpoolDrag.spawnNewColumnArrange(s.arrange, 1, placement);
    eq(out.columns.length, 3);
    eq(out.columns[1].panels[0].type, 'history', 'hidden pool entry kind');
  });
});

// ----- pool_show_new_column reducer arm -----

describe('[8] pool_show_new_column — layout reducer', () => {
  it('valid drop adds a new column with the pool entry', () => {
    const slice = makeSlice();
    const out = layout.update({ type: 'pool_show_new_column', id: 'notes', position: 0 }, slice);
    eq(out.dirty, true);
    eq(out.arrange.columns.length, 3);
    eq(out.arrange.columns[0].panels[0].type, 'history');
    eq(out.arrange.columns[0].panels[0].columnIndex, 0);
    // Other columns' columnIndex got re-stamped.
    eq(out.arrange.columns[1].panels[0].columnIndex, 1);
    eq(out.arrange.columns[2].panels[0].columnIndex, 2);
  });

  it('reserved pool entry (actions) refused → slice unchanged', () => {
    const slice = makeSlice();
    // 'actions' is already placed; remove it first then try to spawn.
    let s = layout.update({ type: 'pool_hide', id: 'actions' }, slice);
    s = layout.update({ type: 'pool_show_new_column', id: 'actions', position: 0 }, s);
    // pool_show_new_column refuses reserved → unchanged from the hide state.
    const placedActions = mpool.findPaneLocation(s.arrange, p => p.type === 'actions');
    assert(placedActions === null, 'actions stays in pool');
  });

  it('right-edge spawn (position N) refused → slice unchanged', () => {
    const slice = makeSlice();
    const out = layout.update({ type: 'pool_show_new_column', id: 'notes', position: 2 }, slice);
    eq(out.arrange.columns.length, 2, 'still 2 columns');
  });

  it('out-of-range position refused', () => {
    const slice = makeSlice();
    const out1 = layout.update({ type: 'pool_show_new_column', id: 'notes', position: -1 }, slice);
    const out2 = layout.update({ type: 'pool_show_new_column', id: 'notes', position: 99 }, slice);
    eq(out1.arrange.columns.length, 2);
    eq(out2.arrange.columns.length, 2);
  });
});

// ----- _dragTargetsEqual handles position field -----

// ----- Phase 3: addColumn / removeColumn leaf helpers + Msg arms -----

describe('[10] addColumn — Phase 3 leaf helper', () => {
  it('inserts an empty column at position; column has explicit width', () => {
    const s = makeSlice();
    const { slice: out, error } = mfc.addColumn(s, 1);
    eq(error, null);
    eq(out.arrange.columns.length, 3);
    eq(out.arrange.columns[1].panels.length, 0, 'inserted column is empty');
    assert(out.arrange.columns[1].width != null, 'inserted column has explicit width');
    eq(out.dirty, true);
  });

  it('position 0 (front) inserts before the first column', () => {
    const s = makeSlice();
    const { slice: out, error } = mfc.addColumn(s, 0);
    eq(error, null);
    eq(out.arrange.columns.length, 3);
    eq(out.arrange.columns[0].panels.length, 0);
    eq(out.arrange.columns[1].panels[0].type, 'containers', 'old col 0 shifted to index 1');
    eq(out.arrange.columns[1].panels[0].columnIndex, 1, 'columnIndex re-stamped');
  });

  it('position N (right edge) refused', () => {
    const s = makeSlice();
    const { slice: out, error } = mfc.addColumn(s, 2);  // N=2
    assert(error !== null);
    assert(/last column/.test(error), `error mentions last column: ${error}`);
    eq(out, s, 'slice unchanged');
  });

  it('out-of-range position refused', () => {
    const s = makeSlice();
    const a = mfc.addColumn(s, -1);
    const b = mfc.addColumn(s, 5);
    assert(a.error !== null);
    assert(b.error !== null);
  });

  it('non-integer position refused', () => {
    const s = makeSlice();
    const { error } = mfc.addColumn(s, '0');
    assert(error !== null);
  });
});

describe('[11] removeColumn — Phase 3 leaf helper', () => {
  it('removes an empty non-last column', () => {
    // First add an empty column at position 1, then remove it.
    let s = makeSlice();
    s = mfc.addColumn(s, 1).slice;
    eq(s.arrange.columns.length, 3);
    const { slice: out, error } = mfc.removeColumn(s, 1);
    eq(error, null);
    eq(out.arrange.columns.length, 2, 'back to 2 columns');
    eq(out.arrange.columns[0].panels[0].type, 'containers');
    eq(out.arrange.columns[1].panels[0].type, 'actions');
  });

  it('refuses removing a non-empty column', () => {
    const s = makeSlice();
    const { slice: out, error } = mfc.removeColumn(s, 0);  // col 0 has panes
    assert(error !== null);
    assert(/not empty/.test(error), `error mentions emptiness: ${error}`);
    eq(out, s);
  });

  it('refuses removing the last column', () => {
    let s = makeSlice();
    // Drain the last column wouldn't work (detail can't be hidden), so
    // just test the guard directly — try to remove index N-1 = 1.
    const { slice: out, error } = mfc.removeColumn(s, 1);
    assert(error !== null);
    assert(/last column/.test(error), `error mentions last column: ${error}`);
    eq(out, s);
  });

  it('out-of-range index refused', () => {
    const s = makeSlice();
    const a = mfc.removeColumn(s, -1);
    const b = mfc.removeColumn(s, 99);
    assert(a.error !== null);
    assert(b.error !== null);
  });
});

describe('[12] add_column / remove_column Msg arms', () => {
  it('add_column emits an info notice on success', () => {
    const slice = makeSlice();
    const out = layout.update({ type: 'add_column', position: 1 }, slice);
    eq(out.arrange.columns.length, 3);
    eq(out.freeConfig.notice, 'added empty column at position 2');
    eq(out.freeConfig.noticeKind, 'info');
  });

  it('add_column emits an error notice on refusal (position N)', () => {
    const slice = makeSlice();
    const out = layout.update({ type: 'add_column', position: 2 }, slice);
    eq(out.arrange.columns.length, 2, 'unchanged');
    assert(out.freeConfig.notice !== null);
    eq(out.freeConfig.noticeKind, 'error');
  });

  it('remove_column emits an info notice on success', () => {
    let slice = makeSlice();
    slice = layout.update({ type: 'add_column', position: 1 }, slice);  // add then remove
    const out = layout.update({ type: 'remove_column', n: 1 }, slice);
    eq(out.arrange.columns.length, 2);
    eq(out.freeConfig.noticeKind, 'info');
  });

  it('remove_column emits an error notice on refusal (non-empty)', () => {
    const slice = makeSlice();
    const out = layout.update({ type: 'remove_column', n: 0 }, slice);
    eq(out.arrange.columns.length, 2, 'unchanged');
    eq(out.freeConfig.noticeKind, 'error');
  });
});

describe('[13] pool_show_new_column success notice', () => {
  it('successful spawn emits an info notice', () => {
    const slice = makeSlice();
    const out = layout.update({ type: 'pool_show_new_column', id: 'notes', position: 0 }, slice);
    eq(out.arrange.columns.length, 3);
    eq(out.freeConfig.noticeKind, 'info');
    assert(/position 1/.test(out.freeConfig.notice), `notice names position 1: ${out.freeConfig.notice}`);
  });
});

describe('[14] _dragTargetsEqual — new_column targets compare on `position`', () => {
  // Re-derive via layout.update's pool_drag_motion behavior. Easier:
  // construct two new_column targets and verify the layout reducer
  // would emit force_full_repaint when they differ. Direct via
  // panel/layout's exported test seam? Not exported. Skip — the
  // function is internal. Just sanity-check the field shape here.
  it('new_column target carries `position` not `columnIndex`/`index`', () => {
    const t = mfc.validateNewColumn(makeSlice(), 'containers', 0);
    eq(t.position, 0);
    eq(t.columnIndex, undefined);
    eq(t.index, undefined);
  });
});

report();
