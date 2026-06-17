/**
 * Adversarial perf check for the resolveTarget / resolveViewerPaneId memo
 * (route.js, v0.6.5). The memo collapses the steady state (streamed
 * appends: focus/arrange/instances all stable) to a few primitive
 * compares. This bench checks the OTHER side: a workload that invalidates
 * the memo on EVERY call, so the memo never pays off and its machinery
 * (key build + the per-miss `_rtMemo = {...}` allocation) is pure
 * overhead on top of the recompute.
 *
 * The question: does the memo make the worst case WORSE than no memo at
 * all? Run this file at the memo commit and at its parent (pre-memo) and
 * compare the MISS rows — if they're within noise, the memo is free even
 * when it never hits.
 *
 * Miss lever: resolveTarget(intent, ctx) keys partly on ctx.focusedTabId.
 * Alternating that string between two NON-viewer ids forces, every call:
 *   - a memo miss (focused changed),
 *   - the full tier 1→4 walk (tier 1 fails on a non-viewer focus; tier 3
 *     walks the arrange; tier 4 finds the 'detail' instance),
 *   - tier 3's short-lived array alloc (mpool.lastColumnPanels) + the
 *     resolveViewerPaneId predicate-closure alloc — the GC churn the memo
 *     exists to avoid.
 * No slice is mutated, so this isolates the memo cost from write cost.
 *
 * Run: node js/test/bench-route-memo.js
 */
'use strict';

const api = require('../panel/api');
const route = require('../panel/route');
require('../dispatch/runtime/effects').installBuiltins();
api.registerComponent(require('../panel/layout'));
api.registerComponent(require('../panel/viewer/viewer'));

// Mute terminal writes so timing isn't polluted.
const term = require('../io/term');
const _w = term.stdout.write.bind(term.stdout);
term.stdout.write = (c, ...r) => { const s = typeof c === 'string' ? c : ''; if (s.startsWith('\x1b')) return true; return _w(c, ...r); };

// Pre-built ctx objects hoisted OUT of the loop, so we measure the memo's
// behavior — not per-call ctx allocation. HIT reuses one; MISS alternates.
const ctxHit = { focusedTabId: 'navA' };
const ctxA = { focusedTabId: 'navA' };
const ctxB = { focusedTabId: 'navB' }; // both non-viewer → tier 1 misses, full walk

function bench(label, n, fn) {
  fn(Math.min(2000, n));               // warm
  const t = process.hrtime.bigint();
  fn(n);
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`  ${label.padEnd(42)} ${n.toLocaleString()} ops  ${ms.toFixed(1)}ms  →  ${Math.round(n / ms * 1000).toLocaleString()} ops/sec  (${(ms * 1000 / n).toFixed(4)}µs/op)`);
}

console.log('\n=== resolveTarget / resolveViewerPaneId memo bench ===');
console.log('Sanity:', JSON.stringify({
  target_navA: route.resolveTarget('viewer', ctxA),     // expect 'detail' (tier 4)
  paneId: route.resolveViewerPaneId(ctxA),               // expect null (no hosting pane)
}));

const N = 100_000;

console.log('\n[1] resolveTarget — memo HIT (steady, same focus)');
bench('resolveTarget HIT', N, (n) => { for (let i = 0; i < n; i++) route.resolveTarget('viewer', ctxHit); });

console.log('\n[2] resolveTarget — memo MISS (focus flips every call)');
bench('resolveTarget MISS', N, (n) => { for (let i = 0; i < n; i++) route.resolveTarget('viewer', (i & 1) ? ctxA : ctxB); });

console.log('\n[3] resolveViewerPaneId — memo HIT (steady)');
bench('resolveViewerPaneId HIT', N, (n) => { for (let i = 0; i < n; i++) route.resolveViewerPaneId(ctxHit); });

console.log('\n[4] resolveViewerPaneId — memo MISS (focus flips every call)');
bench('resolveViewerPaneId MISS', N, (n) => { for (let i = 0; i < n; i++) route.resolveViewerPaneId((i & 1) ? ctxA : ctxB); });

console.log('\n--- Interpretation ---');
console.log('HIT  = best case (memo lands): expect tens of M ops/sec.');
console.log('MISS = worst case (memo never lands): equals recompute + memo machinery.');
console.log('Compare MISS at this commit vs the pre-memo parent — within noise = the');
console.log('memo is free even when it never hits; markedly slower = a churn regression.');
