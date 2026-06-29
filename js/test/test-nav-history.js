/**
 * v0.6.7 Phase 3 — navigation history (jumplist back/forward).
 *
 *   [A] unit — the pure ring leaf (push/dedupe/truncate/cap/step/prune).
 *   [B] capture — driving a real group/focus/tab transition pushes ONE location
 *       record built by STABLE identity (group name, focused-item idOf, tab key).
 *   [C] restore — nav_back/nav_forward re-dispatch primitives to restore the
 *       group + focus; the focused-item cursor is resolved by id (NOT a stored
 *       index), so it lands on the same ITEM even after the list reorders.
 *   [D] 404 — a record whose group no longer exists is pruned + skipped.
 *
 * (Replay-safety — model.nav folds identically through the WAL — is pinned in
 * test-replay.js, which now records nav transitions in its session.)
 *
 * Run: node js/test/test-nav-history.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const navHist = require('../leaves/wm/nav-history');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const loop = require('../dispatch/runtime/loop');
const dispatch = require('../dispatch/control/dispatch');
const route = require('../panel/route');
const api = require('../panel/api');

function capture(fn) {
  const orig = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = orig; }
}

// ---------------------------------------------------------------------------
// [A] pure ring leaf
// ---------------------------------------------------------------------------
describe('[A] nav-history ring (pure leaf)', () => {
  const L = (g) => ({ v: 1, kind: 'loc', group: g, focus: { paneId: g, type: g }, tab: null, sel: null });

  it('push appends; cursor tracks the newest', () => {
    let nav = navHist.EMPTY;
    nav = navHist.push(nav, L('a'));
    nav = navHist.push(nav, L('b'));
    eq(nav.history.length, 2);
    eq(nav.cursor, 1);
  });

  it('consecutive duplicate is a no-op (same ref)', () => {
    let nav = navHist.push(navHist.EMPTY, L('a'));
    const same = navHist.push(nav, L('a'));
    assert(same === nav, 'dedupe returns the same nav ref');
  });

  it('push after a back truncates the forward branch', () => {
    let nav = navHist.EMPTY;
    ['a', 'b', 'c'].forEach(g => { nav = navHist.push(nav, L(g)); });
    nav = navHist.step(nav, -1).nav;      // cursor → 1 (b)
    nav = navHist.step(nav, -1).nav;      // cursor → 0 (a)
    nav = navHist.push(nav, L('d'));      // diverge from a
    eq(nav.history.map(r => r.group), ['a', 'd'], 'forward branch (b,c) truncated');
    eq(nav.cursor, 1);
  });

  it('cap evicts from the front and clamps the cursor', () => {
    let nav = { history: [], cursor: -1, cap: 3 };
    ['a', 'b', 'c', 'd', 'e'].forEach(g => { nav = navHist.push(nav, L(g)); });
    eq(nav.history.map(r => r.group), ['c', 'd', 'e'], 'oldest two evicted');
    eq(nav.cursor, 2, 'cursor on the newest');
  });

  it('step returns null at the ends', () => {
    let nav = navHist.push(navHist.EMPTY, L('a'));   // cursor 0, len 1
    assert(navHist.step(nav, -1) === null, 'nothing behind');
    assert(navHist.step(nav, +1) === null, 'nothing ahead');
  });

  it('prune removes the entry and shifts the cursor', () => {
    let nav = navHist.EMPTY;
    ['a', 'b', 'c'].forEach(g => { nav = navHist.push(nav, L(g)); });  // cursor 2
    nav = navHist.prune(nav, 0);                                       // drop 'a'
    eq(nav.history.map(r => r.group), ['b', 'c']);
    eq(nav.cursor, 1, 'cursor shifted down with the removal');
  });
});

// ---------------------------------------------------------------------------
// real-app boot (mirrors test-replay's minimal-but-real harness)
// ---------------------------------------------------------------------------
const _grp = (name) => ({
  name, label: name, containers: [],
  actions: { a1: { key: 'a1', label: 'A1', type: 'run', script: 'echo a1', tab: false } },
  children: [], parent: null, depth: 0, quick: false,
});
getModel().config = {
  project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
  groups: { g1: _grp('g1'), g2: _grp('g2'), g3: _grp('g3') },
};
initState();

const focusTo = (pane) => capture(() => loop.dispatchMsg({ kind: 'layout', msg: { type: 'focus_set', focus: pane } }));
const kindNow = () => route.instanceKind(route.getFocus());

// ---------------------------------------------------------------------------
// [B] capture — a real focus change pushes one stable-identity record
// ---------------------------------------------------------------------------
describe('[B] capture on transition', () => {
  it('a focus change pushes exactly one record, by stable identity', () => {
    focusTo('groups');                       // baseline
    const before = getModel().nav.history.length;
    focusTo('detail');                       // change → +1
    const hist = getModel().nav.history;
    eq(hist.length, before + 1, 'exactly one record pushed');
    const top = hist[hist.length - 1];
    eq(top.focus.type, 'detail', 'focused pane type captured');
    assert(top.tab && typeof top.tab.targetKey === 'string', 'viewer tab captured by stable key');
  });

  it('a navigator focus captures the cursor item by stable id (not an index)', () => {
    focusTo('groups');
    const top = getModel().nav.history[getModel().nav.history.length - 1];
    eq(top.focus.type, 'groups');
    assert(top.sel && top.sel.panel === 'groups', 'sel records the navigator');
    assert(typeof top.sel.id === 'string' && !('index' in top.sel), 'sel is a stable id, never an index');
    // The id is the item idOf, resolvable in the current list.
    const items = api.getItems('groups');
    assert(items.some(it => api.idOf('groups', it) === top.sel.id), 'sel.id resolves to a live item');
  });

  it('a no-op re-focus does not push', () => {
    focusTo('groups');
    const n = getModel().nav.history.length;
    focusTo('groups');                       // same pane → no change
    eq(getModel().nav.history.length, n, 'no record for a no-op focus');
  });
});

// ---------------------------------------------------------------------------
// [C] restore — back/forward re-dispatch primitives; cursor resolves by id
// ---------------------------------------------------------------------------
describe('[C] back / forward restore', () => {
  it('nav_back / nav_forward restore the focused pane', () => {
    focusTo('detail');
    focusTo('groups');
    focusTo('detail');                       // tail: ... detail, groups, detail
    capture(() => loop.applyMsg({ type: 'nav_back' }));
    eq(kindNow(), 'groups', 'back restored the groups focus');
    capture(() => loop.applyMsg({ type: 'nav_back' }));
    eq(kindNow(), 'detail', 'back again restored the detail focus');
    capture(() => loop.applyMsg({ type: 'nav_forward' }));
    eq(kindNow(), 'groups', 'forward retraced to groups');
  });

  it('restore lands on the same group ITEM after the list reorders', () => {
    const navState = require('../panel/nav-state');
    getModel().nav = { history: [], cursor: -1, cap: 100 };   // clean slate
    // Put the groups cursor on g3, then capture by focusing groups (from detail).
    focusTo('detail');
    const g3idx = api.getItems('groups').findIndex(it => api.idOf('groups', it) === 'g3');
    capture(() => loop.dispatchMsg({ kind: 'groups', msg: { type: 'set_cursor', panel: 'groups', index: g3idx } }));
    focusTo('groups');                       // record now has sel.id === 'g3'
    const rec = getModel().nav.history[getModel().nav.history.length - 1];
    eq(rec.sel.id, 'g3', 'captured the g3 cursor by id');

    // Reorder the underlying group list so g3 sits at a DIFFERENT index.
    const cfg = getModel().config;
    getModel().config = { ...cfg, groups: { g3: cfg.groups.g3, g1: cfg.groups.g1, g2: cfg.groups.g2 } };
    navState.recomputeGroups();
    const newIdx = api.getItems('groups').findIndex(it => api.idOf('groups', it) === 'g3');
    assert(newIdx !== g3idx, 'g3 actually moved to a new index');

    // Move the cursor away, focus off, then nav_back to the g3 record.
    capture(() => loop.dispatchMsg({ kind: 'groups', msg: { type: 'set_cursor', panel: 'groups', index: 0 } }));
    focusTo('detail');
    capture(() => loop.applyMsg({ type: 'nav_back' }));   // restore the groups/g3 record
    eq(kindNow(), 'groups', 'focus restored to groups');
    eq(navState.getSel('groups'), newIdx, 'cursor resolved to g3 by id, at its NEW index (not the stored one)');
    getModel().config = cfg;                 // restore order for later cases
    navState.recomputeGroups();
  });
});

// ---------------------------------------------------------------------------
// [D] 404 — a record whose group is gone is pruned + skipped
// ---------------------------------------------------------------------------
describe('[D] stale-record prune', () => {
  it('a back into a removed-group record prunes it and continues', () => {
    // Hand-build a clean history: a live g1 record, then a (to-be) stale record.
    const liveLoc = { v: 1, kind: 'loc', group: 'g1', focus: { paneId: 'groups', type: 'groups' }, tab: null, sel: null };
    const staleLoc = { v: 1, kind: 'loc', group: 'gGONE', focus: { paneId: 'groups', type: 'groups' }, tab: null, sel: null };
    const here = { v: 1, kind: 'loc', group: 'g2', focus: { paneId: 'detail', type: 'detail' }, tab: null, sel: null };
    getModel().nav = { history: [liveLoc, staleLoc, here], cursor: 2, cap: 100 };
    // gGONE is not in config → back from `here` lands on staleLoc → prune → continue to liveLoc.
    capture(() => loop.applyMsg({ type: 'nav_back' }));
    const nav = getModel().nav;
    assert(!nav.history.some(r => r.group === 'gGONE'), 'stale record pruned out');
    eq(getModel().currentGroup, 'g1', 'continued back to the live g1 record');
  });

  it('a forward into a removed-group record prunes it WITHOUT overshooting the next live record', () => {
    // The prune at the cursor shifts the next-forward record DOWN into the
    // cursor slot, so the cursor already points at the forward target — the
    // continuation must re-resolve in place, not step forward again (which
    // would skip the immediate live target). Regression guard for that bug.
    const here = { v: 1, kind: 'loc', group: 'g1', focus: { paneId: 'groups', type: 'groups' }, tab: null, sel: null };
    const stale = { v: 1, kind: 'loc', group: 'gGONE', focus: { paneId: 'groups', type: 'groups' }, tab: null, sel: null };
    const fwd = { v: 1, kind: 'loc', group: 'g3', focus: { paneId: 'detail', type: 'detail' }, tab: null, sel: null };
    const beyond = { v: 1, kind: 'loc', group: 'g2', focus: { paneId: 'detail', type: 'detail' }, tab: null, sel: null };
    getModel().nav = { history: [here, stale, fwd, beyond], cursor: 0, cap: 100 };
    // forward from g1 → stale gGONE → prune → must land on g3 (the immediate
    // live forward target), NOT overshoot to g2.
    capture(() => loop.applyMsg({ type: 'nav_forward' }));
    const nav = getModel().nav;
    assert(!nav.history.some(r => r.group === 'gGONE'), 'stale record pruned out');
    eq(getModel().currentGroup, 'g3', 'continued forward to the immediate live g3 record (no overshoot)');
    eq(nav.cursor, 1, 'cursor points at the restored g3, not past it');
  });
});

report();
