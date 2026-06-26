/**
 * Semantic purity harness — the behavioral complement to the test-immutable-*
 * suite. Where those deep-freeze a SINGLE reducer call, this folds a whole
 * recorded session through the REAL reduce → finalize → render path with the
 * impure primitives sandboxed, so impurity announces itself however it is
 * spelled (alias, indirection, transitive through a "pure" leaf, dynamic) —
 * which a source grep for `Date.now`/`Math.random` cannot do.
 *
 * Three passes over an in-process WAL (root + comp + key lanes):
 *   A. CLOCK/RANDOM/IO tripwire — record EVERY read (not throw: a read the app
 *      catches internally is still recorded). Assert:
 *        - ZERO fs / child_process reads on the fold+render path, and
 *        - every wall-clock read is the groupActions purity-guard's own timing
 *          (plugin-guard.js — instrumentation whose value is discarded; proven
 *          output-neutral by Pass B). This PINS that single known exception: a
 *          NEW clock read anywhere else on the path fails the test.
 *   B. DETERMINISM — fold twice from the same baseline, force a full repaint
 *      (bypassing the incremental cell-diff cache), assert byte-identical frames.
 *   C. MUTATION — deep-freeze (model,msg) into the root reducer AND (msg,slice)
 *      into every Component update, over every recorded Msg; assert none mutate
 *      (records even a mutation the loop's try/catch would swallow).
 *
 * The embedded-terminal feed (#D14 foreign-component island, xterm internals)
 * is intentionally OUT of scope here — its grid fold is proven in test-replay.js.
 *
 * Run: node js/test/test-purity-tripwire.js
 */
'use strict';

const { describe, it, assert, eq, report, deepFreeze } = require('./test-runner');
const { getModel } = require('../app/runtime');
const state = require('../app/state');
const { initState } = state;
const api = require('../panel/api');
const loop = require('../dispatch/runtime/loop');
const dispatch = require('../dispatch/control/dispatch');
const sessionLog = require('../io/session-log');
const replay = require('../dispatch/runtime/replay');
const reducer = require('../dispatch/update/reducer');
const finalize = require('../dispatch/runtime/finalize');
const rq = require('../leaves/infra/render-queue');
const { render } = require('../render/paint');

// Wire the finalizer reconcilers (production/CLI does this) so a fold mints the
// per-pane instances and render produces a real frame — else the purity
// assertions would be vacuous.
finalize.setInstanceReconciler(state.reconcilePaneInstances);
finalize.setSubscriptionReconciler(state.reconcileSubscriptions);

// --- boot a minimal-but-real app (mirrors test-replay.js) ---
const _grp = (name, label) => ({
  name, label, containers: [],
  actions: { a1: { key: 'a1', label: 'Action 1', type: 'run', script: 'echo a1', tab: false } },
  children: [], parent: null, depth: 0, quick: false,
});
getModel().config = {
  project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
  groups: { g1: _grp('g1', 'Group 1'), g2: _grp('g2', 'Group 2') },
};
initState();
getModel().projectDir = '.';

function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return chunks.join('');
}
// Full-paint render (bypass the incremental cell-diff cache) — the correct
// oracle for a determinism diff and a fuller exercise under the tripwire.
function renderFull() { rq.forceFullRepaint(); return capture(() => render(getModel())); }

// --- record a varied session through the real entry points (all three lanes) ---
const baseline = replay.snapshotState();   // clean state to fold from
sessionLog.enable(true);
sessionLog.clear();
capture(() => {
  loop.applyMsg({ type: 'clock_tick', now: 1234567 });                              // root
  loop.applyMsg({ type: 'jobs_synced', jobs: [{ id: 1, kind: 'pty', label: 'j', status: 'running', startedAt: 1000 }] });
  loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: 'groups' }));     // comp + cascade
  loop.applyMsg({ type: 'set_current_group', name: 'g1' });                         // so the viewer resolves merged actions (exercises the guard)
  dispatch.navSelect('groups', 1);
  state.toggleMultiSel('groups', 'g1');
  loop.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' }));
  dispatch.handleKey('down', 'down');                                               // key
});
const log = sessionLog.snapshot();
sessionLog.enable(false);
const fold = () => replay.replayEntries(log, { fromState: baseline });

// ===== Tripwire (record-all) =================================================
const RealDate = Date, realRandom = Math.random, realHrtime = process.hrtime;
const fsm = require('fs'), cpm = require('child_process');
const FS = ['readFileSync','writeFileSync','appendFileSync','openSync','existsSync','statSync','readdirSync','createReadStream','createWriteStream','readFile','writeFile','appendFile'];
const CP = ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'];
const savedFs = {}, savedCp = {};
let V = [];
const rec = (what) => V.push({ what, stack: new Error().stack });
function arm() {
  V = [];
  global.Date = new Proxy(RealDate, {
    construct(t, a) { if (a.length === 0) rec('new Date()'); return new t(...a); },
    get(t, p) { if (p === 'now') return () => { rec('Date.now()'); return RealDate.now(); }; return t[p]; },
  });
  Math.random = () => { rec('Math.random()'); return realRandom(); };
  process.hrtime = Object.assign(() => { rec('process.hrtime()'); return realHrtime(); },
    { bigint: () => { rec('process.hrtime.bigint()'); return realHrtime.bigint(); } });
  for (const m of FS) if (typeof fsm[m] === 'function') { savedFs[m] = fsm[m]; fsm[m] = (...a) => { rec(`fs.${m}`); return savedFs[m](...a); }; }
  for (const m of CP) if (typeof cpm[m] === 'function') { savedCp[m] = cpm[m]; cpm[m] = (...a) => { rec(`child_process.${m}`); return savedCp[m](...a); }; }
}
function disarm() {
  global.Date = RealDate; Math.random = realRandom; process.hrtime = realHrtime;
  for (const m of Object.keys(savedFs)) fsm[m] = savedFs[m];
  for (const m of Object.keys(savedCp)) cpm[m] = savedCp[m];
}
const isGuard = (s) => s.includes('/js/panel/plugin-guard.js:');

