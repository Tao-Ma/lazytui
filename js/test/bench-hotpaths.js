/**
 * Phase 6 perf benchmark — the two hot paths the pure-TEA arc flagged.
 *
 *   1. `viewer_append` under streamed action output. Each append
 *      spreads `[...slice.lines, line]` — fresh array per Msg. The
 *      worst real-world case is `docker logs -f` on a chatty service:
 *      ~500-1000 lines/sec sustained, with bursts higher.
 *
 *   2. `select_extend` during mouse drag. Mouse motion events fire at
 *      the terminal's rate (typically 60Hz, 100Hz on some terms). Each
 *      one spreads `{ ...slice, select: { ...slice.select, cursor } }`.
 *
 * Both are Msgs through the dispatch graph (applyMsg → runtime.update
 * for the model-level path, dispatchMsg → Component.update for the
 * slice-level path). We measure end-to-end throughput including
 * runEffects so the numbers reflect what the user sees.
 *
 * Run: node js/test/bench-hotpaths.js
 */
'use strict';

const api = require('../panel/api');
const runtime = require('../app/runtime');
const { getInstanceSlice } = api;

require('../dispatch/effects').installBuiltins();
api.registerComponent(require('../panel/layout'));
api.registerComponent(require('../panel/viewer/viewer'));

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
try { require('../render/render-queue').scheduleRender = () => {}; } catch (_) {}

const detailSlice = getInstanceSlice('detail');
detailSlice.lines = [];
// Seed innerH so viewer_append's bottom-stick math has a realistic
// viewport (38 = panelH 40 minus 2-row border chrome). A1/B1 fix: this
// lives on detail's own slice now, not cross-slice in layout.
detailSlice.innerH = 38;
// v0.6.2 — Transcript tab is the unrouted accumulator's display home;
// park the bench on it so we exercise the active-tab mirror path (the
// hot case streaming docker logs hits when the user is watching).
detailSlice.tab = 1;
// Helper — read the displayed buffer length (T2d: slice.lines is
// derived, the buffer is the source of truth).
const bufLen = () => (getInstanceSlice('detail').viewerStreamBuffer || { lines: [] }).lines.length;

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

console.log('\n=== Phase 6 hot-path benchmark ===');
console.log('Each Msg goes through the full dispatch graph (dispatchMsg → Component.update → setSlice).\n');

// --- viewer_append ---
console.log('[1] viewer_append (streamed lines, bottom-stick scroll)');
detailSlice.viewerStreamBuffer = { lines: [], cap: 1_000_000 };  // bench-cap; production cap is 1000
bench('append from empty', 10_000, (n) => {
  for (let i = 0; i < n; i++) {
    api.dispatchMsg(api.wrap('detail', { type: 'viewer_append', line: `line ${i}` }));
  }
});
console.log(`  final buffer length: ${bufLen()}`);

// Reset and benchmark the steady-state (large pre-existing buffer).
console.log('\n[2] viewer_append (buffer already 10k lines — spread cost scales with length)');
bench('append to 10k buffer', 10_000, (n) => {
  for (let i = 0; i < n; i++) {
    api.dispatchMsg(api.wrap('detail', { type: 'viewer_append', line: `line ${i}` }));
  }
});
console.log(`  final buffer length: ${bufLen()}`);

console.log('\n[2b] viewer_append (buffer 50k lines — long-running stream)');
// Build up to 50k without timing the warmup. v0.6.2 T2d — read buffer
// length directly (slice.lines is derived, not the source).
while (bufLen() < 50_000) {
  api.dispatchMsg(api.wrap('detail', { type: 'viewer_append', line: 'x' }));
}
bench('append to 50k buffer', 5_000, (n) => {
  for (let i = 0; i < n; i++) {
    api.dispatchMsg(api.wrap('detail', { type: 'viewer_append', line: `line ${i}` }));
  }
});
console.log(`  final buffer length: ${bufLen()}`);

// --- select_extend ---
console.log('\n[3] select_extend (mouse drag, ~60Hz target = 60 ops/sec minimum)');
// Seed with a select_begin so isActive() returns true and select_extend hits.
api.dispatchMsg(api.wrap('detail', { type: 'select_begin', line: 0, col: 0, kind: 'char' }));
bench('extend through 10k positions', 10_000, (n) => {
  for (let i = 0; i < n; i++) {
    api.dispatchMsg(api.wrap('detail', { type: 'select_extend', line: i % 100, col: i % 50 }));
  }
});

