/**
 * test-scroll-clamp.js — the scroll-clamp safety net + render purity.
 *
 * Since resize-as-Msg P3 (docs/resize-as-msg.md) the clamp lives in
 * the POST-DISPATCH finalizer (dispatch/runtime/finalize.js): after every outermost
 * dispatch, each navigator pane's selected row is pulled back inside
 * its viewport — cursor past the bottom pulls scroll down, above the
 * top pulls it up. `set_cursor` itself still doesn't touch scroll
 * (leaves/nav._stepEntry writes the cursor field only); the finalizer
 * is the only mechanism, and it needs NO render: terminal resize is a
 * `term_resized` Msg (P1), so every clamp trigger is a dispatch.
 *
 * Render dispatches NOTHING — the per-frame _syncScrollClamp deleted
 * in P3. [4] pins that purity: state broken by a direct (non-dispatch)
 * mutation stays broken across a render, and the next dispatch — not
 * the next frame — repairs it.
 *
 * (History: the clamp lived in calcLayout, then paint (wm-geo P1.1),
 * judged against the previous frame's bounds until 8eea6e9, and left
 * the render path entirely in resize-as-Msg P3.)
 *
 * Run: node js/test/test-scroll-clamp.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getInstanceSlice } = require('../panel/api');
const { getSel, setSel, getScroll, setScroll } = require('../app/state');
const geo = require('../leaves/wm/geometry');

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
// into each other.
function boot(rows) {
  process.stdout.columns = 100;
  process.stdout.rows = rows;
  sm.bootFresh({ groups: manyGroups(40) });
  getInstanceSlice('layout').focus = 'pane-groups';
  setSel('groups', 0);
  setScroll('groups', 0);
}

// The groups pane's content viewport from a fresh pure layout pass —
// the same source the finalizer judges against. No render needed.
function groupsInnerH() {
  const ls = getInstanceSlice('layout');
  const layout = geo.calcLayout(ls, ls.dims);
  const rect = layout.rects.find(r => r.paneId === 'pane-groups');
  assert(rect, 'pane-groups has a layout rect');
  return Math.max(1, rect.h - 2);
}

const inView = (sel, scroll, innerH) => sel >= scroll && sel < scroll + innerH;

describe('[1] cursor below viewport: the dispatch pulls scroll down', () => {
  it('set_cursor deep → selected row in view, zero renders', () => {
    boot(20);                        // innerH ≈ 17 — list of 40 overflows
    const innerH = groupsInnerH();
    assert(innerH < 35, `viewport smaller than list (innerH=${innerH})`);
    setSel('groups', 35);            // a dispatch — the finalizer clamps at exit
    const scroll = getScroll('groups');
    eq(scroll, 35 - innerH + 1, 'scroll = sel - innerH + 1 (bottom-aligned)');
    assert(inView(35, scroll, innerH), 'cursor visible — no render involved');
    eq(getSel('groups'), 35, 'cursor itself untouched');
  });
});

describe('[2] cursor above viewport: the dispatch pulls scroll up', () => {
  it('set_scroll past the cursor snaps back immediately', () => {
    boot(20);
    setSel('groups', 2);
    setScroll('groups', 20);         // this dispatch itself triggers the clamp
    eq(getScroll('groups'), 2, 'scroll snapped back to the selected row');
  });
});

describe('[3] terminal resize: clamp lands when the Msg does', () => {
  it('shrink → term_resized → cursor back in view before any repaint', () => {
    boot(40);                        // innerH ≈ 37 — cursor 30 fits unscrolled
    setSel('groups', 30);
    eq(getScroll('groups'), 0, 'no scroll needed at 40 rows');
    const tallInnerH = groupsInnerH();

    sm.resize(100, 18);              // stdout mutate + term_resized dispatch
    const shortInnerH = groupsInnerH();
    assert(shortInnerH < tallInnerH, `viewport shrank (${tallInnerH} → ${shortInnerH})`);
    const scroll = getScroll('groups');
    eq(scroll, 30 - shortInnerH + 1, 'bottom-aligned to the new viewport, pre-render');
    assert(inView(30, scroll, shortInnerH),
      `cursor 30 in view (scroll=${scroll}, innerH=${shortInnerH})`);
    eq(getSel('groups'), 30, 'cursor itself untouched');
  });
});

describe('[4] render purity: render() neither clamps nor dispatches', () => {
  it('a direct (non-dispatch) scroll break survives a render; the next dispatch repairs it', () => {
    boot(20);
    setSel('groups', 2);
    // Break the invariant BEHIND dispatch's back — a direct slice write
    // no production path performs. Render must not repair (or dispatch
    // anything); only the update layer owns writes now.
    getInstanceSlice('pane-groups').nav.scroll = 20;
    eq(getScroll('groups'), 20, 'invariant broken by direct mutation');
    sm.capture(() => sm.render());
    eq(getScroll('groups'), 20, 'render left it broken — no render-side clamp');
    // Any dispatch repairs it — here a no-op same-value cursor write.
    setSel('groups', 2);
    eq(getScroll('groups'), 2, 'next dispatch ran the finalizer and repaired it');
  });
});

process.stdout.columns = 100;
process.stdout.rows = 40;
report();
