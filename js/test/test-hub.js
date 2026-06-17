/**
 * Hub smoke test — exercises every public method and the three access
 * patterns (history / snapshot / matrix) plus lazy retention, wildcards,
 * dynamic window expand/contract, deleteRow, onUpdate, and single-stream
 * (rowKey null) handling.
 *
 * Run: node js/test/test-hub.js
 */
'use strict';

const hub = require('../leaves/hub');
const { describe, it, assert, eq, report } = require('./test-runner');

describe('[1] lazy drop with no subscribers', () => {
  it('publish stores nothing without a subscriber', () => {
    hub._reset();
    hub.publish('docker.stats', 'a', { ts: 1, cpu: 10 });
    hub.publish('docker.stats', 'a', { ts: 2, cpu: 20 });
    eq(hub.history('docker.stats', 'a'), [], 'no buffer allocated');
    eq(hub.topics(), [], 'no topics tracked');
  });
});

describe('[2] subscribe + publish + window trim', () => {
  it('ring trimmed to window=3', () => {
    hub._reset();
    const tok = hub.subscribe('docker.stats', { window: 3 });
    for (let i = 1; i <= 5; i++) hub.publish('docker.stats', 'a', { ts: i, cpu: i * 10 });
    eq(hub.history('docker.stats', 'a').map(s => s.cpu), [30, 40, 50]);
    hub.unsubscribe(tok);
  });
});

describe('[3] snapshot across many rows', () => {
  it('latest sample per row', () => {
    hub._reset();
    hub.subscribe('docker.stats', { window: 1 });
    hub.publish('docker.stats', 'a', { ts: 10, cpu: 11 });
    hub.publish('docker.stats', 'b', { ts: 10, cpu: 22 });
    hub.publish('docker.stats', 'a', { ts: 20, cpu: 99 });   // overwrites 'a'
    const snap = hub.snapshot('docker.stats');
    eq(snap.size, 2, 'snapshot has 2 rows');
    eq(snap.get('a').cpu, 99, 'a → latest');
    eq(snap.get('b').cpu, 22, 'b → latest');
  });
});

describe('[4] matrix returns every row\'s history', () => {
  it('all rows + per-row history with optional limit', () => {
    hub._reset();
    hub.subscribe('docker.stats', { window: 4 });
    hub.publish('docker.stats', 'a', { ts: 1, cpu: 1 });
    hub.publish('docker.stats', 'a', { ts: 2, cpu: 2 });
    hub.publish('docker.stats', 'b', { ts: 1, cpu: 10 });
    hub.publish('docker.stats', 'b', { ts: 2, cpu: 20 });
    const mat = hub.matrix('docker.stats');
    eq(mat.size, 2, 'matrix has 2 rows');
    eq(mat.get('a').map(s => s.cpu), [1, 2], 'a series');
    eq(mat.get('b').map(s => s.cpu), [10, 20], 'b series');
    const matCap = hub.matrix('docker.stats', 1);
    eq(matCap.get('a').length, 1, 'matrix limit respects N');
  });
});

describe('[5] wildcard subscriber retains every matching topic', () => {
  it('docker.* matches docker.stats and docker.events but not redis.metrics', () => {
    hub._reset();
    hub.subscribe('docker.*', { window: 2 });
    hub.publish('docker.stats', 'x', { ts: 1, cpu: 1 });
    hub.publish('docker.events', '_', { ts: 2, evt: 'start' });
    hub.publish('redis.metrics', 'r', { ts: 3, val: 1 });    // not matched
    eq(hub.history('docker.stats', 'x').length, 1, 'docker.stats kept');
    eq(hub.history('docker.events', '_').length, 1, 'docker.events kept (single-stream)');
    eq(hub.history('redis.metrics', 'r').length, 0, 'redis.metrics dropped (no subscriber)');
  });
});

describe('[6] dynamic window from multiple subscribers', () => {
  it('window expands to max, contracts on unsubscribe, drops to 0 on last', () => {
    hub._reset();
    const small = hub.subscribe('docker.stats', { window: 2 });
    const big   = hub.subscribe('docker.stats', { window: 10 });
    for (let i = 1; i <= 8; i++) hub.publish('docker.stats', 'a', { ts: i, cpu: i });
    eq(hub.history('docker.stats', 'a').length, 8, 'big subscriber wins → keeps 8');
    hub.unsubscribe(big);
    hub.publish('docker.stats', 'a', { ts: 9, cpu: 9 });
    eq(hub.history('docker.stats', 'a').length, 2, 'window contracted to 2 after big left');
    hub.unsubscribe(small);
    // Last sub gone → window = 0 → existing buffer is freed (memory hygiene).
    eq(hub.history('docker.stats', 'a'), [], 'last unsub clears buffer');
    hub.publish('docker.stats', 'a', { ts: 10, cpu: 10 });
    eq(hub.history('docker.stats', 'a'), [], 'subsequent publish still drops');
  });
});

