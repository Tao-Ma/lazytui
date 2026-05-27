/**
 * State-transition resets (T4) — group switch and detail-content swap
 * must not leak transient detail state (visual selection, cursor,
 * committed search) from the outgoing content into the new content.
 *
 * Run: node js/test/test-state-resets.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const { S, resetGroupContext, setDetail } = require('../state');

describe('[1] resetGroupContext drops detail-transient state', () => {
  it('clears visual selection, detail cursor, and list-select mode', () => {
    S.sel = {}; S.filters = {}; S.multiSel = {};
    S.select = { active: true, kind: 'char', anchor: { line: 2, col: 1 }, cursor: { line: 3, col: 0 } };
    S.detailCursor = { line: 5, col: 2 };
    S.listSelectMode = true;
    resetGroupContext();
    eq(S.select.active, false, 'visual selection cleared');
    eq(S.detailCursor.line, 0, 'cursor line reset');
    eq(S.detailCursor.col, 0, 'cursor col reset');
    eq(S.listSelectMode, false, 'list-select mode cleared');
  });
});

describe('[2] setDetail invalidates a committed search', () => {
  it('drops stale matches when content is replaced', () => {
    S.detailSearch = { active: true, term: 'err', matches: [{ line: 0, col: 0 }, { line: 2, col: 3 }], idx: 1 };
    setDetail('brand new\ncontent here');
    eq(S.detailSearch.active, false, 'search deactivated');
    eq(S.detailSearch.matches.length, 0, 'stale matches dropped');
    eq(S.detailSearch.term, '', 'term cleared');
  });
  it('leaves an inactive search untouched (no needless churn)', () => {
    S.detailSearch = { active: false, term: '', matches: [], idx: 0 };
    const ref = S.detailSearch;
    setDetail('more content');
    eq(S.detailSearch, ref, 'same object — not reallocated when already inactive');
  });
});

report();
