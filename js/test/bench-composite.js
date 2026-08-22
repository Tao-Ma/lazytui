/**
 * Composite (btop-density box) render bench — the Tier-2 additions:
 *   - a DISPLAY-only composite (graph + bars widget bodies stacked in one border);
 *   - an OVERLAY graph widget (`rasterizeBrailleMulti` — N series in one braille
 *     grid, the new leaf);
 *   - an INTERACTIVE composite (a `bars` widget with a live row cursor threaded in
 *     via getSel/getScroll when the box is focused).
 * Plus a micro-bench isolating `rasterizeBrailleMulti` vs single-series
 * `rasterizeBraille`, since the overlay leaf is the only genuinely new hot code.
 *
 * These paths did not exist before v0.6.23's Tier-2 arc, so the frame is
 * absolute-vs-budget (render is ≤20fps → ~50ms/frame), not before/after. The
 * before/after regression check for the SHARED gauge/stats paths is
 * bench-metrics-panels.js run against v0.6.23 in the same fs.
 *
 * Run: node js/test/bench-composite.js
 */
'use strict';

require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getModel } = require('../app/runtime');
const rq = require('../leaves/infra/render-queue');
const nav = require('../panel/nav-state');
const mpool = require('../leaves/wm/pool');
const panelApi = require('../panel/api');
const sg = require('../panel/monitor/stats-graph');
for (const c of ['stats', 'gauge', 'composite']) {
  if (!panelApi.getComponent(c)) panelApi.registerComponent(require('../panel/monitor/' + c));
}

const _out = process.stdout.write.bind(process.stdout);
function log(s) { _out(s + '\n'); }
// Time fn with stdout SILENCED (sm.render writes a full frame per call — else the
// bench emits ~100MB of escapes). Same shape as bench-metrics-panels.js.
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
const NAMES = ['postgres', 'node', 'redis', 'awk', 'bash', 'vim', 'tmux', 'sshd', 'python', 'ruby'];
// Each row carries `hist` samples so a `graph`/`aggregate` widget has a real
// series to rasterize (not a single point), while `bars` shows the latest per row.
function seed(topic, nRows, hist) {
  const series = {};
  for (let i = 0; i < nRows; i++) {
    const arr = new Array(hist);
    for (let h = 0; h < hist; h++) arr[h] = { cpu: (i * 37 + h * 7) % 100, mem: (i * 13 + h * 11) % 100, comm: NAMES[i % NAMES.length] + i };
    series['p' + i] = arr;
  }
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series, schema: { columns: SCHEMA } } };
}

function bootComposite(widgets) {
  const paneCfg = { id: 'p', type: 'composite', title: 'P', config: { widgets } };
  sm.bootFresh({
    groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
    layout: { pool: { p: paneCfg }, columns: [{ panels: [paneCfg] }] },
  });
  sm.resize(120, 48);
  return mpool.allPanesInColumns(panelApi.getInstanceSlice('layout').arrange).find((p) => p.type === 'composite').paneId;
}

function frame(o) {
  const pct = (o.usPer / 1000 / 50 * 100);
  return `${o.usPer.toFixed(1)}µs/frame  (${o.ops.toLocaleString()} fps-equiv, ${pct.toFixed(1)}% of the 50ms budget)`;
}

log('Composite render bench — Tier-2 boxes (render budget ~50ms/frame @ ≤20fps)\n');

const ROWS = [8, 40, 200];   // a btop box is compact — realistic → stress row counts
const HIST = 40;

log('[composite:display] graph(aggregate) + bars(N rows) — full render(model) per frame');
for (const n of ROWS) {
  bootComposite([
    { type: 'graph', topic: 't', aggregate: 'avg', metrics: ['cpu'], height: '50%' },
    { type: 'bars',  topic: 't', column: 'cpu', label: 'comm' },
  ]);
  seed('t', n, HIST);
  const iters = n >= 200 ? 800 : 3000;
  const o = timeOps(() => { rq.forceFullRepaint(); sm.render(); }, iters);
  log(`  n=${String(n).padStart(4)}  ${frame(o)}`);
}

log('\n[composite:overlay] graph(aggregate, overlay: cpu+mem) + bars(N rows) — full render/frame');
for (const n of ROWS) {
  bootComposite([
    { type: 'graph', topic: 't', aggregate: 'avg', metrics: ['cpu', 'mem'], overlay: true, height: '50%' },
    { type: 'bars',  topic: 't', column: 'cpu', label: 'comm' },
  ]);
  seed('t', n, HIST);
  const iters = n >= 200 ? 800 : 3000;
  const o = timeOps(() => { rq.forceFullRepaint(); sm.render(); }, iters);
  log(`  n=${String(n).padStart(4)}  ${frame(o)}`);
}

log('\n[composite:interactive] graph + bars(interactive, focused, cursor mid-list) — full render/frame');
for (const n of ROWS) {
  const paneId = bootComposite([
    { type: 'graph', topic: 't', aggregate: 'avg', metrics: ['cpu'], height: '50%' },
    { type: 'bars',  topic: 't', column: 'cpu', label: 'comm', interactive: true },
  ]);
  seed('t', n, HIST);
  nav.setSel(paneId, Math.floor(n / 2));                        // cursor mid-list (exercise highlight)
  panelApi.getInstanceSlice('layout').focus = paneId;          // focused → cursor threaded + drawn
  const iters = n >= 200 ? 800 : 3000;
  const o = timeOps(() => { rq.forceFullRepaint(); sm.render(); }, iters);
  log(`  n=${String(n).padStart(4)}  ${frame(o)}`);
}

log('\n[micro] rasterizeBrailleMulti vs rasterizeBraille — the overlay leaf in isolation');
{
  const W = 60, H = 8, HS = W * 2;                              // a box graph body ≈ 60×8 cells
  const mk = (seed0) => { const a = new Array(HS); for (let i = 0; i < HS; i++) a[i] = (i * 7 + seed0 * 13) % 100; return a; };
  const single = mk(0);
  for (const k of [1, 2, 4]) {
    const seriesArr = Array.from({ length: k }, (_, s) => mk(s));
    const iters = 50000;
    const o = timeOps(() => sg.rasterizeBrailleMulti(seriesArr, { width: W, height: H, min: 0, max: 100 }), iters);
    log(`  multi k=${k}  ${o.usPer.toFixed(2)}µs/call`);
  }
  const ob = timeOps(() => sg.rasterizeBraille(single, { width: W, height: H, min: 0, max: 100 }), 50000);
  log(`  single    ${ob.usPer.toFixed(2)}µs/call  (reference — the non-overlay path)`);
}

log('\n--- read ---');
log('  A composite renders only its viewport (box innerH rows). Overlay adds one');
log('  rasterizeBrailleMulti pass (ORs k series into one grid) + per-cell owner');
log('  colouring; interactive adds getSel/getScroll + the cursor highlight — all');
log('  fine while each frame stays a small fraction of the 50ms budget.');
