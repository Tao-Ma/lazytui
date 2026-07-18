/**
 * P1 — the pane-agnostic per-tab state store (leaves/wm/tab-state).
 * See docs/pane-tabs-unification.md. Run: node js/test/test-tab-state.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const ts = require('../leaves/wm/tab-state');

describe('[tab-state] field — read with fallback', () => {
  it('returns the fallback when the tab / field / store is absent', () => {
    eq(ts.field(undefined, 'k', 'scroll', 7), 7);
    eq(ts.field({}, 'k', 'scroll', 7), 7);
    eq(ts.field({ tabState: {} }, 'k', 'scroll', 7), 7);
    eq(ts.field({ tabState: { k: {} } }, 'k', 'scroll', 7), 7);
    eq(ts.field({ tabState: { k: { scroll: 3 } } }, '', 'scroll', 7), 7, 'no key → fallback');
  });
  it('a stored 0 / null / "" wins over the fallback (presence, not truthiness)', () => {
    eq(ts.field({ tabState: { k: { scroll: 0 } } }, 'k', 'scroll', 7), 0);
    eq(ts.field({ tabState: { k: { sel: null } } }, 'k', 'sel', 'fb'), null);
    eq(ts.field({ tabState: { k: { f: '' } } }, 'k', 'f', 'fb'), '');
  });
});

describe('[tab-state] withField — immutable single-field merge', () => {
  it('creates the entry + preserves other tabs/fields', () => {
    const s0 = { tabState: { a: { scroll: 1 } }, other: 9 };
    const s1 = ts.withField(s0, 'b', 'cursor', 4);
    eq(s1.tabState.b.cursor, 4);
    eq(s1.tabState.a.scroll, 1, 'sibling tab untouched');
    eq(s1.other, 9, 'sibling slice field untouched');
    assert(s1 !== s0 && s1.tabState !== s0.tabState, 'fresh slice + store (immutable)');
  });
  it('preserves slice identity when the value is unchanged (cheap re-render)', () => {
    const s0 = { tabState: { a: { scroll: 5 } } };
    eq(ts.withField(s0, 'a', 'scroll', 5), s0, 'same ref');
  });
  it('no-key is a no-op', () => {
    const s0 = { tabState: {} };
    eq(ts.withField(s0, '', 'scroll', 1), s0);
  });
});

describe('[tab-state] withFields — multi-field merge', () => {
  it('merges a patch over the existing entry in one write', () => {
    const s0 = { tabState: { a: { scroll: 1, cursor: 2 } } };
    const s1 = ts.withFields(s0, 'a', { scroll: 9, sticky: true });
    eq(s1.tabState.a.scroll, 9);
    eq(s1.tabState.a.cursor, 2, 'unpatched field kept');
    eq(s1.tabState.a.sticky, true);
  });
  it('no-key / no-patch are no-ops', () => {
    const s0 = { tabState: { a: {} } };
    eq(ts.withFields(s0, '', { x: 1 }), s0);
    eq(ts.withFields(s0, 'a', null), s0);
  });
});

describe('[tab-state] dropEntry — remove a tab', () => {
  it('drops the entry, keeps the rest', () => {
    const s0 = { tabState: { a: { scroll: 1 }, b: { scroll: 2 } } };
    const s1 = ts.dropEntry(s0, 'a');
    assert(!('a' in s1.tabState), 'a dropped');
    eq(s1.tabState.b.scroll, 2, 'b kept');
    assert(s1 !== s0, 'fresh slice');
  });
  it('is a no-op when the key / store is absent', () => {
    const s0 = { tabState: { a: {} } };
    eq(ts.dropEntry(s0, 'nope'), s0);
    eq(ts.dropEntry({}, 'a'), { });
  });
});

report();
