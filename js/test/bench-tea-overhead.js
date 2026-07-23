/**
 * Perf-parity check (release gate).
 *
 * Measures the absolute cost of the per-dispatch / per-render computations the
 * TEA architecture relies on, so a pathological regression shows up as a bench
 * number rather than a laggy TUI. Each case calls the pure reducer arm / render
 * helper directly (NOT through the full dispatch graph), isolating the transform
 * cost from the dispatch-loop + finalizer plumbing.
 *
 * U2f — the viewer/`detail` kind + its flat content-tab machinery are GONE, so
 * the cases that measured `pt.modelBundle` / `pt.resolveTabKey` / `pt.flatTabInfo`
 * (all deleted from leaves/wm/pane-tabs) were DROPPED. The surviving generic case
 * (`mpool.paneSelectItems`, per-render `[≡]`-gate driver) is kept, and the NEW
 * content hot paths that replaced the viewer's tab/append machinery are added:
 *
 * Sites measured:
 *   1. mpool.paneSelectItems(arrange, null) — called PER RENDER in
 *      renderNormal / renderHalf / renderFull to drive the hide-when-nothing-
 *      to-swap [≡] gate. (Unchanged by U2f; kept for parity continuity.)
 *   2. info.update(info_show_content) — the Info body swap, fired per nav-select
 *      (dispatch.showSelectedInfo). Replaced the viewer's `viewer_show_info` arm.
 *   3. text-view.update(tv_append / tv_append_lines) — the streamed-content
 *      append hot path (docker logs / action output). Replaced the viewer's
 *      `viewer_append` into viewerStreamBuffer.
 *   4. layout.update(set_active_tab) — position-tab switching in the content slot
 *      (the `][` cycle / tab click). Replaced the viewer's flat `tab_switch`.
 *
 * Run: node js/test/bench-tea-overhead.js
 */
'use strict';

const api = require('../panel/api');
require('../dispatch/runtime/host-wiring').wirePanelHost();
require('../panel/nav-state').setNavDispatch(require('../dispatch/runtime/effects').effectHost());
require('../dispatch/runtime/effects').installBuiltins();
api.registerComponent(require('../panel/layout'));
// U2f — the content slot's default tabs are `info` (Info) + `text-view`
// (Transcript); register both (the former `detail`/viewer Component is gone).
api.registerComponent(require('../panel/info/info'));
api.registerComponent(require('../panel/text-view/text-view'));

const mpool = require('../leaves/wm/pool');
const info = require('../panel/info/info');
const textView = require('../panel/text-view/text-view');
const layout = require('../panel/layout');

// Realistic medium-sized arrange: 6 panes (postgres-demo shape). The last-column
// detail slot carries role:'content' (the U2f content slot) + a 2-tab strip
// (Info active + Transcript), mirroring what rebuildLayoutFromConfig seeds.
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
      { type: 'detail',  id: 'detail',  paneId: 'pane-detail',  role: 'content',
        activeTabId: 'info-pane-detail',
        tabs: [{ id: 'info-pane-detail', poolId: 'info-pane-detail' },
               { id: 'transcript-pane-detail', poolId: 'transcript-pane-detail' }] },
    ] },
  ],
  pool: {
    containers: { id: 'containers', type: 'containers' },
    groups:     { id: 'groups',     type: 'groups' },
    files:      { id: 'files',      type: 'files' },
    actions:    { id: 'actions',    type: 'actions' },
    stats:      { id: 'stats',      type: 'stats' },
    detail:     { id: 'detail',     type: 'detail' },
    'info-pane-detail':       { id: 'info-pane-detail',       type: 'info' },
    'transcript-pane-detail': { id: 'transcript-pane-detail', type: 'text-view', hint: 'transcript' },
  },
};

// Content-instance fixtures — plain slices via each Component's init (the shape
// the reducer arms operate on).
const infoSlice = { ...info.init('pane-detail'), innerH: 38 };
const _infoA = Array.from({ length: 40 }, (_, i) => `A line ${i}`);
const _infoB = Array.from({ length: 40 }, (_, i) => `B line ${i}`);
const tvSlice = { ...textView.init('pane-detail'), innerH: 38 };

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

console.log('=== TEA-overhead bench (postgres-demo-shape, 6 panes + U2f content slot) ===');

console.log('\n[1] mpool.paneSelectItems (PER RENDER — hot path)');
bench('paneSelectItems(arrange, null)', 100_000, (n) => {
  let acc = 0;
  for (let i = 0; i < n; i++) acc += mpool.paneSelectItems(arrange, null).length;
  if (acc < 0) console.log(acc);  // prevent dead-code elim
});

