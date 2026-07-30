/**
 * Detail-search smoke test — substring + regex matching, case-
 * insensitivity, invalid regex graceful, navigation, autoscroll.
 *
 * U2e P1b — the viewer's single `detail` slot dissolved into sibling
 * POSITION-TAB instances. The content-slot's ACTIVE instance is now `info`
 * (kind 'info'), which stores its buffer on `slice.lines` (not the retired
 * `detail.infoLines`). We boot a real seeded content slot (parse-shaped config
 * → initState → per-pane mint) and drive search through the SAME facade
 * (panel/content/search) production uses: every wrapper targets
 * `resolveTarget('viewer')`, which now resolves to the active `info` instance,
 * so search operates on the info instance's `slice.lines`. The search/match
 * math itself is unchanged. The unrouted-append case ([10]) moved to the
 * Transcript text-view instance's `tv_*` arms.
 *
 * Run: node js/test/test-viewer-search.js
 */
'use strict';

const search = require('../panel/content/search');
const ms = require('../leaves/text/search');
const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');
const route = require('../panel/route');

// --- Boot a real seeded content slot ------------------------------------
//
// test-runner registers layout/detail/groups but not info/text-view, and
// doesn't boot a config. The content slot's info + transcript instances are
// minted by `_seedContentSlots` (arrange.js) → reconcilePaneInstances, which
// only runs through initState. Register the two extra Components (production
// does via BUILTIN_COMPONENTS) then boot a minimal parse-shaped config.
const api = require('../panel/api');
if (!api.getComponent('text-view')) api.registerComponent(require('../panel/text-view/text-view'));
if (!api.getComponent('info'))      api.registerComponent(require('../panel/info/info'));
const { initState } = require('../app/state');
getModel().config = {
  theme: 'default',
  register: { cap: 10 },
  groups: { g: { label: 'G', actions: {}, items: [{ name: 'a' }, { name: 'b' }] } },
  warnings: [],
};
initState();

// The content-slot's ACTIVE instance (info by default) — the facade's
// resolveTarget('viewer') lands here. viewer_info is the same instance while
// info is active; using the explicit intent keeps the resolution honest.
function infoSlice() { return getInstanceSlice(route.resolveTarget('viewer_info')); }

// P1 (viewer-lines selector) — matches are DERIVED via the
// ms.matchesFor(lines, term) memo, not stored on slice.search. Tests
// read them the way production consumers do: derive from the info
// instance's `slice.lines` + the phase-correct term.
function typingMatches() {
  const sl = infoSlice();
  return ms.matchesFor(sl.lines || [], sl.search.typing || '');
}
function committedMatches() {
  const sl = infoSlice();
  return ms.matchesFor(sl.lines || [], sl.search.term || '');
}


function setup(lines, panelH = 10) {
  const sl = infoSlice();
  // U2e P1b — Info content's canonical home is the info instance's `slice.lines`.
  sl.lines = lines.slice();
  sl.scroll = 0;
  // A1/B1 fix: the shared tvu reducer reads slice.innerH directly (stamped by
  // augmentMsg in production). Tests seed it on the info instance's slice.
  sl.innerH = Math.max(1, panelH - 2);
  getModel().modes.detailSearchMode = false;
  sl.search = { active: false, term: '', idx: 0, typing: '' };
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
    eq(infoSlice().search.active, true);
    assert(committedMatches().length > 0);
    search.clearCommitted();
    eq(infoSlice().search.active, false);
    eq(committedMatches().length, 0, 'cleared term derives no matches');
    eq(infoSlice().search.term, '');
  });
  it('empty commit clears active', () => {
    setup(['only one']);
    search.enter();
    search.commit();
    eq(infoSlice().search.active, false, 'empty term yields no active search');
  });
});

