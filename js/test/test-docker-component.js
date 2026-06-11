/**
 * Docker Component (TEA) — reducer + slice-backed reads.
 *
 * Drives update(msg, slice) directly (no real docker) to verify the
 * self-armed poll loop: refresh arms the tick + emits a fetch, the inFlight
 * guard prevents overlapping fetches, dockerTick re-arms unconditionally
 * (the focus + container-count gates live in the dockerFetch/dockerEventsStart
 * effects, not the reducer — Phase-D purity), dockerResult folds the maps +
 * clears the guard, and i/t/s key Msgs emit the right stream/shell effects.
 * A small registered-component section checks that statusFor/getInfo read
 * the live slice.
 *
 * Run: node js/test/test-docker-component.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const api = require('../panel/api');
const { getInstanceSlice } = api;

// Phase 4a — `getSel('containers')` walks panel-type → owning Component
// (docker) → its slice.nav, so the Component must be registered (layout
// first per Phase 3) for the helper to resolve. The Component-level [6]
// section below re-registers; that's idempotent.
api.registerComponent(require('../panel/layout'));
const docker = require('../panel/navigator/docker');
api.registerComponent(docker);
const { setSel, getSel } = require('../app/state');

const { _update } = docker;

// Fresh literal slice (avoid _init() — it re-defines the hub topic each call).
function slice0() {
  return { status: {}, stats: {}, inFlight: false, started: false, eventsStarted: false };
}

function setup(containers = ['c1', 'c2'], focused = true) {
  getModel().config = { groups: { g1: { name: 'g1', containers } } };
  getModel().currentGroup = 'g1';
  // Reset per-panel nav chrome on the docker Component's slice for a
  // deterministic baseline (cursor → 0, multiSel empty).
  setSel('containers', 0);
  api.dispatchMsg(api.wrap('docker', { type: 'multisel_clear', panel: 'containers' }));
  getInstanceSlice("layout").focus = 'containers';
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
    // Phase 2d: the tick's carried msg is wrapped to docker.
    eq(tick.msg.kind, 'docker', 'tick wrapped to docker');
    eq(tick.msg.msg.type, 'dockerTick', 'tick re-dispatches dockerTick');
    assert(slice.started && slice.inFlight && slice.eventsStarted, 'flags set');
  });
  it('no containers: reducer still emits the fetch Cmds (pure) — the effects gate', () => {
    // Phase-D cleanup: the reducer no longer reads getModel().config to
    // gate on container count. It emits dockerEventsStart + dockerFetch
    // unconditionally; the dockerEventsStart effect no-ops on an empty
    // container set and dockerFetch dispatches an empty dockerResult that
    // clears the in-flight latch. The gate moved to the impure layer.
    setup([]);
    const { slice, effects } = step({ type: 'refresh' }, slice0());
    eq(types(effects).join(','), 'tick,dockerEventsStart,dockerFetch', 'reducer emits the full set');
    assert(slice.started && slice.inFlight, 'flags set (inFlight is cleared later by the effect)');
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

describe('[3] dockerTick re-arms always; fetch gating lives in the effect', () => {
  it('tick re-arms and emits the fetch when idle', () => {
    setup(['c1'], true);
    const { effects } = step({ type: 'dockerTick' }, { ...slice0(), started: true, eventsStarted: true });
    assert(types(effects).includes('tick'), 're-armed');
    assert(types(effects).includes('dockerFetch'), 'fetched');
  });
  it('tick re-arms and emits the fetch even while blurred — the effect skips the query', () => {
    // Phase-D cleanup: the focus-pause gate moved from this arm to the
    // dockerFetch effect (a live read — the tick fires async, so an
    // arm-time focus value would be stale). The reducer emits dockerFetch
    // regardless; the effect dispatches dockerResult WITHOUT querying
    // docker when getModel().focused === false.
    setup(['c1'], false);  // getModel().focused = false
    const { effects } = step({ type: 'dockerTick' }, { ...slice0(), started: true, eventsStarted: true });
    assert(types(effects).includes('tick'), 're-armed');
    assert(types(effects).includes('dockerFetch'), 'fetch emitted (the effect gates on focus, not the reducer)');
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
    // Pure key arm: the cursor comes from the passed slice.nav and
    // focusKind from the Msg (as dispatchKeyToFocused threads it) — not
    // from the global registry.
    const mnav = require('../leaves/nav');
    const focused = { ...slice0(), nav: { ...mnav.init(), cursor: 1 } };  // c2 selected
    const km = (key) => ({ type: 'key', key, focusKind: 'containers' });
    const i = step(km('i'), focused);
    eq(i.effects[0].type, 'dockerExec');
    eq(i.effects[0].mode, 'inspect');
    eq(i.effects[0].item, 'c2');
    const t = step(km('t'), focused);
    eq(t.effects[0].mode, 'logs');
    const s = step(km('s'), focused);
    eq(s.effects[0].type, 'dockerShell');
    eq(s.effects[0].item, 'c2');
  });
  it('keys are ignored when the containers panel is not focused', () => {
    setup();
    // focusKind != 'containers' → the pure key arm bails (no global read).
    const { effects } = step({ type: 'key', key: 'i', focusKind: 'groups' }, slice0());
    eq(effects.length, 0, 'no effect when unfocused');
  });
});

describe('[6] registered Component — slice-backed reads', () => {
  it('statusFor + getInfo reflect the folded slice', () => {
    const api = require('../panel/api');
    require('../dispatch/effects').installBuiltins();
    api.registerComponent(docker);
    setup(['c1']);
    // Fold a result into the REGISTERED slice via the real dispatch path.
    api.dispatchMsg(api.wrap('docker', { type: 'dockerResult', status: { c1: 'running' }, stats: { c1: { cpu: '5%', mem: '1MB' } } }));
    eq(api.getInstanceSlice('docker').status.c1, 'running', 'slice updated');
    eq(docker.statusFor('c1'), 'running', 'statusFor reads the slice');
    eq(docker.statusFor('ghost'), null, 'untracked → null');
    const def = api.getPanelDef('containers');
    const info = def.getInfo('c1');
    assert(info.some(l => l.includes('running')), 'getInfo shows status');
    assert(info.some(l => l.includes('5%')), 'getInfo shows cpu');
    // getItems is config-derived (slice unused for the row list).
    eq(def.getItems(api.getInstanceSlice('docker')).join(','), 'c1');
  });
});

describe('[7] Arc 3 — content gate: one host-global fetch loop, per-pane nav', () => {
  const mnav = require('../leaves/nav');
  it('a placed pane (paneId set) no-ops the content Msgs — owner only', () => {
    setup();
    const pane = { ...slice0(), paneId: 'docker-a' };
    const r = step({ type: 'refresh' }, pane);
    eq(r.effects.length, 0, 'no fetch/tick/events from a placed pane');
    assert(!r.slice.started && !r.slice.inFlight && !r.slice.eventsStarted,
      'no content flags set on a placed pane');
    // dockerResult is owner-only too — a placed pane never folds status.
    const res = step({ type: 'dockerResult', status: { c1: 'running' }, stats: {} }, pane);
    eq(res.slice.status.c1, undefined, 'placed pane does not fold content');
  });
  it('the content owner (paneId == null) runs the full content loop', () => {
    setup();
    const { slice, effects } = step({ type: 'refresh' }, slice0());  // slice0 has no paneId
    assert(types(effects).includes('dockerFetch'), 'owner fetches');
    assert(types(effects).includes('dockerEventsStart'), 'owner starts the events stream');
    assert(slice.started && slice.inFlight && slice.eventsStarted, 'owner flags set');
  });
  it('a placed pane still handles its own nav + keys', () => {
    setup(['c1', 'c2']);
    const pane = { ...slice0(), paneId: 'docker-a', nav: { ...mnav.init(), cursor: 1 } };
    const navd = step({ type: 'set_cursor', index: 0, panel: 'containers' }, pane);
    eq(mnav.cursorOf(navd.slice, 'containers'), 0, 'set_cursor applied on a placed pane');
    const k = step({ type: 'key', key: 'i', focusKind: 'containers' }, pane);
    eq(k.effects[0].type, 'dockerExec', 'i key handled on a placed pane');
    eq(k.effects[0].item, 'c2', 'targets the placed pane\'s own cursor row');
  });
  it('two placed panes keep independent nav cursors (real mint + dispatch)', () => {
    setup(['c1', 'c2']);
    const route = require('../panel/route');
    const mpool = require('../leaves/pool');
    const arrange = {
      columns: [
        { width: 30, panels: [{ type: 'containers', paneId: 'docker-a', title: 'A', hotkey: '1', columnIndex: 0 }] },
        { width: 30, panels: [{ type: 'containers', paneId: 'docker-b', title: 'B', hotkey: '2', columnIndex: 1 }] },
      ],
      detailHeightPct: 60,
    };
    getInstanceSlice('layout').arrange = arrange;
    // Mirror state.js's per-pane mint loop.
    const components = api._components();
    for (const p of mpool.allPanesInColumns(arrange)) {
      const comp = components[p.type] || components[route.componentForPanel(p.type)];
      if (route.hasInstance(p.type) && p.type !== p.paneId) route.disposeInstance(p.type);
      if (!route.hasInstance(p.paneId)) route.setInstance(p.paneId, p.type, comp.init(p.paneId));
    }
    try {
      setSel('docker-a', 1);
      setSel('docker-b', 0);
      eq(getSel('docker-a'), 1, 'pane A cursor independent');
      eq(getSel('docker-b'), 0, 'pane B cursor unaffected by A');
      // The register-time singleton survives as the content owner.
      assert(route.hasInstance('docker'), 'content owner instance present');
      eq(route.getInstance('docker').slice.paneId, undefined, 'owner has no paneId');
    } finally {
      route.disposeInstance('docker-a');
      route.disposeInstance('docker-b');
      getInstanceSlice('layout').arrange = undefined;
    }
  });
});

report();