console.log('\n[2] info.update info_show_content (per nav-select — Info body swap)');
bench('info_show_content (40-line swap)', 100_000, (n) => {
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const next = info.update({ type: 'info_show_content', lines: (i & 1) ? _infoA : _infoB }, infoSlice);
    acc += next.lines.length;
  }
  if (acc < 0) console.log(acc);
});

// Steady-state append at a REPRESENTATIVE bounded buffer size — a growing buffer
// would make tv_append O(n²) (each concat copies the whole array), which measures
// GC/copy scaling, not per-append cost. Reset the buffer once it passes CAP so we
// measure append against a ~1k-line window (the production ring size). The
// dedicated 50k-buffer case below covers the copy-cost-at-length scaling.
const _CAP = 1_000;
console.log('\n[3] text-view.update tv_append (streamed line, bottom-stick — ~1k buffer)');
bench('tv_append (~1k buffer)', 100_000, (n) => {
  let s = { ...textView.init('pane-detail'), innerH: 38 };
  for (let i = 0; i < n; i++) {
    if (s.lines.length > _CAP) s = { ...s, lines: s.lines.slice(-_CAP) };
    s = textView.update({ type: 'tv_append', line: `line ${i}` }, s);
  }
  if (s.lines.length < 0) console.log(s.lines.length);
});

console.log('\n[3b] text-view.update tv_append_lines (bulk — 10 lines/Msg, ~1k buffer)');
const _batch10 = Array.from({ length: 10 }, (_, i) => `b${i}`);
bench('tv_append_lines (10/Msg)', 50_000, (n) => {
  let s = { ...textView.init('pane-detail'), innerH: 38 };
  for (let i = 0; i < n; i++) {
    if (s.lines.length > _CAP) s = { ...s, lines: s.lines.slice(-_CAP) };
    s = textView.update({ type: 'tv_append_lines', lines: _batch10 }, s);
  }
  if (s.lines.length < 0) console.log(s.lines.length);
});

console.log('\n[4] layout.update set_active_tab (position-tab switch in the content slot)');
// set_active_tab is idempotent when the target is already active, so alternate
// between the slot's two seeded tabs to exercise a real switch each op. The arm
// pushes undo (freeConfig.undo, capped), re-splices the pane, and rebuilds the
// legacy-Panel mirror from the new active's pool entry (mpane.setActiveTab) — the
// switch cost we measure. Base slice from layout.init() so freeConfig/undo exist.
{
  const s0 = { ...layout.init(), arrange, focus: 'groups', dims: { cols: 100, rows: 40 } };
  bench('set_active_tab (alternating)', 100_000, (n) => {
    let s = s0;
    for (let i = 0; i < n; i++) {
      const tabPoolId = (i & 1) ? 'transcript-pane-detail' : 'info-pane-detail';
      const r = layout.update({ type: 'set_active_tab', paneId: 'pane-detail', tabPoolId }, s);
      s = Array.isArray(r) ? r[0] : r;
    }
    if (!s) console.log('!');
  });
}

// --- Stress: large arrange to spot pathological scaling ---

console.log('\n=== Stress: 50-pane arrange ===');

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
// Ensure a content slot is in the last column for invariants (isDetailPane keys
// on role:'content'). paneSelectItems excludes it, exactly as before.
stressArrange.columns[colCount - 1].panels.push({
  type: 'detail', id: 'detail', paneId: 'pane-detail', role: 'content',
  tabs: [{ id: 'detail', poolId: 'detail' }],
});
stressArrange.pool.detail = { id: 'detail', type: 'detail' };

bench('paneSelectItems (50 panes)', 50_000, (n) => {
  let acc = 0;
  for (let i = 0; i < n; i++) acc += mpool.paneSelectItems(stressArrange, null).length;
  if (acc < 0) console.log(acc);
});

console.log('\n[stress] tv_append against a 50k-line buffer (concat copy cost at length)');
{
  let big = { ...textView.init('pane-detail'), innerH: 38 };
  big = textView.update({ type: 'tv_append_lines', lines: Array.from({ length: 50_000 }, (_, i) => `x${i}`) }, big);
  // Measure ONE append against the fixed 50k buffer (reset each op) — the point is
  // the per-append concat copy cost at length, not O(n²) accumulation.
  bench('tv_append (50k buffer)', 20_000, (n) => {
    let last;
    for (let i = 0; i < n; i++) last = textView.update({ type: 'tv_append', line: 'y' }, big);
    if (last.lines.length < 0) console.log(last.lines.length);
  });
}

console.log('\nDone.');
