/**
 * Detail-search smoke test — substring + regex matching, case-
 * insensitivity, invalid regex graceful, navigation, autoscroll.
 *
 * Run: node js/test/test-viewer-search.js
 */
'use strict';

const search = require('../panel/viewer/search');
const ms = require('../leaves/search');
const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');

// P1 (viewer-lines selector) — matches are DERIVED via the
// ms.matchesFor(lines, term) memo, not stored on slice.search. Tests
// read them the way production consumers do: derive from the slice's
// lines + the phase-correct term.
const { displayedLines } = require('./_helpers/viewer-lines');
function typingMatches() {
  const sl = getInstanceSlice('detail');
  return ms.matchesFor(displayedLines(sl), sl.search.typing || '');
}
function committedMatches() {
  const sl = getInstanceSlice('detail');
  return ms.matchesFor(displayedLines(sl), sl.search.term || '');
}


function setup(lines, panelH = 10) {
  getInstanceSlice('detail').infoLines = lines.slice();  // P3 — Info canonical home
  getInstanceSlice('detail').scroll = 0;
  // A1/B1 fix: viewer.update reads slice.innerH directly. Tests seed it
  // on the detail slice (was: cross-slice into layout.panelHeights.detail).
  getInstanceSlice('detail').innerH = Math.max(1, panelH - 2);
  getModel().modes.detailSearchMode = false;
  getInstanceSlice('detail').search = { active: false, term: '', idx: 0, typing: '' };
}

describe('[1] substring match (regex literal chars)', () => {
  it('finds all occurrences across lines', () => {
    setup(['hello world', 'world peace', 'hello again']);
    search.enter();
    'hello'.split('').forEach(c => search.keystroke(c));
    eq(typingMatches().length, 2, 'matches on line 0 and 2');
    eq(typingMatches()[0].line, 0);
    eq(typingMatches()[0].col, 0);
    eq(typingMatches()[1].line, 2);
  });
});

describe('[2] case-insensitive by default', () => {
  it('lowercase pattern matches uppercase text', () => {
    setup(['HELLO World', 'hello WORLD']);
    search.enter();
    'world'.split('').forEach(c => search.keystroke(c));
    eq(typingMatches().length, 2, 'both lines match');
  });
});

describe('[3] regex meta-characters work', () => {
  it('alternation', () => {
    setup(['error: foo', 'warn: bar', 'info: baz']);
    search.enter();
    'error|warn'.split('').forEach(c => search.keystroke(c));
    eq(typingMatches().length, 2, 'error + warn match');
  });
  it('character class', () => {
    setup(['code 42', 'code 7', 'code XX']);
    search.enter();
    '[0-9]+'.split('').forEach(c => search.keystroke(c));
    eq(typingMatches().length, 2, 'two digit-runs found');
  });
});

describe('[4] invalid regex during typing is graceful', () => {
  it('partial pattern `[` does not throw; matches empty', () => {
    setup(['line a', 'line b']);
    search.enter();
    search.keystroke('[');
    eq(typingMatches().length, 0, 'no matches on invalid pattern');
    // Continue typing to make it valid again
    search.keystroke('a');
    search.keystroke(']');
    eq(typingMatches().length, 1, 'recovers when pattern becomes valid');
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
    assert(committedMatches().length > 0);
    search.clearCommitted();
    eq(getInstanceSlice('detail').search.active, false);
    eq(committedMatches().length, 0, 'cleared term derives no matches');
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
    eq(committedMatches().length, 2);
    search.enter();      // reopen
    search.keystroke('X');
    search.cancel();     // Esc
    eq(getInstanceSlice('detail').search.term, 'hello', 'committed term restored');
    eq(committedMatches().length, 2);
  });
});

