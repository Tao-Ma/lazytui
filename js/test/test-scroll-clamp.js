/**
 * test-scroll-clamp.js — the render-pass scroll-clamp safety net.
 *
 * Every frame, the layout pass keeps each navigator pane's selected row
 * inside its viewport: cursor past the bottom pulls scroll down, cursor
 * above the top pulls scroll up. `set_cursor` itself does NOT sync
 * scroll (leaves/nav._stepEntry only writes the cursor field), so this
 * per-frame clamp is the only mechanism — most visibly on a terminal
 * RESIZE (a `term_resized` Msg since resize-as-Msg P1; the render
 * re-clamps to the shrunken viewport).
 *
 * The clamp reads the pane viewport via getPanelViewportH → boundsFor →
 * slice.paneBounds, and runs AFTER the frame's paneBounds rewrite — so it
 * judges against THIS frame's bounds and a resize re-clamps on the same
 * render ([3] below). (Historical: the clamp originally ran before the
 * rewrite, reading the previous frame's bounds — a one-frame clamp lag
 * on resize, fixed post-P1.1 of the WM geometry refactor.)
 *
 * Pinned ahead of the WM geometry refactor (docs/wm-geometry-refactor.md
 * Phase 1.1), which lifted the clamp out of calcLayout into the paint
 * pass.
 *
 * Run: node js/test/test-scroll-clamp.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getInstanceSlice } = require('../panel/api');
const { getSel, setSel, getScroll, setScroll } = require('../app/state');

function setSize(cols, rows) {
  process.stdout.columns = cols;
  process.stdout.rows = rows;
}

// 40 groups → the groups navigator has enough rows to scroll at any
// terminal height used below.
function manyGroups(n) {
  const groups = {};
  for (let i = 1; i <= n; i++) {
    const name = `g${String(i).padStart(2, '0')}`;
    groups[name] = { name, label: `Group ${i}`,
      containers: [], actions: {}, children: [], parent: null, depth: 0, quick: false };
  }
  return groups;
}

// The groups nav entry survives bootFresh (initState re-mints viewer
// slices, not nav chrome) — zero it explicitly so scenarios don't leak
// into each other. The closing render seeds paneBounds for the size.
function boot(rows) {
  setSize(100, rows);
  sm.bootFresh({ groups: manyGroups(40) });
  getInstanceSlice('layout').focus = 'pane-groups';
  setSel('groups', 0);
  setScroll('groups', 0);
  sm.capture(() => sm.render());
}

// The groups pane's content viewport for the LAST-RENDERED frame,
// derived from the rendered bounds (h - 2 border rows) — independent
// of the geometry accessors whose signatures the refactor changes.
function groupsInnerH() {
  const b = getInstanceSlice('layout').paneBounds['pane-groups'];
  assert(b, 'pane-groups has rendered bounds');
  return Math.max(1, b.h - 2);
}

const inView = (sel, scroll, innerH) => sel >= scroll && sel < scroll + innerH;

describe('[1] cursor below viewport: render pulls scroll down', () => {
  it('set_cursor deep + render → selected row scrolled into view', () => {
    boot(20);                        // innerH ≈ 17 — list of 40 overflows
    const innerH = groupsInnerH();
    assert(innerH < 35, `viewport smaller than list (innerH=${innerH})`);
    setSel('groups', 35);            // deep row, beyond the viewport
    eq(getScroll('groups'), 0, 'set_cursor alone does not move scroll');
    sm.capture(() => sm.render());
    const scroll = getScroll('groups');
    eq(scroll, 35 - innerH + 1, 'scroll = sel - innerH + 1 (bottom-aligned)');
    assert(inView(35, scroll, innerH), 'cursor visible after render');
  });
});

describe('[2] cursor above viewport: render pulls scroll up', () => {
  it('scroll past the cursor + render → scroll snaps back to sel', () => {
    boot(20);
    setSel('groups', 2);
    setScroll('groups', 20);         // viewport now starts below the cursor
    sm.capture(() => sm.render());
    eq(getScroll('groups'), 2, 'scroll clamped up to the selected row');
  });
});

describe('[3] resize re-clamps on the SAME render with no Msg in between', () => {
  it('shrinking the terminal pulls the cursor back into view on render #1', () => {
    boot(40);                        // innerH ≈ 37 — cursor 30 fits unscrolled
    setSel('groups', 30);
    sm.capture(() => sm.render());
    const tallInnerH = groupsInnerH();
    assert(inView(30, getScroll('groups'), tallInnerH), 'visible at 40 rows');

    sm.resize(100, 18);              // shrink — stdout mutate + term_resized Msg (P1)
    sm.capture(() => sm.render());   // render #1: clamp sees the fresh 18-row bounds
    const shortInnerH = groupsInnerH();
    assert(shortInnerH < tallInnerH, `viewport shrank (${tallInnerH} → ${shortInnerH})`);
    const scroll = getScroll('groups');
    eq(scroll, 30 - shortInnerH + 1, 'render #1: bottom-aligned to the new viewport');
    assert(inView(30, scroll, shortInnerH),
      `cursor 30 back in view (scroll=${scroll}, innerH=${shortInnerH})`);
    eq(getSel('groups'), 30, 'cursor itself untouched');
  });
});

setSize(100, 40);  // restore for any later requires in this process
report();
