/**
 * `fetch_choices` effect runtime (args→ports slice 2, commit 2): the dispatch
 * side-effect that invokes a registered `choices_fn` and lands its result as a
 * `fabric_form_choices_resolved` reducer arm. The arm itself lands in commit 3;
 * this file pins the runtime surface only — the handler is driven directly
 * with a mock host so we can observe the dispatched msg without a reducer.
 *
 * Covers:
 *   normalizeResult:
 *     - string[] → { items, labels:null, error:null }
 *     - { items, labels, error } passthrough + label-length clamp
 *     - null / undefined → empty items, no error
 *     - unsupported value → error on payload
 *     - non-string items filtered
 *
 *   handler, synchronous returns:
 *     - unknown ref → error payload, releaseKey called
 *     - fn returns string[] → dispatched items match
 *     - fn throws → error payload, releaseKey called
 *
 *   handler, async returns:
 *     - fn returns Promise<string[]> → msg lands after settle
 *     - fn rejects → error payload
 *     - abort signal already fired BEFORE resolve → NO dispatch (stale-guard
 *       belt — the reducer requestId drops it either way, but we don't want
 *       to write stale items to the WAL)
 *
 * Run: node js/test/test-choices-fn-runtime.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const api = require('../panel/api');
const runtime = require('../feature/choices-fn-runtime');

// Inject the registry lookup the way the live boot does — tests can register
// via api.registerChoicesFn and the runtime resolves through this seam.
runtime.setRegistryHost({ getChoicesFn: api.getChoicesFn });

// Mock effect host — captures dispatched msgs + releaseKey calls so the test
// can observe the handler's outputs without a live reducer.
function makeHost({ signal } = {}) {
  const dispatched = [];
  const released = [];
  return {
    dispatched,
    released,
    host: {
      applyMsg: (m) => dispatched.push(m),
      releaseKey: () => released.push(true),
      signal: signal || { aborted: false },
    },
  };
}

// Drive the handler by registering it on a tiny effect registry we own, then
// calling the registered fn directly. That matches how installBuiltins wires it
// and lets a test synchronously (or on microtask) observe the dispatched msg.
function makeHandler() {
  let handler = null;
  runtime.registerFetchChoicesEffect((type, fn) => {
    if (type === 'fetch_choices') handler = fn;
  });
  if (!handler) throw new Error('registerFetchChoicesEffect did not register fetch_choices');
  return handler;
}

describe('[choices-fn-runtime] normalizeResult', () => {
  it('string[] → structured items', () => {
    eq(runtime.normalizeResult(['a', 'b']),
       { items: ['a', 'b'], labels: null, error: null });
  });

  it('structured return passthrough', () => {
    eq(runtime.normalizeResult({ items: ['x', 'y'], labels: ['X', 'Y'] }),
       { items: ['x', 'y'], labels: ['X', 'Y'], error: null });
  });

  it('labels longer than items are clamped', () => {
    const r = runtime.normalizeResult({ items: ['a'], labels: ['A', 'B', 'C'] });
    eq(r.items, ['a']);
    eq(r.labels, ['A']);
  });

  it('null / undefined → empty, no error', () => {
    eq(runtime.normalizeResult(null),
       { items: [], labels: null, error: null });
    eq(runtime.normalizeResult(undefined),
       { items: [], labels: null, error: null });
  });

  it('unsupported value → error payload', () => {
    const r = runtime.normalizeResult(42);
    eq(r.items, []);
    assert(/unsupported/.test(r.error), 'error mentions unsupported');
  });

  it('non-string items filtered', () => {
    const r = runtime.normalizeResult(['a', 7, null, 'b']);
    eq(r.items, ['a', 'b']);
  });
});

describe('[choices-fn-runtime] fetch_choices handler — sync', () => {
  it('unknown ref → error payload + releaseKey', () => {
    api._resetChoicesFns();
    const handler = makeHandler();
    const { dispatched, released, host } = makeHost();
    handler({ type: 'fetch_choices', ref: 'nope.missing', port: 'p', requestId: 1,
              values: {}, actionKey: 'a', group: 'g' }, host);
    eq(dispatched.length, 1, 'one msg dispatched');
    eq(dispatched[0].type, 'fabric_form_choices_resolved');
    eq(dispatched[0].port, 'p');
    eq(dispatched[0].requestId, 1);
    eq(dispatched[0].items, []);
    assert(/unknown choices_fn/.test(dispatched[0].error), 'error mentions unknown ref');
    eq(released.length, 1, 'releaseKey called once');
  });

  it('fn returns string[] synchronously → dispatched items match', async () => {
    api._resetChoicesFns();
    api.registerChoicesFn('mock', { fn: () => ['x', 'y'] });
    const handler = makeHandler();
    const { dispatched, released, host } = makeHost();
    handler({ type: 'fetch_choices', ref: 'mock.fn', port: 'p', requestId: 2,
              values: {}, actionKey: 'a', group: 'g' }, host);
    // Promise.resolve + .then settles on a microtask.
    await Promise.resolve();
    await Promise.resolve();
    eq(dispatched.length, 1);
    eq(dispatched[0].items, ['x', 'y']);
    eq(dispatched[0].error, null);
    eq(released.length, 1);
  });

  it('fn throws → error payload + releaseKey', () => {
    api._resetChoicesFns();
    api.registerChoicesFn('mock', { fn: () => { throw new Error('boom'); } });
    const handler = makeHandler();
    const { dispatched, released, host } = makeHost();
    handler({ type: 'fetch_choices', ref: 'mock.fn', port: 'p', requestId: 3,
              values: {}, actionKey: 'a', group: 'g' }, host);
    eq(dispatched.length, 1);
    eq(dispatched[0].items, []);
    eq(dispatched[0].error, 'boom');
    eq(released.length, 1);
  });
});

describe('[choices-fn-runtime] fetch_choices handler — async', () => {
  it('fn returns Promise<string[]> → msg lands after settle', async () => {
    api._resetChoicesFns();
    api.registerChoicesFn('mock', { fn: async () => ['a1', 'a2'] });
    const handler = makeHandler();
    const { dispatched, released, host } = makeHost();
    handler({ type: 'fetch_choices', ref: 'mock.fn', port: 'p', requestId: 4,
              values: {}, actionKey: 'a', group: 'g' }, host);
    eq(dispatched.length, 0, 'nothing dispatched synchronously');
    await Promise.resolve();
    await Promise.resolve();
    eq(dispatched.length, 1);
    eq(dispatched[0].items, ['a1', 'a2']);
    eq(released.length, 1);
  });

  it('fn rejects → error payload', async () => {
    api._resetChoicesFns();
    api.registerChoicesFn('mock', { fn: async () => { throw new Error('async-fail'); } });
    const handler = makeHandler();
    const { dispatched, released, host } = makeHost();
    handler({ type: 'fetch_choices', ref: 'mock.fn', port: 'p', requestId: 5,
              values: {}, actionKey: 'a', group: 'g' }, host);
    await Promise.resolve();
    await Promise.resolve();
    eq(dispatched.length, 1);
    assert(/async-fail/.test(dispatched[0].error), 'error carries fn message');
    eq(released.length, 1);
  });

  it('abort already fired before resolve → NO dispatch, releaseKey still called', async () => {
    api._resetChoicesFns();
    let externalResolve;
    const pending = new Promise((r) => { externalResolve = r; });
    api.registerChoicesFn('mock', { fn: () => pending });
    const handler = makeHandler();
    const abortCtrl = { aborted: false };
    const { dispatched, released, host } = makeHost({ signal: abortCtrl });
    handler({ type: 'fetch_choices', ref: 'mock.fn', port: 'p', requestId: 6,
              values: {}, actionKey: 'a', group: 'g' }, host);
    abortCtrl.aborted = true;
    externalResolve(['late', 'items']);
    await Promise.resolve();
    await Promise.resolve();
    eq(dispatched.length, 0, 'nothing dispatched after abort');
    eq(released.length, 1, 'releaseKey still called so the C5 inflight entry clears');
  });
});

report();