describe('[6] cancel during typing restores prior committed term', () => {
  it('partial edit + Esc reverts to last committed', () => {
    setup(['hello world', 'hello again']);
    search.enter();
    'hello'.split('').forEach(c => search.keystroke(c));
    search.commit();
    eq(infoSlice().search.term, 'hello');
    eq(committedMatches().length, 2);
    search.enter();      // reopen
    search.keystroke('X');
    search.cancel();     // Esc
    eq(infoSlice().search.term, 'hello', 'committed term restored');
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
    eq(infoSlice().search.idx, 0);
    search.next();
    eq(infoSlice().search.idx, 1);
    search.next(); search.next();
    eq(infoSlice().search.idx, 3);
    search.next();
    eq(infoSlice().search.idx, 0, 'wraps to start');
    search.prev();
    eq(infoSlice().search.idx, 3, 'prev from 0 wraps to last');
  });
  it('autoscroll brings the match line into view', () => {
    setup(Array.from({ length: 50 }, (_, i) =>
      i === 30 ? 'TARGET' : `filler${i}`
    ), /*panelH=*/ 8);
    search.enter();
    'TARGET'.split('').forEach(c => search.keystroke(c));
    search.commit();
    assert(infoSlice().scroll > 0, `scrolled to TARGET (got ${infoSlice().scroll})`);
    const innerH = 6;
    const top = infoSlice().scroll;
    assert(30 >= top && 30 < top + innerH, 'TARGET line is now in viewport');
  });
});

