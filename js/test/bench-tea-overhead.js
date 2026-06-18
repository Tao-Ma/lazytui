/**
 * Perf check for v0.6.3 TEA-discipline arc.
 *
 * The TEA cleanup moved some compute from inside leaves (reducer arms
 * calling getModel) to inside dispatchers (precomputing facts and
 * threading via Msg). Total work is the same; this bench measures the
 * absolute cost of the per-dispatch / per-render computations the arc
 * relies on, so we can spot any pathological regression.
 *
 * Sites measured:
 *   1. pt.modelBundle(model, groupName) — called once per dispatch
 *      of viewer_add_* / viewer_remove_* / viewer_update_*. Hot when
 *      streaming text into a content tab (updateContentTabLines per
 *      frame).
 *   2. pt.resolveTabKey(idx, slice, model) — called once per tab_switch
 *      dispatch (chain handler / mouse / Cmd cascade).
 *   3. mpool.paneSelectItems(arrange, null) — called PER RENDER in
 *      renderNormal / renderHalf / renderFull to drive the
 *      hide-when-nothing-to-swap [≡] gate.
 *   4. pt.flatTabInfo(slice, model, group) — called inside
 *      _cycleViewerTab (root reducer) per `]`/`[` keystroke.
 *
 * Run: node js/test/bench-tea-overhead.js
 */
'use strict';

const api = require('../panel/api');
require('../dispatch/runtime/effects').installBuiltins();
api.registerComponent(require('../panel/layout'));
api.registerComponent(require('../panel/viewer/viewer'));

const { setModel } = require('../app/runtime');
const pt = require('../leaves/wm/pane-tabs');
const mpool = require('../leaves/wm/pool');

// Realistic medium-sized model: 6 panes (postgres-demo shape) + a
// group with 8 actions (3 tabbed), 2 YAML terminals.
setModel({
  currentGroup: 'pg',
  modes: {},
  config: {
    groups: {
      pg: {
        actions: {
          build:    { label: 'Build', script: 'b', tab: 'Build' },
          test:     { label: 'Test',  script: 't', tab: 'Test' },
          initdb:   { label: 'initdb', script: 'i' },
          'pg-start': { label: 'Start', script: 's', tab: 'Start' },
          'pg-stop':  { label: 'Stop',  script: 's' },
          psql:     { label: 'psql',  script: 'p' },
          'pg-log': { label: 'Log',   script: 'l' },
          'reset':  { label: 'Reset', script: 'r' },
        },
        terminals: {
          shell: { cmd: 'bash', label: 'Shell' },
          repl:  { cmd: 'psql', label: 'REPL' },
        },
      },
    },
  },
});

const arrange = {
  columns: [
    { width: 32, panels: [
      { type: 'containers', id: 'containers', paneId: 'pane-containers', tabs: [{ id: 'containers', poolId: 'containers' }] },
      { type: 'groups',     id: 'groups',     paneId: 'pane-groups',     tabs: [{ id: 'groups', poolId: 'groups' }] },
      { type: 'files',      id: 'files',      paneId: 'pane-files',      tabs: [{ id: 'files', poolId: 'files' }] },
    ] },
    { panels: [
      { type: 'actions', id: 'actions', paneId: 'pane-actions', tabs: [{ id: 'actions', poolId: 'actions' }] },
      { type: 'stats',   id: 'stats',   paneId: 'pane-stats',   tabs: [{ id: 'stats', poolId: 'stats' }] },
      { type: 'detail',  id: 'detail',  paneId: 'pane-detail',  tabs: [{ id: 'detail', poolId: 'detail' }] },
    ] },
  ],
  pool: {
    containers: { id: 'containers', type: 'containers' },
    groups:     { id: 'groups',     type: 'groups' },
    files:      { id: 'files',      type: 'files' },
    actions:    { id: 'actions',    type: 'actions' },
    stats:      { id: 'stats',      type: 'stats' },
    detail:     { id: 'detail',     type: 'detail' },
  },
};

const detailSlice = {
  lines: [], tab: 0,
  ephemeralTerminals: {},
  contentTabs: {},
};

