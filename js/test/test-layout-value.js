/**
 * test-layout-value.js — calcLayout's Layout value (v0.6.3 P1).
 *
 * Locks down the per-frame Rect list calcLayout produces and the
 * shape of its return + getCurrentLayout() — the Layout-as-value
 * contract that P1.1-P1.5 introduced. Regression guard for P3
 * (composeRects) when the rect contract tightens further.
 *
 * Run: node js/test/test-layout-value.js
 */
'use strict';

const layout = require('../render/layout');
const { describe, it, eq, assert, report } = require('./test-runner');
const { getInstanceSlice } = require('../panel/api');

function setSize(cols, rows) {
  process.stdout.columns = cols;
  process.stdout.rows = rows;
}

function setupSlice(arrange, opts = {}) {
  const slice = getInstanceSlice('layout');
  slice.arrange = arrange;
  slice.viewMode = opts.viewMode || 'normal';
  slice.focus = opts.focus || '';
  slice.halfLeftPanel = opts.halfLeftPanel || null;
  slice.panelBounds = {};
  return slice;
}

const pane = (type, paneId, extras = {}) => ({
  type, id: type, paneId, hotkey: extras.hotkey || '1',
  title: extras.title || type, columnIndex: extras.columnIndex || 0,
  ...extras,
});

// ----------------------------------------------------------------

describe('[1] calcLayout return shape', () => {
  it('returns {ranges, availH, rects, viewMode, cols, rows}', () => {
    setSize(120, 30);
    setupSlice({
      detailHeightPct: 60,
      columns: [
        { width: 30, panels: [pane('containers', 'pc', { hotkey: '1', columnIndex: 0 })] },
        { panels: [pane('detail', 'pd', { hotkey: 'o', columnIndex: 1 })] },
      ],
    });
    const out = layout.calcLayout();
    assert(Array.isArray(out.ranges), 'ranges is array');
    eq(typeof out.availH, 'number');
    assert(Array.isArray(out.rects), 'rects is array');
    eq(out.viewMode, 'normal');
    eq(out.cols, 120);
    eq(out.rows, 30);
  });
});

describe('[2] rects: one per placed pane, column-x carried through', () => {
  it('two-column layout produces 4 rects with correct x positions', () => {
    setSize(120, 30);
    setupSlice({
      detailHeightPct: 60,
      columns: [
        { width: 30, panels: [
          pane('containers', 'pc', { hotkey: '1', columnIndex: 0 }),
          pane('groups',     'pg', { hotkey: '2', columnIndex: 0 }),
        ] },
        { panels: [
          pane('actions', 'pa', { hotkey: '0', columnIndex: 1 }),
          pane('detail',  'pd', { hotkey: 'o', columnIndex: 1 }),
        ] },
      ],
    });
    const out = layout.calcLayout();
    eq(out.rects.length, 4);
    const rc = (type) => out.rects.find(r => r.type === type);
    eq(rc('containers').x, 0);
    eq(rc('groups').x,     0);
    eq(rc('actions').x,    30);
    eq(rc('detail').x,     30);
    // First column width = 30; last column takes the remainder.
    eq(rc('containers').w, 30);
    eq(rc('detail').w,     120 - 30);
  });
});

describe('[3] rects: y accumulates within a column, summing to availH', () => {
  it('two flex panels in a column split availH evenly (last gets remainder)', () => {
    setSize(120, 30);  // availH = max(6, 30-1) = 29
    setupSlice({
      detailHeightPct: 60,
      columns: [
        { width: 30, panels: [
          pane('a', 'pa', { columnIndex: 0 }),
          pane('b', 'pb', { columnIndex: 0 }),
        ] },
        { panels: [pane('detail', 'pd', { hotkey: 'o', columnIndex: 1 })] },
      ],
    });
    const out = layout.calcLayout();
    const a = out.rects.find(r => r.type === 'a');
    const b = out.rects.find(r => r.type === 'b');
    eq(a.y, 0);
    eq(b.y, a.h, 'b.y starts where a ends');
    eq(a.h + b.h, out.availH, 'col 0 fully covered');
    eq(out.availH, 29);
  });
});

describe('[4] all-collapsed column: rects sum below availH (the 6d9ad31 case)', () => {
  it('three collapsed panels → three 1-row rects, sum=3<availH', () => {
    setSize(80, 30);
    setupSlice({
      detailHeightPct: 60,
      columns: [
        { width: 32, panels: [
          pane('p1', 'p1', { hotkey: '1', columnIndex: 0, collapsed: true }),
          pane('p2', 'p2', { hotkey: '2', columnIndex: 0, collapsed: true }),
          pane('p3', 'p3', { hotkey: '3', columnIndex: 0, collapsed: true }),
        ] },
        { panels: [pane('detail', 'pd', { hotkey: 'o', columnIndex: 1 })] },
      ],
    });
    const out = layout.calcLayout();
    const col0 = out.rects.filter(r => r.x === 0);
    eq(col0.length, 3);
    for (const r of col0) {
      eq(r.h, 1, `${r.type} collapsed = 1 row`);
      assert(r.collapsed, `${r.type} has collapsed=true`);
    }
    eq(col0.reduce((s, r) => s + r.h, 0), 3);
    assert(out.availH > 3, `availH ${out.availH} > collapsed sum 3 (renderNormal pads — see 6d9ad31)`);
  });
});

describe('[5] getCurrentLayout publishes after calcLayout', () => {
  it('returns the most-recent rect list, same content as calcLayout return', () => {
    setSize(120, 30);
    setupSlice({
      detailHeightPct: 60,
      columns: [{ panels: [pane('detail', 'pd', { hotkey: 'o', columnIndex: 0 })] }],
    });
    const ret = layout.calcLayout();
    const cur = layout.getCurrentLayout();
    assert(cur, 'getCurrentLayout returns non-null after calcLayout');
    eq(cur.viewMode, ret.viewMode);
    eq(cur.availH,   ret.availH);
    eq(cur.rects.length, ret.rects.length);
    // Same shape (P1.2 publishes the same object that's in the return).
    eq(cur.rects[0].type, ret.rects[0].type);
    eq(cur.rects[0].h,    ret.rects[0].h);
  });
});

describe('[6] boundsFor (P1.3 shim): slice first, rects fallback', () => {
  it('reads from slice.panelBounds when present', () => {
    setSize(120, 30);
    const slice = setupSlice({
      detailHeightPct: 60,
      columns: [{ panels: [pane('detail', 'pd', { hotkey: 'o', columnIndex: 0 })] }],
    });
    layout.calcLayout();  // populates _currentLayout
    slice.panelBounds.detail = { x: 999, y: 999, w: 1, h: 1 };  // sentinel
    const b = layout.boundsFor('detail');
    eq(b.x, 999, 'slice value wins (P1.3 priority)');
  });
  it('falls through to _currentLayout.rects when slice is empty', () => {
    setSize(120, 30);
    const slice = setupSlice({
      detailHeightPct: 60,
      columns: [
        { panels: [
          pane('detail',  'pd', { hotkey: 'o', columnIndex: 0 }),
          pane('actions', 'pa', { hotkey: '0', columnIndex: 0 }),
        ] },
      ],
    });
    layout.calcLayout();
    slice.panelBounds = {};  // clear after render
    const b = layout.boundsFor('actions');
    assert(b, 'fall-through finds rect');
    eq(b.type, 'actions');
    eq(b.x, 0);
  });
});

report();
