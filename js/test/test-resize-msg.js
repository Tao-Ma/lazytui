/**
 * test-resize-msg.js — resize-as-Msg (docs/resize-as-msg.md).
 *
 * P1: terminal dimensions are MODEL state. `layoutSlice.dims` is seeded
 * at boot (initState) and written only by the layout reducer's
 * `term_resized` arm; geometry reads the model's dims, never the live
 * terminal. Mutating process.stdout alone changes NOTHING until the
 * Msg lands — that's the contract (production's stdout 'resize'
 * listener always dispatches the Msg; tests use sm.resize()).
 *
 * P2 (added in that phase): the post-dispatch finalizer clamps nav
 * scroll at dispatch time — no render needed.
 *
 * Run: node js/test/test-resize-msg.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getInstanceSlice } = require('../panel/api');
const geo = require('../leaves/geometry');

function boot(cols, rows) {
  process.stdout.columns = cols;
  process.stdout.rows = rows;
  sm.bootFresh();
}

describe('[1] boot seeds layoutSlice.dims from the terminal', () => {
  it('initState lands the live size in the model', () => {
    boot(120, 35);
    const dims = getInstanceSlice('layout').dims;
    eq(dims.cols, 120, 'cols seeded');
    eq(dims.rows, 35, 'rows seeded');
  });
});

describe('[2] term_resized is the single writer', () => {
  it('the Msg updates dims; identity preserved on no-change', () => {
    boot(120, 35);
    const slice0 = getInstanceSlice('layout');
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'term_resized', cols: 90, rows: 28 }));
    const slice1 = getInstanceSlice('layout');
    eq(slice1.dims.cols, 90, 'cols updated');
    eq(slice1.dims.rows, 28, 'rows updated');
    assert(slice1 !== slice0, 'slice ref changed on a real resize');
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'term_resized', cols: 90, rows: 28 }));
    assert(getInstanceSlice('layout') === slice1, 'same-size Msg preserves the slice ref');
  });
  it('zero/garbage payload is rejected', () => {
    boot(120, 35);
    const before = getInstanceSlice('layout').dims;
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'term_resized', cols: 0, rows: 28 }));
    eq(getInstanceSlice('layout').dims, before, 'cols=0 dropped');
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'term_resized', cols: 90 }));
    eq(getInstanceSlice('layout').dims, before, 'missing rows dropped');
  });
});

describe('[3] geometry reads the model clock, not the terminal', () => {
  it('stdout mutation alone changes nothing; the Msg changes layout without a render', () => {
    boot(100, 40);
    const layoutSlice = getInstanceSlice('layout');
    const availBefore = geo.calcLayout(layoutSlice, layoutSlice.dims).availH;
    eq(availBefore, 39, 'layout reflects boot size');

    process.stdout.rows = 18;        // live terminal changed, no Msg
    const sliceAfterMutate = getInstanceSlice('layout');
    eq(sliceAfterMutate.dims.rows, 40, 'model dims untouched by a bare stdout mutation');

    sm.resize(100, 18);              // the production path: mutate + Msg
    const layoutSlice2 = getInstanceSlice('layout');
    eq(layoutSlice2.dims.rows, 18, 'Msg landed the new size');
    const availAfter = geo.calcLayout(layoutSlice2, layoutSlice2.dims).availH;
    eq(availAfter, 17, 'pure layout sees the new size with NO render in between');
  });
});

// ——— P2 — the post-dispatch finalizer clamps scroll, no render needed ———

const { getSel, setSel, getScroll, setScroll } = require('../app/state');

function manyGroups(n) {
  const groups = {};
  for (let i = 1; i <= n; i++) {
    const name = `g${String(i).padStart(2, '0')}`;
    groups[name] = { name, label: `Group ${i}`,
      containers: [], actions: {}, children: [], parent: null, depth: 0, quick: false };
  }
  return groups;
}

// The groups pane's content viewport from a FRESH pure layout pass —
// the same source the finalizer judges against (not paneBounds, which
// only exists after a render).
function groupsInnerHFresh() {
  const ls = getInstanceSlice('layout');
  const layout = geo.calcLayout(ls, ls.dims);
  const rect = layout.rects.find(r => r.paneId === 'pane-groups');
  assert(rect, 'pane-groups has a layout rect');
  return Math.max(1, rect.h - 2);
}

function bootOverflowing(cols, rows) {
  process.stdout.columns = cols;
  process.stdout.rows = rows;
  sm.bootFresh({ groups: manyGroups(40) });
  getInstanceSlice('layout').focus = 'pane-groups';
  setSel('groups', 0);
  setScroll('groups', 0);
}

describe('[4] P2 — deep cursor move clamps at dispatch time', () => {
  it('set_cursor Msg → scroll already clamped, zero renders', () => {
    bootOverflowing(100, 20);
    const innerH = groupsInnerHFresh();
    assert(innerH < 35, `viewport smaller than list (innerH=${innerH})`);
    setSel('groups', 35);            // a dispatch — finalizer runs at exit
    eq(getScroll('groups'), 35 - innerH + 1,
      'clamped by the post-dispatch pass (bottom-aligned), no render involved');
    eq(getSel('groups'), 35, 'cursor untouched');
  });
});

describe('[5] P2 — terminal shrink clamps when the Msg lands', () => {
  it('term_resized → scroll clamped before any repaint', () => {
    bootOverflowing(100, 40);
    setSel('groups', 30);
    const tallInnerH = groupsInnerHFresh();
    assert(30 < tallInnerH, 'cursor fits unscrolled at 40 rows');
    eq(getScroll('groups'), 0, 'no scroll needed at 40 rows');

    sm.resize(100, 18);              // dispatches term_resized — no render
    const shortInnerH = groupsInnerHFresh();
    assert(shortInnerH < tallInnerH, `viewport shrank (${tallInnerH} → ${shortInnerH})`);
    eq(getScroll('groups'), 30 - shortInnerH + 1,
      'clamped the moment the resize Msg landed');
  });
});

describe('[6] P2 — scroll-away snaps back at dispatch time', () => {
  it('set_scroll past the cursor is immediately pulled back', () => {
    bootOverflowing(100, 20);
    setSel('groups', 2);
    setScroll('groups', 20);         // the dispatch itself triggers the pass
    eq(getScroll('groups'), 2, 'snapped back to the selected row, no render');
  });
});

describe('[7] resize refreshes the io/term mirror (footer paints at the NEW bottom row)', () => {
  it('grow 30→40: cols()/rows() fresh; no frame write below the old bottom lands at row 30', () => {
    // Regression: resize-as-Msg P1 removed the per-frame refreshSize
    // (rode on termDims) — io/term froze at boot size, so the footer
    // painted at the OLD bottom row every frame, mid-screen after a
    // grow, permanently covering a pane's top border (user-reported).
    process.stdout.columns = 100;
    process.stdout.rows = 30;
    sm.bootFresh();
    sm.capture(() => sm.render());

    sm.resize(100, 40);              // production path incl. refreshSize
    const term = require('../io/term');
    eq(term.cols(), 100, 'io/term cols fresh');
    eq(term.rows(), 40, 'io/term rows fresh (was frozen at 30)');

    const { raw } = sm.capture(() => sm.render());
    const writes = new Set();
    const re = /\x1b\[(\d+);(\d+)H/g;
    let m; while ((m = re.exec(raw))) writes.add(Number(m[1]));
    assert(writes.has(40), 'footer row (40) painted');
    assert(writes.has(1), 'top border row painted');
  });
});

// blessed-exceptions Phase A.1 — the viewer's `innerH` viewport cache is
// produced by the dispatch FINALIZER, not by render(). These tests never
// call render(), so a correct innerH proves the finalizer is the writer
// (and that it tracks a resize freshly, off this dispatch's Layout).
describe('[9] viewer innerH is produced by the finalizer, not render', () => {
  const route = require('../panel/route');
  function viewerInnerH() {
    const t = route.resolveTarget('viewer');
    return t ? (getInstanceSlice(t) || {}).innerH : undefined;
  }
  function expectedInnerH() {
    const ls = getInstanceSlice('layout');
    const layout = geo.calcLayout(ls, ls.dims);
    return geo.getPanelViewportH(ls, route.resolveViewerPaneId(), ls.dims, layout);
  }

  it('innerH is set after a dispatch with no render', () => {
    boot(120, 40);
    // A bare dispatch (no render anywhere in this test) runs the finalizer.
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'term_resized', cols: 120, rows: 40 }));
    const ih = viewerInnerH();
    assert(typeof ih === 'number' && ih > 0, `viewer innerH produced by finalizer: ${ih}`);
    eq(ih, expectedInnerH(), 'innerH matches the viewer viewport height for this Layout');
  });

  it('innerH tracks a resize freshly (no render, no one-frame lag)', () => {
    boot(120, 40);
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'term_resized', cols: 120, rows: 40 }));
    const tall = viewerInnerH();
    sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'term_resized', cols: 120, rows: 20 }));
    const short = viewerInnerH();
    assert(short < tall, `innerH shrank with the terminal (${tall} → ${short}) on the resize dispatch`);
    eq(short, expectedInnerH(), 'innerH equals the post-resize viewport height immediately');
  });
});

process.stdout.columns = 100;
process.stdout.rows = 40;
report();
