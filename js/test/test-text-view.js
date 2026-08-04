/**
 * U2a — the pure text-view render leaf (leaves/text-view/render#buildTextView).
 * See docs/one-tab-system.md. Run: node js/test/test-text-view.js
 *
 * buildTextView is the reusable "render a scrollable text buffer" primitive:
 * window the visible rows (A3 windowed-decorate), apply at most one decoration
 * (selection wins over search), assemble renderPanel args. Pure — resolved state
 * in, plain-object args out.
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { buildTextView } = require('../leaves/text-view/render');
const ms = require('../leaves/text/search');

const LINES = ['line one', 'line two', 'line three', 'line four', 'line five'];

describe('[text-view] window slice + render args', () => {
  it('windows [scroll, scroll+innerH) and stamps scrollOffset/windowed', () => {
    const a = buildTextView({ lines: LINES, scroll: 1, innerH: 2, width: 20, height: 4 });
    eq(a.lines.length, 2);
    eq(a.lines[0], 'line two');
    eq(a.lines[1], 'line three');
    eq(a.scrollOffset, 1);
    eq(a.windowed, true);
  });
  it('count set only when content overflows the viewport', () => {
    eq(JSON.stringify(buildTextView({ lines: LINES, scroll: 0, innerH: 2, width: 20, height: 4 }).count), '[2,5]');
    eq(buildTextView({ lines: LINES, scroll: 0, innerH: 10, width: 20, height: 12 }).count, null);
  });
  it('scroll past end → short/empty window, no throw', () => {
    eq(buildTextView({ lines: LINES, scroll: 99, innerH: 3, width: 20, height: 5 }).lines.length, 0);
  });
  it('empty buffer passthrough', () => {
    const a = buildTextView({ lines: [], scroll: 0, innerH: 3, width: 20, height: 5 });
    eq(a.lines.length, 0);
    eq(a.count, null);
  });
  it('threads chrome args through (title/hotkey/focused/panelType/chrome)', () => {
    const a = buildTextView({ lines: LINES, scroll: 0, innerH: 3, width: 20, height: 5,
      title: 'T', hotkey: '3', focused: true, panelType: 'detail', chrome: { x: 1 } });
    eq(a.title, 'T'); eq(a.hotkey, '3'); eq(a.focused, true);
    eq(a.panelType, 'detail'); eq(JSON.stringify(a.chrome), '{"x":1}');
    eq(a.width, 20); eq(a.height, 5);
  });
});

describe('[text-view] search decoration', () => {
  // Leaf DEFAULTS pinned here ('yellow' / 'reverse yellow' — one tag since
  // the truecolor arc 3a); production callers thread theme().match /
  // theme().match_current through o.searchTags instead.
  it('window matches paint the match tag; the active one the current tag', () => {
    const lines = ['aa foo', 'bb foo', 'cc foo'];
    const matches = ms.matchesFor(lines, 'foo');
    const a = buildTextView({ lines, scroll: 0, innerH: 3, searchDecoration: { matches, activeIdx: 1 }, width: 20, height: 5 });
    assert(a.lines[0].includes('[yellow]') && !a.lines[0].includes('[reverse yellow]'), 'idx 0 plain match tag');
    assert(a.lines[1].includes('[reverse yellow]'), 'idx 1 active current tag');
    assert(a.lines[2].includes('[yellow]') && !a.lines[2].includes('[reverse yellow]'), 'idx 2 plain match tag');
  });
  it('active-match index is ABSOLUTE across the buffer, not window-relative', () => {
    const lines = ['aa foo', 'bb foo', 'cc foo', 'dd foo'];
    const matches = ms.matchesFor(lines, 'foo');
    // window = abs lines 2..3; active global idx 2 → the FIRST window row.
    const a = buildTextView({ lines, scroll: 2, innerH: 2, searchDecoration: { matches, activeIdx: 2 }, width: 20, height: 4 });
    assert(a.lines[0].includes('[reverse yellow]'), 'window row 0 (abs line 2) is active');
    assert(!a.lines[1].includes('[reverse yellow]'), 'window row 1 (abs line 3) not active');
  });
  it('o.searchTags overrides the defaults (the production theme path)', () => {
    const lines = ['aa foo'];
    const matches = ms.matchesFor(lines, 'foo');
    const a = buildTextView({
      lines, scroll: 0, innerH: 1, width: 20, height: 3,
      searchDecoration: { matches, activeIdx: 0 },
      searchTags: { match: 'M', current: 'C' },
    });
    assert(a.lines[0].includes('[C]foo[/]'), 'current tag threaded');
  });
});

describe('[text-view] A3 windowed-decorate byte-identity', () => {
  it('window+offset decorate == whole-buffer decorate then slice', () => {
    const lines = ['x foo', 'y foo', 'z foo', 'w foo', 'v foo'];
    const matches = ms.matchesFor(lines, 'foo');
    const whole = buildTextView({ lines, scroll: 0, innerH: 5, searchDecoration: { matches, activeIdx: 3 }, width: 20, height: 7 }).lines;
    const window = buildTextView({ lines, scroll: 1, innerH: 3, searchDecoration: { matches, activeIdx: 3 }, width: 20, height: 5 }).lines;
    eq(JSON.stringify(window), JSON.stringify(whole.slice(1, 4)), 'window == whole then slice');
  });
});

describe('[text-view] selection wins over search', () => {
  it('decorates the selected line ([reverse]); search is suppressed', () => {
    const lines = ['hello', 'world', 'again'];
    const sel = { active: true, kind: 'char', anchor: { line: 1, col: 0 }, cursor: { line: 1, col: 4 } };
    const searchDecoration = { matches: [{ line: 0, col: 0, len: 5 }], activeIdx: 0 };
    const a = buildTextView({ lines, scroll: 0, innerH: 3, select: sel, searchDecoration, width: 20, height: 5 });
    assert(a.lines[1].includes('[reverse]'), 'selected line 1 highlighted');
    eq(a.lines[0], 'hello', 'line 0 untouched — search suppressed by an active selection');
  });
});

describe('[text-view] no decoration', () => {
  it('passthrough window when neither select nor search given', () => {
    const a = buildTextView({ lines: LINES, scroll: 0, innerH: 3, width: 20, height: 5 });
    eq(a.lines[0], 'line one');
    assert(!a.lines[0].includes('['), 'no markup added');
  });
});

report();
