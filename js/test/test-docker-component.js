/**
 * Docker Component (TEA) — reducer + slice-backed reads.
 *
 * Drives update(msg, slice) directly (no real docker) to verify the poll
 * loop: refresh/dockerPoll emit a fetch (the recurring cadence is a declared
 * `interval` Sub — subscriptions() — not a self-armed tick, FIX-3 Phase 4),
 * the inFlight guard prevents overlapping fetches (the focus + container-count
 * gates live in the dockerFetch effect, not the reducer —
 * Phase-D purity), dockerResult folds the maps + clears the guard, and i/t/s
 * key Msgs emit the right stream/shell effects.
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
  return { status: {}, stats: {}, inFlight: false };
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
// Mirror the framework shell: thread model facts via augmentMsg before update
// (dispatch/runtime/loop _runInstance / dispatchKeyToFocused do this in production), so the
// key arm sees msg.items without update() reaching for getModel().
function step(msg, slice) {
  const m = docker.augmentMsg ? docker.augmentMsg(msg, getModel()) : msg;
  const r = _update(m, slice);
  return Array.isArray(r) ? { slice: r[0], effects: r[1] || [] } : { slice: r, effects: [] };
}
const types = (effects) => effects.map(e => e.type);

describe('[1] refresh polls now (just a fetch — cadence + events are declared Subs)', () => {
  it('first refresh: dockerFetch only, inFlight set — NO tick, NO dockerEventsStart', () => {
    setup();
    const { slice, effects } = step({ type: 'refresh' }, slice0());
    // FIX-3: the recurring cadence is the interval Sub and the events watcher
    // is the process-stream Sub (both in subscriptions()), so refresh just polls.
    eq(types(effects).join(','), 'dockerFetch', 'refresh emits only the fetch (no tick, no events-start)');
    assert(slice.inFlight, 'inFlight set (cleared later by the effect)');
  });
  it('no containers: still just the fetch (the dockerFetch effect gates on count)', () => {
    setup([]);
    const { slice, effects } = step({ type: 'refresh' }, slice0());
    eq(types(effects).join(','), 'dockerFetch', 'reducer emits only the fetch');
    assert(slice.inFlight, 'inFlight set');
  });
});

describe('[1b] subscriptions() declares the poll + events-watcher Subs', () => {
  const PANE = { type: 'containers', paneId: 'docker-a' };
  it('with a tracked container: interval poll + process-stream events watcher', () => {
    setup(['c1']);
    const subs = docker.subscriptions(PANE, getModel());
    const interval = subs.find(s => s.kind === 'interval');
    const proc = subs.find(s => s.kind === 'process-stream');
    assert(interval && interval.id === 'docker-poll', 'interval poll declared (stable id)');
    assert(proc && proc.id === 'docker-events', 'process-stream events watcher declared');
    eq(proc.cmd, 'docker', 'spawns docker');
    eq(proc.args[0], 'events', 'docker events');
    assert(proc.reconnectMs > 0, 'has a reconnect backoff');
    // interval onTick dispatches a wrapped dockerPoll
    let polled = null;
    interval.onTick({ dispatch: (m) => { polled = m; }, wrap: (k, m) => ({ kind: k, msg: m }) });
    eq(polled.kind, 'docker', 'wrapped to docker');
    eq(polled.msg.type, 'dockerPoll', 'interval ticks dispatch dockerPoll');
  });
  it('no tracked container: only the interval poll (no events watcher to spawn)', () => {
    setup([]);
    const subs = docker.subscriptions(PANE, getModel());
    assert(subs.some(s => s.kind === 'interval'), 'interval poll still declared');
    assert(!subs.some(s => s.kind === 'process-stream'), 'no process-stream without a tracked container');
  });
});

describe('[2] inFlight guards overlapping fetches', () => {
  it('refresh while a fetch is in flight does not emit another', () => {
    setup();
    const busy = { ...slice0(), inFlight: true };
    const { effects } = step({ type: 'refresh' }, busy);
    assert(!types(effects).includes('dockerFetch'), 'no second fetch');
  });
  it('dockerPoll while in flight is a no-op', () => {
    setup();
    const busy = { ...slice0(), inFlight: true };
    const { effects } = step({ type: 'dockerPoll' }, busy);
    eq(effects.length, 0, 'no effects');
  });
});

describe('[3] dockerPoll polls without arming a tick (cadence is the interval Sub)', () => {
  it('emits the fetch when idle — no tick re-arm', () => {
    setup(['c1'], true);
    const { effects } = step({ type: 'dockerPoll' }, slice0());
    assert(!types(effects).includes('tick'), 'no self-armed tick (FIX-3 Phase 4 — the interval Sub drives cadence)');
    assert(types(effects).includes('dockerFetch'), 'fetched');
  });
  it('emits the fetch even while blurred — the dockerFetch effect skips the query', () => {
    // The focus-pause gate lives in the dockerFetch effect (a live read —
    // the poll fires async, so an arm-time focus value would be stale). The
    // reducer emits dockerFetch regardless; the effect dispatches dockerResult
    // WITHOUT querying docker when getModel().focused === false.
    setup(['c1'], false);  // getModel().focused = false
    const { effects } = step({ type: 'dockerPoll' }, slice0());
    assert(types(effects).includes('dockerFetch'), 'fetch emitted (the effect gates on focus, not the reducer)');
  });
});

describe('[4] dockerResult folds maps + clears the guard', () => {
  it('stores status/stats and requests a render', () => {
    setup();
    const busy = { ...slice0(), inFlight: true };
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
    const prior = { ...slice0(), status: { c1: 'running' }, inFlight: true };
    const { slice } = step({ type: 'dockerResult' }, prior);
    eq(slice.status.c1, 'running', 'prior status retained');
    assert(!slice.inFlight, 'guard cleared so polling resumes');
  });
});

describe('[5] item-action key Msgs emit the right effects on the focused row', () => {
  it('i inspect / L logs / s shell → stream/shell effects; S/R/K → confirmed run_action', () => {
    setup(['c1', 'c2']);
    // Pure key arm: the cursor comes from the passed slice.nav and
    // focusKind from the Msg (as dispatchKeyToFocused threads it) — not
    // from the global registry. Keys are the declared _itemActions list.
    const mnav = require('../leaves/wm/nav');
    const focused = { ...slice0(), nav: { ...mnav.init(), cursor: 1 } };  // c2 selected
    const km = (key) => ({ type: 'key', key, focusKind: 'containers' });
    const i = step(km('i'), focused);
    eq(i.effects[0].type, 'dockerExec');
    eq(i.effects[0].mode, 'inspect');
    eq(i.effects[0].item, 'c2');
    assert(i.effects.some(e => e.type === '_claimed'), 'an item-action key claims it (no framework re-run)');
    const l = step(km('L'), focused);   // logs is L now (t was never in the word; l = focus-right nav)
    eq(l.effects[0].mode, 'logs');
    const s = step(km('s'), focused);
    eq(s.effects[0].type, 'dockerShell');
    eq(s.effects[0].item, 'c2');
    // Shift keys → the destructive verbs, via the confirm-gated run_action.
    for (const [key, verb] of [['S', 'stop'], ['R', 'restart'], ['K', 'kill']]) {
      const r = step(km(key), focused);
      eq(r.effects[0].type, 'run_action');
      assert(r.effects[0].action.script.includes(`docker ${verb} `), `${key} → docker ${verb}`);
      assert(/container "c2"\?$/.test(r.effects[0].action.confirm), `${key} confirm prompt`);
    }
    eq(step(km('t'), focused).effects.length, 0, 't is no longer bound');
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
    require('../dispatch/runtime/effects').installBuiltins();
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
  const mnav = require('../leaves/wm/nav');
  it('a placed pane (paneId set) no-ops the content Msgs — owner only', () => {
    setup();
    const pane = { ...slice0(), paneId: 'docker-a' };
    const r = step({ type: 'refresh' }, pane);
    eq(r.effects.length, 0, 'no fetch/events from a placed pane');
    assert(!r.slice.inFlight, 'no content flags set on a placed pane');
    // dockerResult is owner-only too — a placed pane never folds status.
    const res = step({ type: 'dockerResult', status: { c1: 'running' }, stats: {} }, pane);
    eq(res.slice.status.c1, undefined, 'placed pane does not fold content');
  });
  it('the content owner (paneId == null) runs the fetch loop', () => {
    setup();
    const { slice, effects } = step({ type: 'refresh' }, slice0());  // slice0 has no paneId
    assert(types(effects).includes('dockerFetch'), 'owner fetches');
    assert(slice.inFlight, 'owner inFlight set');
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
    const mpool = require('../leaves/wm/pool');
    const arrange = {
      columns: [
        { width: 30, panels: [{ type: 'containers', paneId: 'docker-a', title: 'A', hotkey: '1', columnIndex: 0 }] },
        { width: 30, panels: [{ type: 'containers', paneId: 'docker-b', title: 'B', hotkey: '2', columnIndex: 1 }] },
      ],
      detailHeightPct: 60,
    };
    getInstanceSlice('layout').arrange = arrange;
    // Mirror state.js's per-pane mint loop (panel-type registry only —
    // NO Component-name arm; see initState).
    const components = api._components();
    for (const p of mpool.allPanesInColumns(arrange)) {
      const comp = components[route.componentForPanel(p.type)];
      if (!comp) continue;
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
  it('a rogue `type: docker` pane cannot clobber the content owner (service slot)', () => {
    // Regression — _primaryByKind split arc P0. Pre-split, the mint
    // loop's `components[kind]` arm matched Component NAMES, so a config
    // pane of `type: docker` resolved the docker Component, DISPOSED the
    // register-time owner, and re-pointed the kind primary at a nav-only
    // per-pane mint — the update() owner-gate then no-opped every content
    // Msg and fetching silently died. Two independent fixes pin here:
    // the name-arm is gone (rogue pane mints nothing), and the owner is
    // a service slot (dispose refuses even if some path tries).
    setup(['c1']);
    const route = require('../panel/route');
    const mpool = require('../leaves/wm/pool');
    assert(route.isService('docker'), 'owner is a service slot');
    const arrange = {
      columns: [
        { width: 30, panels: [{ type: 'docker', paneId: 'pane-rogue', title: 'R', hotkey: '1', columnIndex: 0 }] },
        { width: 30, panels: [{ type: 'containers', paneId: 'docker-c', title: 'C', hotkey: '2', columnIndex: 1 }] },
      ],
      detailHeightPct: 60,
    };
    getInstanceSlice('layout').arrange = arrange;
    const components = api._components();
    try {
      for (const p of mpool.allPanesInColumns(arrange)) {
        const comp = components[route.componentForPanel(p.type)];
        if (!comp) continue;
        if (route.hasInstance(p.type) && p.type !== p.paneId) route.disposeInstance(p.type);
        if (!route.hasInstance(p.paneId)) route.setInstance(p.paneId, p.type, comp.init(p.paneId));
      }
      // 'docker' is a Component NAME, not a registered panel-type → the
      // rogue pane resolves no Component and mints nothing.
      assert(!route.hasInstance('pane-rogue'), 'rogue pane minted no instance');
      assert(route.hasInstance('docker'), 'content owner survives the mint loop');
      eq(route.getInstance('docker').slice.paneId, undefined, 'owner still has no paneId');
      // Fetching provably alive: a dockerResult folds into the owner
      // slice and statusFor reads it back through _slice().
      api.dispatchMsg(api.wrap('docker', { type: 'dockerResult', status: { c1: 'running' }, stats: {} }));
      eq(docker.statusFor('c1'), 'running', 'content path alive after the rogue config');
      // Belt + braces: a direct dispose refuses on the service slot.
      route.disposeInstance('docker');   // logs a refusal, no-op
      assert(route.hasInstance('docker'), 'disposeInstance refused on the service slot');
    } finally {
      route.disposeInstance('docker-c');
      getInstanceSlice('layout').arrange = undefined;
    }
  });
});

describe('[8] groupActions: logs spawns through a mouse-capable pager', () => {
  it('logs pipes the follow into the less probe (mouse-scrollable spawned window)', () => {
    const acts = docker.groupActions({ compose: 'docker-compose.yml' });
    eq(acts.logs.type, 'spawn', 'still a spawn');
    assert(acts.logs.script.includes('docker compose logs -f --tail=50'), 'follow command intact');
    assert(acts.logs.script.includes('| $p'), 'output piped into the chosen pager');
    assert(acts.logs.script.includes("less --mouse -R +F"), 'probes for less --mouse');
    assert(acts.logs.script.startsWith('p=cat;'), 'cat fallback when less is absent');
  });
  it('compose-file flag still threads through', () => {
    const acts = docker.groupActions({ compose: 'stack.yml' });
    assert(acts.logs.script.includes('docker compose -f stack.yml logs -f --tail=50'),
      'custom compose file preserved inside the pager pipeline');
  });
});

describe('[9] refresh_ms — poll cadence seeded from the RESOLVED pool config', () => {
  const mc = require('../leaves/render/refresh-control');
  // Real parsed shape (verified against parser.parse): `panels:` folds into
  // config.layout.pool[id] with plugin config nested under `.config` — there is
  // NO top-level config.panels. (The old test pinned a `{panels}` fiction that
  // parse() never produces, so the dead seam stayed green — review HIGH.)
  const cfg = (pool) => ({ layout: { pool } });
  it('defaults when no containers pane / no refresh_ms configured', () => {
    eq(docker.configuredRefreshMs({}), mc.DEFAULT_REFRESH_MS);
    eq(docker.configuredRefreshMs(cfg({ s: { type: 'stats', config: {} } })), mc.DEFAULT_REFRESH_MS);
    eq(docker.configuredRefreshMs(cfg({ c: { type: 'containers', config: {} } })), mc.DEFAULT_REFRESH_MS);
    eq(docker.configuredRefreshMs(cfg({ c: { type: 'containers' } })), mc.DEFAULT_REFRESH_MS);   // no .config
  });
  it('reads the containers pane config.refresh_ms, clamped', () => {
    eq(docker.configuredRefreshMs(cfg({ c: { type: 'containers', config: { refresh_ms: 2000 } } })), 2000);
    eq(docker.configuredRefreshMs(cfg({ c: { type: 'containers', config: { refresh_ms: 10 } } })), mc.MIN_REFRESH_MS);
    eq(docker.configuredRefreshMs(cfg({ c: { type: 'containers', config: { refresh_ms: 999999 } } })), mc.MAX_REFRESH_MS);
    eq(docker.configuredRefreshMs(cfg({ c: { type: 'containers', config: { refresh_ms: 'nope' } } })), mc.DEFAULT_REFRESH_MS);
    eq(docker.configuredRefreshMs(cfg({ c: { type: 'containers', config: { refresh_ms: 0 } } })), mc.DEFAULT_REFRESH_MS);   // ≤0 → default
  });
  it('configuredRefreshLadder reads refresh_ladder (normalized); default otherwise', () => {
    eq(docker.configuredRefreshLadder({}), mc.REFRESH_LADDER);
    eq(docker.configuredRefreshLadder(cfg({ c: { type: 'containers', config: {} } })), mc.REFRESH_LADDER);
    eq(docker.configuredRefreshLadder(cfg({ c: { type: 'containers', config: { refresh_ladder: [5000, 2000, 60000] } } })),
       [2000, 5000, 60000]);                                     // sorted
    eq(docker.configuredRefreshLadder(cfg({ c: { type: 'containers', config: { refresh_ladder: 'bad' } } })), mc.REFRESH_LADDER);
  });
  it('refresh_ms is clamped into the CONFIGURED ladder', () => {
    const L = { refresh_ladder: [3000, 6000, 120000] };
    eq(docker.configuredRefreshMs(cfg({ c: { type: 'containers', config: { ...L, refresh_ms: 120000 } } })), 120000);  // 60s ceiling lifted
    eq(docker.configuredRefreshMs(cfg({ c: { type: 'containers', config: { ...L, refresh_ms: 1000 } } })), 3000);      // clamped up to custom min
  });
  it('init seeds the service slice from the boot seed config (cadence + ladder)', () => {
    // init-injection: config arrives via the seed the mint threads (api
    // registerComponent for the service slot), NOT getModel() — init is pure.
    const config = cfg({ c: { type: 'containers', config: { refresh_ms: 5000, refresh_ladder: [1000, 5000, 60000] } } });
    const s = docker._init(undefined, { config });
    eq(s.refreshMs, 5000);
    eq(s.refreshLadder, [1000, 5000, 60000]);
  });
  it('init with no seed degrades to the default cadence + ladder', () => {
    const s = docker._init();
    eq(s.refreshMs, require('../leaves/render/refresh-control').DEFAULT_REFRESH_MS);
  });
});

describe('[10] set_refresh_ms steps the owner poll cadence', () => {
  const mc = require('../leaves/render/refresh-control');
  it('dir +1 slower / -1 faster, and emits a render', () => {
    const owner = { ...slice0(), refreshMs: 2000 };
    const up = step({ type: 'set_refresh_ms', dir: 1 }, owner);
    eq(up.slice.refreshMs, 5000);
    assert(types(up.effects).includes('render'), 'render Cmd emitted');
    eq(step({ type: 'set_refresh_ms', dir: -1 }, owner).slice.refreshMs, 1000);
  });
  it('a ladder-end step is a no-op — same slice ref, no render (no reconcile churn)', () => {
    const owner = { ...slice0(), refreshMs: mc.MAX_REFRESH_MS };
    const r = step({ type: 'set_refresh_ms', dir: 1 }, owner);
    assert(r.slice === owner, 'unchanged slice returned by reference');
    eq(r.effects.length, 0, 'no render on a no-op');
  });
  it('ms sets the cadence directly, clamped to the ladder', () => {
    const owner = { ...slice0(), refreshMs: 2000 };   // no refreshLadder → default ladder
    eq(step({ type: 'set_refresh_ms', ms: 5000 }, owner).slice.refreshMs, 5000);
    eq(step({ type: 'set_refresh_ms', ms: 500 }, owner).slice.refreshMs, mc.MIN_REFRESH_MS);   // below floor → clamped
    eq(step({ type: 'set_refresh_ms', ms: 999999 }, owner).slice.refreshMs, mc.MAX_REFRESH_MS);
  });
  it('a placed pane (paneId set) ignores it — the cadence is host-global (owner only)', () => {
    const placed = { ...slice0(), paneId: 'docker-a', refreshMs: 2000 };
    eq(step({ type: 'set_refresh_ms', dir: 1 }, placed).slice.refreshMs, 2000);
  });
});

describe('[11] refreshMs drives subscriptions() + is a reconcile-gate input', () => {
  const state = require('../app/state');
  it('the interval Sub ms tracks the owner slice refreshMs (so a change re-arms it)', () => {
    const PANE = { type: 'containers', paneId: 'c-sub', title: 'C' };
    api.dispatchMsg(api.wrap('docker', { type: 'set_refresh_ms', ms: 2000 }));
    eq(api.serviceSlice('docker').refreshMs, 2000);
    eq(docker.subscriptions(PANE, getModel()).find(s => s.kind === 'interval').ms, 2000);
    api.dispatchMsg(api.wrap('docker', { type: 'set_refresh_ms', ms: 5000 }));
    eq(docker.subscriptions(PANE, getModel()).find(s => s.kind === 'interval').ms, 5000);
  });
  it('changing refreshMs changes the desired-sub key → must be (and is) in the gate key', () => {
    // The docker-poll interval sub keys on `${id}:${ms}`, so a rate change is a
    // NEW desired-set key. reconcileSubscriptions' perf gate folds `dockerRefresh`
    // in for exactly this reason (state.js); without it the change would be
    // skipped and the timer never re-armed.
    getInstanceSlice('layout').arrange = {
      columns: [{ panels: [{ type: 'containers', paneId: 'c-gate', title: 'C', columnIndex: 0 }] }],
      detailHeightPct: 60,
    };
    api.dispatchMsg(api.wrap('docker', { type: 'set_refresh_ms', ms: 2000 }));
    const a = [...state._desiredSubs(getModel()).keys()].sort();
    api.dispatchMsg(api.wrap('docker', { type: 'set_refresh_ms', ms: 5000 }));
    const b = [...state._desiredSubs(getModel()).keys()].sort();
    assert(a.some(k => k.includes('docker-poll')), 'docker-poll sub is present');
    assert(JSON.stringify(a) !== JSON.stringify(b), 'the docker-poll key changed with refreshMs');
  });
});

describe('[12] render draws the refresh control on the top border', () => {
  const { stripMarkup } = require('../leaves/text/ansi');
  const drender = docker.panelTypes.containers.render;
  it('shows `- Ns +` on the top border when chrome is present and it fits', () => {
    setup(['c1', 'c2']);
    api.dispatchMsg(api.wrap('docker', { type: 'set_refresh_ms', ms: 2000 }));
    const panel = { paneId: 'containers', title: 'Containers', hotkey: '1' };
    const out = drender(panel, 44, 8, null, { focused: true, chrome: { collapse: 'expand' } });
    const top = stripMarkup(out.split('\n')[0]);
    assert(top.includes('- 2s +'), `control on top border: ${JSON.stringify(top)}`);
  });
  it('reflects the current cadence (5s after a step)', () => {
    setup(['c1']);
    api.dispatchMsg(api.wrap('docker', { type: 'set_refresh_ms', ms: 5000 }));
    const panel = { paneId: 'containers', title: 'Containers', hotkey: '1' };
    const top = stripMarkup(drender(panel, 44, 8, null, { focused: true, chrome: { collapse: 'expand' } }).split('\n')[0]);
    assert(top.includes('- 5s +'), `control shows 5s: ${JSON.stringify(top)}`);
  });
});

describe('[13] hitTestBorderControls resolves refresh + sort clicks on a placed containers pane', () => {
  const { hitTestBorderControls } = require('../panel/chrome-hittest');
  // Two controls share the strip now — refresh (host-global, leftmost) then the
  // sort selector (per-pane, nearest the glyphs). For a w=40 pane at "2s",
  // unsorted (sort label `·`): collapse [_] x0 = 36;
  //   sort  vw=5 → x0 = 36-1-5 = 30  (‹ 30-31, · 32, › 33-34)
  //   refresh vw=6 → x0 = 30-1-6 = 23 (- 23-24, label 25-26, + 27-28)
  const setupPane = (modes) => {
    const ls = getInstanceSlice('layout');
    ls.arrange = { columns: [{ panels: [{ type: 'containers', paneId: 'c-hit', title: 'C', columnIndex: 0 }] }], detailHeightPct: 60 };
    ls.paneBounds = { 'c-hit': { x: 0, y: 0, w: 40, h: 8 } };
    ls.freeConfig = null;
    getModel().modes = modes;
    api.dispatchMsg(api.wrap('docker', { type: 'set_refresh_ms', ms: 2000 }));
  };
  it('refresh -/+ route to the docker owner (host-global cadence)', () => {
    setupPane({});
    eq(hitTestBorderControls(23, 0), { owner: 'docker', msg: { type: 'set_refresh_ms', dir: -1 } });   // on `-`
    eq(hitTestBorderControls(28, 0), { owner: 'docker', msg: { type: 'set_refresh_ms', dir: 1 } });    // on `+`
    eq(hitTestBorderControls(25, 0), null);   // refresh label — no region
  });
  it('sort ‹ / › cycle the column, label reverses — routed to the CLICKED pane', () => {
    setupPane({});
    eq(hitTestBorderControls(34, 0), { owner: 'c-hit', msg: { type: 'set_sort', panel: 'containers', key: 'name' } });  // `›` next: null→name
    eq(hitTestBorderControls(30, 0), { owner: 'c-hit', msg: { type: 'set_sort', panel: 'containers', key: 'mem'  } });  // `‹` prev: null→mem (wrap)
    eq(hitTestBorderControls(32, 0), { owner: 'c-hit', msg: { type: 'sort_reverse', panel: 'containers' } });           // label → reverse
  });
  it('off-row / too-narrow / free-config miss (no phantom click)', () => {
    setupPane({});
    eq(hitTestBorderControls(23, 1), null);   // wrong row
    const ls = getInstanceSlice('layout');
    ls.paneBounds = { 'c-hit': { x: 0, y: 0, w: 12, h: 8 } };   // too narrow → strip not shown
    eq(hitTestBorderControls(5, 0), null);
    setupPane({ freeConfigMode: true });       // both controls suppressed
    eq(hitTestBorderControls(23, 0), null);
    eq(hitTestBorderControls(34, 0), null);
    getModel().modes = {};
  });
});

describe('[14] sort orders the canonical getItems list, composes with filter, and augmentMsg threads it', () => {
  const setSort  = (key) => api.dispatchMsg(api.wrap('docker', { type: 'set_sort', panel: 'containers', key }));
  const reverse  = ()    => api.dispatchMsg(api.wrap('docker', { type: 'sort_reverse', panel: 'containers' }));
  const setFilter = (t)  => api.dispatchMsg(api.wrap('docker', { type: 'set_filter', panel: 'containers', text: t }));
  it('default = native config order; set_sort name orders A→Z; reverse flips', () => {
    setup(['zeta', 'alpha', 'mike']);
    setSort(null); setFilter('');
    eq(api.getItems('containers'), ['zeta', 'alpha', 'mike']);   // native order — nothing reorders by default
    setSort('name');
    eq(api.getItems('containers'), ['alpha', 'mike', 'zeta']);
    reverse();
    eq(api.getItems('containers'), ['zeta', 'mike', 'alpha']);
    setSort(null); setFilter('');
  });
  it('sort composes with filter (filter narrows, then sort orders the survivors)', () => {
    setup(['zeta', 'alpha', 'mike']);
    setSort('name'); setFilter('a');   // 'a' matches zeta + alpha; mike drops
    eq(api.getItems('containers'), ['alpha', 'zeta']);
    setSort(null); setFilter('');
  });
  it('augmentMsg threads EXACTLY the canonical sorted list (cursor 0 → the rendered first row)', () => {
    setup(['zeta', 'alpha', 'mike']);
    setSort('name'); setFilter('');
    const threaded = docker.augmentMsg({ type: 'key', key: 'i' }, getModel()).items;
    eq(threaded, api.getItems('containers'));   // same order the renderer uses — no raw/rendered desync
    eq(threaded[0], 'alpha');                    // NOT config's 'zeta' — i/t/s act on the visible row
    setSort(null); setFilter('');
  });
});

describe('[15] item-action bar: reducer Cmds, confirm on destructive, focused bottom hit-test', () => {
  it('inspect/logs/shell emit their effects directly', () => {
    const item = 'web';
    eq(step({ type: 'item_action', action: 'inspect', item }, slice0()).effects, [{ type: 'dockerExec', mode: 'inspect', item }]);
    eq(step({ type: 'item_action', action: 'logs',    item }, slice0()).effects, [{ type: 'dockerExec', mode: 'logs', item }]);
    eq(step({ type: 'item_action', action: 'shell',   item }, slice0()).effects, [{ type: 'dockerShell', item }]);
  });
  it('stop/restart/kill run `docker <verb>` through the shared confirm gate (run_action)', () => {
    for (const verb of ['stop', 'restart', 'kill']) {
      const e = step({ type: 'item_action', action: verb, item: 'web' }, slice0()).effects;
      eq(e.length, 1);
      eq(e[0].type, 'run_action');
      eq(e[0].action.type, 'run');
      assert(e[0].action.script.includes(`docker ${verb} `), `runs docker ${verb}: ${e[0].action.script}`);
      assert(/container "web"\?$/.test(e[0].action.confirm), `confirm prompt: ${e[0].action.confirm}`);
    }
  });
  it('no selected item → no Cmd', () => {
    eq(step({ type: 'item_action', action: 'kill', item: undefined }, slice0()).effects, []);
  });
  it('a click on a bottom-legend label dispatches item_action for the focused pane', () => {
    const { hitTestBorderControls } = require('../panel/chrome-hittest');
    setup(['c1', 'c2']);                 // setup() focuses the 'containers' pane
    const ls = getInstanceSlice('layout');
    ls.arrange = { columns: [{ panels: [{ type: 'containers', paneId: 'containers', title: 'C', columnIndex: 0 }] }], detailHeightPct: 60 };
    ls.paneBounds = { containers: { x: 0, y: 0, w: 60, h: 8 } };   // legend row = y+h-1 = 7; bottomX0 = 2
    ls.freeConfig = null;
    getModel().modes = {};
    // 'inspect logs shell stop restart kill' from x0=2 → inspect 2..8, kill 34..37
    eq(hitTestBorderControls(2, 7),  { owner: 'containers', msg: { type: 'item_action', action: 'inspect', item: 'c1' } });
    eq(hitTestBorderControls(34, 7), { owner: 'containers', msg: { type: 'item_action', action: 'kill', item: 'c1' } });
    eq(hitTestBorderControls(9, 7), null);   // the separator gap between inspect and logs
  });
  it('the bar is suppressed on an UNfocused pane (no phantom bottom hit)', () => {
    const ls = getInstanceSlice('layout');
    ls.focus = 'elsewhere';
    eq(require('../panel/chrome-hittest').hitTestBorderControls(34, 7), null);
    ls.focus = 'containers';
  });
});

describe('[16] a collapsed docker pane paints NO border controls → clicks miss (no phantom kill)', () => {
  const { hitTestBorderControls } = require('../panel/chrome-hittest');
  const arrange = (collapsed, h) => {
    const ls = getInstanceSlice('layout');
    ls.arrange = { columns: [{ panels: [{ type: 'containers', paneId: 'containers', title: 'C', columnIndex: 0, collapsed }] }], detailHeightPct: 60 };
    ls.paneBounds = { containers: { x: 0, y: 0, w: 60, h } };   // w=60: refresh `-` at x=43 when expanded
    ls.freeConfig = null;
    getModel().modes = {};
    api.dispatchMsg(api.wrap('docker', { type: 'set_refresh_ms', ms: 2000 }));
  };
  it('EXPANDED at w=60: the refresh `-` at (43,0) hits — the control IS present', () => {
    setup(['c1', 'c2']); arrange(false, 8);
    eq(hitTestBorderControls(43, 0), { owner: 'docker', msg: { type: 'set_refresh_ms', dir: -1 } });
  });
  it('COLLAPSED (1-row bar): the SAME cell + the sort/legend cells all miss', () => {
    setup(['c1', 'c2']); arrange(true, 1);
    eq(hitTestBorderControls(43, 0), null);   // refresh — suppressed
    eq(hitTestBorderControls(50, 0), null);   // sort selector — suppressed
    eq(hitTestBorderControls(2, 0), null);    // bottom legend (row 0 when h=1) — suppressed
  });
});

describe('[17] augmentMsg threads the canonical list only for key Msgs, keyed on the pane', () => {
  it('key Msg → the pane\'s filtered+sorted items; non-key Msg → untouched (skips the sort)', () => {
    setup(['b', 'a']);
    api.dispatchMsg(api.wrap('docker', { type: 'set_sort', panel: 'containers', key: 'name' }));
    const keyMsg = docker.augmentMsg({ type: 'key', key: 'i' }, getModel(), { paneId: 'containers' });
    eq(keyMsg.items, ['a', 'b']);                       // sorted, not config order
    eq(keyMsg.items, api.getItems('containers'));       // exactly the canonical list
    const pollMsg = docker.augmentMsg({ type: 'dockerResult' }, getModel(), { paneId: 'containers' });
    assert(pollMsg.items === undefined, 'a non-key Msg carries no items');
    api.dispatchMsg(api.wrap('docker', { type: 'set_sort', panel: 'containers', key: null }));   // cleanup
  });
});

describe('[18] paneTypeHasBottomBar — the footer uses this to avoid double-showing quick keys', () => {
  it('true for a pane with a bottom action bar (containers), false otherwise', () => {
    eq(api.paneTypeHasBottomBar('containers'), true);
    eq(api.paneTypeHasBottomBar('groups'), false);
  });
});

describe('[19] item-action invariants', () => {
  it('label[0] === key for every real _itemActions entry (the render highlights label[0])', () => {
    for (const a of docker._itemActions) eq(a.label[0], a.key, a.id);
  });
  it('the bar reports no bottom control on a too-narrow pane (footer becomes the fallback)', () => {
    // innerW 6 can\'t fit even the compact 6-key row (needs >= 13) → the bar is
    // absent, so _showFooterHints must NOT suppress the footer (FINDING 2).
    const narrow = { paneId: 'containers', type: 'containers', focused: true, innerW: 6 };
    const wide   = { paneId: 'containers', type: 'containers', focused: true, innerW: 40 };
    getModel().config = { ...getModel().config, quick_keys: 'border' };
    const hasBottom = (pane) => api.borderControlsFor(pane, getModel()).some(c => (c.spec.slot || 'top') === 'bottom');
    eq(hasBottom(narrow), false, 'no bar when too narrow');
    eq(hasBottom(wide), true, 'bar present when wide');
    delete getModel().config.quick_keys;
  });
});

report();
