/**
 * Docker Component (TEA) — reducer + slice-backed reads.
 *
 * Drives update(msg, slice) directly (no real docker) to verify the
 * self-armed poll loop: refresh arms the tick + emits a fetch, the inFlight
 * guard prevents overlapping fetches, dockerTick re-arms and is focus-gated,
 * dockerResult folds the maps + clears the guard, and i/t/s key Msgs emit the
 * right stream/shell effects. A small registered-component section checks that
 * statusFor/getInfo read the live slice.
 *
 * Run: node js/test/test-docker-component.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../runtime');
const { getComponentSlice } = require('../plugins/api');


const docker = require('../plugins/docker');
const { _update } = docker;

// Fresh literal slice (avoid _init() — it re-defines the hub topic each call).
function slice0() {
  return { status: {}, stats: {}, inFlight: false, started: false, eventsStarted: false };
}

function setup(containers = ['c1', 'c2'], focused = true) {
  getModel().config = { groups: { g1: { name: 'g1', containers } } };
  getModel().currentGroup = 'g1';
  getModel().ui.sel = { containers: 0 };
  getModel().ui.scroll = {};
  getModel().ui.filters = {};
  getModel().ui.multiSel = {};
  getModel().focus = 'containers';
  getModel().focused = focused;
}

// update() returns either a bare slice or [slice, effects]; normalize.
function step(msg, slice) {
  const r = _update(msg, slice);
  return Array.isArray(r) ? { slice: r[0], effects: r[1] || [] } : { slice: r, effects: [] };
}
const types = (effects) => effects.map(e => e.type);

describe('[1] refresh arms the recurring tick + an immediate fetch', () => {
  it('first refresh: tick + events-start + fetch, flags set', () => {
    setup();
    const { slice, effects } = step({ type: 'refresh' }, slice0());
    assert(types(effects).includes('tick'), 'tick armed');
    assert(types(effects).includes('dockerFetch'), 'immediate fetch');
    assert(types(effects).includes('dockerEventsStart'), 'events subscription started');
    const tick = effects.find(e => e.type === 'tick');
    eq(tick.msg.type, 'dockerTick', 'tick re-dispatches dockerTick');
    assert(slice.started && slice.inFlight && slice.eventsStarted, 'flags set');
  });
  it('no containers: arms the tick but emits no fetch', () => {
    setup([]);
    const { slice, effects } = step({ type: 'refresh' }, slice0());
    eq(types(effects).join(','), 'tick', 'only the tick is armed');
    assert(slice.started && !slice.inFlight, 'started, but nothing in flight');
  });
});

describe('[2] inFlight guards overlapping fetches', () => {
  it('refresh while a fetch is in flight does not emit another', () => {
    setup();
    const busy = { ...slice0(), started: true, inFlight: true, eventsStarted: true };
    const { effects } = step({ type: 'refresh' }, busy);
    assert(!types(effects).includes('dockerFetch'), 'no second fetch');
  });
  it('dockerPoll while in flight is a no-op', () => {
    setup();
    const busy = { ...slice0(), started: true, inFlight: true, eventsStarted: true };
    const { effects } = step({ type: 'dockerPoll' }, busy);
    eq(effects.length, 0, 'no effects');
  });
});

describe('[3] dockerTick re-arms always; fetch is focus-gated', () => {
  it('tick re-arms and fetches when focused + idle', () => {
    setup(['c1'], true);
    const { effects } = step({ type: 'dockerTick' }, { ...slice0(), started: true, eventsStarted: true });
    assert(types(effects).includes('tick'), 're-armed');
    assert(types(effects).includes('dockerFetch'), 'fetched');
  });
  it('tick re-arms but skips the fetch while blurred', () => {
    setup(['c1'], false);  // getModel().focused = false
    const { effects } = step({ type: 'dockerTick' }, { ...slice0(), started: true, eventsStarted: true });
    eq(types(effects).join(','), 'tick', 're-armed, no fetch while blurred');
  });
});

describe('[4] dockerResult folds maps + clears the guard', () => {
  it('stores status/stats and requests a render', () => {
    setup();
    const busy = { ...slice0(), started: true, inFlight: true, eventsStarted: true };
    const { slice, effects } = step({
      type: 'dockerResult',
      status: { c1: 'running', c2: 'exited' },
      stats: { c1: { cpu: '3%', mem: '10MB' } },
    }, busy);
    eq(slice.status.c1, 'running');
    eq(slice.status.c2, 'exited');
    eq(slice.stats.c1.cpu, '3%');
    assert(!slice.inFlight, 'guard cleared');
    assert(types(effects).includes('render'), 'render requested');
  });
  it('a failed fetch (no maps) keeps prior maps but clears the guard', () => {
    setup();
    const prior = { ...slice0(), status: { c1: 'running' }, inFlight: true, started: true };
    const { slice } = step({ type: 'dockerResult' }, prior);
    eq(slice.status.c1, 'running', 'prior status retained');
    assert(!slice.inFlight, 'guard cleared so polling resumes');
  });
});

describe('[5] i/t/s key Msgs emit stream/shell effects on the focused row', () => {
  it('i → inspect, t → logs, s → shell, targeting the selected container', () => {
    setup(['c1', 'c2']);
    getModel().ui.sel.containers = 1;  // c2 focused
    const i = step({ type: 'key', key: 'i' }, slice0());
    eq(i.effects[0].type, 'dockerExec');
    eq(i.effects[0].mode, 'inspect');
    eq(i.effects[0].item, 'c2');
    const t = step({ type: 'key', key: 't' }, slice0());
    eq(t.effects[0].mode, 'logs');
    const s = step({ type: 'key', key: 's' }, slice0());
    eq(s.effects[0].type, 'dockerShell');
    eq(s.effects[0].item, 'c2');
  });
  it('keys are ignored when the containers panel is not focused', () => {
    setup();
    getModel().focus = 'groups';
    const { effects } = step({ type: 'key', key: 'i' }, slice0());
    eq(effects.length, 0, 'no effect when unfocused');
  });
});

describe('[6] registered Component — slice-backed reads', () => {
  it('statusFor + getInfo reflect the folded slice', () => {
    const api = require('../plugins/api');
    require('../effects').installBuiltins();
    api.registerComponent(docker);
    setup(['c1']);
    // Fold a result into the REGISTERED slice via the real dispatch path.
    api.dispatchMsg({ type: 'dockerResult', status: { c1: 'running' }, stats: { c1: { cpu: '5%', mem: '1MB' } } });
    eq(api.getComponentSlice('docker').status.c1, 'running', 'slice updated');
    eq(docker.statusFor('c1'), 'running', 'statusFor reads the slice');
    eq(docker.statusFor('ghost'), null, 'untracked → null');
    const def = api.getPanelDef('containers');
    const info = def.getInfo('c1');
    assert(info.some(l => l.includes('running')), 'getInfo shows status');
    assert(info.some(l => l.includes('5%')), 'getInfo shows cpu');
    // getItems is config-derived (slice unused for the row list).
    eq(def.getItems(api.getComponentSlice('docker')).join(','), 'c1');
  });
});

report();
