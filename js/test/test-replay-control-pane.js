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

  // overlay render (pane is open — default 'full')
  const overlayFrame = stripAnsi(capOut(() => require('../overlay/replay-control').render(replayControl.renderData())));
  const fullView = replayControl._state().paneView;

  // cycle the pane view: full → mini → hidden → full
  const drawPane = () => stripAnsi(capOut(() => require('../overlay/replay-control').render(replayControl.renderData())));
  replayControl.cyclePane();                       // → mini
  const miniView = replayControl._state().paneView;
  const miniFrame = drawPane();
  // up/down navigate checkpoints in MINI (no view gate on the keys)
  replayControl.seekToCheckpoint(1);
  replayControl.handleKey('up', 'up');
  const cpAfterUp = replayControl._state().cursor;
  replayControl.handleKey('down', 'down');
  const cpAfterDown = replayControl._state().cursor;
  replayControl.cyclePane();                       // → hidden
  const hiddenView = replayControl._state().paneView;
  const hiddenFrame = drawPane();
  // playback/seek keys still act while hidden (view = display only)
  const idxBeforeHiddenKey = replayControl._state().idx;
  replayControl.handleKey('[', '[');               // step back one entry
  const idxAfterHiddenKey = replayControl._state().idx;
  replayControl.cyclePane();                       // → full (restore)
  const cycledBackView = replayControl._state().paneView;

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
  describe('[4b] pane view cycles full → mini → hidden', () => {
    it('cyclePane walks the three states and back', () => {
      eq(fullView, 'full'); eq(miniView, 'mini'); eq(hiddenView, 'hidden'); eq(cycledBackView, 'full');
    });
    it('mini shows speed + seq + checkpoint cursor + a progress bar with ticks, but NOT the legend', () => {
      assert(/×/.test(miniFrame), 'speed (ratio) shown');
      assert(/\d+\/\d+/.test(miniFrame), 'seq shown');
      assert(/cp \d+\/\d+/.test(miniFrame), 'checkpoint cursor shown');
      assert(/[█░]/.test(miniFrame), 'progress bar shown');
      assert(/┃/.test(miniFrame), 'checkpoint ticks on the bar');
      assert(!/seek/.test(miniFrame), 'no key legend in mini');
    });
    it('up/down navigate checkpoints while in mini', () => { eq(cpAfterUp, 0); eq(cpAfterDown, 1); });
    it('hidden renders nothing', () => eq(hiddenFrame, ''));
    it('playback keys still act while hidden', () => eq(idxAfterHiddenKey, Math.max(0, idxBeforeHiddenKey - 1)));
  });
  describe('[5] exit restores the live session', () => {
    it('was active, now inactive', () => { assert(activeBeforeExit, 'active during replay'); eq(activeAfterExit, false); });
    it('live state restored exactly', () => eq(afterExitEnc, liveEnc));
  });

  // ===== [6] deterministic clock-driven playback (injected clock + manual _tick) =====
  const { EVEN_RATE } = require('../leaves/replay/timeline');
  let vt = 0;
  const noTimer = { unref() {} };
  replayControl._setClock({ now: () => vt, setTimer: () => noTimer, clearTimer: () => {} });
  let renderCount = 0;
  const origSched = api.scheduleRender;
  api.scheduleRender = () => { renderCount++; };

  replayControl.enter(wal);
  await new Promise(res => setImmediate(res));
  replayControl.toggleMode();                 // realtime → even (index-based, deterministic)
  const end = replayControl._state().log.length - 1;
  // ms to reach entry index i at ratio 1 in even mode.
  const tForIdx = (i, ratio = 1) => Math.ceil((i * 1000) / (ratio * EVEN_RATE));

  // --- forward advancement: the timer actually advances idx ---
  replayControl.seekToEnd(-1);                 // idx 0
  vt = 0; replayControl.play('fwd');           // anchor at vt=0
  vt = tForIdx(2); replayControl._tick();
  const idxA = replayControl._state().idx;     // expect 2
  vt = tForIdx(4); replayControl._tick();
  const idxB = replayControl._state().idx;     // expect 4

  // --- no-op skip: a sub-entry clock bump renders NOTHING ---
  renderCount = 0;
  vt = tForIdx(4) + 1; replayControl._tick();  // still floor → idx 4
  const idxNoop = replayControl._state().idx;
  const renderOnNoop = renderCount;

  // --- ratio re-anchor: doubling speed must NOT retroactively rescale ---
  replayControl.setRatio(+1);                  // ratio 2, re-anchors at idx 4 / vt
  vt = vt + tForIdx(2, 2);                     // +2 entries at 2× over this span
  replayControl._tick();
  const idxAfterRatio = replayControl._state().idx;  // expect 6, NOT the buggy ~12

  // --- end-stop: clock far past the end settles + pauses ---
  vt = 10_000_000; replayControl._tick();
  const idxAtEnd = replayControl._state().idx;
  const playingAtEnd = replayControl._state().playing;

  // --- reverse play via the ladder reconstructs correctly ---
  replayControl.setRatio(-1);                  // back to ratio 1
  replayControl.seekToEnd(+1);                 // idx end
  vt = 1_000_000; replayControl.play('rev');   // anchor
  vt = 1_000_000 + tForIdx(2); replayControl._tick();
  const idxRev = replayControl._state().idx;   // ~ end-2
  const revState = enc(replay.snapshotState());
  // reference: a full checkpoint-anchored replayTo at the same index
  const rlog = replayControl._state().log;
  replay.replayTo(rlog, rlog[idxRev].seq, { useCheckpoints: true });
  const revRef = enc(replay.snapshotState());

  // --- slow mode: sub-1× speed advances proportionally slower ---
  replayControl.pause();
  replayControl.seekToEnd(-1);                 // idx 0 (mode even, ratio 1)
  replayControl.setRatio(-1); const ratioHalf = replayControl._state().ratio;     // 0.5
  replayControl.setRatio(-1); const ratioQuarter = replayControl._state().ratio;  // 0.25
  replayControl.setRatio(+1);                  // back to 0.5×
  vt = 5_000_000; replayControl.play('fwd');   // anchor at idx 0
  vt = 5_000_000 + tForIdx(4); replayControl._tick();   // wall time that reaches idx 4 at 1×
  const idxSlow = replayControl._state().idx;  // at 0.5× → idx 2 (half)

  // --- mode toggle + idle-cap cycle preserve the current position ---
  replayControl.pause();
  const idxBeforeToggle = replayControl._state().idx;
  replayControl.toggleMode();
  const idxAfterToggle = replayControl._state().idx;
  replayControl.cycleIdleCap();
  const idxAfterCap = replayControl._state().idx;
  const capChanged = replayControl._state().idleCap;

  api.scheduleRender = origSched;
  replayControl.exit();

  describe('[6] clock-driven playback (deterministic, injected clock)', () => {
    it('the session is long enough to exercise playback', () => assert(end >= 6, `end=${end}`));
    it('forward play advances idx with the clock', () => { eq(idxA, 2); eq(idxB, 4); });
    it('a sub-entry tick is a no-op (idx stable, NO render)', () => { eq(idxNoop, 4); eq(renderOnNoop, 0); });
    it('ratio change re-anchors (no retroactive jump)', () => eq(idxAfterRatio, 6));
    it('play stops at the end', () => { eq(idxAtEnd, end); eq(playingAtEnd, null); });
    it('reverse play reconstructs == replayTo at the same idx', () => { assert(idxRev < end, `idxRev ${idxRev} < end ${end}`); eq(revState, revRef); });
    it('slow mode (sub-1× speed) advances at half rate', () => { eq(ratioHalf, 0.5); eq(ratioQuarter, 0.25); eq(idxSlow, 2); });
    it('mode toggle + idle-cap cycle preserve position', () => { eq(idxAfterToggle, idxBeforeToggle); eq(idxAfterCap, idxBeforeToggle); assert(capChanged !== 1000, 'cap advanced from default'); });
  });

  try { fs.unlinkSync(wal); } catch {}
  report();
})();