// ===== Pass A — clock/random/IO tripwire =====================================
fold();                                   // warm caches/lazy requires (no tripwire)
const refFrame = renderFull();
// Clear the groupActions memo so the guard's timing fires UNDER the tripwire
// (else the warmup cached it and the armed pass sees zero — a cleaner result,
// but it would make the "guard is the sole clock source" check vacuous).
require('../panel/plugin-guard').reset();
arm();
let frameA = null;
try { fold(); frameA = renderFull(); } finally { disarm(); }
const ioV = V.filter(v => /^fs\.|^child_process/.test(v.what));
const clockV = V.filter(v => /Date|hrtime|random/.test(v.what));
const clockNonGuard = clockV.filter(v => !isGuard(v.stack));

describe('[A] clock/random/IO tripwire over the real fold + full render', () => {
  it('the frame is non-trivial (purity assertions are not vacuous)', () => {
    assert(/Group/.test(refFrame) && refFrame.length > 500, `frame len ${refFrame.length}`);
  });
  it('reads NO fs / child_process on the fold+render path', () => {
    if (ioV.length) console.error('   IO reads:\n' + ioV.map(v => '    ' + v.what + '\n' + v.stack.split('\n')[2]).join('\n'));
    eq(ioV.length, 0, 'zero fs/spawn reads');
  });
  it('reads NO wall clock on the path except the groupActions purity guard', () => {
    // With a minimal config (no Component defines groupActions) this is ZERO
    // clock reads — the purest result. The guard's discarded timing is the only
    // sanctioned source (exercised + pinned in [A2]); a Date.now / new Date() /
    // Math.random added to any reducer, leaf, or render would surface here as a
    // non-guard read and fail the test.
    if (clockNonGuard.length) console.error('   non-guard clock reads:\n' + clockNonGuard.map(v => '    ' + v.what + '\n' + v.stack.split('\n').slice(1, 5).join('\n')).join('\n'));
    eq(clockNonGuard.length, 0, `no non-guard clock reads (total clock reads on this path: ${clockV.length})`);
  });
});

// Pin the ONE documented exception deterministically + self-contained: the
// groupActions purity guard times the projection with the wall clock to warn on
// a blocking plugin. The read is confined to plugin-guard.js and its value is
// discarded (proven output-neutral by [B]).
describe('[A2] the sole sanctioned clock read — the groupActions purity-guard timing', () => {
  const guard = require('../panel/plugin-guard');
  const probe = { name: 'probe', groupActions: () => ({ x: { label: 'x' } }) };  // a pure projection
  guard.reset();
  arm();
  try { guard.callGroupActions(probe, { actions: {} }, 'g1', {}, getModel()); } finally { disarm(); }
  const gClock = V.filter(v => /Date|hrtime|random/.test(v.what));
  it('the guard DOES time groupActions via the wall clock', () => {
    assert(gClock.length > 0, `guard clock reads: ${gClock.length}`);
  });
  it('and every such read is confined to plugin-guard.js', () => {
    eq(gClock.filter(v => !isGuard(v.stack)).length, 0, 'all guard-path clock reads are in plugin-guard.js');
  });
});

// ===== Pass B — determinism ==================================================
fold(); const f1 = renderFull();
fold(); const f2 = renderFull();
describe('[B] determinism — fold twice, full repaint, diff the frame', () => {
  it('byte-identical rendered frame across folds (model + render deterministic)', () => {
    eq(f1, f2);
    eq(f1, refFrame);
  });
});

// ===== Pass C — mutation (deep-freeze inputs over real recorded Msgs) =========
const comps = api._components();
const realUpdate = reducer.update;
const realCompUpdate = {};
let froze = 0;
const mutations = [];
const isFrozenErr = (e) => e && /frozen|read[- ]only|Cannot assign/i.test(e.message || '');
reducer.update = (model, msg) => {
  froze++; deepFreeze(model); deepFreeze(msg);
  try { return realUpdate(model, msg); }
  catch (e) { if (isFrozenErr(e)) mutations.push(`root reducer / ${msg && msg.type}: ${e.message}`); throw e; }
};
for (const name of Object.keys(comps)) {
  const c = comps[name];
  if (c && typeof c.update === 'function') {
    realCompUpdate[name] = c.update;
    c.update = (msg, slice) => {
      froze++; deepFreeze(msg); deepFreeze(slice);
      try { return realCompUpdate[name](msg, slice); }
      catch (e) { if (isFrozenErr(e)) mutations.push(`${name}.update / ${msg && (msg.type || msg.kind)}: ${e.message}`); throw e; }
    };
  }
}
try { fold(); }
catch (e) { if (!isFrozenErr(e)) mutations.push(`fold threw: ${e.message}`); }
finally {
  reducer.update = realUpdate;
  for (const name of Object.keys(realCompUpdate)) comps[name].update = realCompUpdate[name];
}
describe('[C] mutation — deep-frozen inputs to reducer + every Component update', () => {
  it('exercised real reducer/Component update calls', () => assert(froze >= 6, `update calls: ${froze}`));
  it('no update mutated its frozen (model,msg)/(msg,slice) input', () => {
    if (mutations.length) console.error('   mutations:\n' + mutations.map(m => '    ' + m).join('\n'));
    eq(mutations.length, 0, 'zero in-place mutations');
  });
});

report();
