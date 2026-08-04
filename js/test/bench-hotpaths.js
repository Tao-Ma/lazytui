/**
 * Hot-path perf benchmark — the streaming-append + selection-drag paths.
 *
 *   1. Streamed action / log output. U2f — the viewer's `viewer_append` (into a
 *      per-tab `viewerStreamBuffer`) is GONE; a `text-view` instance now owns its
 *      content directly on `slice.lines`, and streamed output arrives as
 *      `tv_append` (one line) / `tv_append_lines` (a batch). Each `tv_append`
 *      concats `slice.lines.concat([line])` — a fresh array per Msg. The worst
 *      real-world case is `docker logs -f` on a chatty service: ~500-1000
 *      lines/sec sustained, with bursts higher.
 *
 *   2. `select_extend` during mouse drag. Mouse motion events fire at the
 *      terminal's rate (typically 60Hz, 100Hz on some terms). Each one spreads
 *      `{ ...slice, select: { ...slice.select, cursor } }`. Post-U2f this flows
 *      through the SHARED tvu reducer on the text-view's own slice (the same
 *      transform the viewer used) — see leaves/text/text-view-update.
 *
 * Both are Msgs through the dispatch graph (dispatchMsg → Component.update →
 * setSlice). We measure end-to-end throughput including the finalizer so the
 * numbers reflect what the user sees.
 *
 * U2f target instance: the content slot's seeded Transcript tab is a real
 * `text-view` instance, so we bench straight against it (no mint needed).
 *
 * Run: node js/test/bench-hotpaths.js
 */
'use strict';

const api = require('../panel/api');
const { getInstanceSlice } = api;
// B/S6 — the Component fan-out relocated to dispatch/runtime/loop.js; wire the
// injected hosts like production boot so dispatchMsg + the finalizer resolve.
const fanout = require('../dispatch/runtime/loop');
require('../dispatch/runtime/host-wiring').wirePanelHost();
require('../panel/nav-state').setNavDispatch(require('../dispatch/runtime/effects').effectHost());

require('../dispatch/runtime/effects').installBuiltins();
api.registerComponent(require('../panel/layout'));
// U2f — the content slot's default tabs are `info` (Info) + `text-view`
// (Transcript); register both so initState's reconcile mints the slot's tabs
// (the former `detail`/viewer Component is gone). We stream into the Transcript
// text-view instance.
api.registerComponent(require('../panel/info/info'));
api.registerComponent(require('../panel/text-view/text-view'));

// Mute the OSC52 / render scheduling side-channels so timing isn't
// polluted by terminal writes. (Filter OSC52 only — keep stdout
// otherwise functional so our own console.log still prints.)
const term = require('../io/term');
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;') || s.startsWith('\x1b[')) return true;
  return _origWrite(chunk, ...rest);
};
try { require('../leaves/infra/render-queue').scheduleRender = () => {}; } catch (_) {}

// Boot a seeded model with a placed content slot; rebuildLayoutFromConfig seeds
// its Info(active) + Transcript tabs. The Transcript tab is a `text-view`
// instance keyed `newPaneId('transcript-<slotPaneId>')`.
const route = require('../panel/route');
const mpane = require('../leaves/wm/pane');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
process.stdout.columns = 100;
process.stdout.rows = 40;
getModel().config = { project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
  groups: { g: { name: 'g', label: 'g', containers: [], actions: {},
    children: [], parent: null, depth: 0, quick: false } } };
getModel().projectDir = '.';
getModel().currentGroup = 'g';
initState();

const slotPaneId = route.resolveViewerPaneId();          // 'pane-detail'
const TV = mpane.newPaneId('transcript-' + slotPaneId);  // Transcript text-view instance id
const INFO = route.resolveTarget('viewer_info');          // Info instance id
if (!route.hasInstance(TV)) throw new Error('bench setup: Transcript text-view instance not minted');
if (!route.hasInstance(INFO)) throw new Error('bench setup: Info instance not minted');

// This bench isolates the streaming/selection TRANSFORM cost (per-Msg reducer +
// dispatch plumbing), the same thing the pre-U2f bench measured — that one never
// booted a layout, so its post-dispatch finalizer early-returned. Post-U2f we
// MUST boot a placed slot (to have a real text-view instance), which arms the
// finalizer's two injected reconcilers. The SUBSCRIPTION reconciler in particular
// runs UNGATED per outermost dispatch and costs ~350µs/op in steady state
// (dominated by _appSubscriptions → visibleTerminalSurfaces, ~135µs), which
// swamps the ~4µs transform signal and pins every case to a flat ~2.8k ops/sec.
// (That fixed per-dispatch overhead is a real production cost — reported to the
// caller, NOT a bench artifact.) Unwire both reconcilers here so the bench
// measures the transform, not the fixed finalizer floor; the arrange is stable
// through the append loops anyway, so the instance-reconcile would no-op.
const finalize = require('../dispatch/runtime/finalize');
finalize.setSubscriptionReconciler(null);
finalize.setInstanceReconciler(null);

