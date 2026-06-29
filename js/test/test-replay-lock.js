/**
 * B6 — Pause vs Lock (controller). Lock freezes the DISPLAY while playback keeps
 * advancing S.idx underneath; pause freezes idx. Run: node js/test/test-replay-lock.js
 */
'use strict';

const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');
const sessionLog = require('../io/session-log');
const rc = require('../dispatch/runtime/replay-control');
const replayCli = require('../app/replay-cli');
const route = require('../panel/route');
const runtime = require('../app/runtime');
const { getModel, setModel } = require('../model/store');
const state = require('../app/state');
const loop = require('../dispatch/runtime/loop');
const api = require('../panel/api');
require('../render/paint');

const TMP = process.env.SCRATCH_DIR || '/tmp';
const wal = path.join(TMP, `replay-lock-${process.pid}.jsonl`);
const cap = (fn) => { const o = process.stdout.write; process.stdout.write = () => true; try { return fn(); } finally { process.stdout.write = o; } };
const _grp = (n) => ({ name: n, label: n, containers: [], actions: {}, children: [], parent: null, depth: 0, quick: false });

// Spy scheduleRender (the controller's _render seam) to count repaints.
let renders = 0;
const _origSched = api.scheduleRender;
api.scheduleRender = () => { renders++; };

function boot() {
  route._resetRegistryForTest();
  state._resetSubscriptions();
  setModel(runtime.init());
  replayCli._installRuntime();
  getModel().config = { project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {}, groups: { g1: _grp('g1') } };
  sessionLog.enable(false); sessionLog.clear();
  cap(() => state.initState());
}

(async () => {
  boot();
  sessionLog.enable(true); sessionLog.clear();
  cap(() => { for (let i = 1; i <= 8; i++) loop.applyMsg({ type: 'clock_tick', now: i * 1000 }); });
  sessionLog.save(wal);
  sessionLog.enable(false); sessionLog.clear();

  boot();
  // Deterministic clock: controllable now + a no-op timer (we call _tick manually).
  let nowVal = 0;
  rc._setClock({ now: () => nowVal, setTimer: () => ({ unref() {} }), clearTimer: () => {} });
  rc.enter(wal);
  await new Promise(res => setImmediate(res));
  const S = rc._state();
  cap(() => rc.seekToEnd(-1));   // start at idx 0

  describe('[B6] lock freezes the display while playback advances idx', () => {
    it('toggleLock pins lockedIdx and renders once', () => {
      cap(() => rc.play('fwd'));
      eq(S.idx, 0, 'still at start (no tick yet)');
      renders = 0;
      cap(() => rc.toggleLock());
      eq(S.locked, true);
      eq(S.lockedIdx, 0, 'display pinned at idx 0');
      eq(renders, 1, 'lock paints once to show the frozen frame');
    });
    it('a tick advances S.idx but does NOT repaint while locked', () => {
      renders = 0;
      nowVal += 100000;            // jump the clock far forward
      cap(() => rc._tick());
      assert(S.idx > 0, 'idx advanced underneath the lock');
      eq(renders, 0, 'no repaint while locked (display frozen)');
    });
    it('unlock snaps the display forward with exactly one repaint', () => {
      renders = 0;
      cap(() => rc.toggleLock());
      eq(S.locked, false);
      eq(S.lockedIdx, null);
      eq(renders, 1, 'unlock paints once to snap to the live idx');
    });
  });

  describe('[B6] pause vs lock', () => {
    it('pause freezes idx (a tick is a no-op); lock keeps idx moving', () => {
      cap(() => rc.seekToEnd(-1));   // idx 0
      cap(() => rc.play('fwd'));
      cap(() => rc.pause());
      eq(S.playing, null, 'paused');
      const at = S.idx;
      nowVal += 100000;
      cap(() => rc._tick());
      eq(S.idx, at, 'paused → tick is a no-op, idx frozen');
    });
  });

  describe('[B6] locked playback reaching the end halts without unfreezing', () => {
    it('end-of-playback under lock keeps the display frozen', () => {
      cap(() => rc.seekToEnd(-1));
      cap(() => rc.play('fwd'));
      cap(() => rc.toggleLock());
      renders = 0;
      nowVal += 1e9;               // blow past the end
      cap(() => rc._tick());
      eq(S.playing, null, 'playback halted at the end');
      eq(renders, 0, 'display stayed frozen (no repaint on the silent halt)');
    });
  });

  api.scheduleRender = _origSched;
  cap(() => rc.exit());
  try { require('fs').unlinkSync(wal); } catch {}
  report();
})();
