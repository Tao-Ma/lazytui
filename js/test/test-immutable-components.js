/**
 * Pure-TEA conversion smoke test — stateless Components (Phase 2).
 *
 * The Components in this file already used return-new at audit time
 * (Phase 2 was billed as a verification pass per the arc memo). These
 * tests pin the contract so a future in-place regression is caught
 * automatically: each public Msg's slice-mutating branch runs against
 * a deep-frozen input.
 *
 * Scope: the branches that can be exercised WITHOUT global IO setup —
 *   docker          dockerResult
 *   files           dirLoaded, showHidden
 *   config-status   cfgStatusResult, key '['/']'
 *   stats           any-Msg no-op (identity)
 *   history         non-claim no-op + nav Msg (T9 coverage)
 *   actions         nav Msg + non-nav identity (T9 coverage)
 *
 * Branches that read model.config / model.focused / panel layout (eg.
 * `refresh` on docker, files, config-status) are exercised by the
 * existing integration suites — pinning them here would require deep
 * fixture setup that duplicates that coverage.
 *
 * config-branch isn't a Component — it exports `name` + `groupActions`
 * only (no `update`), so it has no slice-write surface to pin.
 *
 * Run: node js/test/test-immutable-components.js
 */
'use strict';

const { describe, it, eq, assert, expectNoMutation, report } = require('./test-runner');

const docker        = require('../panel/navigator/docker');
const files         = require('../panel/navigator/files');
const configStatus  = require('../panel/navigator/config-status');
const stats         = require('../panel/monitor/stats');
const history       = require('../panel/navigator/history');
const actions       = require('../panel/navigator/actions');
const groups        = require('../panel/navigator/groups');
const detail        = require('../panel/viewer/viewer');
const runtime       = require('../app/runtime');

// --- docker --------------------------------------------------------------

describe('[immutable] docker', () => {
  it('dockerResult folds status + stats into a new slice', () => {
    const slice = {
      status: { old: 'running' },
      stats: { old: { cpu: '1%', mem: '10M' } },
      inFlight: true,
      started: true,
      eventsStarted: true,
      nav: {},
    };
    const msg = {
      type: 'dockerResult',
      status: { box: 'running' },
      stats: { box: { cpu: '5%', mem: '20M' } },
    };
    const [next, fx] = expectNoMutation(
      'docker dockerResult leaves input frozen',
      () => docker.update(msg, slice),
      slice,
    );
    eq(next.status.box, 'running', 'new status folded');
    eq(next.stats.box.cpu, '5%', 'new stats folded');
    eq(next.inFlight, false, 'inFlight cleared');
    assert(next !== slice, 'fresh slice ref');
    eq(fx[0].type, 'render', 'render Cmd emitted');
  });

  it('dockerResult with no maps keeps prior values', () => {
    const slice = { status: { a: 'running' }, stats: { a: {} }, inFlight: true, nav: {} };
    const [next] = expectNoMutation(
      'docker dockerResult (no maps) leaves input frozen',
      () => docker.update({ type: 'dockerResult' }, slice),
      slice,
    );
    eq(next.status, slice.status, 'status ref preserved (no replacement)');
    eq(next.inFlight, false, 'inFlight still clears');
  });
});

// --- files ---------------------------------------------------------------

describe('[immutable] files', () => {
  it('dirLoaded updates the named browser, leaves others alone', () => {
    const slice = {
      browsers: {
        files: { cwd: '/', items: null, loading: true, seq: 1, lastError: null },
        ssh: { cwd: '/etc', items: ['x'], loading: false, seq: 7, lastError: null },
      },
      nav: {},
    };
    const msg = { type: 'dirLoaded', panelType: 'files', seq: 1, items: [{ kind: 'file', name: 'a' }] };
    const [next, fx] = expectNoMutation(
      'files dirLoaded leaves input frozen',
      () => files.update(msg, slice),
      slice,
    );
    eq(next.browsers.files.items.length, 1, 'items folded into named browser');
    eq(next.browsers.files.loading, false, 'loading flag cleared');
    eq(next.browsers.ssh, slice.browsers.ssh, 'other browsers ref-preserved');
    eq(fx[0].type, 'render');
  });

  it('dirLoaded with stale seq is a no-op', () => {
    const slice = {
      browsers: { files: { cwd: '/', items: null, loading: true, seq: 5, lastError: null } },
      nav: {},
    };
    const out = files.update({ type: 'dirLoaded', panelType: 'files', seq: 1, items: [] }, slice);
    assert(out === slice, 'stale dirLoaded returns same ref');
  });

  it('showHidden fans across browsers, marks each new', () => {
    const slice = {
      browsers: {
        files: { cwd: '/', showHidden: false, items: null, loading: false, seq: 0 },
      },
      nav: {},
    };
    const [next] = expectNoMutation(
      'files showHidden leaves input frozen',
      () => files.update({ type: 'showHidden', mode: 'on' }, slice),
      slice,
    );
    eq(next.browsers.files.showHidden, true, 'flag toggled on');
    // The other owned type gets seeded with the toggle applied
    eq(next.browsers['file-browser'].showHidden, true, 'file-browser seeded with toggle');
  });
});

