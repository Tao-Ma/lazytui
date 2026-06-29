/**
 * B6 — per-Msg model diff panel + skip-to-next-change (controller integration).
 * Mirrors the test-replay-control-pane.js harness. Run: node js/test/test-replay-diff.js
 */
'use strict';

const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');
const sessionLog = require('../io/session-log');
const replay = require('../dispatch/runtime/replay');
const rc = require('../dispatch/runtime/replay-control');
const replayCli = require('../app/replay-cli');
const route = require('../panel/route');
const runtime = require('../app/runtime');
const { getModel, setModel } = require('../model/store');
const state = require('../app/state');
const loop = require('../dispatch/runtime/loop');
require('../render/paint');

const TMP = process.env.SCRATCH_DIR || '/tmp';
const wal = path.join(TMP, `replay-diff-${process.pid}.jsonl`);
const cap = (fn) => { const o = process.stdout.write; process.stdout.write = () => true; try { return fn(); } finally { process.stdout.write = o; } };
const capOut = (fn) => { const o = process.stdout.write; const c = []; process.stdout.write = (s) => { c.push(String(s)); return true; }; try { fn(); } finally { process.stdout.write = o; } return c.join(''); };
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
const _grp = (n) => ({ name: n, label: n, containers: [], actions: {}, children: [], parent: null, depth: 0, quick: false });

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
  // Record 4 clock_ticks: a no-op (same now) sits between changes so skip must
  // step OVER it. idx 0:→1000  1:1000→1000(no change)  2:1000→2000  3:2000→3000.
  sessionLog.enable(true); sessionLog.clear();
  cap(() => {
    loop.applyMsg({ type: 'clock_tick', now: 1000 });
    loop.applyMsg({ type: 'clock_tick', now: 1000 });
    loop.applyMsg({ type: 'clock_tick', now: 2000 });
    loop.applyMsg({ type: 'clock_tick', now: 3000 });
  });
  sessionLog.save(wal);
  sessionLog.enable(false); sessionLog.clear();

  boot();
  rc.enter(wal);
  await new Promise(res => setImmediate(res));
  const S = rc._state();

  describe('[B6] per-Msg model diff panel', () => {
    it('panel off → renderData().diff is null', () => {
      eq(rc.renderData().diff, null);
    });
    it('toggling the panel computes the diff for the current Msg (idx 3: now 2000→3000)', () => {
      eq(S.idx, S.log.length - 1, 'entered at the end');
      cap(() => rc.toggleDiffPanel());
      const d = rc.renderData().diff;
      assert(d && d.changes.length >= 1, 'a change computed');
      const now = d.changes.find(c => c.path === 'model.now');
      assert(now, 'model.now changed');
      eq(now.before, '2000'); eq(now.after, '3000');
    });
    it('computing the diff RESTORES the displayed frame (model still @ idx 3)', () => {
      eq(replay.snapshotState().model.now, 3000, 'reconstruction unchanged by the scratch fold');
    });
    it('the scrubber renders the changes section', () => {
      const out = stripAnsi(capOut(() => require('../overlay/replay-scrubber').render(rc.renderData())));
      assert(/changes @/.test(out), 'changes header rendered');
      assert(/model\.now/.test(out), 'the changed path rendered');
    });
  });

  describe('[B6] skip-to-next-change', () => {
    it('seek to the start, then `n` skips the no-op Msg and lands on the next change', () => {
      cap(() => rc.seekToEnd(-1));          // idx 0
      eq(S.idx, 0);
      cap(() => rc.handleKey('', 'n'));     // skip fwd: idx1 (no change) → idx2 (1000→2000)
      eq(S.idx, 2, 'skipped the no-op clock_tick, landed on the change');
      const now = rc.renderData().diff.changes.find(c => c.path === 'model.now');
      eq(now.after, '2000');
    });
    it('`N` skips back over the no-op to the prior change', () => {
      cap(() => rc.handleKey('', 'N'));     // from idx2 back: idx1 (no change) → idx0
      eq(S.idx, 0, 'skipped back over the no-op');
    });
  });

  describe('[B6] panel gate', () => {
    it('toggling off clears the diff from renderData', () => {
      cap(() => rc.toggleDiffPanel());
      eq(rc.renderData().diff, null);
    });
  });

  cap(() => rc.exit());

  // ---------------------------------------------------------------------------
  // [B6] skip-to-next-change: NO match (Round-3 review). A scan that finds no
  // changing Msg within SCAN_CAP must STAY PUT — it used to teleport up to
  // SCAN_CAP frames to a non-change frame at the scan boundary.
  // ---------------------------------------------------------------------------
  boot();
  sessionLog.enable(true); sessionLog.clear();
  cap(() => {
    loop.applyMsg({ type: 'clock_tick', now: 1000 });   // idx 0: →1000 (the start anchor)
    loop.applyMsg({ type: 'clock_tick', now: 1000 });   // idx 1: no change
    loop.applyMsg({ type: 'clock_tick', now: 1000 });   // idx 2: no change
  });
  sessionLog.save(wal);
  sessionLog.enable(false); sessionLog.clear();
  boot();
  rc.enter(wal);
  await new Promise(res => setImmediate(res));
  const S2 = rc._state();

  describe('[B6] skip-to-next-change: no later change stays put', () => {
    it('`n` with no later change stays put (no teleport to the scan boundary)', () => {
      cap(() => rc.seekToEnd(-1));            // idx 0
      eq(S2.idx, 0);
      cap(() => rc.handleKey('', 'n'));       // idx1, idx2 are no-ops → nothing changes ahead
      eq(S2.idx, 0, 'stayed put — did not jump to the last no-change frame');
    });
    it('`N` reaches the timeline start anchor (idx 0), skipping the no-op', () => {
      cap(() => rc.seekToEnd(1));             // idx 2 (end)
      eq(S2.idx, 2);
      cap(() => rc.handleKey('', 'N'));       // idx1 no-op → idx0 (the start anchor)
      eq(S2.idx, 0, 'reached idx 0 by intent, not by a fall-through teleport');
    });
  });

  cap(() => rc.exit());
  try { require('fs').unlinkSync(wal); } catch {}
  report();
})();
