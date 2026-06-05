/**
 * Detail-search smoke test — substring + regex matching, case-
 * insensitivity, invalid regex graceful, navigation, autoscroll.
 *
 * Run: node js/test/test-viewer-search.js
 */
'use strict';

const search = require('../panel/viewer/search');
const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');


function setup(lines, panelH = 10) {
  getInstanceSlice('detail').lines = lines.slice();
  getInstanceSlice('detail').scroll = 0;
  // A1/B1 fix: viewer.update reads slice.innerH directly. Tests seed it
  // on the detail slice (was: cross-slice into layout.panelHeights.detail).
  getInstanceSlice('detail').innerH = Math.max(1, panelH - 2);
  getModel().modes.detailSearchMode = false;
  getInstanceSlice('detail').search = { active: false, term: '', matches: [], idx: 0 };
}

describe('[1] substring match (regex literal chars)', () => {
  it('finds all occurrences across lines', () => {
    setup(['hello world', 'world peace', 'hello again']);
    search.enter();
    'hello'.split('').forEach(c => search.keystroke(c));
    eq(getInstanceSlice('detail').search.matches.length, 2, 'matches on line 0 and 2');
    eq(getInstanceSlice('detail').search.matches[0].line, 0);
    eq(getInstanceSlice('detail').search.matches[0].col, 0);
    eq(getInstanceSlice('detail').search.matches[1].line, 2);
  });
});

describe('[2] case-insensitive by default', () => {
  it('lowercase pattern matches uppercase text', () => {
    setup(['HELLO World', 'hello WORLD']);
    search.enter();
    'world'.split('').forEach(c => search.keystroke(c));
    eq(getInstanceSlice('detail').search.matches.length, 2, 'both lines match');
  });
});

describe('[3] regex meta-characters work', () => {
  it('alternation', () => {
    setup(['error: foo', 'warn: bar', 'info: baz']);
    search.enter();
    'error|warn'.split('').forEach(c => search.keystroke(c));
    eq(getInstanceSlice('detail').search.matches.length, 2, 'error + warn match');
  });
  it('character class', () => {
    setup(['code 42', 'code 7', 'code XX']);
    search.enter();
    '[0-9]+'.split('').forEach(c => search.keystroke(c));
    eq(getInstanceSlice('detail').search.matches.length, 2, 'two digit-runs found');
  });
});

describe('[4] invalid regex during typing is graceful', () => {
  it('partial pattern `[` does not throw; matches empty', () => {
    setup(['line a', 'line b']);
    search.enter();
    search.keystroke('[');
    eq(getInstanceSlice('detail').search.matches.length, 0, 'no matches on invalid pattern');
    // Continue typing to make it valid again
    search.keystroke('a');
    search.keystroke(']');
    eq(getInstanceSlice('detail').search.matches.length, 1, 'recovers when pattern becomes valid');
  });
});

describe('[5] commit + clear', () => {
  it('Enter commits typing → active; Esc on committed clears', () => {
    setup(['alpha', 'beta', 'gamma']);
    search.enter();
    'a'.split('').forEach(c => search.keystroke(c));
    search.commit();
    eq(getModel().modes.detailSearchMode, false);
    eq(getInstanceSlice('detail').search.active, true);
    assert(getInstanceSlice('detail').search.matches.length > 0);
    search.clearCommitted();
    eq(getInstanceSlice('detail').search.active, false);
    eq(getInstanceSlice('detail').search.matches.length, 0);
    eq(getInstanceSlice('detail').search.term, '');
  });
  it('empty commit clears active', () => {
    setup(['only one']);
    search.enter();
    search.commit();
    eq(getInstanceSlice('detail').search.active, false, 'empty term yields no active search');
  });
});

describe('[6] cancel during typing restores prior committed term', () => {
  it('partial edit + Esc reverts to last committed', () => {
    setup(['hello world', 'hello again']);
    search.enter();
    'hello'.split('').forEach(c => search.keystroke(c));
    search.commit();
    eq(getInstanceSlice('detail').search.term, 'hello');
    eq(getInstanceSlice('detail').search.matches.length, 2);
    search.enter();      // reopen
    search.keystroke('X');
    search.cancel();     // Esc
    eq(getInstanceSlice('detail').search.term, 'hello', 'committed term restored');
    eq(getInstanceSlice('detail').search.matches.length, 2);
  });
});

describe('[7] next/prev cycles + autoscroll', () => {
  it('next wraps around; idx advances', () => {
    setup(Array.from({ length: 20 }, (_, i) => `row${i % 5}`));
    // matches "row0" at lines 0, 5, 10, 15
    search.enter();
    'row0'.split('').forEach(c => search.keystroke(c));
    search.commit();
    eq(getInstanceSlice('detail').search.matches.length, 4);
    eq(getInstanceSlice('detail').search.idx, 0);
    search.next();
    eq(getInstanceSlice('detail').search.idx, 1);
    search.next(); search.next();
    eq(getInstanceSlice('detail').search.idx, 3);
    search.next();
    eq(getInstanceSlice('detail').search.idx, 0, 'wraps to start');
    search.prev();
    eq(getInstanceSlice('detail').search.idx, 3, 'prev from 0 wraps to last');
  });
  it('autoscroll brings the match line into view', () => {
    setup(Array.from({ length: 50 }, (_, i) =>
      i === 30 ? 'TARGET' : `filler${i}`
    ), /*panelH=*/ 8);
    search.enter();
    'TARGET'.split('').forEach(c => search.keystroke(c));
    search.commit();
    assert(getInstanceSlice('detail').scroll > 0, `scrolled to TARGET (got ${getInstanceSlice('detail').scroll})`);
    const innerH = 6;
    const top = getInstanceSlice('detail').scroll;
    assert(30 >= top && 30 < top + innerH, 'TARGET line is now in viewport');
  });
});

describe('[8] decorateLines render integration', () => {
  it('non-matching lines pass through', () => {
    setup(['no match here', 'has FOO in it']);
    search.enter();
    'foo'.split('').forEach(c => search.keystroke(c));
    search.commit();
    const out = search.decorateLines(getInstanceSlice('detail').lines);
    eq(out[0], 'no match here', 'untouched');
    assert(out[1].includes('[yellow]'), 'matched line carries [yellow]');
  });
  it('current match gets reverse style', () => {
    setup(['foo bar foo']);
    search.enter();
    'foo'.split('').forEach(c => search.keystroke(c));
    search.commit();
    getInstanceSlice('detail').search.idx = 0;
    const out = search.decorateLines(getInstanceSlice('detail').lines);
    // First match (idx=0) → [reverse][yellow]
    assert(out[0].includes('[reverse][yellow]'), `expected active style: ${out[0]}`);
    // Second match (idx=1) → [yellow] only (no reverse)
    const r1 = out[0].indexOf('[reverse]');
    const y2 = out[0].indexOf('[yellow]', r1 + 1);
    assert(y2 > 0, 'second span exists');
  });
  it('no matches → pass-through', () => {
    setup(['abc', 'def']);
    const out = search.decorateLines(getInstanceSlice('detail').lines);
    eq(out, getInstanceSlice('detail').lines);
  });
});

describe('[9] zero-width pattern does not infinite-loop', () => {
  it('pattern `a*` matches but the recompute terminates', () => {
    setup(['banana']);
    search.enter();
    // Time-bound: if this hangs we never get to the assertion.
    const start = Date.now();
    search.keystroke('a');
    search.keystroke('*');
    const elapsed = Date.now() - start;
    assert(elapsed < 500, `recompute fast (${elapsed}ms)`);
  });
});

report();
