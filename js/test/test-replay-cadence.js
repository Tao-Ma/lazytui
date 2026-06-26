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

// --- cadence ON: checkpoints appear automatically ---
boot();
sessionLog.enable(true);
sessionLog.setCheckpointCadence(5);
sessionLog.clear();
drive(12);
const autoCount = sessionLog.snapshot().filter(e => e.kind === 'checkpoint').length;
sessionLog.enable(false); sessionLog.setCheckpointCadence(0); sessionLog.clear();

// --- cadence OFF: no auto-checkpoints ---
boot();
sessionLog.enable(true);
sessionLog.setCheckpointCadence(0);
sessionLog.clear();
drive(12);
const offCount = sessionLog.snapshot().filter(e => e.kind === 'checkpoint').length;
sessionLog.enable(false); sessionLog.clear();

describe('[1] auto-cadence writes periodic checkpoints while recording', () => {
  it('a small cadence yields ≥1 auto checkpoint', () => assert(autoCount >= 1, `auto checkpoints: ${autoCount}`));
});

describe('[2] cadence 0 disables auto-checkpointing', () => {
  it('no checkpoints when cadence is off', () => eq(offCount, 0));
});

report();
