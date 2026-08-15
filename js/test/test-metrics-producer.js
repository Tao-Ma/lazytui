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

// --- end-to-end: real poll → parse → publish, then GC + empty-poll-no-wipe --
// Async (execAsync spawn → hub.publish), so it uses section()+direct asserts and
// the single report() lands at the end of the chain.
const fs = require('fs');
const os = require('os');
const path = require('path');

function waitFor(pred, ms, label) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (pred()) { clearInterval(iv); res(); }
      else if (Date.now() - t0 > ms) { clearInterval(iv); rej(new Error(`timeout: ${label}`)); }
    }, 20);
  });
}

(async () => {
  // 1) printf single-stream: coercion + basic publish.
  hub._reset(); state._resetSubscriptions();
  section('[metrics-poll] end-to-end: printf → hub');
  hub.subscribe(TOPIC, { window: 10 });
  state.reconcileSubscriptions(producerModel());
  assert(state._liveSubKeys().includes(KEY), 'producer sub is live after reconcile');
  try {
    await waitFor(() => hub.snapshot(TOPIC).has('_'), 5000, 'first publish');
    const s = hub.snapshot(TOPIC).get('_');
    eq(s.cpu, 42.5, 'cpu percent-coerced');
    eq(s.mem, 128, 'mem bytes-coerced (bare number = bytes)');
    state._resetSubscriptions();
    assert(!state._liveSubKeys().includes(KEY), 'producer torn down on reset');

    // 2) temp-file driven: row-GC on a successful poll, and the MEDIUM fix —
    //    an empty/failed poll must NOT wipe surviving rows.
    hub._reset(); state._resetSubscriptions();
    section('[metrics-poll] end-to-end: GC + empty-poll must not wipe');
    const TF = path.join(os.tmpdir(), `lazytui-metrics-${process.pid}.txt`);
    fs.writeFileSync(TF, 'a 5\nb 7\n');
    const T2 = 'test.e2e';
    const K2 = `metrics-poll:metrics:${T2}`;
    const m2 = { config: { metrics: { [T2]: {
      cmd: `cat ${TF}`, interval: 100, focus_gate: false,
      extract: { mode: 'columns', row_key: 'k', fields: { k: 0, v: 1 } },
      schema: { columns: { v: { type: 'number' } } },
    } } }, jobs: [], modes: {} };
    const keys = () => [...hub.snapshot(T2).keys()].sort().join(',');
    hub.subscribe(T2, { window: 10 });
    state.reconcileSubscriptions(m2);
    try {
      await waitFor(() => keys() === 'a,b', 3000, 'initial a,b');
      eq(hub.snapshot(T2).get('a').v, 5, 'row a value');

      fs.writeFileSync(TF, 'a 6\n');                         // b vanishes from a good poll
      await waitFor(() => keys() === 'a', 3000, 'b GC-d');
      eq(hub.snapshot(T2).get('a').v, 6, 'row a updated');

      fs.writeFileSync(TF, '');                              // empty poll → must NOT wipe
      await new Promise(r => setTimeout(r, 350));            // ~3 empty polls
      eq(keys(), 'a', 'empty poll did NOT wipe the surviving row');
      eq(hub.snapshot(T2).get('a').v, 6, 'row a intact after empty polls');

      state._resetSubscriptions();
      assert(!state._liveSubKeys().includes(K2), 'producer torn down on reset (2)');
    } finally { try { fs.unlinkSync(TF); } catch (_) { /* best effort */ } }

    // 3) counter → rate: a monotonic counter field publishes its per-second rate,
    //    and defineTopic advertises the column as `rate` to consumers.
    hub._reset(); state._resetSubscriptions();
    section('[metrics-poll] end-to-end: counter → rate');
    const TF3 = path.join(os.tmpdir(), `lazytui-counter-${process.pid}.txt`);
    fs.writeFileSync(TF3, '1000');
    const T3 = 'test.rate';
    const m3 = { config: { metrics: { [T3]: {
      cmd: `cat ${TF3}`, interval: 80, focus_gate: false,
      extract: { mode: 'regex', fields: { c: '(\\d+)' } },
      schema: { columns: { c: { type: 'counter' } } },
    } } }, jobs: [], modes: {} };
    hub.subscribe(T3, { window: 10 });
    state.reconcileSubscriptions(m3);
    try {
      eq((hub.schema(T3).columns.c || {}).type, 'rate', 'counter column advertised to consumers as rate');
      await waitFor(() => hub.snapshot(T3).has('_'), 3000, 'first counter publish');
      fs.writeFileSync(TF3, '9000');                          // counter rises by 8000
      await waitFor(() => { const s = hub.snapshot(T3).get('_'); return s && Number.isFinite(s.c) && s.c > 0; }, 3000, 'positive rate');
      assert(true, 'rising counter → positive finite rate');
      fs.writeFileSync(TF3, '5');                             // counter RESET (drops)
      await waitFor(() => { const s = hub.snapshot(T3).get('_'); return s && !Number.isFinite(s.c); }, 3000, 'reset → NaN');
      assert(true, 'counter reset → NaN, not a negative spike');
      state._resetSubscriptions();
    } finally { try { fs.unlinkSync(TF3); } catch (_) { /* best effort */ } }
  } catch (e) {
    assert(false, e.message);
  }
  report();
})();
