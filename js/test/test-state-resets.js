/**
 * State-transition resets (T4) — group switch and detail-content swap
 * must not leak transient detail state (visual selection, cursor,
 * committed search) from the outgoing content into the new content.
 *
 * Run: node js/test/test-state-resets.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const { resetGroupContext, setDetail } = require('../app/state');
const runtime = require('../app/runtime');
const { getModel } = runtime;
const { getComponentSlice } = require('../panel/api');

describe('[1] resetGroupContext drops ROOT chrome state', () => {
  it('clears list-select + per-panel filters/multi-sel (root layer)', () => {
    // Set up via the reducer rather than poking model.modes directly —
    // tests post-Phase 4 should mirror the production write path.
    const dispatch = require('../dispatch/dispatch');
    dispatch.applyMsg({ type: 'list_select', mode: 'on' });
    eq(getModel().modes.listSelectMode, true, 'precondition: mode armed');
    resetGroupContext();
    eq(getModel().modes.listSelectMode, false, 'list-select mode cleared');
  });
});

describe('[2] viewer_reset_chrome clears VIEWER-slice transient state', () => {
  it('Msg-driven so per-layer single-writer holds (Phase B)', () => {
    // Phase B: the viewer state moved into the detail Component's slice;
    // test via the Component's update directly (isolated, no global state).
    const detail = require('../panel/viewer/viewer');
    const init = detail._init();
    // Phase 3 — _update returns the new slice; assert on the return value.
    const slice = {
      ...init,
      select: { active: true, kind: 'char', anchor: { line: 2, col: 1 }, cursor: { line: 3, col: 0 } },
      cursor: { line: 5, col: 2 },
      tab: 3,
    };
    const r = detail._update({ type: 'viewer_reset_chrome' }, slice);
    eq(r.select.active, false, 'visual selection cleared');
    eq(r.cursor.line, 0, 'cursor line reset');
    eq(r.cursor.col, 0, 'cursor col reset');
    eq(r.tab, 0, 'tab reset');
  });
});

describe('[3] setDetail invalidates a committed search', () => {
  it('drops stale matches when content is replaced', () => {
    getComponentSlice('detail').search = { active: true, term: 'err', matches: [{ line: 0, col: 0 }, { line: 2, col: 3 }], idx: 1 };
    setDetail('brand new\ncontent here');
    eq(getComponentSlice('detail').search.active, false, 'search deactivated');
    eq(getComponentSlice('detail').search.matches.length, 0, 'stale matches dropped');
    eq(getComponentSlice('detail').search.term, '', 'term cleared');
  });
  it('leaves an inactive search untouched (no needless churn)', () => {
    getComponentSlice('detail').search = { active: false, term: '', matches: [], idx: 0 };
    const ref = getComponentSlice('detail').search;
    setDetail('more content');
    eq(getComponentSlice('detail').search, ref, 'same object — not reallocated when already inactive');
  });
});

report();
