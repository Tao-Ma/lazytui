/**
 * Stale-while-refetch cache for computed port choices (Brief 3).
 *
 * The cache lives on `model.choicesCache` so WAL replay reconstructs it
 * deterministically. Key: `${actionKey}|${port}|${source}|${depsHash}`
 * where source is `cmd:<cmd>` or `fn:<ref>`. Dep values in the key keep
 * same-port fetches for different repos / targets apart.
 *
 * Covers:
 *   - fabric_form_choices_request on a cold cache: computed.state='pending',
 *     no stale marker. (Baseline — unchanged behavior.)
 *   - fabric_form_choices_resolved (ok): writes cache + clears stale.
 *   - Second request with the SAME key: cache hit → computed.state='ok'
 *     immediately + stale:true, AND the fetch Cmd STILL fires (cache is
 *     a HINT, not the source of truth).
 *   - Dep-value change → different cache key, no cross-pollination.
 *   - Error settle with stale items present: keep stale items visible,
 *     state='error', stale:true (brief: "old list beats empty popover").
 *   - Error settle with NO prior cache: existing behavior (items=[], no stale).
 *   - LRU eviction at cap boundary.
 *   - WAL round-trip: a WAL replay reconstructs identical cache state
 *     (extends test-replay-choices-resolved.js's family).
 *   - Chip renderer emits `⟳` suffix on stale ok and on stale error.
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getModel, setModel } = require('../model/store');
const runtime = require('../app/runtime');
const replay = require('../dispatch/runtime/replay');
const { freshOverlayModel, captureOverlay } = require('./_helpers/overlay-capture');
const { renderFabricFormOverlay } = require('../overlay/fabric-form');

// Build a one-field cmd-channel form at `fabric_form_enter`.
function openCmdForm({ actionKey = 'restart', port = 'name', cmd = "printf 'a\\nb\\n'", deps = {} } = {}) {
  const field = {
    port, text: '',
    required: true,
    default: null,
    desc: '',
    choicesCmd: cmd,
    choicesLabeled: false,
    choicesTimeout: 2000,
    dependsOn: Object.keys(deps),
    choicesFnRef: null,
  };
  // Prepend extra text fields the deps bind to, if any.
  const depFields = Object.entries(deps).map(([name, text]) => ({
    port: name, text, required: false, default: null, desc: '',
  }));
  let m = getModel();
  [m] = apply({ type: 'fabric_form_enter', fields: [...depFields, field],
    pendingAction: { actionKey, action: { label: actionKey } } });
  setModel(m);                                          // persist so later getModel() + reducer calls see it
  return m;
}

function fieldAt(m, port) {
  return m.modal.fabricForm.fields.find((f) => f.port === port);
}

// Apply a Msg to the live model AND persist via setModel. Returns [nextModel, cmds].
// This mirrors what the real dispatch loop does — the reducer alone just
// returns new state; the store commit is a separate step. Tests that chain
// multiple updates PLUS re-read via getModel() (e.g. after a cancel + re-open)
// need this; chaining via the returned `m` variable alone would ok too, but
// mixing both reads sees drift otherwise.
function apply(msg) {
  const [m, cmds] = runtime.update(getModel(), msg);
  setModel(m);
  return [m, cmds];
}

describe('[cache] fabric_form_choices_request — baseline cold cache', () => {
  it('cold cache: computed.state=pending, stale=false, cacheKey populated', () => {
    sm.bootFresh();
    openCmdForm();
    let m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const f = fieldAt(m, 'name');
    eq(f.computed.state, 'pending', 'cold cache → pending');
    eq(f.computed.stale, false, 'cold cache → stale:false');
    assert(typeof f.computed.cacheKey === 'string' && f.computed.cacheKey.length > 0,
      `cacheKey should be a non-empty string, got: ${JSON.stringify(f.computed.cacheKey)}`);
    assert(/^restart\|name\|cmd:/.test(f.computed.cacheKey),
      `cacheKey format: actionKey|port|source|deps, got: ${f.computed.cacheKey}`);
  });
});

describe('[cache] resolved (ok) writes the cache + clears stale', () => {
  it('after ok settle: model.choicesCache carries the entry; computed.stale=false', () => {
    sm.bootFresh();
    openCmdForm();
    let m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const requestId = fieldAt(m, 'name').computed.requestId;
    const cacheKey = fieldAt(m, 'name').computed.cacheKey;
    [m] = apply({
      type: 'fabric_form_choices_resolved',
      port: 'name', actionKey: 'restart', requestId,
      items: ['nginx', 'sshd'], labels: null, error: null, truncated: false,
    });
    const f = fieldAt(m, 'name');
    eq(f.computed.state, 'ok');
    eq(f.computed.items, ['nginx', 'sshd']);
    eq(f.computed.stale, false, 'fresh ok → stale cleared');
    const cached = m.choicesCache.entries[cacheKey];
    assert(cached, `cache entry should exist at key ${cacheKey}; got entries=${JSON.stringify(Object.keys(m.choicesCache.entries))}`);
    eq(cached.items, ['nginx', 'sshd'], 'cached items match');
    assert(m.choicesCache.order.includes(cacheKey), 'key is in LRU order');
  });
});

describe('[cache] second request with same key: cache HIT seeds immediately + stale marker', () => {
  it('cache hit: state=ok + stale:true before the fresh fetch settles', () => {
    sm.bootFresh();
    // Prime the cache via a full request → resolve cycle.
    openCmdForm();
    let m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const rid = fieldAt(m, 'name').computed.requestId;
    [m] = apply({ type: 'fabric_form_choices_resolved',
      port: 'name', actionKey: 'restart', requestId: rid,
      items: ['nginx', 'sshd'], labels: null, error: null, truncated: false });
    // Cancel + reopen the form (session-lifetime cache persists across modal re-open).
    [m] = apply({ type: 'fabric_form_cancel' });
    openCmdForm();
    m = getModel();
    // Now a fresh request fires — same key as before.
    let cmds;
    [m, cmds] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const f = fieldAt(m, 'name');
    eq(f.computed.state, 'ok', 'cache hit seeds state=ok, NOT pending');
    eq(f.computed.stale, true, 'cache hit sets stale:true');
    eq(f.computed.items, ['nginx', 'sshd'], 'items served from cache');
    // The fetch Cmd STILL fires — the brief is explicit: cache is a hint.
    assert(cmds.length === 1 && cmds[0].type === 'fetch_choices_cmd',
      `expected fetch Cmd to still fire, got: ${JSON.stringify(cmds)}`);
  });

  it('fresh ok settle REPLACES stale items + clears stale marker', () => {
    sm.bootFresh();
    openCmdForm();
    let m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const r1 = fieldAt(m, 'name').computed.requestId;
    [m] = apply({ type: 'fabric_form_choices_resolved',
      port: 'name', actionKey: 'restart', requestId: r1,
      items: ['nginx'], labels: null, error: null, truncated: false });
    [m] = apply({ type: 'fabric_form_cancel' });
    openCmdForm();
    m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    assert(fieldAt(m, 'name').computed.stale, 'precondition: stale after cache hit');
    const r2 = fieldAt(m, 'name').computed.requestId;
    // Fresh ok arrives — different items (list changed).
    [m] = apply({ type: 'fabric_form_choices_resolved',
      port: 'name', actionKey: 'restart', requestId: r2,
      items: ['postgres', 'redis'], labels: null, error: null, truncated: false });
    const f = fieldAt(m, 'name');
    eq(f.computed.items, ['postgres', 'redis'], 'fresh items replace stale');
    eq(f.computed.stale, false, 'stale marker cleared');
    eq(f.computed.state, 'ok');
  });
});

describe('[cache] dep-value change → different cache key, no cross-pollination', () => {
  it('port "branch" with dep "repo" — repoA cache does NOT serve repoB request', () => {
    sm.bootFresh();
    // Seed cache for repoA.
    openCmdForm({ port: 'branch', cmd: "git -C $repo branch", deps: { repo: '/home/me/repoA' } });
    let m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'branch' });
    const rA = fieldAt(m, 'branch').computed.requestId;
    [m] = apply({ type: 'fabric_form_choices_resolved',
      port: 'branch', actionKey: 'restart', requestId: rA,
      items: ['main', 'feature-a'], labels: null, error: null, truncated: false });
    const keyA = fieldAt(m, 'branch').computed.cacheKey;

    // Cancel + reopen with dep=repoB — different key, cold cache.
    [m] = apply({ type: 'fabric_form_cancel' });
    openCmdForm({ port: 'branch', cmd: "git -C $repo branch", deps: { repo: '/home/me/repoB' } });
    m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'branch' });
    const f = fieldAt(m, 'branch');
    assert(f.computed.cacheKey !== keyA,
      `dep change should produce different cacheKey; keyA=${keyA} keyB=${f.computed.cacheKey}`);
    eq(f.computed.state, 'pending', 'repoB has no cache entry — stays cold');
    eq(f.computed.stale, false);
    // repoA entry still in cache — untouched.
    assert(m.choicesCache.entries[keyA], 'repoA cache entry survived');
    eq(m.choicesCache.entries[keyA].items, ['main', 'feature-a'],
      'repoA cache entry unchanged by repoB request');
  });
});

describe('[cache] error settle with stale items present → keep items + error chip', () => {
  it('cache hit then error on refetch: items PRESERVED, state=error, stale:true', () => {
    sm.bootFresh();
    openCmdForm();
    let m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const r1 = fieldAt(m, 'name').computed.requestId;
    [m] = apply({ type: 'fabric_form_choices_resolved',
      port: 'name', actionKey: 'restart', requestId: r1,
      items: ['nginx', 'sshd'], labels: null, error: null, truncated: false });
    [m] = apply({ type: 'fabric_form_cancel' });
    openCmdForm();
    m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const r2 = fieldAt(m, 'name').computed.requestId;
    // Refetch TIMES OUT or returns error.
    [m] = apply({ type: 'fabric_form_choices_resolved',
      port: 'name', actionKey: 'restart', requestId: r2,
      items: [], labels: null, error: 'choices_cmd timed out after 2000ms', truncated: false });
    const f = fieldAt(m, 'name');
    eq(f.computed.state, 'error', 'error state landed');
    eq(f.computed.items, ['nginx', 'sshd'],
      'stale items PRESERVED under error (old list beats empty popover)');
    eq(f.computed.stale, true, 'stale marker stays — fresh fetch failed');
    assert(/timed out/.test(f.computed.error || ''), 'error message carried');
  });

  it('error settle with NO prior cache: existing behavior (items=[], stale=false)', () => {
    sm.bootFresh();
    // Explicitly reset the cache — sm.bootFresh doesn't touch model.choicesCache
    // (session-lifetime semantics), so entries from earlier tests persist across
    // bootFresh. This test specifically pins "no prior cache", so wipe it.
    getModel().choicesCache = { entries: {}, order: [], cap: 64 };
    openCmdForm();
    let m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const rid = fieldAt(m, 'name').computed.requestId;
    [m] = apply({ type: 'fabric_form_choices_resolved',
      port: 'name', actionKey: 'restart', requestId: rid,
      items: [], labels: null, error: 'spawn ENOENT', truncated: false });
    const f = fieldAt(m, 'name');
    eq(f.computed.state, 'error');
    eq(f.computed.items, [], 'no stale items to keep');
    eq(f.computed.stale, false, 'stale stays false (nothing to be stale)');
  });
});

describe('[cache] LRU eviction', () => {
  it('cache grows up to cap, then evicts the LRU-most key', () => {
    sm.bootFresh();
    // Shrink cap for a tractable test. Direct model mutation is fine for test
    // fixtures — production code never mutates the cap.
    getModel().choicesCache.cap = 3;
    getModel().choicesCache.entries = {};
    getModel().choicesCache.order = [];
    // Prime 3 entries via distinct cmds.
    for (const cmd of ['a', 'b', 'c']) {
      openCmdForm({ cmd: `printf '${cmd}\\n'` });
      let m = getModel();
      [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
      const rid = fieldAt(m, 'name').computed.requestId;
      [m] = apply({ type: 'fabric_form_choices_resolved',
        port: 'name', actionKey: 'restart', requestId: rid,
        items: [cmd], labels: null, error: null, truncated: false });
      [m] = apply({ type: 'fabric_form_cancel' });
    }
    eq(getModel().choicesCache.order.length, 3, '3 entries at cap');

    // Add a 4th — should evict the first ('a').
    openCmdForm({ cmd: `printf 'd\\n'` });
    let m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const rid = fieldAt(m, 'name').computed.requestId;
    [m] = apply({ type: 'fabric_form_choices_resolved',
      port: 'name', actionKey: 'restart', requestId: rid,
      items: ['d'], labels: null, error: null, truncated: false });

    const c = getModel().choicesCache;
    eq(c.order.length, 3, 'still at cap after eviction');
    assert(!c.order.some((k) => k.includes("'a\\n'") || k.includes('a\\n')),
      `'a' key should have been evicted — order=${JSON.stringify(c.order)}`);
    assert(c.order.some((k) => k.includes("'d\\n'") || k.includes('d\\n')),
      `'d' key should be present — order=${JSON.stringify(c.order)}`);
  });

  it('re-fetch of an existing key MOVES it to MRU (not re-inserted)', () => {
    sm.bootFresh();
    getModel().choicesCache.cap = 2;
    getModel().choicesCache.entries = {};
    getModel().choicesCache.order = [];
    // Prime 2 entries.
    const prime = (cmd) => {
      openCmdForm({ cmd: `printf '${cmd}\\n'` });
      let m = getModel();
      [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
      const rid = fieldAt(m, 'name').computed.requestId;
      [m] = apply({ type: 'fabric_form_choices_resolved',
        port: 'name', actionKey: 'restart', requestId: rid,
        items: [cmd], labels: null, error: null, truncated: false });
      [m] = apply({ type: 'fabric_form_cancel' });
    };
    prime('x');
    prime('y');
    const firstKey = getModel().choicesCache.order[0];        // LRU-most ('x')
    // Re-fetch 'x' — should promote to MRU.
    prime('x');
    const after = getModel().choicesCache.order;
    eq(after[after.length - 1], firstKey, 'refetched key promoted to MRU');
    eq(after.length, 2, 'size unchanged — update, not new insert');
  });
});

describe('[cache] WAL round-trip — replay reconstructs identical cache + computed', () => {
  it('replay of (request → resolve ok) produces the same choicesCache entry + computed state', () => {
    sm.bootFresh();
    openCmdForm();
    const snap = replay.snapshotState();
    const WAL = [
      { kind: 'msg', lane: 'root',
        msg: { type: 'fabric_form_choices_request', port: 'name', requestId: 1, inputsHash: '[]', depValues: {} } },
      { kind: 'msg', lane: 'root',
        msg: { type: 'fabric_form_choices_resolved',
               port: 'name', actionKey: 'restart', requestId: 1,
               items: ['one', 'two'], labels: null, error: null, truncated: false } },
    ];
    replay.replayEntries(WAL, { fromState: snap });
    const m = getModel();
    const f = fieldAt(m, 'name');
    eq(f.computed.state, 'ok');
    eq(f.computed.items, ['one', 'two'], 'items replay-identical');
    eq(f.computed.stale, false, 'no stale marker after fresh ok');
    const cacheKey = f.computed.cacheKey;
    assert(m.choicesCache.entries[cacheKey], 'cache entry reconstructed on replay');
    eq(m.choicesCache.entries[cacheKey].items, ['one', 'two']);
  });
});

describe('[cache] chip renderer — `⟳` marker on stale ok and stale error', () => {
  it('ok+stale → `[2 choices ⟳]` chip', () => {
    sm.bootFresh();
    openCmdForm();
    let m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const r1 = fieldAt(m, 'name').computed.requestId;
    [m] = apply({ type: 'fabric_form_choices_resolved',
      port: 'name', actionKey: 'restart', requestId: r1,
      items: ['nginx', 'sshd'], labels: null, error: null, truncated: false });
    [m] = apply({ type: 'fabric_form_cancel' });
    openCmdForm();
    m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const out = captureOverlay(m, (nr, c) => renderFabricFormOverlay(nr, c));
    assert(/\[2 choices ⟳\]/.test(out),
      `expected '[2 choices ⟳]' chip for stale ok — got: ${JSON.stringify(out).slice(0, 300)}`);
  });

  it('error+stale → `[error ⟳]` chip (items kept visible under it)', () => {
    sm.bootFresh();
    openCmdForm();
    let m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const r1 = fieldAt(m, 'name').computed.requestId;
    [m] = apply({ type: 'fabric_form_choices_resolved',
      port: 'name', actionKey: 'restart', requestId: r1,
      items: ['nginx', 'sshd'], labels: null, error: null, truncated: false });
    [m] = apply({ type: 'fabric_form_cancel' });
    openCmdForm();
    m = getModel();
    [m] = apply({ type: 'fabric_form_choices_request', port: 'name' });
    const r2 = fieldAt(m, 'name').computed.requestId;
    [m] = apply({ type: 'fabric_form_choices_resolved',
      port: 'name', actionKey: 'restart', requestId: r2,
      items: [], labels: null, error: 'choices_cmd timed out', truncated: false });
    const out = captureOverlay(m, (nr, c) => renderFabricFormOverlay(nr, c));
    assert(/\[error ⟳\]/.test(out),
      `expected '[error ⟳]' chip for stale error — got: ${JSON.stringify(out).slice(0, 300)}`);
  });
});

describe('[cache] regression — literal choices do NOT grow a stale/cache state', () => {
  it('literal `choices:` field: cacheKey stays null, stale stays false, no entry written', () => {
    sm.bootFresh();
    const m0 = freshOverlayModel();
    const field = {
      port: 'tunnel', text: '', required: true, default: null, desc: '',
      choices: { items: ['--full-tunnel', '--no-full-tunnel'], labels: null, truncated: false },
    };
    let m;
    [m] = runtime.update(m0, { type: 'fabric_form_enter', fields: [field],
      pendingAction: { actionKey: 'reissue', action: {} } });
    const f = m.modal.fabricForm.fields[0];
    eq(f.computed.state, 'ok', 'literal seeded ok');
    eq(f.computed.stale, false, 'literal is NEVER stale');
    eq(f.computed.cacheKey, null, 'literal has no cache key');
    eq(Object.keys(m.choicesCache.entries).length, 0, 'no cache entry written for literal');
  });
});

report();
