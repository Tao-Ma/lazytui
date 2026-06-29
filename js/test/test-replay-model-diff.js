/**
 * B6 — per-Msg model diff leaf (js/leaves/replay/model-diff.js). Pure, fast.
 * Run: node js/test/test-replay-model-diff.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { diffState } = require('../leaves/replay/model-diff');

const S = (model, slices = {}) => ({ model, slices });

describe('[B6] diffState', () => {
  it('identical inputs → no changes', () => {
    const r = diffState(S({ a: 1, b: { c: 2 } }), S({ a: 1, b: { c: 2 } }));
    eq(r.changes, []);
    eq(r.truncated, false);
  });

  it('scalar change → one change row with dotted path + before/after', () => {
    const r = diffState(S({ modal: { cmdline: { sel: 0 } } }), S({ modal: { cmdline: { sel: 1 } } }));
    eq(r.changes.length, 1);
    eq(r.changes[0].path, 'model.modal.cmdline.sel');
    eq(r.changes[0].kind, 'change');
    eq(r.changes[0].before, '0');
    eq(r.changes[0].after, '1');
  });

  it('key added / removed → add/remove kinds', () => {
    const add = diffState(S({}), S({ x: 5 }));
    eq(add.changes[0].kind, 'add'); eq(add.changes[0].path, 'model.x'); eq(add.changes[0].after, '5');
    const rem = diffState(S({ x: 5 }), S({}));
    eq(rem.changes[0].kind, 'remove'); eq(rem.changes[0].before, '5');
  });

  it('array element change → [i] path', () => {
    const r = diffState(S({ history: [{ n: 1 }, { n: 2 }] }), S({ history: [{ n: 1 }, { n: 9 }] }));
    eq(r.changes.length, 1);
    eq(r.changes[0].path, 'model.history[1].n');
  });

  it('Set add/remove (slice multiSel) → one row per member, correct kind', () => {
    const a = S({}, { groups: { nav: { multiSel: new Set(['g1']) } } });
    const b = S({}, { groups: { nav: { multiSel: new Set(['g1', 'g2']) } } });
    const r = diffState(a, b);
    eq(r.changes.length, 1);
    eq(r.changes[0].path, 'slices.groups.nav.multiSel');
    eq(r.changes[0].kind, 'add');
    eq(r.changes[0].after, '"g2"');
    // equal Sets → no change
    eq(diffState(b, b).changes, []);
  });

  it('max bound → truncated, length capped', () => {
    const a = S({}); const b = S({ a: 1, b: 2, c: 3, d: 4 });
    const r = diffState(a, b, { max: 2 });
    eq(r.changes.length, 2);
    eq(r.truncated, true);
  });

  it('pathFilter → only matching paths', () => {
    const a = S({ modal: { cmdline: { sel: 0 } }, nav: { cursor: 0 } });
    const b = S({ modal: { cmdline: { sel: 1 } }, nav: { cursor: 5 } });
    const r = diffState(a, b, { pathFilter: 'cmdline' });
    eq(r.changes.length, 1);
    eq(r.changes[0].path, 'model.modal.cmdline.sel');
  });

  it('max:1 presence test stops early (skip-to-change primitive)', () => {
    const a = S({ a: 1, b: 1 }); const b = S({ a: 2, b: 2 });
    const r = diffState(a, b, { max: 1 });
    assert(r.changes.length === 1, 'found a change');
  });

  it('deep nesting does not throw (depth guard)', () => {
    let deepA = 0, deepB = 0; let oa = { v: 0 }, ob = { v: 1 };
    for (let i = 0; i < 30; i++) { oa = { n: oa }; ob = { n: ob }; }
    const r = diffState(S(oa), S(ob));
    assert(Array.isArray(r.changes), 'returned without throwing');
  });

  // Round-3 review: a Map/Date used to fall into the plain-object branch
  // (Object.keys(map) === []), so a value change was SILENTLY reported as "no
  // change" — which would also make skip-to-change skip it. The strict
  // isPlainObj routes them to the leaf branch so a change is always reported.
  it('a Map value change is reported, not silently missed', () => {
    const a = S({ m: new Map([['k', 1]]) });
    const b = S({ m: new Map([['k', 2]]) });
    const r = diffState(a, b);
    assert(r.changes.length >= 1, 'the Map change is reported');
    eq(r.changes[0].path, 'model.m');
    // equal-by-ref → no change (Object.is short-circuit)
    const m = new Map([['k', 1]]);
    eq(diffState(S({ m }), S({ m })).changes, []);
  });

  it('a Date change is reported, not silently missed', () => {
    const r = diffState(S({ t: new Date(1000) }), S({ t: new Date(2000) }));
    assert(r.changes.length >= 1, 'the Date change is reported');
    eq(r.changes[0].path, 'model.t');
  });
});

report();
