/**
 * Perf-parity check (release gate) for the border-control facility.
 *
 * Measures the per-frame + per-interaction costs the docker item-action bar /
 * sort selector add to the render path, so a regression shows up as a bench
 * number rather than a laggy TUI. Render is 50ms-debounced (≤20fps; ~50ms/frame
 * budget) — each site prints its share of that budget. Scaled by container count
 * because the sort is O(n log n).
 *
 * Sites measured (per container count n):
 *   1. api.getItems('containers') UNSORTED — the default (sort.key = null). Must
 *      stay ~free: it returns the raw list ref (no filter, no sort, no alloc).
 *   2. api.getItems('containers') SORTED by cpu — the sort delta (decorate-index
 *      map → stable sort → extract, + a parsePercent per row). Opt-in: only paid
 *      once the user picks a column.
 *   3. api.borderControlsFor(focusedPane) — resolves the pane's control specs
 *      (refresh + sort + action-legend render). Runs per docker render AND, since
 *      the quick_keys=footer-fallback wiring, once per FRAME in the footer while a
 *      docker pane is focused — so it must be cheap + flat in n.
 *   4. the full docker render() per frame — the pre-existing row build plus the
 *      two above; the ceiling the arc rides on.
 *
 * Run: node js/test/bench-border-controls.js
 */
'use strict';

const api = require('../panel/api');
require('../dispatch/runtime/host-wiring').wirePanelHost();
require('../panel/nav-state').setNavDispatch(require('../dispatch/runtime/effects').effectHost());
require('../dispatch/runtime/effects').installBuiltins();
api.registerComponent(require('../panel/layout'));
const docker = require('../panel/navigator/docker');
api.registerComponent(docker);

const { getModel } = require('../model/store');
const mnav = require('../leaves/wm/nav');
const render = docker.panelTypes.containers.render;

const FRAME_US = 50000;   // 50ms debounce budget

function bench(label, n, fn) {
  fn(Math.min(2000, n));   // V8 warmup
  const start = process.hrtime.bigint();
  fn(n);
  const ns = Number(process.hrtime.bigint() - start);
  const usPerOp = ns / 1000 / n;
  const pct = (usPerOp / FRAME_US * 100).toFixed(4);
  console.log(`  ${label.padEnd(46)} ${usPerOp.toFixed(3).padStart(9)} µs/op   ${pct.padStart(8)}% of frame`);
}

// Bench-only: set the pane's committed sort directly (dispatchMsg needs the full
// runtime loop the bench doesn't boot). getItems reads this exact slice.
function setSort(key) {
  const s = api.sliceForPane('containers', 'docker');
  s.nav = s.nav || mnav.init();
  s.nav.sort = { key, dir: -1 };
}

console.log('=== border-controls bench (docker containers pane; ~50ms/frame budget) ===');

for (const n of [10, 100, 1000]) {
  const names = Array.from({ length: n }, (_, i) => `c${i}`);
  getModel().config = { groups: { g1: { containers: names } } };
  getModel().currentGroup = 'g1';
  getModel().modes = {};
  // Seed running status + varied cpu/mem so the sort comparator does real parse work.
  const svc = api.serviceSlice('docker');
  svc.status = {}; svc.stats = {};
  for (const nm of names) {
    svc.status[nm] = 'running';
    svc.stats[nm] = { cpu: `${(nm.length * 7) % 97}.5%`, mem: '12MiB / 1GiB' };
  }
  const pane = { paneId: 'containers', type: 'containers', focused: true, innerW: 58 };
  const panel = { paneId: 'containers', title: 'Containers', hotkey: '1' };
  let sink = 0;

  console.log(`\n[n=${n}]`);
  setSort(null);
  bench('getItems unsorted (default — must stay ~free)', 20000, (k) => { for (let i = 0; i < k; i++) sink += api.getItems('containers').length; });
  setSort('cpu');
  bench('getItems sorted by cpu (the sort delta, opt-in)', 20000, (k) => { for (let i = 0; i < k; i++) sink += api.getItems('containers').length; });
  bench('borderControlsFor (per docker + per footer frame)', 20000, (k) => { for (let i = 0; i < k; i++) sink += api.borderControlsFor(pane, getModel()).length; });
  bench('full docker render() per frame', 5000, (k) => { for (let i = 0; i < k; i++) sink += render(panel, 60, 20, null, { focused: true, chrome: { collapse: 'x' } }).length; });
  setSort(null);
  if (sink < 0) console.log(sink);   // defeat dead-code elimination
}

console.log('\nDecision: getItems-unsorted + borderControlsFor must stay flat + sub-frame-fraction');
console.log('(the always-paid per-frame costs); the sort is O(n log n) but opt-in and');
console.log('should stay well under the frame budget at any realistic container count.');
console.log('\nDone.');
