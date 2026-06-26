/**
 * v0.6.6 replay arc — Phase D: checkpoints (resumable points + correctness).
 *
 * Proves the WAL+checkpoint contract for the model side:
 *   - the Set-aware JSON codec round-trips nav-slice Sets (multiSel/expanded);
 *   - a full fold reproduces the live state;
 *   - seeking to the nearest checkpoint and folding forward == the full fold
 *     (resume is exact — the checkpoint is a valid resumable point);
 *   - a recorded checkpoint stores exactly the fold-to-that-seq state.
 *
 * Run: node js/test/test-replay-checkpoint.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const api = require('../panel/api');
const loop = require('../dispatch/runtime/loop');
const dispatch = require('../dispatch/control/dispatch');
const state = require('../app/state');
const sessionLog = require('../io/session-log');
const replay = require('../dispatch/runtime/replay');
const route = require('../panel/route');
const runtime = require('../app/runtime');
const { setModel } = require('../model/store');
const replayCli = require('../app/replay-cli');

// --- boot a minimal-but-real app ---
const _grp = (name, label) => ({
  name, label, containers: [],
  actions: { a1: { key: 'a1', label: 'Action 1', type: 'run', script: 'echo a1', tab: false } },
  children: [], parent: null, depth: 0, quick: false,
});
// Boot the FULL runtime (all built-in Components — like the live app and the
// --replay harness), so the recorded instance set matches what a bare-registry
// replay (block [4]) reconstructs.
route._resetRegistryForTest();
state._resetSubscriptions();
setModel(runtime.init());
replayCli._installRuntime();
getModel().config = {
  project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
  groups: { g1: _grp('g1', 'Group 1'), g2: _grp('g2', 'Group 2') },
};
initState();
getModel().projectDir = '.';

const enc = (s) => sessionLog.encodeJson(s);
const cap = (fn) => {
  const o = process.stdout.write; process.stdout.write = () => true;
  try { fn(); } finally { process.stdout.write = o; }
};

describe('[0] Set-aware JSON codec round-trips nav Sets', () => {
  it('encodeJson → JSON → decodeJson restores nested Sets', () => {
    const v = { a: 1, s: new Set(['x', 'y']), nested: { t: new Set([1, 2]) }, arr: [new Set(['z'])] };
    const round = sessionLog.decodeJson(JSON.parse(JSON.stringify(sessionLog.encodeJson(v))));
    assert(round.s instanceof Set && round.s.has('x') && round.s.has('y'), 'top-level Set restored');
    assert(round.nested.t instanceof Set && round.nested.t.has(2), 'nested Set restored');
    assert(round.arr[0] instanceof Set && round.arr[0].has('z'), 'Set inside array restored');
    eq(round.a, 1, 'plain fields preserved');
  });
});

// Record a multi-phase, pane-stable session with checkpoints between phases.
const checkpoint0 = replay.snapshotState();
sessionLog.enable(true);
sessionLog.clear();

cap(() => {
  loop.applyMsg({ type: 'clock_tick', now: 100 });
  loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: 'groups' }));
  dispatch.navSelect('groups', 1);
});
replay.checkpointNow();                                // CP1
cap(() => {
  state.toggleMultiSel('groups', 'g1');                // mutates a Set in the slice
  loop.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' }));
  loop.applyMsg({ type: 'jobs_synced', jobs: [{ id: 1, label: 'a', status: 'running' }] });
});
const cp2Seq = replay.checkpointNow();                 // CP2
cap(() => {
  dispatch.navSelect('groups', 0);
  loop.applyMsg({ type: 'clock_tick', now: 200 });
});

const finalEnc = enc(replay.snapshotState());
const log = sessionLog.snapshot();
sessionLog.enable(false);

// Full fold from the boot baseline (checkpoints ignored).
replay.replayTo(log, Infinity, { useCheckpoints: false, fromState: checkpoint0 });
const fullEnc = enc(replay.snapshotState());

// Seek fold (restore nearest checkpoint, fold forward).
replay.replayTo(log, Infinity, { useCheckpoints: true });
const seekEnc = enc(replay.snapshotState());

// Fold from the start up to CP2's seq, to compare against CP2's stored snapshot.
replay.replayTo(log, cp2Seq, { useCheckpoints: false, fromState: checkpoint0 });
const foldToCp2 = enc(replay.snapshotState());
const cp2Entry = log.find(e => e.kind === 'checkpoint' && e.seq === cp2Seq);

// Bare-registry checkpoint seek (mint-on-restore): reset to a fresh registry +
// model (as a `--replay` subprocess starts), install the CLI runtime
// scaffolding, then seek — replayTo restores the nearest checkpoint into the
// BARE registry, recreating the per-pane instance set from its arrange before
// writing slices. The recorded log here has NO set_config/boot Msgs (recording
// started post-boot), so this works ONLY because the checkpoint carries the full
// model + slices.
route._resetRegistryForTest();
state._resetSubscriptions();
setModel(runtime.init());
replayCli._installRuntime();
replay.replayTo(log, Infinity, { useCheckpoints: true });
const bareSeekEnc = enc(replay.snapshotState());

describe('[1] full fold reproduces the live state', () => {
  it('replayTo(useCheckpoints:false) == live', () => eq(fullEnc, finalEnc));
});

describe('[2] checkpoint seek == full fold (resume is exact)', () => {
  it('two checkpoints were recorded', () => eq(log.filter(e => e.kind === 'checkpoint').length, 2));
  it('replayTo(useCheckpoints:true) == live', () => eq(seekEnc, finalEnc));
});

describe('[3] a checkpoint stores exactly the fold-to-that-seq state', () => {
  it('CP2.state == fold(boot → cp2Seq)', () => {
    assert(cp2Entry && cp2Entry.state, 'CP2 entry present with state');
    eq(cp2Entry.state, foldToCp2);
  });
});

describe('[4] checkpoint seek from a BARE registry (mint-on-restore)', () => {
  it('restores + folds to the full live state from a fresh registry', () => eq(bareSeekEnc, finalEnc));
});

report();
