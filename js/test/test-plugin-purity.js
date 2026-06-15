/**
 * groupActions purity-contract enforcement (Component contract).
 *
 * `panel/plugin-guard.js` wraps EVERY `groupActions(group, name, config,
 * model)` call (in production too — no env gate): it read-only-wraps the args
 * and times the call; a mutation or a slow (IO-ish) call is surfaced to the
 * diagnostics window WITHOUT mutating the real model/config or hard-failing.
 * A Component opts into a memoized fast path with `groupActionsMemo: true`
 * (guarded once per group, then cached).
 *
 * Run: node js/test/test-plugin-purity.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const guard = require('../panel/plugin-guard');
const diag = require('../dispatch/diag-log');

function fresh() { diag.clear(); guard.reset(); }
function warnCodes() { return diag.snapshot().map(e => e.code); }

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

  it('a slow plugin records plugin-slow but keeps its output', () => {
    fresh();
    const slow = {
      name: 'slow',
      groupActions: () => {
        const end = Date.now() + guard.SLOW_MS + 5;
        while (Date.now() < end) { /* busy-wait > SLOW_MS */ }
        return { s: { label: 'S' } };
      },
    };
    const out = guard.callGroupActions(slow, {}, 'g', {}, {});
    assert(out && out.s, 'slow plugin output still returned');
    assert(warnCodes().includes('plugin-slow'), 'plugin-slow recorded');
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
    eq(calls, 1, 'computed exactly once');
    assert(a.m && b === a && c === a, 'same cached object reused (no re-call, no re-proxy)');
  });

  it('non-memoized: groupActions runs on EVERY call (the Proxy is paid each time)', () => {
    fresh();
    let calls = 0;
    const plain = { name: 'plain', groupActions: () => { calls++; return {}; } };
    const group = { tag: true };
    guard.callGroupActions(plain, group, 'g', {}, {});
    guard.callGroupActions(plain, group, 'g', {}, {});
    eq(calls, 2, 'recomputed each call — the incentive to opt into memo');
  });

  it('memo is keyed on the group object — a distinct group recomputes', () => {
    fresh();
    let calls = 0;
    const memo = { name: 'memo2', groupActionsMemo: true, groupActions: () => { calls++; return {}; } };
    guard.callGroupActions(memo, { a: 1 }, 'g', {}, {});
    guard.callGroupActions(memo, { a: 1 }, 'g', {}, {}); // same shape, different object
    eq(calls, 2, 'distinct group objects → distinct cache entries (a config reload mints new groups)');
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
    guard.callGroupActions(memo, group, 'g', {}, {});
    guard.reset();
    guard.callGroupActions(memo, group, 'g', {}, {}); // same group, memo cleared
    eq(calls, 2, 'reset cleared the cache → recomputed');
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