// text-view owns its scroll; seed a realistic viewport (38 = panelH 40 minus the
// 2-row border chrome) so tv_append's bottom-stick math clamps correctly even
// though the bench doesn't run a full render to stamp innerH via augmentMsg.
const tvSlice = () => getInstanceSlice(TV);
route.setInstanceSlice(TV, { ...tvSlice(), innerH: 38 });
// Helper — the text-view's buffer IS slice.lines (no separate stream buffer).
const bufLen = () => (tvSlice().lines || []).length;

function bench(label, n, fn) {
  // One warmup pass so V8 has a chance to inline / optimize.
  fn(Math.min(100, n));
  const start = process.hrtime.bigint();
  fn(n);
  const ns = Number(process.hrtime.bigint() - start);
  const ms = ns / 1e6;
  const opsPerSec = Math.round((n / ms) * 1000);
  console.log(`  ${label.padEnd(40)}  ${n.toLocaleString()} ops  ${ms.toFixed(2)}ms  →  ${opsPerSec.toLocaleString()} ops/sec`);
}

console.log('\n=== hot-path benchmark (U2f: text-view streaming + selection) ===');
console.log('Each Msg goes through the full dispatch graph (dispatchMsg → Component.update → setSlice).\n');

// --- tv_append ---
console.log('[1] tv_append (streamed lines, bottom-stick scroll — from empty)');
route.setInstanceSlice(TV, { ...tvSlice(), lines: [], scroll: 0, innerH: 38 });
bench('append from empty', 10_000, (n) => {
  for (let i = 0; i < n; i++) {
    fanout.dispatchMsg(api.wrap(TV, { type: 'tv_append', line: `line ${i}` }));
  }
});
console.log(`  final buffer length: ${bufLen()}`);

// Steady-state (large pre-existing buffer): tv_append concats slice.lines, so the
// per-append copy cost scales with buffer length.
console.log('\n[2] tv_append (buffer already 10k lines — concat cost scales with length)');
bench('append to 10k buffer', 10_000, (n) => {
  for (let i = 0; i < n; i++) {
    fanout.dispatchMsg(api.wrap(TV, { type: 'tv_append', line: `line ${i}` }));
  }
});
console.log(`  final buffer length: ${bufLen()}`);

console.log('\n[2b] tv_append (buffer 50k lines — long-running stream)');
// Build up to 50k without timing the warmup.
while (bufLen() < 50_000) {
  fanout.dispatchMsg(api.wrap(TV, { type: 'tv_append', line: 'x' }));
}
bench('append to 50k buffer', 5_000, (n) => {
  for (let i = 0; i < n; i++) {
    fanout.dispatchMsg(api.wrap(TV, { type: 'tv_append', line: `line ${i}` }));
  }
});
console.log(`  final buffer length: ${bufLen()}`);

// --- select_extend ---
console.log('\n[3] select_extend (mouse drag, ~60Hz target = 60 ops/sec minimum)');
// Seed with a select_begin so slice.select.active is true and select_extend hits.
fanout.dispatchMsg(api.wrap(TV, { type: 'select_begin', line: 0, col: 0, kind: 'char' }));
bench('extend through 10k positions', 10_000, (n) => {
  for (let i = 0; i < n; i++) {
    fanout.dispatchMsg(api.wrap(TV, { type: 'select_extend', line: i % 100, col: i % 50 }));
  }
});

// --- tv_append_lines bulk variant ---
//
// Stream-end footers, preempt notices, decoder-tail flushes dispatch
// tv_append_lines (bulk) instead of N × tv_append. One Msg per batch = one
// finalizer pass per batch, and one concat of N lines rather than N concats.
console.log('\n[4] tv_append_lines bulk (one Msg per N-line batch)');
route.setInstanceSlice(TV, { ...tvSlice(), lines: [], scroll: 0, innerH: 38 });
const _batch10 = () => Array.from({ length: 10 }, (_, i) => `b${i}`);
bench('append_lines x1000 (10 lines/batch)', 1_000, (n) => {
  const lines = _batch10();
  for (let i = 0; i < n; i++) {
    fanout.dispatchMsg(api.wrap(TV, { type: 'tv_append_lines', lines }));
  }
});
console.log(`  final buffer length: ${bufLen()}`);

