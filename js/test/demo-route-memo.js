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
// U2f — the content slot's default tabs are `info` (Info) + `text-view`
// (Transcript); register both so initState's reconcile mints the slot's tabs
// (the former `detail`/viewer Component is gone). resolveTarget('viewer') now
// resolves the seeded slot's ACTIVE instance (its `info` tab), not a `detail` one.
require('../dispatch/runtime/host-wiring').wirePanelHost();
require('../panel/nav-state').setNavDispatch(require('../dispatch/runtime/effects').effectHost());
require('../dispatch/runtime/effects').installBuiltins();
api.registerComponent(require('../panel/layout'));
api.registerComponent(require('../panel/info/info'));
api.registerComponent(require('../panel/text-view/text-view'));

// Mute terminal writes so timing isn't polluted.
const term = require('../io/term');
const _w = term.stdout.write.bind(term.stdout);
term.stdout.write = (c, ...r) => { const s = typeof c === 'string' ? c : ''; if (s.startsWith('\x1b')) return true; return _w(c, ...r); };

// Boot a seeded model with a placed content slot so resolveViewerPaneId has an
// arrange to walk (else every call short-circuits to null and the memo never
// exercises its tier walk). Mirrors bench-route-memo.js.
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

const N = 50_000;

const ls = () => route.getInstanceSlice('layout');

// U2f — classify HIT vs MISS STRUCTURALLY (whether the memo key changed between
// consecutive calls), not by a cost threshold. Pre-U2f a MISS cost ~70µs (a
// tier-4 instance scan + short-lived allocs), so a 5µs threshold cleanly split
// the two. Post-U2f the recompute is a cheap slot walk (~0.4µs), within noise of
// a HIT (~0.08µs), so cost can no longer classify — but the HIT/MISS *behavior*
// is unchanged: a call HITS iff every memo-key field matches the prior call. We
// read the same fields resolveTarget keys on ((intent, focused, lastViewerTab,
// arrange-ref); `_instVer` isn't exported but is stable in these scenarios) and
// still REPORT the measured per-op cost so the (now-narrow) HIT/MISS cost gap is
// visible.
function _memoKey() {
  const l = ls() || {};
  return { focused: route.getFocus(), lastViewerTab: l.lastViewerTab, arrange: l.arrange };
}
function _keyEq(a, b) {
  return a.focused === b.focused && a.lastViewerTab === b.lastViewerTab && a.arrange === b.arrange;
}

function classify(label, mutate) {
  for (let i = 0; i < 2000; i++) { mutate(i); route.resolveTarget('viewer'); } // warm
  // Structural HIT/MISS: does the memo key change from one call to the next?
  mutate(0); route.resolveTarget('viewer');
  const k0 = _memoKey();
  mutate(1); const k1 = _memoKey();
  route.resolveTarget('viewer');
  const hit = _keyEq(k0, k1);
  // Cost measurement (informational): isolate resolveTarget by subtracting the
  // mutation's own cost.
  let s = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { mutate(i); route.resolveTarget('viewer'); }
  const both = Number(process.hrtime.bigint() - s) / 1000 / N;
  s = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { mutate(i); }
  const mut = Number(process.hrtime.bigint() - s) / 1000 / N;
  const rt = Math.max(0, both - mut);
  console.log(`  ${label.padEnd(46)} resolveTarget ≈ ${rt.toFixed(3)}µs/op  →  ${hit ? 'HIT ' : 'MISS'}`);
}

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
console.log('U2f — the post-dissolution recompute is a cheap slot walk (no tier-4 instance');
console.log('scan), so the HIT/MISS cost gap is now narrow; classification is structural');
console.log('(memo key changed?), not a cost threshold.');