// --- viewer_append routed, off-active-tab ---
//
// Real-world scenario: user runs Build (action tab), then switches to
// Test to watch it. Build keeps streaming in the background — every
// append is routed (tabKey='build') but the active tab is Test, so the
// reducer's mirror branch doesn't fire. The buffer write + finalizer
// pass still run. Pre-T3f-fix this path bypassed tabState; post-
// T3f-fix the finalizer's transition-detect is a single ref check
// (no transition during the bench), so we measure the routed-append
// off-tab cost cleanly.
console.log('\n[4] viewer_append routed, off-active-tab (background streaming while user is elsewhere)');
// Set up a minimal group + actions so flatTabInfo recognizes two
// action tabs. Park the user on the first; route appends to the second.
const runtime_mod = require('../app/runtime');
const m = runtime_mod.getModel();
m.config = {
  groups: { g: { label: 'G', actions: {
    build: { label: 'Build', script: 'true', tab: true },
    test:  { label: 'Test',  script: 'true', tab: true },
  } } },
};
m.currentGroup = 'g';
// Tab strip is now: [Info][Transcript][Build=2][Test=3]. Park on Build.
detailSlice.tab = 2;
bench('routed off-tab append (10k)', 10_000, (n) => {
  for (let i = 0; i < n; i++) {
    api.dispatchMsg(api.wrap('detail', {
      type: 'viewer_append', line: `bg ${i}`,
      tabKey: 'test', groupName: 'g',  // routed to Test, but user is on Build
    }));
  }
});
const testBufLen = ((api.getInstanceSlice('detail').actionTabBuffers || {}).g || {}).test || { lines: [] };
console.log(`  final test buffer length: ${testBufLen.lines.length}`);

// --- viewer_append_lines bulk variant ---
//
// Stream-end footers, preempt notices, decoder-tail flushes dispatch
// viewer_append_lines (bulk) instead of N x viewer_append. One Msg per
// batch = one finalizer pass per batch. Producers in stream.js use
// this for the `Press Enter to run again.` + status footer pair.
console.log('\n[5] viewer_append_lines bulk (one Msg per N-line batch)');
detailSlice.tab = 1;  // back to Transcript so the unrouted mirror engages
api.getInstanceSlice('detail').viewerStreamBuffer = { lines: [], cap: 1_000_000 };
const _batch10 = () => Array.from({ length: 10 }, (_, i) => `b${i}`);
bench('append_lines x1000 (10 lines/batch)', 1_000, (n) => {
  const lines = _batch10();
  for (let i = 0; i < n; i++) {
    api.dispatchMsg(api.wrap('detail', { type: 'viewer_append_lines', lines }));
  }
});
console.log(`  final buffer length: ${bufLen()}`);

// --- pure finalizer cost (per-Msg overhead) ---
//
// What does the finalizer-+-update plumbing cost per Msg, when the
// reducer arm itself does minimal work? Useful baseline for any future
// finalizer addition. viewer_search_clear_committed always returns a
// fresh slice with an empty search struct (no buffer scan, no
// lines change) — closest synthetic for "single dispatch + finalizer
// + minimal reducer alloc."
console.log('\n[6] pure finalizer cost (viewer_search_clear_committed per Msg)');
api.getInstanceSlice('detail').viewerStreamBuffer = { lines: [], cap: 1_000_000 };
bench('search_clear x100k', 100_000, (n) => {
  for (let i = 0; i < n; i++) {
    api.dispatchMsg(api.wrap('detail', { type: 'viewer_search_clear_committed' }));
  }
});

console.log('\n--- Interpretation ---');
console.log('viewer_append target: docker logs -f sustains ~1k lines/sec; bursts to ~5k.');
console.log('select_extend target: 60Hz mouse drag = 60 ops/sec; 100Hz = 100 ops/sec.');
console.log('off-tab append target: same hot path as foreground; mirror branch skipped — should be ≥ on-tab throughput.');
console.log('append_lines bulk: one finalizer pass per N lines — per-line cost should beat singular viewer_append.');
console.log('finalizer cost: per-Msg overhead floor; ≫ 10k ops/sec means finalizer is not a bottleneck.\n');
