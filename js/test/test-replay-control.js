/**
 * v0.6.6 replay arc — record-save / record-load / record-stop control.
 *
 * Covers the runtime side of the record-* triggers (the flags + cmdline verbs):
 *   - record-save checkpoints the full state, then streams follow-ups to a
 *     SELF-CONTAINED file (replayable from a bare boot via the checkpoint);
 *   - record-stop detaches the stream + disables;
 *   - the saved file reconstructs the live end-state from a fresh registry;
 *   - the effect host exposes recordSave/recordLoad/recordStop (the verb wiring).
 *
 * Run: node js/test/test-replay-control.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');
const sessionLog = require('../io/session-log');
const rc = require('../dispatch/runtime/record-control');
const replay = require('../dispatch/runtime/replay');
const replayCli = require('../app/replay-cli');
const route = require('../panel/route');
const runtime = require('../app/runtime');
const { getModel, setModel } = require('../model/store');
const state = require('../app/state');
const api = require('../panel/api');
const loop = require('../dispatch/runtime/loop');
const dispatch = require('../dispatch/control/dispatch');
const { effectHost } = require('../dispatch/runtime/effects');

const TMP = process.env.SCRATCH_DIR || '/tmp';
const wal = path.join(TMP, `replay-control-${process.pid}.jsonl`);
const enc = (s) => sessionLog.encodeJson(s);
const cap = (fn) => { const o = process.stdout.write; process.stdout.write = () => true; try { fn(); } finally { process.stdout.write = o; } };
const _grp = (name, label) => ({ name, label, containers: [], actions: {}, children: [], parent: null, depth: 0, quick: false });

// Boot the full runtime headlessly.
route._resetRegistryForTest();
state._resetSubscriptions();
setModel(runtime.init());
replayCli._installRuntime();
getModel().config = { project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {},
  groups: { g1: _grp('g1', 'Group 1'), g2: _grp('g2', 'Group 2') } };
sessionLog.enable(false);
sessionLog.clear();
cap(() => state.initState());
getModel().projectDir = '.';

// Pre-save ops (baked into the checkpoint), then record-save, then post-save ops.
cap(() => {
  loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: 'groups' }));
  dispatch.navSelect('groups', 1);
});
const saved = rc.save(wal);
const enabledAfterSave = sessionLog.isEnabled();
const streamAfterSave = sessionLog.streamPath();
const fileAfterSave = fs.readFileSync(wal, 'utf8').trim().split('\n');
const savedAgain = rc.save(wal);   // repeated record-save while already recording → skipped

cap(() => {
  state.toggleMultiSel('groups', 'g1');
  loop.applyMsg({ type: 'clock_tick', now: 4242 });
});
const fileAfterOps = fs.readFileSync(wal, 'utf8').trim().split('\n');
const liveEnc = enc(replay.snapshotState());

rc.stop();
const enabledAfterStop = sessionLog.isEnabled();
const streamAfterStop = sessionLog.streamPath();
cap(() => loop.applyMsg({ type: 'clock_tick', now: 9999 }));   // should NOT be written
const fileAfterStop = fs.readFileSync(wal, 'utf8').trim().split('\n');

// Reconstruct from the file in a BARE registry (as --record-load does).
route._resetRegistryForTest();
state._resetSubscriptions();
setModel(runtime.init());
replayCli._installRuntime();
const log = sessionLog.load(wal);
replay.replayTo(log, Infinity, { useCheckpoints: true });
const reconstructedEnc = enc(replay.snapshotState());

describe('[1] record-save writes a self-contained file (checkpoint-seeded)', () => {
  it('returns the path and enables streaming to it', () => {
    eq(saved.path, wal, 'returns the file path');
    assert(!saved.skipped, 'not skipped on first save');
    assert(enabledAfterSave, 'recording enabled after save');
    eq(streamAfterSave, wal, 'streaming to the file');
  });
  it('the first non-header entry is a checkpoint', () => {
    eq(JSON.parse(fileAfterSave[0]).kind, 'header', 'header first');
    eq(JSON.parse(fileAfterSave[1]).kind, 'checkpoint', 'checkpoint seed second');
  });
  it('a repeated record-save while recording is skipped', () => {
    assert(savedAgain.skipped, 'second save skipped');
    eq(savedAgain.path, wal, 'reports the in-progress path');
  });
});

describe('[2] follow-up Msgs stream to the file', () => {
  it('the file grew after post-save ops', () => assert(fileAfterOps.length > fileAfterSave.length, `${fileAfterSave.length} → ${fileAfterOps.length}`));
});

describe('[3] record-stop detaches + disables', () => {
  it('disabled with no stream after stop', () => { assert(!enabledAfterStop, 'disabled'); eq(streamAfterStop, null, 'no stream'); });
  it('post-stop Msgs are NOT written', () => eq(fileAfterStop.length, fileAfterOps.length, 'file unchanged after stop'));
});

describe('[4] the saved file reconstructs the live end-state from a bare registry', () => {
  it('record-load (via replayTo + mint-on-restore) == live', () => eq(reconstructedEnc, liveEnc));
});

describe('[5] the effect host exposes the record verbs', () => {
  it('recordSave/recordLoad/recordStop are wired', () => {
    const h = effectHost();
    assert(typeof h.recordSave === 'function', 'recordSave');
    assert(typeof h.recordLoad === 'function', 'recordLoad');
    assert(typeof h.recordStop === 'function', 'recordStop');
  });
});

try { fs.unlinkSync(wal); } catch {}
report();
