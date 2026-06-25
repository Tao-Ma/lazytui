/**
 * Stats panel smoke test — exercises the line-graph rasterizer, the
 * docker stat-string parsers, default-metrics inference, and value
 * formatters. Hub schema registration is verified via the docker
 * plugin's init() side effect.
 *
 * Run: node js/test/test-stats.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const hub = require('../leaves/infra/hub');
const { update } = require('../app/runtime');
const { rasterize, BLOCKS } = require('../panel/monitor/stats-graph');
const stats = require('../panel/monitor/stats');
const docker = require('../panel/navigator/docker');

// --- rasterize: shape ---

describe('[1] rasterize: empty / degenerate inputs', () => {
  it('zero height returns []', () => {
    eq(rasterize([1, 2, 3], { width: 5, height: 0, min: 0, max: 10 }), []);
  });
  it('zero width returns rows of length 0', () => {
    const rows = rasterize([1, 2, 3], { width: 0, height: 3, min: 0, max: 10 });
    eq(rows.length, 0, 'no columns → no point producing rows');
  });
  it('empty samples → empty cells but right shape', () => {
    const rows = rasterize([], { width: 4, height: 3, min: 0, max: 10 });
    eq(rows.length, 3, 'three rows');
    rows.forEach(r => eq(r.length, 4, 'each row exactly W wide'));
    rows.forEach(r => eq(r, '    ', 'all-empty cells render as spaces'));
  });
});

describe('[2] rasterize: right-aligned, NaN as gap', () => {
  it('shorter-than-width samples left-pad with empty cells', () => {
    const rows = rasterize([100], { width: 4, height: 1, min: 0, max: 100 });
    eq(rows.length, 1);
    eq(rows[0], '   █', 'newest sample at last column, full cell');
  });
  it('NaN values render as space', () => {
    const rows = rasterize([NaN, 50, NaN, 100], { width: 4, height: 1, min: 0, max: 100 });
    eq(rows[0][0], ' ', 'col 0 is NaN');
    eq(rows[0][2], ' ', 'col 2 is NaN');
    eq(rows[0][3], '█', 'col 3 is 100% → full cell');
  });
});

describe('[3] rasterize: scale clamping', () => {
  it('values above max clamp to full', () => {
    const rows = rasterize([200], { width: 1, height: 1, min: 0, max: 100 });
    eq(rows[0], '█', '200 of 100 max → full cell');
  });
  it('values below min clamp to empty', () => {
    const rows = rasterize([-50], { width: 1, height: 1, min: 0, max: 100 });
    eq(rows[0], ' ', 'negative → empty cell');
  });
  it('zero range produces empty graph', () => {
    const rows = rasterize([5, 5, 5], { width: 3, height: 2, min: 5, max: 5 });
    rows.forEach(r => eq(r, '   ', 'flat range with no spread → empty'));
  });
});

describe('[4] rasterize: vertical resolution', () => {
  it('single row uses 8 fill levels', () => {
    // Sample at exactly 50% should be 4 of 8 levels — block "▄".
    const rows = rasterize([50], { width: 1, height: 1, min: 0, max: 100 });
    eq(rows[0], BLOCKS[4], '50% of 8 levels = ▄');
  });
  it('multi-row uses (H*8) levels — bottom-up fill', () => {
    // 3 rows × 8 levels = 24 slots. Value=12 of 100 → slot 3 of 24,
    // appears in bottom row only.
    const rows = rasterize([12.5], { width: 1, height: 3, min: 0, max: 100 });
    eq(rows.length, 3);
    eq(rows[0], ' ', 'top row empty');
    eq(rows[1], ' ', 'middle row empty');
    eq(rows[2], BLOCKS[3], 'bottom row = ▃');
  });
  it('full value → all rows full', () => {
    const rows = rasterize([100, 100, 100], { width: 3, height: 3, min: 0, max: 100 });
    rows.forEach(r => eq(r, '███', 'every cell full'));
  });
});

// --- docker stat parsers ---

describe('[5] parseBytes: docker mem unit forms', () => {
  it('plain bytes', () => eq(docker._parseBytes('512B'), 512));
  it('KiB binary', () => eq(docker._parseBytes('1KiB'), 1024));
  it('MiB binary', () => eq(docker._parseBytes('120MiB'), 120 * 1024 * 1024));
  it('GiB binary', () => eq(docker._parseBytes('2GiB'), 2 * 1024 ** 3));
  it('decimal MB', () => eq(docker._parseBytes('1MB'), 1_000_000));
  it('fractional + space', () => eq(docker._parseBytes('1.5 MiB'), 1.5 * 1024 * 1024));
  it('garbled returns NaN', () => assert(Number.isNaN(docker._parseBytes('???'))));
  it('empty returns NaN', () => assert(Number.isNaN(docker._parseBytes(''))));
});

describe('[6] parseMem: split "used / limit"', () => {
  it('splits and parses both sides', () => {
    const r = docker._parseMem('120MiB / 2GiB');
    eq(r.used, 120 * 1024 * 1024);
    eq(r.limit, 2 * 1024 ** 3);
  });
  it('missing limit → NaN', () => {
    const r = docker._parseMem('120MiB');
    eq(r.used, 120 * 1024 * 1024);
    assert(Number.isNaN(r.limit), 'no slash → limit unknown');
  });
});

describe('[7] parsePercent', () => {
  it('with sign', () => eq(docker._parsePercent('3.2%'), 3.2));
  it('without sign', () => eq(docker._parsePercent('47'), 47));
  it('zero', () => eq(docker._parsePercent('0%'), 0));
  it('garbage NaN', () => assert(Number.isNaN(docker._parsePercent('??'))));
});

// --- default metrics inference ---

describe('[8] _defaultMetrics: filters by schema column type', () => {
  it('only percent + bytes pass through, meta excluded', () => {
    const schema = {
      columns: {
        cpu:      { type: 'percent' },
        mem:      { type: 'bytes' },
        memLimit: { type: 'bytes', meta: true },   // scale ref, not graphable
        label:    { type: 'string' },
        ts:       { type: 'number' },
      },
    };
    const ms = stats._defaultMetrics(schema);
    eq(ms, ['cpu', 'mem'], 'meta + non-numeric columns excluded');
  });
  it('null schema → empty', () => eq(stats._defaultMetrics(null), []));
  it('schema without columns → empty', () => eq(stats._defaultMetrics({}), []));
});

// --- value formatters ---

describe('[9] _fmtPercent + _fmtBytes', () => {
  it('percent: one decimal', () => eq(stats._fmtPercent(3.2), '3.2%'));
  it('percent: NaN → em-dash', () => eq(stats._fmtPercent(NaN), '—'));
  it('bytes: KiB/MiB/GiB boundaries', () => {
    eq(stats._fmtBytes(512), '512B');
    eq(stats._fmtBytes(1536), '1.5KiB');
    eq(stats._fmtBytes(125 * 1024 * 1024), '125.0MiB');
    eq(stats._fmtBytes(2 * 1024 ** 3), '2.00GiB');
  });
});

// --- hub round-trip on docker.stats topic ---

describe('[10] docker plugin defines docker.stats schema on init', () => {
  it('schema present after init', () => {
    hub._reset();
    docker.init({});
    const sch = hub.schema('docker.stats');
    assert(sch !== null, 'schema registered');
    eq(sch.rowKey, 'container_name');
    eq(sch.columns.cpu.type, 'percent');
    eq(sch.columns.mem.type, 'bytes');
  });
});

describe('[11] hub: docker.stats publish + history', () => {
  it('history returns published samples per container', () => {
    hub._reset();
    docker.init({});
    hub.subscribe('docker.stats', { window: 5 });
    for (let i = 0; i < 3; i++) {
      hub.publish('docker.stats', 'foo', { ts: i, cpu: 10 + i, mem: 100, memLimit: 1000 });
      hub.publish('docker.stats', 'bar', { ts: i, cpu: 50, mem: 500, memLimit: 1000 });
    }
    const fooHist = hub.history('docker.stats', 'foo', 10);
    eq(fooHist.length, 3, 'three samples for foo');
    eq(fooHist[0].cpu, 10, 'oldest first');
    eq(fooHist[2].cpu, 12, 'newest last');
    const barHist = hub.history('docker.stats', 'bar', 10);
    eq(barHist.length, 3, 'three samples for bar');
    barHist.forEach(s => eq(s.cpu, 50, 'bar always 50%'));
  });
});

describe('[12] hub: docker.stats window eviction', () => {
  it('publish past window → oldest dropped', () => {
    hub._reset();
    docker.init({});
    hub.subscribe('docker.stats', { window: 5 });
    for (let i = 0; i < 12; i++) {
      hub.publish('docker.stats', 'foo', { ts: i, cpu: i, mem: i, memLimit: 100 });
    }
    const h = hub.history('docker.stats', 'foo', 100);
    eq(h.length, 5, 'trimmed to window');
    eq(h[0].cpu, 7, 'oldest survivor is 12 - 5 = sample 7');
    eq(h[h.length - 1].cpu, 11, 'newest survives');
  });
});

describe('[13] hub: docker.stats delete clears row history', () => {
  it('delete removes a row but leaves siblings alone', () => {
    hub._reset();
    docker.init({});
    hub.subscribe('docker.stats', { window: 5 });
    hub.publish('docker.stats', 'foo', { ts: 1, cpu: 10, mem: 1, memLimit: 100 });
    hub.publish('docker.stats', 'bar', { ts: 1, cpu: 20, mem: 2, memLimit: 100 });
    hub.delete('docker.stats', 'foo');
    eq(hub.history('docker.stats', 'foo').length, 0, 'foo cleared');
    eq(hub.history('docker.stats', 'bar').length, 1, 'bar intact');
  });
});

// --- v0.6.4 Phase D — declared hub subscriptions wired at mount ---

describe('[14] stats declares its metrics-mirror subscription (pure)', () => {
  it('subscriptions(paneDef) projects a metrics-mirror descriptor; no topic → []', () => {
    // Pure function of the pane config — no side effects, no hub touch.
    // v0.6.6 Finding B — declares a `metrics-mirror` Sub (was a bare hub sub).
    eq(stats.subscriptions({ topic: 'docker.stats', window: 5 })[0].kind, 'metrics-mirror', 'metrics-mirror kind');
    eq(stats.subscriptions({ topic: 'docker.stats', window: 5 })[0].topic, 'docker.stats', 'topic carried');
    eq(stats.subscriptions({ topic: 'docker.stats', window: 5 })[0].window, 5, 'explicit window carried');
    eq(stats.subscriptions({ topic: 'docker.stats' })[0].window, 40, 'window defaults to 40 (matches render)');
    eq(stats.subscriptions({}).length, 0, 'no topic → no subscription');
    eq(stats.subscriptions(undefined).length, 0, 'no paneDef → no subscription');
  });
});

describe('[15] framework reconciles declared subscriptions (Model → Sub, #D13)', () => {
  const state = require('../app/state');
  const api = require('../panel/api');
  const route = require('../panel/route');
  const layout = require('../panel/layout');
  const { getModel } = require('../model/store');

  // Place `panes` in the layout arrange so reconcileSubscriptions sees them
  // (the desired set is a pure projection of the placed panes). Registers the
  // 'layout' service slot (the arrange holder) + the 'stats' owner so the
  // reconciler resolves them via componentForPanel.
  function _place(panes) {
    api.registerComponent(layout);
    api.registerComponent(stats);
    const cur = api.serviceSlice('layout') || {};
    route.setInstanceSlice('layout', { ...cur, arrange: { columns: [{ panels: panes }] } });
  }
  const STATS_PANE = { type: 'stats', paneId: 'pane-stats', topic: 'docker.stats', window: 5 };

  it('a placed stats pane subscribes; removing it TEARS THE SUB DOWN', () => {
    hub._reset(); state._resetSubscriptions(); docker.init({});
    _place([STATS_PANE]);
    state.reconcileSubscriptions(getModel());
    hub.publish('docker.stats', 'foo', { ts: 1, cpu: 10, mem: 100, memLimit: 1000 });
    eq(hub.history('docker.stats', 'foo', 10).length, 1, 'placed → subscribed → sample retained (no render)');
    // Remove the pane and re-reconcile — the sub MUST be torn down (the leak
    // the old mount-time wiring left live). #D13 — Model→Sub start/stop.
    _place([]);
    state.reconcileSubscriptions(getModel());
    hub.publish('docker.stats', 'foo', { ts: 2, cpu: 12, mem: 100, memLimit: 1000 });
    eq(hub.history('docker.stats', 'foo', 10).length, 0, 'removed → unsubscribed → nothing retained (teardown)');
  });

  it('dedup: two stats panes on the same (topic, window) share ONE sub', () => {
    hub._reset(); state._resetSubscriptions(); docker.init({});
    _place([STATS_PANE, { ...STATS_PANE, paneId: 'pane-stats-2' }]);
    state.reconcileSubscriptions(getModel());
    // One ring buffer per topic regardless → publishing once yields exactly
    // one retained sample (no duplication from the second pane).
    hub.publish('docker.stats', 'foo', { ts: 1, cpu: 7, mem: 1, memLimit: 100 });
    eq(hub.history('docker.stats', 'foo', 10).length, 1, 'single sample retained');
  });

  it('a pane whose Component declares no subscriptions() is a no-op', () => {
    hub._reset(); state._resetSubscriptions(); docker.init({});
    _place([{ type: 'groups', paneId: 'pane-groups' }]);  // groups has no subscriptions hook
    state.reconcileSubscriptions(getModel());
    hub.publish('docker.stats', 'foo', { ts: 1, cpu: 1, mem: 1, memLimit: 1 });
    eq(hub.history('docker.stats', 'foo', 10).length, 0, 'nothing subscribed → nothing retained');
  });

  it('_desiredSubs is a pure projection: app-global resize + store mirrors + the placed stats pane', () => {
    _place([STATS_PANE]);
    const desired = state._desiredSubs(getModel());
    // App-global subs always desired: `resize` (FIX-3 Phase 2) + the three
    // `store-mirror`s (FIX-1: history / diag / jobs), plus the stats pane's
    // `metrics-mirror` (Finding B) → five.
    eq(desired.size, 5, 'resize + 3 store mirrors + one stats metrics-mirror');
    assert(desired.has('resize:resize'), 'app-global resize sub present (FIX-3 Phase 2)');
    assert(desired.has('store-mirror:history'), 'app-global history store-mirror present (FIX-1)');
    assert(desired.has('store-mirror:diag'), 'app-global diag store-mirror present (FIX-1)');
    assert(desired.has('store-mirror:jobs'), 'app-global jobs store-mirror present (FIX-1)');
    eq(desired.get('store-mirror:jobs').kind, 'store-mirror', 'tagged store-mirror');
    // Finding B — the stats pane's metrics-mirror, keyed by topic (not topic:window).
    assert(desired.has('metrics-mirror:docker.stats'), 'placed stats pane → metrics-mirror keyed by topic');
    eq(desired.get('metrics-mirror:docker.stats').kind, 'metrics-mirror', 'descriptor tagged with its kind');
  });
});

describe('[16] metrics_synced arm — hub series mirrored into model.metrics (Finding B)', () => {
  it('lands { series, schema } under model.metrics[topic] + emits a render Cmd', () => {
    const series = { foo: [{ ts: 1, cpu: 10 }, { ts: 2, cpu: 20 }] };
    const schema = { columns: { cpu: { type: 'percent' } } };
    const [m, cmds] = update({ metrics: {} }, { type: 'metrics_synced', topic: 'docker.stats', series, schema });
    eq(m.metrics['docker.stats'].series, series, 'series stored under the topic');
    eq(m.metrics['docker.stats'].schema, schema, 'schema stored under the topic');
    // The trailing metrics-mirror sample arrives via ctx.applyMsg (no implicit
    // repaint), so the arm must emit render or the graph never refreshes between
    // unrelated dispatches (v0.6.6 pre-release review regression fix).
    eq(cmds.length, 1, 'one Cmd'); eq(cmds[0].type, 'render', 'render Cmd repaints the graph');
  });

  it('merges topics — a new topic does not clobber others', () => {
    const base = { metrics: { 'a.x': { series: { r: [] }, schema: {} } } };
    const [m] = update(base, { type: 'metrics_synced', topic: 'b.y', series: { s: [] }, schema: {} });
    assert(m.metrics['a.x'], 'pre-existing topic preserved');
    assert(m.metrics['b.y'], 'new topic added');
  });
});

report();
