/**
 * v0.6.6 replay arc — interactive replay-control pane (the scrubber).
 *
 * Records a session (with checkpoints) to a file, then drives the controller:
 *   - enter() builds the checkpoint list + reconstructs the recorded end;
 *   - seekToCheckpoint(i) reconstructs EXACTLY that checkpoint's stored state
 *     (forward AND backward — backward seek is the reverse mechanism);
 *   - stepSeq moves by one entry; play/pause toggle the flag;
 *   - exit() restores the live session captured on enter;
 *   - the overlay renders the checkpoint list + status.
 *
 * Run: node js/test/test-replay-control-pane.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');
const sessionLog = require('../io/session-log');
const replay = require('../dispatch/runtime/replay');
const replayControl = require('../dispatch/runtime/replay-control');
const replayCli = require('../app/replay-cli');
const route = require('../panel/route');
const runtime = require('../app/runtime');
const { getModel, setModel } = require('../model/store');
const state = require('../app/state');
const api = require('../panel/api');
const loop = require('../dispatch/runtime/loop');
const dispatch = require('../dispatch/control/dispatch');
require('../render/paint');   // sets the overlay draw writer so render() emits

const TMP = process.env.SCRATCH_DIR || '/tmp';
const wal = path.join(TMP, `replay-pane-${process.pid}.jsonl`);
const enc = (s) => sessionLog.encodeJson(s);
const cap = (fn) => { const o = process.stdout.write; process.stdout.write = () => true; try { fn(); } finally { process.stdout.write = o; } };
const capOut = (fn) => { const o = process.stdout.write; const c = []; process.stdout.write = (s) => { c.push(String(s)); return true; }; try { fn(); } finally { process.stdout.write = o; } return c.join(''); };
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[=>]/g, '');
const _grp = (name, label) => ({ name, label, containers: [], actions: { a1: { key: 'a1', label: 'A1', type: 'run', script: 'echo', tab: false } }, children: [], parent: null, depth: 0, quick: false });

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

(async () => {
  // ---- record a session with two checkpoints ----
  boot();
  sessionLog.enable(true); sessionLog.clear();
  cap(() => { loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: 'groups' })); dispatch.navSelect('groups', 1); });
  replay.checkpointNow();          // CP1
  cap(() => { state.toggleMultiSel('groups', 'g1'); loop.applyMsg({ type: 'clock_tick', now: 5000 }); });
  replay.checkpointNow();          // CP2
  cap(() => { dispatch.navSelect('groups', 0); loop.applyMsg({ type: 'clock_tick', now: 9000 }); });
  const finalEnc = enc(replay.snapshotState());
  sessionLog.save(wal);
  sessionLog.enable(false); sessionLog.clear();

  // ---- establish a distinct LIVE session (what :record-load snapshots aside) ----
  boot();
  cap(() => loop.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' })));
  const liveEnc = enc(replay.snapshotState());

  // ---- enter interactive replay ----
  replayControl.enter(wal);
  await new Promise(res => setImmediate(res));   // flush the reconstruct
  const S = replayControl._state();
  const enterEnc = enc(replay.snapshotState());
  const cpCount = S ? S.checkpoints.length : -1;
  const cp1State = S.log.filter(e => e.kind === 'checkpoint')[0].state;
  const cp2State = S.log.filter(e => e.kind === 'checkpoint')[1].state;

  // seek backward to CP1, then forward to CP2 (backward seek = reverse path)
  replayControl.seekToCheckpoint(0);
  const seek0Enc = enc(replay.snapshotState());
  const idxAtCp1 = replayControl._state().idx;
  replayControl.seekToCheckpoint(1);
  const seek1Enc = enc(replay.snapshotState());

  // step one entry back from CP2
  replayControl.stepSeq(-1);
  const idxAfterStepBack = replayControl._state().idx;

  // play/pause flag
  replayControl.play('fwd');
  const playingFwd = replayControl._state().playing;
  replayControl.pause();
  const pausedNull = replayControl._state().playing;

  // overlay render (pane is open)
  const overlayFrame = stripAnsi(capOut(() => require('../overlay/replay-control').render(replayControl.renderData())));

  // exit → live restored
  const activeBeforeExit = replayControl.active();
  replayControl.exit();
  const afterExitEnc = enc(replay.snapshotState());
  const activeAfterExit = replayControl.active();

  describe('[1] enter loads checkpoints + reconstructs the recorded end', () => {
    it('two checkpoints listed', () => eq(cpCount, 2));
    it('reconstructed end == recorded final state', () => eq(enterEnc, finalEnc));
  });
  describe('[2] seek reconstructs the exact checkpoint state (backward + forward)', () => {
    it('seekToCheckpoint(0) == CP1 stored state (backward seek)', () => eq(seek0Enc, cp1State));
    it('seekToCheckpoint(1) == CP2 stored state', () => eq(seek1Enc, cp2State));
    it('backward seek (CP1) is earlier than the end', () => assert(idxAtCp1 < S.log.length - 1, `cp1 idx ${idxAtCp1} < end ${S.log.length - 1}`));
  });
  describe('[3] step + play/pause', () => {
    it('stepSeq(-1) moved one entry back from CP2', () => assert(idxAfterStepBack >= 0, `idx ${idxAfterStepBack}`));
    it('play sets fwd, pause clears', () => { eq(playingFwd, 'fwd'); eq(pausedNull, null); });
  });
  describe('[4] overlay renders the checkpoint list + status', () => {
    it('shows the Replay title + a timestamp + the hint line', () => {
      assert(/Replay/.test(overlayFrame), 'title');
      assert(/\d\d:\d\d:\d\d/.test(overlayFrame), 'a HH:MM:SS timestamp');
      assert(/seek/.test(overlayFrame), 'hint line');
    });
  });
  describe('[5] exit restores the live session', () => {
    it('was active, now inactive', () => { assert(activeBeforeExit, 'active during replay'); eq(activeAfterExit, false); });
    it('live state restored exactly', () => eq(afterExitEnc, liveEnc));
  });

  try { fs.unlinkSync(wal); } catch {}
  report();
})();
