/**
 * v0.6.6 replay arc — auto-cadence checkpointing.
 *
 * With recording on and a cadence set, the finalizer writes a checkpoint every
 * N recorded entries (replay.maybeCheckpoint → session-log.checkpointDue), so a
 * long recording stays fast to seek. Cadence 0 = off (no auto-checkpoints).
 *
 * Run: node js/test/test-replay-cadence.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sessionLog = require('../io/session-log');
const replayCli = require('../app/replay-cli');
const route = require('../panel/route');
const runtime = require('../app/runtime');
const { getModel, setModel } = require('../model/store');
const state = require('../app/state');
const api = require('../panel/api');
const loop = require('../dispatch/runtime/loop');

const cap = (fn) => { const o = process.stdout.write; process.stdout.write = () => true; try { fn(); } finally { process.stdout.write = o; } };
const _grp = (name, label) => ({ name, label, containers: [], actions: {}, children: [], parent: null, depth: 0, quick: false });

function boot() {
  route._resetRegistryForTest();
  state._resetSubscriptions();
  setModel(runtime.init());
  replayCli._installRuntime();
  getModel().config = { project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
    groups: { g1: _grp('g1', 'Group 1'), g2: _grp('g2', 'Group 2') } };
  sessionLog.enable(false); sessionLog.clear();
  cap(() => state.initState());
  getModel().projectDir = '.';
}

// Drive `n` outermost Component dispatches (each runs the finalizer → maybeCheckpoint).
function drive(n) {
  cap(() => {
    for (let i = 0; i < n; i++) {
      loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: i % 2 ? 'groups' : 'actions' }));
    }
  });
}

const cpCount = () => sessionLog.snapshot().filter(e => e.kind === 'checkpoint').length;

// --- BYTES-primary: small byte threshold → periodic checkpoints ---
boot();
sessionLog.enable(true);
sessionLog.setCheckpointCadence({ bytes: 300 });   // entries OFF
sessionLog.clear();
drive(12);
const byteCount = cpCount();
sessionLog.enable(false); sessionLog.setCheckpointCadence(); sessionLog.clear();

// --- COUNT backstop: bytes OFF, small entry ceiling → periodic checkpoints ---
boot();
sessionLog.enable(true);
sessionLog.setCheckpointCadence({ entries: 4 });   // bytes OFF
sessionLog.clear();
drive(12);
const entryCount = cpCount();
sessionLog.enable(false); sessionLog.setCheckpointCadence(); sessionLog.clear();

// --- OFF: both thresholds 0 → no auto-checkpoints ---
boot();
sessionLog.enable(true);
sessionLog.setCheckpointCadence();
sessionLog.clear();
drive(12);
const offCount = cpCount();
sessionLog.enable(false); sessionLog.clear();

describe('[1] bytes-primary cadence writes periodic checkpoints', () => {
  it('a small byte threshold yields ≥1 auto checkpoint', () => assert(byteCount >= 1, `byte-cadence checkpoints: ${byteCount}`));
});

describe('[2] entry-count backstop also triggers (bytes off)', () => {
  it('a small entry ceiling yields ≥1 auto checkpoint', () => assert(entryCount >= 1, `count-cadence checkpoints: ${entryCount}`));
});

describe('[3] both thresholds 0 disables auto-checkpointing', () => {
  it('no checkpoints when cadence is off', () => eq(offCount, 0));
});

report();