// --- info_show_content (Info body swap on nav-select) ---
//
// The Info tab's content is REPLACED wholesale each time the focused Navigator's
// selection changes (dispatch.showSelectedInfo → info_show_content). Redraw fires
// this on every nav-select, so it sits on the navigator-cursor hot path. The arm
// scans for content-equality (ref-stable slice on no-change) then replaces.
console.log('\n[5] info_show_content (Info body swap on nav-select — alternating content)');
const _infoA = Array.from({ length: 40 }, (_, i) => `A line ${i}`);
const _infoB = Array.from({ length: 40 }, (_, i) => `B line ${i}`);
bench('show_content x100k (alternating)', 100_000, (n) => {
  for (let i = 0; i < n; i++) {
    fanout.dispatchMsg(api.wrap(INFO, { type: 'info_show_content', lines: (i & 1) ? _infoA : _infoB }));
  }
});
console.log(`  final Info buffer length: ${(getInstanceSlice(INFO).lines || []).length}`);

// --- per-Msg dispatch/reducer floor ---
//
// What does the dispatch + Component.update plumbing cost per Msg when the reducer
// arm itself does minimal work? Useful baseline for any future arm. Note: the
// heavy per-dispatch FINALIZER reconcilers were unwired at boot (see setup), so
// this is the transform plumbing floor, NOT production's full per-dispatch cost
// (which additionally pays the ~350µs subscription reconcile — see the report).
// viewer_search_clear_committed (owned by the shared tvu reducer) returns a fresh
// slice with an empty search struct (no buffer scan, no lines change) — closest
// synthetic for "single dispatch + minimal reducer alloc."
console.log('\n[6] per-Msg dispatch/reducer floor (viewer_search_clear_committed per Msg)');
bench('search_clear x100k', 100_000, (n) => {
  for (let i = 0; i < n; i++) {
    fanout.dispatchMsg(api.wrap(TV, { type: 'viewer_search_clear_committed' }));
  }
});

// --- richToAnsi (truecolor arc 1a — the tag parser + memo) ---------------
// Guards the parser rewrite: richToAnsi runs per visible row per frame and
// twice per diffed row. Frozen table-lookup baseline: 0.90 µs/row on the
// 4-named-tag row (2026-08-03, docs/truecolor.md §Bench); parser+memo
// landed at 0.83. Hex tags must stay in the same ballpark as named.
{
  const { richToAnsi } = require('../leaves/text/ansi');
  const namedRow = '[yellow]item[/]  [dim]2026-08-03[/]  [green]running[/]  [bold cyan]42%[/]' + ' pad'.repeat(8);
  const hexRow = '[#e6db74]item[/]  [dim]2026-08-03[/]  [#a6e22e]running[/]  [bold #66d9ef]42%[/]' + ' pad'.repeat(8);
  console.log('\n[7] richToAnsi (tag parser + memo; per visible row per frame)');
  bench('richToAnsi 4 named tags', 200_000, (n) => {
    for (let i = 0; i < n; i++) richToAnsi(namedRow);
  });
  bench('richToAnsi 4 hex/mixed tags', 200_000, (n) => {
    for (let i = 0; i < n; i++) richToAnsi(hexRow);
  });
}

// --- downgradeAnsi (truecolor arc 1b — the write-boundary depth funnel) --
// Only 256/16 devices pay this; truecolor is an identity fast-path. The
// input models a diff-emit chunk: MoveTos + mixed truecolor SGR + glyphs.
{
  const { downgradeAnsi } = require('../leaves/render/color-depth');
  let chunk = '';
  for (let i = 0; i < 40; i++) {
    chunk += `\x1b[${i + 1};10H\x1b[0m\x1b[38;2;${40 + i * 5};${240 - i * 4};96;48;2;40;42;54m graph-cell-${i} `;
  }
  console.log('\n[8] downgradeAnsi (write-boundary; per emitted frame chunk, ~2.6KB)');
  bench('downgrade at 16', 20_000, (n) => {
    for (let i = 0; i < n; i++) downgradeAnsi(chunk, '16');
  });
  bench('downgrade at 256', 20_000, (n) => {
    for (let i = 0; i < n; i++) downgradeAnsi(chunk, '256');
  });
  bench('truecolor identity fast-path', 200_000, (n) => {
    for (let i = 0; i < n; i++) downgradeAnsi(chunk, 'truecolor');
  });
}

console.log('\n--- Interpretation ---');
console.log('tv_append target: docker logs -f sustains ~1k lines/sec; bursts to ~5k.');
console.log('select_extend target: 60Hz mouse drag = 60 ops/sec; 100Hz = 100 ops/sec.');
console.log('append_lines bulk: one finalizer pass per N lines — per-line cost should beat singular tv_append.');
console.log('info_show_content: fires per nav-select; content-equality guard keeps no-change refreshes cheap.');
console.log('dispatch/reducer floor: transform plumbing per Msg (finalizer reconcilers unwired for this bench).\n');
