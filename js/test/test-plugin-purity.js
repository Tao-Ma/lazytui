/**
 * groupActions purity-contract enforcement (Component contract).
 *
 * `panel/plugin-guard.js` wraps EVERY `groupActions(group, name, config,
 * model)` call (in production too — no env gate): it read-only-wraps the args
 * (mutation guard, every call) and, ONCE per (group, Component), verifies
 * determinism with a clock-free back-to-back re-call + compare; an opt-in
 * (LAZYTUI_VERIFY_PLUGINS=1) check intercepts fs/child_process to flag IO.
 * Violations are surfaced to the diagnostics window WITHOUT mutating the real
 * model/config or hard-failing. A Component opts into a memoized fast path with
 * `groupActionsMemo: true` (guarded once per group, then cached).
 *
 * v0.6.6 §9 follow-up: callGroupActions runs on render paths, so the guard
 * recordDeferred()s its warns rather than warn()ing synchronously (render-path
 * purity). These tests flushDeferred() before reading diag state — modelling
 * the dispatch finalizer's drain.
 *
 * Run: node js/test/test-plugin-purity.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const guard = require('../panel/plugin-guard');
const diag = require('../io/diag-log');

function fresh() { diag.clear(); guard.reset(); }
// The guard defers its warns (render-path purity); drain before reading, as the
// dispatch finalizer does in production.
function warnCodes() { diag.flushDeferred(); return diag.snapshot().map(e => e.code); }

const pure = {
  name: 'pure-plugin',
  init: () => ({}),
  update: (_msg, slice) => slice,
  groupActions: (group) => (group && group.tag ? { a: { label: 'A', script: 'echo a' } } : {}),
};

describe('[readonly] recursive read-only proxy', () => {
  it('reads pass through at any depth', () => {
    const ro = guard.readonly({ x: 1, n: { y: 2 } }, 'obj', 'p');
    eq(ro.x, 1, 'top-level read');
    eq(ro.n.y, 2, 'nested read');
  });
  it('top-level write throws PluginImpurityError', () => {
    const ro = guard.readonly({ x: 1 }, 'config', 'p');
    let err = null;
    try { ro.x = 2; } catch (e) { err = e; }
    assert(err && err.code === 'plugin-impure', 'threw plugin-impure');
    assert(/config\.x/.test(err.message), 'message names the path');
  });
  it('nested write throws and does NOT mutate the real object', () => {
    const real = { groups: { g: { actions: {} } } };
    const ro = guard.readonly(real, 'config', 'p');
    let threw = false;
    try { ro.groups.g.actions.injected = {}; } catch (_) { threw = true; }
    assert(threw, 'nested write threw');
    eq(Object.keys(real.groups.g.actions).length, 0, 'real object untouched');
  });
  it('delete throws', () => {
    const ro = guard.readonly({ x: 1 }, 'model', 'p');
    let threw = false;
    try { delete ro.x; } catch (_) { threw = true; }
    assert(threw, 'delete threw');
  });
});

describe('[guard] callGroupActions is always enforced', () => {
  it('a pure plugin returns its actions and records NO warning', () => {
    fresh();
    const out = guard.callGroupActions(pure, { tag: true }, 'g', {}, {});
    assert(out && out.a, 'pure plugin output present');
    diag.flushDeferred();
    eq(diag.size(), 0, 'no diagnostics for a pure plugin');
  });

  it('a mutating plugin records plugin-impure, drops its output, leaves config intact', () => {
    fresh();
    const config = { groups: { g: { actions: { real: {} } } } };
    const mutator = {
      name: 'mutator',
      groupActions: (_g, _n, cfg) => { cfg.groups.g.actions.injected = { label: 'X' }; return { x: {} }; },
    };
    const out = guard.callGroupActions(mutator, config.groups.g, 'g', config, {});
    eq(JSON.stringify(out), '{}', 'violating plugin contributes nothing');
    assert(warnCodes().includes('plugin-impure'), 'plugin-impure recorded');
    assert(!('injected' in config.groups.g.actions), 'real config NOT mutated');
  });

  it('a nondeterministic plugin records plugin-nondeterministic (clock-free check)', () => {
    fresh();
    let n = 0;
    // Output varies per call (≈ reading Date.now / Math.random) — the back-to-
    // back re-call on first use sees a different result and flags it.
    const flaky = { name: 'flaky', groupActions: () => ({ a: { label: `A${n++}` } }) };
    const out = guard.callGroupActions(flaky, { tag: true }, 'g', {}, {});
    assert(out && out.a, 'output still returned');
    assert(warnCodes().includes('plugin-nondeterministic'), 'plugin-nondeterministic recorded');
  });

  it('a deterministic plugin records NO plugin-nondeterministic across the verify re-call', () => {
    fresh();
    const det = { name: 'det', groupActions: (g) => (g && g.tag ? { a: { label: 'A' } } : {}) };
    guard.callGroupActions(det, { tag: true }, 'g', {}, {});
    diag.flushDeferred();
    eq(diag.size(), 0, 'a pure projection passes the determinism re-call cleanly');
  });

  it('verify mode (LAZYTUI_VERIFY_PLUGINS=1) flags IO directly', () => {
    fresh();
    const io = { name: 'io-plugin',
      groupActions: () => { require('fs').existsSync('/tmp'); return { a: { label: 'A' } }; } };
    process.env.LAZYTUI_VERIFY_PLUGINS = '1';
    try { guard.callGroupActions(io, { tag: true }, 'g', {}, {}); }
    finally { delete process.env.LAZYTUI_VERIFY_PLUGINS; }
    assert(warnCodes().includes('plugin-io'), 'plugin-io recorded when verify mode is on');
  });

  it('without verify mode, IO is NOT intercepted (no plugin-io, no global patching)', () => {
    fresh();
    const io = { name: 'io-plugin2',
      groupActions: () => { require('fs').existsSync('/tmp'); return { a: { label: 'A' } }; } };
    guard.callGroupActions(io, { tag: true }, 'g', {}, {});
    assert(!warnCodes().includes('plugin-io'), 'IO check is opt-in (off by default)');
  });

  it('a genuine plugin bug (non-purity throw) propagates', () => {
    fresh();
    const buggy = { name: 'buggy', groupActions: () => { throw new Error('boom'); } };
    let err = null;
    try { guard.callGroupActions(buggy, {}, 'g', {}, {}); } catch (e) { err = e; }
    assert(err && /boom/.test(err.message), 'non-purity throw re-thrown for api.js catch');
  });

  it('repeated identical violations dedupe to ONE diagnostic', () => {
    fresh();
    const config = { groups: { g: { actions: {} } } };
    const mutator = {
      name: 'mutator', groupActions: (_g, _n, cfg) => { cfg.groups.g.actions.z = {}; return {}; },
    };
    guard.callGroupActions(mutator, config.groups.g, 'g', config, {});
    guard.callGroupActions(mutator, config.groups.g, 'g', config, {});
    guard.callGroupActions(mutator, config.groups.g, 'g', config, {});
    diag.flushDeferred();
    eq(diag.counts().warn, 1, 'three calls → one warn (deduped)');
  });
});

describe('[memo] groupActionsMemo opt-in fast path', () => {
  it('memoized: groupActions runs ONCE per group, the result is reused', () => {
    fresh();
    let calls = 0;
    const memo = { name: 'memo', groupActionsMemo: true,
      groupActions: () => { calls++; return { m: { label: 'M' } }; } };
    const group = { tag: true };
    const a = guard.callGroupActions(memo, group, 'g', {}, {});
    const b = guard.callGroupActions(memo, group, 'g', {}, {});
    const c = guard.callGroupActions(memo, group, 'g', {}, {});
    eq(calls, 2, 'computed once + verified once (a back-to-back re-call) on first use, then cached');
    assert(a.m && b === a && c === a, 'same cached object reused (the first-call result; no re-call, no re-proxy)');
  });

  it('non-memoized: groupActions runs on EVERY call (+ one verify re-call on first use)', () => {
    fresh();
    let calls = 0;
    const plain = { name: 'plain', groupActions: () => { calls++; return {}; } };
    const group = { tag: true };
    guard.callGroupActions(plain, group, 'g', {}, {});   // compute + one-shot determinism verify
    guard.callGroupActions(plain, group, 'g', {}, {});   // recompute (already verified)
    eq(calls, 3, 'first use computes twice (verify), then every call recomputes — the incentive to memoize');
  });

  it('memo is keyed on the group object — a distinct group recomputes', () => {
    fresh();
    let calls = 0;
    const memo = { name: 'memo2', groupActionsMemo: true, groupActions: () => { calls++; return {}; } };
    guard.callGroupActions(memo, { a: 1 }, 'g', {}, {});
    guard.callGroupActions(memo, { a: 1 }, 'g', {}, {}); // same shape, different object
    eq(calls, 4, 'distinct group objects → distinct cache+verify entries (2 calls each: compute + verify)');
  });

  it('the first memoized call is STILL guarded — an impure memoized Component is caught', () => {
    fresh();
    const config = { groups: { g: { actions: {} } } };
    const badMemo = { name: 'bad-memo', groupActionsMemo: true,
      groupActions: (_g, _n, cfg) => { cfg.groups.g.actions.z = {}; return { x: {} }; } };
    const out = guard.callGroupActions(badMemo, config.groups.g, 'g', config, {});
    eq(JSON.stringify(out), '{}', 'violation dropped even on the memoized path');
    assert(warnCodes().includes('plugin-impure'), 'impurity caught on the one guarded call');
    assert(!('z' in config.groups.g.actions), 'real config intact');
  });

  it('reset() clears the memo', () => {
    fresh();
    let calls = 0;
    const memo = { name: 'memo3', groupActionsMemo: true, groupActions: () => { calls++; return {}; } };
    const group = { a: 1 };
    guard.callGroupActions(memo, group, 'g', {}, {});   // compute + verify
    guard.reset();
    guard.callGroupActions(memo, group, 'g', {}, {});   // same group, memo + verify state cleared → compute + verify
    eq(calls, 4, 'reset cleared the cache + verify state → recomputed and re-verified');
  });
});

describe('[api] getMergedActions routes plugins through the guard', () => {
  it('a mutating plugin is caught end-to-end; YAML + pure-plugin actions survive', () => {
    fresh();
    const api = require('../panel/api');
    const { setModel } = require('../app/runtime');
    setModel({
      currentGroup: 'g', modes: {},
      config: { groups: { g: { label: 'G', tag: true, actions: { ybuild: { label: 'Build' } } } } },
    });
    const mutator = {
      name: 'api-mutator', init: () => ({}), update: (_m, s) => s,
      groupActions: (_g, _n, cfg) => { cfg.injectedTop = true; return { bad: {} }; },
    };
    api.registerComponent(pure);       // contributes `a` (group.tag === true)
    api.registerComponent(mutator);    // tries to mutate config → dropped
    const merged = api.getMergedActions('g');
    assert('ybuild' in merged, 'YAML action present');
    assert('a' in merged, 'pure plugin action present');
    assert(!('bad' in merged), 'mutating plugin contributed nothing');
    assert(warnCodes().includes('plugin-impure'), 'impurity surfaced end-to-end');
    assert(!('injectedTop' in require('../app/runtime').getModel().config), 'real config intact');
  });
});

report();
