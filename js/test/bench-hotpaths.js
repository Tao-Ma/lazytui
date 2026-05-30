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
const { getComponentSlice } = api;

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

const detailSlice = getComponentSlice('detail');
detailSlice.lines = [];
// Seed innerH so viewer_append's bottom-stick math has a realistic
// viewport (38 = panelH 40 minus 2-row border chrome). A1/B1 fix: this
// lives on detail's own slice now, not cross-slice in layout.
detailSlice.innerH = 38;

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
detailSlice.lines = [];
bench('append from empty', 10_000, (n) => {
  for (let i = 0; i < n; i++) {
    api.dispatchMsg(api.wrap('detail', { type: 'viewer_append', line: `line ${i}` }));
  }
});
console.log(`  final lines.length: ${getComponentSlice('detail').lines.length}`);

// Reset and benchmark the steady-state (large pre-existing buffer).
console.log('\n[2] viewer_append (buffer already 10k lines — spread cost scales with length)');
bench('append to 10k buffer', 10_000, (n) => {
  for (let i = 0; i < n; i++) {
    api.dispatchMsg(api.wrap('detail', { type: 'viewer_append', line: `line ${i}` }));
  }
});
console.log(`  final lines.length: ${getComponentSlice('detail').lines.length}`);

console.log('\n[2b] viewer_append (buffer 50k lines — long-running stream)');
// Build up to 50k without timing the warmup.
while (getComponentSlice('detail').lines.length < 50_000) {
  api.dispatchMsg(api.wrap('detail', { type: 'viewer_append', line: 'x' }));
}
bench('append to 50k buffer', 5_000, (n) => {
  for (let i = 0; i < n; i++) {
    api.dispatchMsg(api.wrap('detail', { type: 'viewer_append', line: `line ${i}` }));
  }
});
console.log(`  final lines.length: ${getComponentSlice('detail').lines.length}`);

// --- select_extend ---
console.log('\n[3] select_extend (mouse drag, ~60Hz target = 60 ops/sec minimum)');
// Seed with a select_begin so isActive() returns true and select_extend hits.
api.dispatchMsg(api.wrap('detail', { type: 'select_begin', line: 0, col: 0, kind: 'char' }));
bench('extend through 10k positions', 10_000, (n) => {
  for (let i = 0; i < n; i++) {
    api.dispatchMsg(api.wrap('detail', { type: 'select_extend', line: i % 100, col: i % 50 }));
  }
});

console.log('\n--- Interpretation ---');
console.log('viewer_append target: docker logs -f sustains ~1k lines/sec; bursts to ~5k.');
console.log('select_extend target: 60Hz mouse drag = 60 ops/sec; 100Hz = 100 ops/sec.');
console.log('Pure-TEA spread cost grows linearly with buffer length for append; flat for select_extend.\n');