// --- config-status -------------------------------------------------------

describe('[immutable] config-status', () => {
  const makeSlice = () => ({
    tab: 0, cache: null, branch: 'main', expanded: {}, computing: true,
    nav: {},
  });

  it('cfgStatusResult folds cache + clears computing', () => {
    const slice = makeSlice();
    const result = { branch: 'main', byPath: {}, children: {}, computedAt: 1 };
    const [next, fx] = expectNoMutation(
      'config-status cfgStatusResult leaves input frozen',
      () => configStatus.update({ type: 'cfgStatusResult', cache: result }, slice),
      slice,
    );
    eq(next.cache, result, 'cache folded');
    eq(next.computing, false);
    eq(fx[0].type, 'render');
  });

  it('] key advances the active tab', () => {
    const slice = makeSlice();
    const [next, fx] = expectNoMutation(
      "config-status ']' leaves input frozen",
      () => configStatus.update({ type: 'key', key: ']' }, slice),
      slice,
    );
    eq(next.tab, 1, 'tab advanced');
    eq(fx[0].type, '_claimed', 'key claimed');
  });

  it('[ key reverses', () => {
    const slice = { ...makeSlice(), tab: 1 };
    const [next] = expectNoMutation(
      "config-status '[' leaves input frozen",
      () => configStatus.update({ type: 'key', key: '[' }, slice),
      slice,
    );
    eq(next.tab, 0, 'tab reversed');
  });
});

// --- stats ---------------------------------------------------------------

describe('[immutable] stats', () => {
  it('any Msg returns the same slice', () => {
    const slice = { whatever: 'is here' };
    const out = stats.update({ type: 'refresh' }, slice);
    assert(out === slice, 'identity-preserve');
  });
});

// --- history -------------------------------------------------------------

describe('[immutable] history', () => {
  it('non-claim Msg returns the same slice', () => {
    const slice = { nav: {} };
    const out = history.update({ type: 'refresh' }, slice);
    assert(out === slice, 'no-op for non-handled Msg');
  });
  it('nav set_cursor flows through the shared leaf without mutating input', () => {
    const slice = { nav: { history: { cursor: 0, scroll: 0, multiSel: new Set(), filter: '' } } };
    const out = expectNoMutation(
      'history nav set_cursor leaves input frozen',
      () => history.update({ type: 'set_cursor', panel: 'history', index: 3 }, slice),
      slice,
    );
    eq(out.nav.history.cursor, 3, 'cursor advanced on a new slice');
    assert(out !== slice, 'fresh slice ref');
  });
});

// --- actions -------------------------------------------------------------
//
// Stateless Navigator — the entire update is `mnav.isNavMsg(msg) ? mnav.apply
// (slice, msg) : slice`. Pinning the freeze contract end-to-end through the
// Component (not just the leaf, which test-immutable-leaves.js covers) means
// a future direct mutation in the wrapper would still be caught.

describe('[immutable] actions', () => {
  it('nav set_cursor returns a new slice without mutating input', () => {
    const slice = { nav: { actions: { cursor: 0, scroll: 0, multiSel: new Set(), filter: '' } } };
    const out = expectNoMutation(
      'actions nav set_cursor leaves input frozen',
      () => actions.update({ type: 'set_cursor', panel: 'actions', index: 2 }, slice),
      slice,
    );
    eq(out.nav.actions.cursor, 2, 'cursor advanced on a new slice');
    assert(out !== slice, 'fresh slice ref');
  });
  it('nav multisel_toggle clones the Set copy-on-write', () => {
    const slice = { nav: { actions: { cursor: 0, scroll: 0, multiSel: new Set(['a']), filter: '' } } };
    const out = expectNoMutation(
      'actions multisel_toggle leaves input frozen',
      () => actions.update({ type: 'multisel_toggle', panel: 'actions', id: 'b' }, slice),
      slice,
    );
    assert(out.nav.actions.multiSel.has('b'), 'b added to new Set');
    assert(!slice.nav.actions.multiSel.has('b'), 'original Set untouched');
    assert(out.nav.actions.multiSel !== slice.nav.actions.multiSel, 'Set ref distinct');
  });
  it('non-nav Msg is identity-preserving', () => {
    const slice = { nav: { actions: { cursor: 0, scroll: 0, multiSel: new Set(), filter: '' } } };
    const same = actions.update({ type: 'action', actionKey: 'foo' }, slice);
    assert(same === slice, 'non-nav Msg returns the same slice ref');
  });
});