describe('[7] next/prev cycles + autoscroll', () => {
  it('next wraps around; idx advances', () => {
    setup(Array.from({ length: 20 }, (_, i) => `row${i % 5}`));
    // matches "row0" at lines 0, 5, 10, 15
    search.enter();
    'row0'.split('').forEach(c => search.keystroke(c));
    search.commit();
    eq(committedMatches().length, 4);
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
    const out = search.decorateLines(displayedLines(getInstanceSlice('detail')));
    eq(out[0], 'no match here', 'untouched');
    assert(out[1].includes('[yellow]'), 'matched line carries [yellow]');
  });
  it('current match gets reverse style', () => {
    setup(['foo bar foo']);
    search.enter();
    'foo'.split('').forEach(c => search.keystroke(c));
    search.commit();
    getInstanceSlice('detail').search.idx = 0;
    const out = search.decorateLines(displayedLines(getInstanceSlice('detail')));
    // First match (idx=0) → [reverse][yellow]
    assert(out[0].includes('[reverse][yellow]'), `expected active style: ${out[0]}`);
    // Second match (idx=1) → [yellow] only (no reverse)
    const r1 = out[0].indexOf('[reverse]');
    const y2 = out[0].indexOf('[yellow]', r1 + 1);
    assert(y2 > 0, 'second span exists');
  });
  it('no matches → pass-through', () => {
    setup(['abc', 'def']);
    const out = search.decorateLines(displayedLines(getInstanceSlice('detail')));
    eq(out, displayedLines(getInstanceSlice('detail')));
  });
});

