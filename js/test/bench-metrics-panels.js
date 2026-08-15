/**
 * Metrics-consumer render bench — the gauge / table panels + the shared getItems
 * sort, at realistic → stress row counts. Guards the v0.6.18 metrics work: the
 * per-position gradient fill, the O(N) denom/label-width reduce scans (replacing
 * the Math.max spread), and the internal getItems sort. Render is ≤20fps
 * (~50ms/frame budget), so per-frame cost only matters if it approaches that.
 *
 * Run: node js/test/bench-metrics-panels.js
 */
'use strict';

require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getModel } = require('../app/runtime');
const rq = require('../leaves/infra/render-queue');
const panelApi = require('../panel/api');
for (const c of ['stats', 'table', 'gauge']) {
  if (!panelApi.getComponent(c)) panelApi.registerComponent(require('../panel/monitor/' + c));
}

const _out = process.stdout.write.bind(process.stdout);
function log(s) { _out(s + '\n'); }
// Time fn with stdout SILENCED (sm.render writes a full frame per call — else the
// bench emits ~100MB of escapes). log() uses the saved real writer.
function timeOps(fn, iters) {
  const sink = () => true;
  process.stdout.write = sink;
  try {
    for (let i = 0; i < Math.min(iters, 50); i++) fn();        // warm
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < iters; i++) fn();
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    return { usPer: (ms * 1000) / iters, ops: Math.round(iters / (ms / 1000)) };
  } finally { process.stdout.write = _out; }
}

const SCHEMA = { cpu: { type: 'percent' }, mem: { type: 'percent' }, comm: { type: 'string' } };
function seed(topic, n) {
  const series = {};
  const names = ['postgres', 'node', 'redis', 'awk', 'bash', 'vim', 'tmux', 'sshd', 'python', 'ruby'];
  for (let i = 0; i < n; i++) series['p' + i] = [{ cpu: (i * 37) % 100, mem: (i * 13) % 100, comm: names[i % names.length] + i }];
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series, schema: { columns: SCHEMA } } };
}

function bootPane(type, extra) {
  const paneCfg = { id: 'p', type, title: 'P', config: Object.assign({ topic: 't', column: 'cpu', columns: ['cpu', 'mem', 'comm'], label: 'comm', sort: 'cpu' }, extra || {}) };
  sm.bootFresh({
    groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
    layout: { pool: { p: paneCfg }, columns: [{ panels: [paneCfg] }] },
  });
  sm.resize(120, 48);
}

log('Metrics-consumer render bench (render budget ~50ms/frame @ ≤20fps)\n');

const ROWS = [40, 500, 5000];

log('[getItems] internal sort (desc by cpu) — shared by gauge + table');
for (const n of ROWS) {
  bootPane('table');
  seed('t', n);
  const iters = n >= 5000 ? 2000 : 20000;
  const o = timeOps(() => panelApi.getItems('p'), iters);
  log(`  n=${String(n).padStart(5)}  ${o.usPer.toFixed(2)}µs/call`);
}

for (const type of ['gauge', 'table']) {
  log(`\n[${type}] full pane render(model) per frame`);
  for (const n of ROWS) {
    bootPane(type);
    seed('t', n);
    const iters = n >= 5000 ? 300 : 3000;
    const o = timeOps(() => { rq.forceFullRepaint(); sm.render(); }, iters);
    const pct = (o.usPer / 1000 / 50 * 100);
    log(`  n=${String(n).padStart(5)}  ${o.usPer.toFixed(1)}µs/frame  (${o.ops.toLocaleString()} fps-equiv, ${pct.toFixed(1)}% of the 50ms budget)`);
  }
}

log('\n--- read ---');
log('  A gauge/table shows only its viewport (~innerH rows); the O(N-total) cost is');
log('  the getItems sort + the denom/label-width reduce scans. Fine while each stays');
log('  a small fraction of the 50ms frame budget at realistic (tens–hundreds) counts.');
