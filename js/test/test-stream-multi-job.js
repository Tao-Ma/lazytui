/**
 * v0.6.2 Large — multi-job stream invariants.
 *
 * Pins:
 *   - cross-slot concurrent: two routed streams in DIFFERENT
 *     (group, tabKey) slots register both into the jobs registry and
 *     leave both alive.
 *   - same-slot preempt: re-running a routed stream in the SAME slot
 *     kills the previous (status='killed') before the new one starts.
 *   - unrouted singleton: a new unrouted stream preempts the previous
 *     unrouted (one 'unrouted' slot).
 *   - routed vs unrouted independence: starting unrouted does NOT
 *     kill routed (and vice versa).
 *
 * Run: node js/test/test-stream-multi-job.js
 *
 * Spawns are real `sh -c 'sleep N'` processes so jobs persist long
 * enough to inspect; cleanup at the end kills them all.
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const stream = require('../io/stream');
const jobs = require('../feature/jobs');
const runtime = require('../app/runtime');

function seedModel() {
  const m = runtime.init();
  m.config = {
    groups: {
      g: {
        label: 'G',
        actions: {
          'test':       { label: 'Test',   script: 'sleep 5', tab: 'Test' },
          'server-log': { label: 'Server', script: 'sleep 5', tab: 'Server' },
        },
      },
    },
  };
  m.currentGroup = 'g';
  runtime.setModel(m);
}

function running() {
  return jobs.list().filter(j => j.status === 'running');
}

describe('[multi-job] cross-slot routed streams run concurrently', () => {
  it('Test + Server log both alive after sequential starts', () => {
    seedModel();
    jobs._reset();
    stream.streamCommand('test', 'sleep 5', [], { tabKey: 'test', groupName: 'g' });
    stream.streamCommand('server-log', 'sleep 5', [], { tabKey: 'server-log', groupName: 'g' });
    const r = running();
    eq(r.length, 2, 'two running jobs');
    const labels = r.map(j => j.label).sort();
    eq(labels[0], 'server-log');
    eq(labels[1], 'test');
    stream.killAll({ silent: true });
    eq(running().length, 0, 'cleanup');
  });
});

describe('[multi-job] same-slot re-run preempts', () => {
  it('two starts of the same routed slot → one running, one killed', () => {
    seedModel();
    jobs._reset();
    stream.streamCommand('test', 'sleep 5', [], { tabKey: 'test', groupName: 'g' });
    const firstId = running()[0].id;
    stream.streamCommand('test', 'sleep 5', [], { tabKey: 'test', groupName: 'g' });
    const r = running();
    eq(r.length, 1, 'only one alive in the slot');
    const all = jobs.list();
    const prior = all.find(j => j.id === firstId);
    eq(prior.status, 'killed', 'previous slot occupant marked killed');
    stream.killAll({ silent: true });
  });
});

describe('[multi-job] unrouted slot is singleton', () => {
  it('two unrouted starts → only one alive', () => {
    seedModel();
    jobs._reset();
    stream.streamCommand('docker logs nginx', 'sleep 5', []);
    stream.streamCommand('docker logs db',    'sleep 5', []);
    const r = running();
    eq(r.length, 1, 'unrouted singleton');
    eq(r[0].label, 'docker logs db', 'newer unrouted is the survivor');
    stream.killAll({ silent: true });
  });
});

describe('[multi-job] routed + unrouted independent', () => {
  it('starting unrouted does NOT kill routed', () => {
    seedModel();
    jobs._reset();
    stream.streamCommand('test', 'sleep 5', [], { tabKey: 'test', groupName: 'g' });
    stream.streamCommand('docker logs',  'sleep 5', []);
    const r = running();
    eq(r.length, 2, 'both alive');
    const kinds = r.map(j => j.kind).sort();
    eq(kinds[0], 'stream-routed');
    eq(kinds[1], 'stream-unrouted');
    stream.killAll({ silent: true });
  });
});

describe('[multi-job] model.unroutedStreaming reflects the unrouted slot', () => {
  it('flag toggles with unrouted lifecycle; routed-only does not flip it', () => {
    seedModel();
    jobs._reset();
    // Routed-only — flag stays false.
    stream.streamCommand('test', 'sleep 5', [], { tabKey: 'test', groupName: 'g' });
    eq(runtime.getModel().unroutedStreaming, false, 'routed-only — flag stays false');
    // Unrouted start — flag flips true.
    stream.streamCommand('docker logs', 'sleep 5', []);
    eq(runtime.getModel().unroutedStreaming, true, 'unrouted alive — flag true');
    stream.killAll({ silent: true });
    eq(runtime.getModel().unroutedStreaming, false, 'all killed — flag clears');
  });
});

setTimeout(() => report(), 200);  // give onExit a tick to land for the test runner's count