describe('[8b] decorateLines decorates the RENDERED pane, not the focused one', () => {
  // P4 review fix (multi-viewer) — an explicit slice arg wins over the
  // focused-viewer resolution, and the typing-phase preview applies
  // ONLY to the focused slice; an unfocused pane shows its own
  // committed term.
  it('explicit slice arg drives term + idx', () => {
    setup(['focused content']);              // focused viewer: no search
    const other = {
      infoLines: ['target here', 'no hit', 'target again'],
      search: { active: true, term: 'target', idx: 1, typing: '' },
    };
    const lines = other.infoLines;
    const out = search.decorateLines(lines, other);
    assert(out[0].includes('[yellow]'), 'unfocused pane decorated with ITS OWN committed term');
    assert(out[2].includes('[reverse]'), 'active idx from the passed slice');
    const focusedOut = search.decorateLines(displayedLines(getInstanceSlice('detail')));
    eq(focusedOut[0], 'focused content', 'focused pane (no search) untouched');
  });
  it('typing preview applies only to the focused slice', () => {
    setup(['alpha beta']);
    search.enter();
    'beta'.split('').forEach(c => search.keystroke(c));
    // While detailSearchMode is ON, a DIFFERENT pane's decoration must
    // not pick up the focused pane's typing buffer.
    const other = {
      infoLines: ['beta lives here'],
      search: { active: false, term: '', idx: 0, typing: '' },
    };
    const out = search.decorateLines(other.infoLines, other);
    eq(out[0], 'beta lives here', 'unfocused pane has no active search → no highlight');
    search.cancel();
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

describe('[10] P1 — committed search survives a lines-change (derived matches)', () => {
  // Historical B2 added a finalizer recompute so a committed search
  // survived content changes. P1 deleted that machinery: matches DERIVE
  // from (lines, term) via ms.matchesFor, so survival is structural —
  // these tests pin the derived behavior across an append.
  it('viewer_append on Transcript re-derives matches against the new buffer', () => {
    const viewer = require('../panel/viewer/viewer');
    // Park on Transcript (tab 1) with one matching line in the buffer.
    const s0 = {
      ...viewer._init(),
      tab: 1,
      innerH: 8,
      viewerStreamBuffer: { lines: ['target line one'], cap: 1000 },
    };
    // Commit a search by running it through the reducer (search.enter +
    // keystrokes + commit) so the finalizer derives lines from the
    // buffer and the search state lands `active=true`.
    let s = viewer._update({ type: 'viewer_search_enter' }, s0);
    s = Array.isArray(s) ? s[0] : s;
    for (const c of 'target') {
      s = viewer._update({ type: 'viewer_search_key', seq: c }, s);
      s = Array.isArray(s) ? s[0] : s;
    }
    s = viewer._update({ type: 'viewer_search_commit' }, s);
    s = Array.isArray(s) ? s[0] : s;
    eq(s.search.active, true, 'search committed');
    eq(ms.matchesFor(displayedLines(s), s.search.term).length, 1, 'one match before append');

    // Append a second line that also matches /target.
    const r = viewer._update({ type: 'viewer_append', line: 'another target' }, s);
    const next = Array.isArray(r) ? r[0] : r;
    eq(next.viewerStreamBuffer.lines.length, 2, 'buffer grew');
    const derived = ms.matchesFor(displayedLines(next), next.search.term);
    eq(derived.length, 2, 'matches derive against new lines (P1)');
    eq(derived[1].line, 1, 'new match lands on line 1');
  });

  it('a non-matching append still re-derives — matches re-count to original', () => {
    const viewer = require('../panel/viewer/viewer');
    const s0 = {
      ...viewer._init(),
      tab: 1,
      innerH: 8,
      viewerStreamBuffer: { lines: ['target one', 'noise'], cap: 1000 },
    };
    let s = viewer._update({ type: 'viewer_search_enter' }, s0);
    s = Array.isArray(s) ? s[0] : s;
    for (const c of 'target') {
      s = viewer._update({ type: 'viewer_search_key', seq: c }, s);
      s = Array.isArray(s) ? s[0] : s;
    }
    s = viewer._update({ type: 'viewer_search_commit' }, s);
    s = Array.isArray(s) ? s[0] : s;
    eq(ms.matchesFor(displayedLines(s), s.search.term).length, 1, 'one match before append');

    const r = viewer._update({ type: 'viewer_append', line: 'unrelated' }, s);
    const next = Array.isArray(r) ? r[0] : r;
    eq(ms.matchesFor(displayedLines(next), next.search.term).length, 1, 'still one match (no new hits)');
  });

  it('inactive search is not touched (gate respects search.active=false)', () => {
    const viewer = require('../panel/viewer/viewer');
    const s0 = {
      ...viewer._init(),
      tab: 1,
      innerH: 8,
      viewerStreamBuffer: { lines: ['line one'], cap: 1000 },
    };
    const r = viewer._update({ type: 'viewer_append', line: 'line two' }, s0);
    const next = Array.isArray(r) ? r[0] : r;
    eq(next.search.active, false, 'search still inactive');
    eq(ms.matchesFor(displayedLines(next), next.search.term || '').length, 0, 'no term derives no matches');
  });
});

describe('[N] "/" key enters search via the viewer itself (#3 controller-thinning)', () => {
  // The viewer claims `/` in its own `case 'key'` now that it's the focused
  // pane — dispatch.js no longer focus-checks + dispatches viewer_search_enter.
  // Same end state as the `viewer_search_enter` Msg path (search.js), reached
  // through the key claim.
  it('focused detail: "/" claims the key and arms detailSearchMode', () => {
    const viewer = require('../panel/viewer/viewer');
    const s0 = { ...viewer._init(), infoLines: ['alpha', 'beta'], innerH: 8 };
    const r = viewer._update({ type: 'key', key: '/', focusKind: 'detail' }, s0);
    assert(Array.isArray(r), 'returns [slice, effects] (claimed)');
    const effects = r[1];
    assert(effects.some(e => e.type === '_claimed'), 'claims the keystroke');
    assert(
      effects.some(e => e.type === 'msg' && e.msg && e.msg.type === 'mode_set' && e.msg.flag === 'detailSearchMode'),
      'arms the detailSearchMode chain flag (same as viewer_search_enter)',
    );
  });

  it('non-detail focus: "/" is left for the controller (filter mode)', () => {
    const viewer = require('../panel/viewer/viewer');
    const r = viewer._update({ type: 'key', key: '/', focusKind: 'groups' }, { ...viewer._init() });
    assert(!Array.isArray(r), 'returns the bare slice (unclaimed) so handleNormalKey runs _enterFilterMode');
  });
});

report();
