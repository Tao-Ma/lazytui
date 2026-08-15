/**
 * metrics-poll — the headless producer Sub kind (docs/metrics-producer.md §4).
 * Covers the wiring the pure extractor test can't: the descriptor is sourced
 * app-globally from `config.metrics`, `normalize` rejects malformed producers,
 * and end-to-end a real `printf` poll lands parsed samples on the hub topic and
 * tears down on reset.
 *
 * Run: node js/test/test-metrics-producer.js
 */
'use strict';

const { describe, it, eq, assert, section, report } = require('./test-runner');
const hub = require('../leaves/infra/hub');
const state = require('../app/state');

const TOPIC = 'test.metrics';
const KEY = `metrics-poll:metrics:${TOPIC}`;

function producerModel(extra) {
  return {
    // focus_gate:false → poll regardless of the live model's focus (bare test).
    config: { metrics: { [TOPIC]: {
      cmd: "printf 'cpu 42.5\\nmem 128\\n'",
      interval: 100000,          // large → only the first (t=0) poll fires in-test
      focus_gate: false,
      extract: { mode: 'regex', fields: { cpu: 'cpu ([0-9.]+)', mem: 'mem ([0-9.]+)' } },
      schema: { columns: { cpu: { type: 'percent' }, mem: { type: 'bytes' } } },
      ...extra,
    } } },
    jobs: [], modes: {},
  };
}

describe('[metrics-poll] app-global sourcing from config.metrics', () => {
  it('_desiredSubs emits one metrics-poll per producer, keyed by topic', () => {
    const desired = state._desiredSubs(producerModel());
    assert(desired.has(KEY), 'producer present in the desired set');
    const { kind, desc } = desired.get(KEY);
    eq(kind, 'metrics-poll');
    eq(desc.topic, TOPIC);
    assert(typeof desc.cmd === 'string' && desc.extract, 'descriptor carries cmd + extract');
  });
  it('no metrics: block → no producer subs', () => {
    const desired = state._desiredSubs({ config: {}, jobs: [], modes: {} });
    assert(![...desired.keys()].some(k => k.startsWith('metrics-poll:')), 'none sourced');
  });
});

describe('[metrics-poll] normalize rejects malformed producers', () => {
  it('accepts a well-formed descriptor', () => {
    const m = new Map();
    state._addDesired(m, { kind: 'metrics-poll', id: 'ok', topic: 't', cmd: 'echo', extract: { fields: { a: 'x' } } });
    assert(m.has('metrics-poll:ok'));
  });
  it('rejects one missing cmd or extract', () => {
    const m = new Map();
    state._addDesired(m, { kind: 'metrics-poll', id: 'no-cmd', topic: 't', extract: { fields: {} } });
    state._addDesired(m, { kind: 'metrics-poll', id: 'no-extract', topic: 't', cmd: 'echo' });
    assert(!m.has('metrics-poll:no-cmd') && !m.has('metrics-poll:no-extract'), 'both dropped');
  });
});

// --- end-to-end: real poll → parse → publish → teardown -------------------
// Async chain (setTimeout(0) → execAsync spawn → hub.publish → onUpdate), so it
// uses section()+direct asserts and the single report() lands in the callback.

hub._reset();
state._resetSubscriptions();

section('[metrics-poll] end-to-end: printf → hub');

// Subscribe first so the topic has a retention window (else publish drops) and
// we get notified on the first sample.
let resolveFirst;
const firstPublish = new Promise((res) => { resolveFirst = res; });
hub.subscribe(TOPIC, { window: 10, onUpdate: () => resolveFirst() });

const bail = setTimeout(() => { assert(false, 'timed out waiting for first publish'); report(); }, 5000);

state.reconcileSubscriptions(producerModel());
assert(state._liveSubKeys().includes(KEY), 'producer sub is live after reconcile');

firstPublish.then(() => {
  clearTimeout(bail);
  const s = hub.snapshot(TOPIC).get('_');
  assert(s, 'a single-stream row "_" was published');
  eq(s.cpu, 42.5, 'cpu percent-coerced');
  eq(s.mem, 128, 'mem bytes-coerced (bare number = bytes)');

  state._resetSubscriptions();
  assert(!state._liveSubKeys().includes(KEY), 'producer torn down on reset');
  report();
});