function bench(label, n, fn) {
  // Warmup pass for V8.
  fn(Math.min(1000, n));
  const start = process.hrtime.bigint();
  fn(n);
  const ns = Number(process.hrtime.bigint() - start);
  const us = (ns / 1000).toFixed(1);
  const opsPerSec = Math.round((n * 1e9) / ns).toLocaleString();
  const usPerOp = (ns / 1000 / n).toFixed(3);
  console.log(`  ${label.padEnd(38)} ${n.toLocaleString().padStart(10)} ops  ${us}µs  →  ${opsPerSec} ops/sec  (${usPerOp}µs/op)`);
}

console.log('=== v0.6.3 TEA-overhead bench (postgres-demo-shape, 6 panes, 8 actions) ===');

const { getModel } = require('../app/runtime');
const model = getModel();

console.log('\n[1] pt.modelBundle (per viewer_add/remove/update dispatch)');
bench('modelBundle(model, "pg")', 100_000, (n) => {
  let acc = 0;
  for (let i = 0; i < n; i++) acc += pt.modelBundle(model, 'pg').actionCount;
  if (acc < 0) console.log(acc);  // prevent dead-code elim
});

console.log('\n[2] pt.resolveTabKey (per tab_switch dispatch)');
bench('resolveTabKey(2, slice, model)', 100_000, (n) => {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const k = pt.resolveTabKey(2, detailSlice, model);
    if (k) acc++;
  }
  if (acc < 0) console.log(acc);
});

console.log('\n[3] mpool.paneSelectItems (PER RENDER — hot path)');
bench('paneSelectItems(arrange, null)', 100_000, (n) => {
  let acc = 0;
  for (let i = 0; i < n; i++) acc += mpool.paneSelectItems(arrange, null).length;
  if (acc < 0) console.log(acc);
});

console.log('\n[4] pt.flatTabInfo (per ]/[ keystroke via _cycleViewerTab)');
bench('flatTabInfo(slice, model, "pg")', 100_000, (n) => {
  let acc = 0;
  for (let i = 0; i < n; i++) acc += pt.flatTabInfo(detailSlice, model, 'pg').total;
  if (acc < 0) console.log(acc);
});

// --- Stress: large config to spot pathological scaling ---

console.log('\n=== Stress: 50-pane arrange, 100-action group ===');

const stressActions = {};
for (let i = 0; i < 100; i++) {
  stressActions[`a${i}`] = { label: `A${i}`, script: 'x', tab: (i % 4 === 0) ? `A${i}` : undefined };
}
setModel({
  currentGroup: 'big',
  modes: {},
  config: { groups: { big: { actions: stressActions, terminals: {} } } },
});
const stressModel = getModel();

const stressArrange = { columns: [], pool: {} };
const colCount = 5;
const perCol = 10;
for (let ci = 0; ci < colCount; ci++) {
  const panels = [];
  for (let pi = 0; pi < perCol; pi++) {
    const id = `pane-${ci}-${pi}`;
    panels.push({ type: id, id, paneId: `p-${id}`, tabs: [{ id, poolId: id }] });
    stressArrange.pool[id] = { id, type: id };
  }
  stressArrange.columns.push({ width: 20, panels });
}
// Ensure detail is in the last column for invariants.
stressArrange.columns[colCount - 1].panels.push({
  type: 'detail', id: 'detail', paneId: 'pane-detail', tabs: [{ id: 'detail', poolId: 'detail' }],
});
stressArrange.pool.detail = { id: 'detail', type: 'detail' };

bench('modelBundle (100 actions, 50 panes)', 50_000, (n) => {
  for (let i = 0; i < n; i++) pt.modelBundle(stressModel, 'big');
});

bench('paneSelectItems (50 panes)', 50_000, (n) => {
  let acc = 0;
  for (let i = 0; i < n; i++) acc += mpool.paneSelectItems(stressArrange, null).length;
  if (acc < 0) console.log(acc);
});

bench('flatTabInfo (100 actions)', 50_000, (n) => {
  let acc = 0;
  for (let i = 0; i < n; i++) acc += pt.flatTabInfo(detailSlice, stressModel, 'big').total;
  if (acc < 0) console.log(acc);
});

console.log('\nDone.');