describe('[8] decorateLines render integration', () => {
  it('non-matching lines pass through', () => {
    setup(['no match here', 'has FOO in it']);
    search.enter();
    'foo'.split('').forEach(c => search.keystroke(c));
    search.commit();
    const out = search.decorateLines(infoSlice().lines);
    eq(out[0], 'no match here', 'untouched');
    assert(out[1].includes('[yellow]'), 'matched line carries [yellow]');
  });
  it('current match gets reverse style', () => {
    setup(['foo bar foo']);
    search.enter();
    'foo'.split('').forEach(c => search.keystroke(c));
    search.commit();
    infoSlice().search.idx = 0;
    const out = search.decorateLines(infoSlice().lines);
    // First match (idx=0) → [reverse][yellow]
    assert(out[0].includes('[reverse][yellow]'), `expected active style: ${out[0]}`);
    // Second match (idx=1) → [yellow] only (no reverse)
    const r1 = out[0].indexOf('[reverse]');
    const y2 = out[0].indexOf('[yellow]', r1 + 1);
    assert(y2 > 0, 'second span exists');
  });
  it('no matches → pass-through', () => {
    setup(['abc', 'def']);
    const out = search.decorateLines(infoSlice().lines);
    eq(out, infoSlice().lines);
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
      lines: ['target here', 'no hit', 'target again'],
      search: { active: true, term: 'target', idx: 1, typing: '' },
    };
    const lines = other.lines;
    const out = search.decorateLines(lines, other);
    assert(out[0].includes('[yellow]'), 'unfocused pane decorated with ITS OWN committed term');
    assert(out[2].includes('[reverse]'), 'active idx from the passed slice');
    const focusedOut = search.decorateLines(infoSlice().lines);
    eq(focusedOut[0], 'focused content', 'focused pane (no search) untouched');
  });
  it('typing preview applies only to the focused slice', () => {
    setup(['alpha beta']);
    search.enter();
    'beta'.split('').forEach(c => search.keystroke(c));
    // While detailSearchMode is ON, a DIFFERENT pane's decoration must
    // not pick up the focused pane's typing buffer.
    const other = {
      lines: ['beta lives here'],
      search: { active: false, term: '', idx: 0, typing: '' },
    };
    const out = search.decorateLines(other.lines, other);
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
  // from (lines, term) via ms.matchesFor, so survival is structural.
  // U2e P1b — the unrouted stream moved off the viewer's flat
  // `viewerStreamBuffer` onto the Transcript text-view INSTANCE's `slice.lines`
  // via the `tv_*` arms. These pin the derived behavior across a `tv_append`,
  // driving the transcript instance through wrapped viewer_search_* + tv_* Msgs.
  const D = (id, msg) => api.dispatchMsg(api.wrap(id, msg));
  const transcriptId = () => route.resolveTarget('viewer_transcript');
  // The transcript instance is a shared singleton across `it` blocks (the
  // original tests each spun a fresh viewer._init()). Reset its committed
  // search + set a viewport before each case so no prior term leaks in
  // (viewer_search_enter would seed the leaked term into `typing`).
  const resetTranscript = (tid) => {
    D(tid, { type: 'viewer_search_clear_committed' });
    api.getInstanceSlice(tid).innerH = 8;
  };

  it('tv_append on the Transcript instance re-derives matches against the new buffer', () => {
    const tid = transcriptId();
    // Park on Transcript with one matching line; give it a viewport.
    resetTranscript(tid);
    D(tid, { type: 'tv_set_lines', lines: ['target line one'] });
    // Commit a search by running it through the transcript instance's reducer.
    D(tid, { type: 'viewer_search_enter' });
    for (const c of 'target') D(tid, { type: 'viewer_search_key', seq: c });
    D(tid, { type: 'viewer_search_commit' });
    let s = api.getInstanceSlice(tid);
    eq(s.search.active, true, 'search committed');
    eq(ms.matchesFor(s.lines, s.search.term).length, 1, 'one match before append');

    // Append a second line that also matches /target.
    D(tid, { type: 'tv_append', line: 'another target' });
    s = api.getInstanceSlice(tid);
    eq(s.lines.length, 2, 'buffer grew');
    const derived = ms.matchesFor(s.lines, s.search.term);
    eq(derived.length, 2, 'matches derive against new lines (P1)');
    eq(derived[1].line, 1, 'new match lands on line 1');
  });

  it('a non-matching append still re-derives — matches re-count to original', () => {
    const tid = transcriptId();
    resetTranscript(tid);
    D(tid, { type: 'tv_set_lines', lines: ['target one', 'noise'] });
    D(tid, { type: 'viewer_search_enter' });
    for (const c of 'target') D(tid, { type: 'viewer_search_key', seq: c });
    D(tid, { type: 'viewer_search_commit' });
    let s = api.getInstanceSlice(tid);
    eq(ms.matchesFor(s.lines, s.search.term).length, 1, 'one match before append');

    D(tid, { type: 'tv_append', line: 'unrelated' });
    s = api.getInstanceSlice(tid);
    eq(ms.matchesFor(s.lines, s.search.term).length, 1, 'still one match (no new hits)');
  });

  it('inactive search is not touched (gate respects search.active=false)', () => {
    const tid = transcriptId();
    resetTranscript(tid);   // fresh set of lines with no committed search
    D(tid, { type: 'tv_set_lines', lines: ['line one'] });
    D(tid, { type: 'tv_append', line: 'line two' });
    const s = api.getInstanceSlice(tid);
    eq(s.search.active, false, 'search still inactive');
    eq(ms.matchesFor(s.lines, s.search.term || '').length, 0, 'no term derives no matches');
  });
});

describe('[N] "/" key enters search via the content pane itself (#3 controller-thinning)', () => {
  // The focused content pane claims `/` in its own `case 'key'` (dispatch.js no
  // longer focus-checks + dispatches viewer_search_enter). U2f — the `detail`
  // viewer Component is gone; the `/`-claim now lives in the SHARED tvu reducer
  // (leaves/text/text-view-update `case 'key'`), gated on `msg.focusKind ===
  // ownKind`. The content slot's active tab is `info` (ownKind 'info'), so we
  // exercise the claim through the info Component's `update` — the same end state
  // as the `viewer_search_enter` Msg path (search.js), reached through the key claim.
  const info = require('../panel/info/info');
  it('focused content pane: "/" claims the key and arms detailSearchMode', () => {
    const s0 = { ...info.init('pane-x'), lines: ['alpha', 'beta'], innerH: 8 };
    const r = info.update({ type: 'key', key: '/', focusKind: 'info' }, s0);
    assert(Array.isArray(r), 'returns [slice, effects] (claimed)');
    const effects = r[1];
    assert(effects.some(e => e.type === '_claimed'), 'claims the keystroke');
    assert(
      effects.some(e => e.type === 'msg' && e.msg && e.msg.type === 'mode_set' && e.msg.flag === 'detailSearchMode'),
      'arms the detailSearchMode chain flag (same as viewer_search_enter)',
    );
  });

  it('non-content focus: "/" is left for the controller (filter mode)', () => {
    // focusKind mismatches ownKind ('info') → the tvu key state machine returns the
    // bare slice (unclaimed), so handleNormalKey runs _enterFilterMode.
    const r = info.update({ type: 'key', key: '/', focusKind: 'groups' }, { ...info.init('pane-x') });
    assert(!Array.isArray(r), 'returns the bare slice (unclaimed) so handleNormalKey runs _enterFilterMode');
  });
});

report();
