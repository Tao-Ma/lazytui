/**
 * E9 (v0.6.7) — normal-mode keymap pure leaf (leaves/input/keymap.js).
 * Run: node js/test/test-keymap.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const km = require('../leaves/input/keymap');

describe('[E9] resolveNormalSpec', () => {
  it('resolves a key from the global context', () => {
    const spec = km.resolveNormalSpec('r', ['list', 'global'], km.DEFAULT_NORMAL);
    eq(spec, { builtin: 'refresh' });
  });
  it('walks contexts most-specific-first (focus-kind beats global)', () => {
    const table = {
      detail: [{ key: 'x', spec: { builtin: 'foo' } }],
      global: [{ key: 'x', spec: { builtin: 'bar' } }],
    };
    eq(km.resolveNormalSpec('x', ['detail', 'global'], table), { builtin: 'foo' });
    eq(km.resolveNormalSpec('x', ['list', 'global'], table), { builtin: 'bar' });
  });
  it('returns null on a miss (caller falls through to the switch)', () => {
    eq(km.resolveNormalSpec('Z', ['list', 'global'], km.DEFAULT_NORMAL), null);
  });
});

describe('[E9] _normalizeSpec', () => {
  it('bare string → { builtin }', () => { eq(km._normalizeSpec('refresh'), { builtin: 'refresh' }); });
  it("'noop' → the NOOP sentinel", () => { eq(km._normalizeSpec('noop'), km.NOOP); });
  it('one-verb mapping passes through (trimmed)', () => {
    eq(km._normalizeSpec({ action: ' grep ' }), { action: 'grep' });
    eq(km._normalizeSpec({ command: 'show-hidden' }), { command: 'show-hidden' });
  });
  it('rejects empty / multi-verb / non-string', () => {
    eq(km._normalizeSpec(''), null);
    eq(km._normalizeSpec({ builtin: 'a', action: 'b' }), null);
    eq(km._normalizeSpec({}), null);
    eq(km._normalizeSpec(42), null);
  });
});

describe('[E9] mergeUserNormal', () => {
  const reserved = new Set(['x', '[', ']', '/']);
  const get = (table, key) => (table.global.find(e => e.key === key) || {}).spec;

  it('adds a new binding (bare string), defaults preserved', () => {
    const { table, errors } = km.mergeUserNormal(km.DEFAULT_NORMAL, { R: 'refresh' }, { reservedKeys: reserved });
    eq(errors, []);
    eq(get(table, 'R'), { builtin: 'refresh' });
    eq(get(table, 'r'), { builtin: 'refresh' }, 'default r untouched');
  });
  it('overrides an existing default key', () => {
    const { table } = km.mergeUserNormal(km.DEFAULT_NORMAL, { r: { builtin: 'show_help' } }, { reservedKeys: reserved });
    eq(get(table, 'r'), { builtin: 'show_help' });
  });
  it('noop disables a default', () => {
    const { table } = km.mergeUserNormal(km.DEFAULT_NORMAL, { r: 'noop' }, { reservedKeys: reserved });
    eq(get(table, 'r'), undefined, 'r removed');
  });
  it('move = bind new + noop old', () => {
    const { table } = km.mergeUserNormal(km.DEFAULT_NORMAL, { R: 'refresh', r: 'noop' }, { reservedKeys: reserved });
    eq(get(table, 'R'), { builtin: 'refresh' });
    eq(get(table, 'r'), undefined);
  });
  it('reserved key → actionable error, not added', () => {
    const { table, errors } = km.mergeUserNormal(km.DEFAULT_NORMAL, { x: 'refresh' }, { reservedKeys: reserved });
    assert(errors.length === 1 && /reserved/.test(errors[0]) && /remappable keys:/.test(errors[0]), `error: ${errors[0]}`);
    eq(get(table, 'x'), undefined);
  });
  it('unknown builtin verb → actionable error listing valid verbs', () => {
    const { errors } = km.mergeUserNormal(km.DEFAULT_NORMAL, { R: { builtin: 'refesh' } }, { reservedKeys: reserved });
    assert(errors.length === 1 && /unknown verb 'refesh'/.test(errors[0]) && /valid verbs:/.test(errors[0]), `error: ${errors[0]}`);
  });
  it('malformed value → form error', () => {
    const { errors } = km.mergeUserNormal(km.DEFAULT_NORMAL, { R: 42 }, { reservedKeys: reserved });
    assert(errors.length === 1 && /must be a verb name/.test(errors[0]), `error: ${errors[0]}`);
  });
  it('action / command shapes pass (target validated by the caller)', () => {
    const { table, errors } = km.mergeUserNormal(km.DEFAULT_NORMAL, { g: { action: 'grep' }, G: { command: 'show-hidden' } }, { reservedKeys: reserved });
    eq(errors, []);
    eq(get(table, 'g'), { action: 'grep' });
    eq(get(table, 'G'), { command: 'show-hidden' });
  });
  it('empty / whitespace key → actionable error, not installed (review round)', () => {
    const a = km.mergeUserNormal(km.DEFAULT_NORMAL, { '': 'refresh' }, { reservedKeys: reserved });
    assert(a.errors.length === 1 && /not a pressable key/.test(a.errors[0]), `empty: ${a.errors[0]}`);
    const b = km.mergeUserNormal(km.DEFAULT_NORMAL, { 'a b': 'refresh' }, { reservedKeys: reserved });
    assert(b.errors.length === 1 && /not a pressable key/.test(b.errors[0]), `ws: ${b.errors[0]}`);
  });
  it('returned table deep-copies default specs (no singleton poisoning, review round)', () => {
    const { table } = km.mergeUserNormal(km.DEFAULT_NORMAL, { Z: 'refresh' }, { reservedKeys: reserved });
    const merged = table.global.find(e => e.key === 'r');
    const dflt = km.DEFAULT_NORMAL.global.find(e => e.key === 'r');
    assert(merged.spec !== dflt.spec, 'spec is a copy, not the singleton ref');
    merged.spec.builtin = 'MUT';
    eq(dflt.spec.builtin, 'refresh', 'mutating the merged spec does not poison DEFAULT_NORMAL');
  });
});

describe('[E9] schemaCompat', () => {
  it('missing → assume current (no message)', () => { eq(km.schemaCompat(undefined), { compat: 'missing', message: null }); });
  it('current → ok', () => { eq(km.schemaCompat(km.KEYMAP_VERSION).compat, 'ok'); });
  it('older → best-effort with a message', () => {
    const r = km.schemaCompat(km.KEYMAP_VERSION - 1);
    eq(r.compat, 'older'); assert(/best-effort/.test(r.message));
  });
  it('newer → loud warn, still loads', () => {
    const r = km.schemaCompat(km.KEYMAP_VERSION + 1);
    eq(r.compat, 'newer'); assert(/NEWER/.test(r.message));
  });
  it('numeric string coerces by value', () => { eq(km.schemaCompat('1').compat, 'ok'); });
  it('non-numeric → treated as missing with a note', () => {
    const r = km.schemaCompat('abc');
    eq(r.compat, 'missing'); assert(/non-numeric/.test(r.message));
  });
  it('false / [] / "" / [1] / {} → missing, NOT coerced to 0/1 (review round)', () => {
    for (const v of [false, [], '', [1], {}]) eq(km.schemaCompat(v).compat, 'missing', `${JSON.stringify(v)} → missing`);
  });
});

report();