// --- groups (Phase 3 — stateful Component) -------------------------------
//
// Tree shape transforms now return-new. Use a minimal config so the leaf
// reads through getModel() find something.

describe('[immutable] groups', () => {
  function setupConfig() {
    const m = runtime.getModel();
    m.config = { groups: {
      g1:    { name: 'g1',    children: ['g1.a'], parent: null },
      'g1.a':{ name: 'g1.a',  children: [],       parent: 'g1', quick: true },
      g2:    { name: 'g2',    children: [],       parent: null },
    } };
    m.currentGroup = 'g1';
  }

  it('groups_recompute returns a new slice with rebuilt list', () => {
    setupConfig();
    const slice = { list: [], expanded: new Set(), tab: 'all', nav: {} };
    const out = expectNoMutation(
      'groups_recompute leaves input frozen',
      () => groups._update({ type: 'groups_recompute' }, slice),
      slice,
    );
    assert(out.list.length >= 2, 'list rebuilt with visible roots');
    assert(out !== slice, 'fresh slice ref');
  });

  it('toggle_group expand mutates copy-on-write Set', () => {
    setupConfig();
    const slice = { list: [], expanded: new Set(), tab: 'all', nav: {} };
    const [next, cmds] = expectNoMutation(
      'toggle_group expand leaves input frozen',
      () => groups._update({ type: 'toggle_group', name: 'g1' }, slice),
      slice,
    );
    assert(next.expanded.has('g1'), 'g1 expanded in new Set');
    assert(!slice.expanded.has('g1'), 'original Set untouched');
    assert(next.expanded !== slice.expanded, 'Set ref distinct');
    assert(Array.isArray(cmds), 'cascade Cmds returned');
  });

  it('toggle_group collapse builds a fresh Set without the path', () => {
    setupConfig();
    const init = { list: [], expanded: new Set(['g1']), tab: 'all', nav: {} };
    const recomputed = groups._update({ type: 'groups_recompute' }, init);
    const [next] = expectNoMutation(
      'toggle_group collapse leaves input frozen',
      () => groups._update({ type: 'toggle_group', name: 'g1' }, recomputed),
      recomputed,
    );
    assert(!next.expanded.has('g1'), 'g1 collapsed in new Set');
    assert(recomputed.expanded.has('g1'), 'original Set still has g1');
  });

  it('toggle_groups_tab swaps tab + rebuilds list', () => {
    setupConfig();
    const init = { list: [], expanded: new Set(), tab: 'all', nav: {} };
    const recomputed = groups._update({ type: 'groups_recompute' }, init);
    const [next] = expectNoMutation(
      'toggle_groups_tab leaves input frozen',
      () => groups._update({ type: 'toggle_groups_tab' }, recomputed),
      recomputed,
    );
    eq(next.tab, 'quick', 'flipped to quick');
    eq(recomputed.tab, 'all', 'original untouched');
  });
});

// --- detail / viewer (Phase 3 — the heavy Component) ---------------------
//
// The viewer slice owns lines/scroll/tab/search/select/cursor/contentTabs/
// ephemeralTerminals. Each non-IO Msg should return a fresh slice without
// touching the input.