describe('[7] producer-driven row deletion', () => {
  it('delete(topic, rowKey) drops that row but keeps others', () => {
    hub._reset();
    hub.subscribe('docker.stats', { window: 5 });
    hub.publish('docker.stats', 'a', { ts: 1, cpu: 1 });
    hub.publish('docker.stats', 'b', { ts: 1, cpu: 1 });
    hub.delete('docker.stats', 'a');
    eq(hub.snapshot('docker.stats').size, 1, 'a row gone');
    assert(hub.snapshot('docker.stats').has('b'), 'b row still present');
  });
});

describe('[8] onUpdate notifications', () => {
  it('callback fires sync on publish for matching topics', () => {
    hub._reset();
    const events = [];
    hub.subscribe('docker.stats', {
      window: 1,
      onUpdate: (topic, rk, sample) => events.push([topic, rk, sample.cpu]),
    });
    hub.publish('docker.stats', 'a', { ts: 1, cpu: 7 });
    hub.publish('docker.stats', 'b', { ts: 1, cpu: 8 });
    eq(events, [['docker.stats', 'a', 7], ['docker.stats', 'b', 8]]);
  });
});

describe('[9] single-stream rowKey null normalization', () => {
  it('null / undefined / "_" all map to the same row', () => {
    hub._reset();
    hub.subscribe('actions.lifecycle', { window: 3 });
    hub.publish('actions.lifecycle', null,      { ts: 1, label: 'a' });
    hub.publish('actions.lifecycle', undefined, { ts: 2, label: 'b' });
    hub.publish('actions.lifecycle', '_',       { ts: 3, label: 'c' });
    eq(hub.history('actions.lifecycle', null).length, 3, 'all three normalized');
    eq(hub.history('actions.lifecycle', '_').map(s => s.label), ['a','b','c'], 'order preserved');
  });
});

describe('[10] schema hint + introspection', () => {
  it('defineTopic registers schema; topics() lists declared even without publish', () => {
    hub._reset();
    hub.defineTopic('docker.stats', {
      rowKey: 'container_name',
      columns: { cpu: { type: 'percent', unit: '%' } },
    });
    const sch = hub.schema('docker.stats');
    eq(sch.rowKey, 'container_name', 'schema rowKey');
    eq(sch.columns.cpu.unit, '%', 'schema column unit');
    assert(hub.topics().includes('docker.stats'), 'defineTopic shows in topics() even without publish');
    eq(hub.schema('unknown.topic'), null, 'unknown schema → null');
  });
});

describe('[11] wildcard onUpdate fan-out', () => {
  it('wildcard subscriber fires for every matched topic', () => {
    hub._reset();
    const seen = new Set();
    hub.subscribe('docker.*', { window: 1, onUpdate: (t) => seen.add(t) });
    hub.publish('docker.stats', 'a', { ts: 1 });
    hub.publish('docker.events', '_', { ts: 2 });
    eq([...seen].sort(), ['docker.events', 'docker.stats']);
  });
});

describe('[12] history limit parameter', () => {
  it('limit returns last N or all when limit > available', () => {
    hub._reset();
    hub.subscribe('t', { window: 10 });
    for (let i = 1; i <= 5; i++) hub.publish('t', 'r', { ts: i });
    eq(hub.history('t', 'r', 2).map(s => s.ts), [4, 5], 'last 2');
    eq(hub.history('t', 'r', 100).length, 5, 'limit > available → all');
    eq(hub.history('t', 'r').length, 5, 'no limit → all');
  });
});

describe('[13] wildcard semantics', () => {
  it('docker.stats.* does NOT match parent topic docker.stats', () => {
    hub._reset();
    hub.subscribe('docker.stats.*', { window: 1 });
    hub.publish('docker.stats',          'a', { ts: 1 });   // parent: NOT matched
    hub.publish('docker.stats.dev9-env', '_', { ts: 2 });   // child: matched
    eq(hub.history('docker.stats', 'a').length, 0, 'parent topic not matched by .*');
    eq(hub.history('docker.stats.dev9-env', '_').length, 1, 'child topic matched');
  });
});

report();
