/**
 * FIX-1 bench — cost of sampling the live stores (jobs / diag-log / history)
 * into the Model, to choose: whole-snapshot Msg vs event-delta Msg.
 *
 * Grounding (verified in code):
 *   - jobs    : register/update/close → discrete lifecycle events; bounded
 *               (dozens of concurrent at most). Each already scheduleRender()s.
 *   - diag-log: push on WARNING/ERROR → discrete, rare; capped ring (~200).
 *   - history : register + end → discrete (per action start/finish). Output
 *               append is SILENT (no scheduleRender) and capped (200 lines /
 *               4KB per entry); cap = 100 entries. So sample on lifecycle, not
 *               per output line.
 *
 * The model field would hold an array of entry REFERENCES (shallow) — the
 * entry objects are shared, not deep-copied. So a whole-snapshot reducer is
 * `{...model, store: snapshot.slice()}` = a ref-array copy.
 *
 * We measure the reducer-side cost of each strategy at realistic + stress
 * sizes. The per-change FREQUENCY is the other half: discrete events a few
 * times/sec, NOT per frame.
 */
'use strict';

function bench(label, fn, iters) {
  // warmup
  for (let i = 0; i < 1000; i++) fn(i);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iters; i++) fn(i);
  const t1 = process.hrtime.bigint();
  const ms = Number(t1 - t0) / 1e6;
  const ops = Math.round((iters / ms) * 1000);
  console.log(`  ${label.padEnd(46)} ${String(iters).padStart(8)} ops  ${ms.toFixed(2)}ms  →  ${ops.toLocaleString()} ops/sec`);
}

// Realistic entry shapes
function jobEntry(i) {
  return { id: `job-${i}`, kind: 'stream', label: `task ${i}`, pid: 1000 + i,
           owner: { groupName: 'g', ptyId: `p${i}` }, startedAt: i, status: 'running', exitCode: null, endedAt: null };
}
function diagEntry(i) { return { t: i, level: 'warn', code: 'W1', message: `diagnostic message number ${i} with some detail` }; }
function histEntry(i) {
  // output capped at 200 lines / 4KB; model holds the REF, not a copy
  const output = Array.from({ length: 200 }, (_, k) => `line ${k} of output for entry ${i}`);
  return { rowKey: `cmd-${i}`, label: `docker logs ${i}`, startedAt: i, endedAt: i + 1, exitCode: 0, output, _outputBytes: 4096 };
}

function makeStore(n, mk) { return Array.from({ length: n }, (_, i) => mk(i)); }

const model = { now: 0, theme: 'dark', currentGroup: 'g' /* ...etc */ };

console.log('=== FIX-1 bench: live-store → Model sampling cost ===\n');

for (const [name, mk, cap] of [['jobs', jobEntry, 64], ['diag-log', diagEntry, 200], ['history', histEntry, 100]]) {
  console.log(`[${name}] (cap ${cap})`);
  const extra = mk(999999); // pre-built entry ref (reducer appends an existing ref, never constructs)
  for (const n of [Math.min(20, cap), cap]) {
    const store = makeStore(n, mk);
    // Strategy A — whole-snapshot: reducer returns {...model, store: snapshot.slice()}
    bench(`whole-snapshot N=${n}`, () => { const next = { ...model, store: store.slice() }; return next.store.length; }, 1_000_000);
    // Strategy B — event-delta: reducer appends one EXISTING ref + trims to cap
    bench(`event-delta   N=${n}`, () => {
      const arr = store.length >= cap ? store.slice(1) : store.slice();
      arr.push(extra);
      const next = { ...model, store: arr };
      return next.store.length;
    }, 1_000_000);
  }
  console.log('');
}

// Stress: 10x the largest cap, whole-snapshot
console.log('[stress] whole-snapshot far beyond caps');
for (const n of [1000, 5000]) {
  const store = makeStore(n, jobEntry);
  bench(`whole-snapshot N=${n}`, () => { const next = { ...model, store: store.slice() }; return next.store.length; }, 200_000);
}

console.log('\n--- Interpretation ---');
console.log('Change FREQUENCY (verified in code): jobs register/update/close, diag push,');
console.log('history register/end — all DISCRETE lifecycle events (a few per second under');
console.log('heavy use), NOT per-frame and NOT per output-line (history append is silent).');
console.log('Snapshot SIZE is bounded by each store cap (jobs ~dozens, diag ~200, history 100).');
console.log('Entry objects are SHARED refs — snapshot copies the ref array, not the content.');
console.log('Compare to the already-measured floors (bench-hotpaths): full dispatch+finalizer');
console.log('≈ 160k ops/sec; pure finalizer ≈ 1.6M ops/sec. A sampling dispatch is one of those.');
