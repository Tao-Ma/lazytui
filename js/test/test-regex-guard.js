/**
 * regex-guard — defensive RegExp constructor used by the `/`-filter
 * (files panel) and `/`-search (detail panel) paths to neutralize
 * catastrophic-backtracking patterns the user might type live.
 *
 * Run: node js/test/test-regex-guard.js
 */
'use strict';

const { safeRegex, MAX_PATTERN_LEN } = require('../regex-guard');
const { describe, it, eq, assert, report } = require('./test-runner');

describe('[1] returns a RegExp for safe patterns', () => {
  it('plain substring', () => {
    const rx = safeRegex('hello', 'i');
    assert(rx instanceof RegExp);
    eq(rx.test('Hello World'), true);
  });
  it('benign meta chars', () => {
    assert(safeRegex('\\.txt$', 'i'));
    assert(safeRegex('[0-9]+', 'gi'));
    assert(safeRegex('foo|bar', 'i'));
  });
});

describe('[2] rejects on invalid syntax', () => {
  it('unclosed group', () => {
    eq(safeRegex('(', 'i'), null);
    eq(safeRegex('[', 'i'), null);
  });
});

describe('[3] rejects classic catastrophic-backtracking shapes', () => {
  it('(a+)+', () => { eq(safeRegex('(a+)+', 'i'), null); });
  it('(a*)*', () => { eq(safeRegex('(a*)*', 'i'), null); });
  it('(.*)+', () => { eq(safeRegex('(.*)+', 'i'), null); });
  it('(.+)+x', () => { eq(safeRegex('(.+)+x', 'i'), null); });
  it('(\\d+)+', () => { eq(safeRegex('(\\d+)+', 'i'), null); });
});

describe('[4] length cap', () => {
  it('rejects over MAX_PATTERN_LEN', () => {
    const big = 'a'.repeat(MAX_PATTERN_LEN + 1);
    eq(safeRegex(big, 'i'), null);
  });
  it('accepts at the cap', () => {
    const at = 'a'.repeat(MAX_PATTERN_LEN);
    assert(safeRegex(at, 'i'));
  });
});

describe('[5] non-string / empty inputs', () => {
  it('null', () => { eq(safeRegex(null, 'i'), null); });
  it('undefined', () => { eq(safeRegex(undefined, 'i'), null); });
  it('empty string', () => { eq(safeRegex('', 'i'), null); });
  it('number', () => { eq(safeRegex(42, 'i'), null); });
});

describe('[6] runtime guard — patterns that would freeze without guard', () => {
  it('(a+)+ rejected before .test() ever runs', () => {
    const rx = safeRegex('(a+)+x', 'i');
    eq(rx, null, 'returns null so caller never invokes .test');
    // Sanity: if we DID compile it and run, it would hang. Don't run.
  });
});

report();
