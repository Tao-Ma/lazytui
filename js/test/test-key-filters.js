/**
 * Key-filter middleware — pre-dispatch hooks that can transform or
 * suppress key events. CHANGELOG v0.3.0; design rationale in
 * dispatch.js.
 *
 * Run: node js/test/test-key-filters.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const dispatch = require('../dispatch');

// We don't want to drive the real handleKey here (it requires a fully
// set-up framework + would render). Instead, mock the bits the filter
// chain doesn't need. The tests focus on the filter contract itself.

function withDispatchKey(key, seq, recorded) {
  // Reset filters before each scenario so they're independent.
  dispatch.clearKeyFilters();
  // Replace the part of handleKey that goes downstream with a sink
  // we can observe. Easiest way: install a filter at the END that
  // captures whatever made it past upstream filters, then returns
  // null to suppress the rest of dispatch (which we don't want to
  // exercise here — no real render, no real mode handlers).
  return (filtersToInstall) => {
    for (const f of filtersToInstall) dispatch.registerKeyFilter(f);
    // Terminal filter that captures and stops the chain.
    dispatch.registerKeyFilter((evt) => {
      recorded.push({ key: evt.key, seq: evt.seq });
      return null;  // suppress — no downstream side-effects fire
    });
    dispatch.handleKey(key, seq);
  };
}

describe('[1] no filters — captures unchanged', () => {
  it('event reaches the terminal sink with original key/seq', () => {
    const recorded = [];
    withDispatchKey('down', undefined, recorded)([]);
    eq(recorded.length, 1, 'one event captured');
    eq(recorded[0].key, 'down', 'key passed through');
  });
});

describe('[2] one filter — passes event through unchanged', () => {
  it('identity filter preserves the event', () => {
    const recorded = [];
    withDispatchKey('up', undefined, recorded)([
      (evt) => evt,  // identity
    ]);
    eq(recorded.length, 1, 'one event captured');
    eq(recorded[0].key, 'up', 'key unchanged');
  });
});

describe('[3] remap filter — translates key', () => {
  it('hjkl → up/down/left/right (vim-mode style)', () => {
    const recorded = [];
    const vim = (evt) => {
      const map = { h: 'left', j: 'down', k: 'up', l: 'right' };
      if (map[evt.key]) return { ...evt, key: map[evt.key] };
      return evt;
    };
    withDispatchKey('j', undefined, recorded)([vim]);
    eq(recorded[0].key, 'down', 'j remapped to down');

    dispatch.clearKeyFilters();
    const recorded2 = [];
    withDispatchKey('a', undefined, recorded2)([vim]);
    eq(recorded2[0].key, 'a', 'non-mapped key untouched');
  });
});

describe('[4] suppress filter — returns null to drop the key', () => {
  it('returns null → no downstream event captured', () => {
    const recorded = [];
    withDispatchKey('q', undefined, recorded)([
      (evt) => (evt.key === 'q' ? null : evt),
    ]);
    eq(recorded.length, 0, 'q was suppressed before reaching the sink');
  });

  it('non-matching key still passes', () => {
    const recorded = [];
    withDispatchKey('x', undefined, recorded)([
      (evt) => (evt.key === 'q' ? null : evt),
    ]);
    eq(recorded[0].key, 'x', 'x passed through (not matching the suppressor)');
  });
});

describe('[5] filters run in registration order', () => {
  it('first filter sees the original, second sees the first\'s output', () => {
    const seenByFirst = [];
    const seenBySecond = [];
    const recorded = [];
    withDispatchKey('a', undefined, recorded)([
      (evt) => { seenByFirst.push(evt.key); return { ...evt, key: 'b' }; },
      (evt) => { seenBySecond.push(evt.key); return { ...evt, key: 'c' }; },
    ]);
    eq(seenByFirst[0],  'a', 'first filter saw the original key');
    eq(seenBySecond[0], 'b', 'second filter saw the first filter\'s output');
    eq(recorded[0].key, 'c', 'terminal sink saw the final transformed key');
  });
});

describe('[6] registerKeyFilter validates input', () => {
  it('throws on non-function argument', () => {
    let caught = null;
    try { dispatch.registerKeyFilter('not a function'); }
    catch (e) { caught = e; }
    assert(caught instanceof Error, 'threw');
    assert(caught.message.includes('function'), 'error message mentions function');
  });
});

report();
