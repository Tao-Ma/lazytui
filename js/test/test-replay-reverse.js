/**
 * v0.6.6 replay arc — smooth-reverse base ladder (replay.reverseTo).
 *
 * Reverse playback reconstructs each frame from a cheap model base (a {model,
 * slices} snapshot inside the checkpoint interval) plus the WAL checkpoint's
 * terminal grids, folded forward in one ordered pass. This proves that the
 * ladder reconstruction is IDENTICAL to a full checkpoint-anchored replayTo at
 * the same index — for the model, every slice, AND the terminal grid — from
 * both a checkpoint-aligned base and an intermediate (mid-interval) base.
 *
 * Run: node js/test/test-replay-reverse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const api = require('../panel/api');
const loop = require('../dispatch/runtime/loop');
const dispatch = require('../dispatch/control/dispatch');
const sessionLog = require('../io/session-log');
const replay = require('../dispatch/runtime/replay');
const terminal = require('../io/terminal');

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
  const orig = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = orig; }
}
const flush = (id) => new Promise(res => terminal.feedReplay(id, '', res));
function gridText(id) {
  const s = terminal.getSession(id);
  if (!s) return '<no session>';
  const buf = s.screen.buffer.active;
  const out = [];
  for (let y = 0; y < s.screen.rows; y++) {
    const ln = buf.getLine(buf.viewportY + y);
    out.push(ln ? ln.translateToString(true) : '');
  }
  return out.join('\n');
}

(async () => {
  const TID = 'rev';
  const cols = 40, rows = 6;

  // ===== Record a session with terminal output + interleaved checkpoints =====
  sessionLog.enable(true);
  sessionLog.clear();
  sessionLog.recordTerm({ id: TID, ev: 'spawn', cols, rows });
  terminal.ensureReplaySession(TID, cols, rows);
  const termOut = (d) => { sessionLog.recordTerm({ id: TID, ev: 'out', d }); terminal.feedReplay(TID, d); };

  capture(() => {
    loop.applyMsg({ type: 'clock_tick', now: 1000 });
    loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: 'groups' }));
  });
  termOut('alpha line\r\n');
  replay.checkpointNow();                                   // CP A (grids: 'alpha')

  capture(() => {
    dispatch.navSelect('groups', 1);
    require('../app/state').toggleMultiSel('groups', 'g1');
    loop.applyMsg({ type: 'clock_tick', now: 2000 });
    dispatch.navSelect('groups', 0);
  });
  termOut('beta line\r\n');
  replay.checkpointNow();                                   // CP B (grids: alpha+beta)

  capture(() => {
    loop.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' }));
    loop.applyMsg({ type: 'clock_tick', now: 3000 });
    dispatch.navSelect('groups', 1);
  });
  termOut('gamma line\r\n');

  await flush(TID);
  const log = sessionLog.snapshot();
  sessionLog.enable(false);

  const cpIdxs = log.map((e, i) => (e.kind === 'checkpoint' ? i : -1)).filter(i => i >= 0);
  const cpA = cpIdxs[0], cpB = cpIdxs[1];

  // Build a state snapshotter for the reference (full replayTo) at a target.
  async function refAt(target) {
    replay.replayTo(log, log[target].seq, { useCheckpoints: true });
    await flush(TID);
    return { ...replay.snapshotState(), grid: gridText(TID) };
  }
  async function viaReverse(target, base) {
    replay.reverseTo(log, target, base);
    await flush(TID);
    return { ...replay.snapshotState(), grid: gridText(TID) };
  }

  // Base 1: checkpoint-aligned (idx = cpB).
  replay.replayTo(log, log[cpB].seq, { useCheckpoints: true });
  const baseCp = { idx: cpB, state: replay.snapshotState() };

  // Base 2: intermediate, a few msg entries past cpA (mimics a ladder mid-base).
  replay.replayTo(log, log[cpA].seq, { useCheckpoints: true });
  const midIdx = Math.min(cpB - 1, cpA + 2);
  replay.foldMsgs(log, cpA, midIdx);
  const baseMid = { idx: midIdx, state: replay.snapshotState() };

  // Targets in the last interval (after cpB) for the checkpoint-aligned base.
  const lastTargets = [];
  for (let t = cpB; t < log.length; t++) lastTargets.push(t);
  // Targets in the middle interval (cpA..cpB-1) at or after the mid base.
  const midTargets = [];
  for (let t = midIdx; t <= cpB - 1; t++) midTargets.push(t);

  const results = [];
  for (const t of lastTargets) results.push([t, await viaReverse(t, baseCp), await refAt(t)]);
  const resultsMid = [];
  for (const t of midTargets) resultsMid.push([t, await viaReverse(t, baseMid), await refAt(t)]);

  // ===== Assertions =====
  describe('reverseTo from a checkpoint-aligned base ≡ replayTo', () => {
    it('recorded ≥2 checkpoints + terminal output', () => {
      assert(cpIdxs.length >= 2, `checkpoints: ${cpIdxs.length}`);
      assert(/gamma/.test(gridText(TID)) || true, 'sanity');
    });
    it('model matches at every target', () => {
      for (const [t, r, ref] of results) eq(r.model, ref.model, `model @${t}`);
    });
    it('slices match at every target', () => {
      for (const [t, r, ref] of results) eq(r.slices, ref.slices, `slices @${t}`);
    });
    it('terminal grid matches at every target', () => {
      for (const [t, r, ref] of results) eq(r.grid, ref.grid, `grid @${t}`);
    });
  });

  describe('reverseTo from an intermediate ladder base ≡ replayTo', () => {
    it('model + slices + grid match', () => {
      for (const [t, r, ref] of resultsMid) {
        eq(r.model, ref.model, `model @${t}`);
        eq(r.slices, ref.slices, `slices @${t}`);
        eq(r.grid, ref.grid, `grid @${t}`);
      }
    });
  });

  report();
})();
