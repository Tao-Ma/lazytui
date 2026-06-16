/**
 * Demonstrates WHEN the route memo (resolveTarget / resolveViewerPaneId,
 * route.js v0.6.5) hits vs misses — the companion to bench-route-memo.js
 * (which measures the HIT/MISS *cost*; this one classifies which user
 * actions land in each bucket).
 *
 * Both functions cache the last single result keyed on
 *   (intent, focused, lastViewerTab, arrange-ref, _instVer)
 * A call HITS only if all five match the previous call. The point of the
 * key is that the high-frequency paths (streamed viewer_append, text-
 * selection drag, navigator cursor moves) touch NONE of those fields, so
 * they hit; the things that miss (focus change, layout edit, pane
 * open/close) are human-paced — a handful per second at most.
 *
 * Technique: isolate resolveTarget's per-call cost in a scenario by timing
 * (mutate + resolveTarget) and subtracting (mutate alone). The remainder is
 * ~0.05µs when that call HIT (a few primitive compares) and ~70µs when it
 * MISSED (full tier walk + the short-lived allocations the memo avoids).
 *
 * Run: node js/test/demo-route-memo.js
 */
'use strict';

const api = require('../panel/api');
const route = require('../panel/route');
const { setSel } = require('../app/state');
require('../dispatch/effects').installBuiltins();
api.registerComponent(require('../panel/layout'));
api.registerComponent(require('../panel/viewer/viewer'));

// Mute terminal writes so timing isn't polluted.
const term = require('../io/term');
const _w = term.stdout.write.bind(term.stdout);
term.stdout.write = (c, ...r) => { const s = typeof c === 'string' ? c : ''; if (s.startsWith('\x1b')) return true; return _w(c, ...r); };

const N = 50_000;
const MISS_THRESHOLD_US = 5; // anything above this per-op is a recompute, not a cache hit

function classify(label, mutate) {
  for (let i = 0; i < 2000; i++) { mutate(i); route.resolveTarget('viewer'); } // warm
  let s = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { mutate(i); route.resolveTarget('viewer'); }
  const both = Number(process.hrtime.bigint() - s) / 1000 / N;
  s = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { mutate(i); }
  const mut = Number(process.hrtime.bigint() - s) / 1000 / N;
  const rt = Math.max(0, both - mut);
  console.log(`  ${label.padEnd(46)} resolveTarget ≈ ${rt.toFixed(3)}µs/op  →  ${rt > MISS_THRESHOLD_US ? 'MISS' : 'HIT '}`);
}

const ls = () => route.getInstanceSlice('layout');

console.log('\n=== when does the route memo HIT vs MISS? ===');
console.log('(key: intent, focused, lastViewerTab, arrange-ref, _instVer)\n');

// (A) Nothing routing-relevant changes — the streamed-append / select-drag
//     hot path. focused/arrange/instances all stable.
classify('(A) no change (streamed append / select)', () => {});

// (B) Cursor moves WITHIN the focused navigator. `sel` changes, but `focused`
//     is *which pane*, not the row — and `sel` isn't in the key. → HIT.
classify('(B) move cursor in focused pane (j/k)', (i) => { setSel('groups', i % 20); });

// (C) FOCUS switches to a different pane each call (Tab / click). `focused`
//     differs → MISS. In real use this is ONE miss per Tab, then re-hits.
classify('(C) change focus every call (Tab)', (i) => {
  route.setInstanceSlice('layout', { ...ls(), focus: (i & 1) ? 'groups' : 'containers' });
});

// (D) Layout STRUCTURE replaced each call (resize-drag / add-column / pool
//     hide-show / free-config). `arrange` ref differs → MISS.
classify('(D) replace arrange every call (layout edit)', (i) => {
  route.setInstanceSlice('layout', { ...ls(), arrange: { columns: [{ panels: [] }], _v: i } });
});

console.log('\n--- Takeaway ---');
console.log('A/B (the thousands-per-second paths) HIT; C/D (human-paced, a few/sec) MISS.');
console.log('A focus change is ONE miss, then re-hits while focus stays put — see the');
console.log('walkthrough in docs/v0.6.5.md §1. Worst-case MISS cost: see bench-route-memo.js.');