describe('[immutable] detail (viewer)', () => {
  const makeSlice = (overrides = {}) => ({
    lines: ['hello', 'world', 'third'],
    scroll: 0,
    tab: 0,
    search: { active: false, term: '', matches: [], idx: 0, typing: '' },
    select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
    cursor: { line: 0, col: 0 },
    contentTabs: {},
    ephemeralTerminals: {},
    ...overrides,
  });

  it('viewer_set_content writes viewerOverride, resets scroll, clears active search', () => {
    // v0.6.2 T2c — viewer_set_content now writes slice.viewerOverride
    // (discrete-doc slot) instead of slice.lines. Render's viewerLines()
    // consults override first; tab_switch clears it.
    const slice = makeSlice({
      scroll: 5,
      search: { active: true, term: 'old', matches: [{ line: 0, col: 0 }], idx: 0, typing: '' },
    });
    const out = expectNoMutation(
      'viewer_set_content leaves input frozen',
      () => detail._update({ type: 'viewer_set_content', lines: ['new'] }, slice),
      slice,
    );
    eq(out.viewerOverride.lines, ['new']);
    eq(out.scroll, 0);
    eq(out.search.active, false);
    assert(out !== slice, 'fresh ref');
  });

  it('viewer_set_content preserves an inactive search ref (identity)', () => {
    const slice = makeSlice();
    const out = detail._update({ type: 'viewer_set_content', lines: ['x'] }, slice);
    assert(out.search === slice.search, 'inactive search ref preserved');
  });

  it('viewer_append spreads lines, follows bottom', () => {
    // v0.6.2 T2d — slice.lines is derived from viewerLines (buffer is
    // source of truth). Seed buffer state directly; tab=1 is Transcript
    // in the test model's default (no per-group tabs → total=2 → idx 1).
    const slice = makeSlice({
      scroll: 0,
      innerH: 3,
      tab: 1,
      viewerStreamBuffer: { lines: ['a', 'b', 'c'], cap: 1000 },
    });
    const out = expectNoMutation(
      'viewer_append leaves input frozen',
      () => detail._update({ type: 'viewer_append', line: 'd' }, slice),
      slice,
    );
    eq(out.lines.length, 4);
    eq(out.lines[3], 'd');
    eq(out.scroll, 1, 'followed to bottom');
    assert(out.lines !== slice.lines, 'lines array re-allocated');
  });

  it('viewer_set_tab returns new slice on change, same ref on no-op', () => {
    const slice = makeSlice({ tab: 2 });
    const same = detail._update({ type: 'viewer_set_tab', tab: 2 }, slice);
    assert(same === slice, 'no-op no-allocate');
    const next = expectNoMutation(
      'viewer_set_tab change leaves input frozen',
      () => detail._update({ type: 'viewer_set_tab', tab: 5 }, slice),
      slice,
    );
    eq(next.tab, 5);
  });

  it('viewer_reset_chrome clears tab, cursor, select.active', () => {
    const slice = makeSlice({
      tab: 3,
      cursor: { line: 7, col: 4 },
      select: { active: true, kind: 'line', anchor: { line: 7, col: 0 }, cursor: { line: 8, col: 2 } },
    });
    const out = expectNoMutation(
      'viewer_reset_chrome leaves input frozen',
      () => detail._update({ type: 'viewer_reset_chrome' }, slice),
      slice,
    );
    eq(out.tab, 0);
    eq(out.cursor.line, 0);
    eq(out.cursor.col, 0);
    eq(out.select.active, false);
    eq(slice.select.active, true, 'original select untouched');
  });

  it('select_begin builds fresh select + cursor', () => {
    const slice = makeSlice();
    const out = expectNoMutation(
      'select_begin leaves input frozen',
      () => detail._update({ type: 'select_begin', line: 1, col: 2, kind: 'line' }, slice),
      slice,
    );
    eq(out.select.active, true);
    eq(out.select.kind, 'line');
    eq(out.cursor.line, 1);
    eq(out.cursor.col, 2);
  });

  it('select_extend writes a new cursor on an existing selection', () => {
    const slice = makeSlice({
      select: { active: true, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
    });
    const out = expectNoMutation(
      'select_extend leaves input frozen',
      () => detail._update({ type: 'select_extend', line: 2, col: 4 }, slice),
      slice,
    );
    eq(out.select.cursor.line, 2);
    eq(out.select.cursor.col, 4);
    assert(out.select !== slice.select, 'select ref distinct');
  });

  it('select_cancel returns new slice with active:false; no-op if absent', () => {
    const slice = makeSlice({
      select: { active: true, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 1, col: 1 } },
    });
    const out = expectNoMutation(
      'select_cancel leaves input frozen',
      () => detail._update({ type: 'select_cancel' }, slice),
      slice,
    );
    eq(out.select.active, false);

    const noSelect = { ...slice, select: null };
    const same = detail._update({ type: 'select_cancel' }, noSelect);
    assert(same === noSelect, 'identity-preserve when no select');
  });

  it('stream_start replaces lines, resets scroll', () => {
    // v0.6.2 — unrouted stream_start now auto-jumps to the Transcript
    // tab (last in the strip); with no per-group tabs in this test
    // model's currentGroup, total=2 and transcript idx = 1. Returns
    // [slice, cmds] when slice.tab !== transcriptIdx (the jump path).
    const slice = makeSlice({ lines: ['x'], scroll: 8, tab: 0 });
    const r = expectNoMutation(
      'stream_start leaves input frozen',
      () => detail._update({ type: 'stream_start', header: '$ cmd' }, slice),
      slice,
    );
    const out = Array.isArray(r) ? r[0] : r;
    eq(out.lines, ['$ cmd']);
    eq(out.scroll, 0);
    eq(out.tab, 1, 'auto-jumped to Transcript');
  });
});

report();
