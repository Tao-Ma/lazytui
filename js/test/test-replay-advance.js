/**
 * v0.6.6 replay arc — incremental forward fold (replay.advance).
 *
 * The interactive player advances forward by applying ONLY the new entries
 * (fromIdx, toIdx] to the live state, instead of re-folding from a checkpoint
 * every frame. This proves that incremental advance is EQUIVALENT to the two
 * full-fold paths it replaces:
 *
 *   advance stepping 0→1→2→…→k   ≡   replayEntries(log[0..k], fromState)
 *                                ≡   replayTo(seq_k, {fromState})
 *
 * for the model + every slice (deterministic), and that a combined model+term
 * session reconstructs the SAME terminal grid via incremental advance as via a
 * fresh full replayTo (the #D14 side-channel folds forward too).
 *
 * Run: node js/test/test-replay-advance.js
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
  const orig = process.stdout.write;
  process.stdout.write = () => true;
  try { return fn(); } finally { process.stdout.write = orig; }
}
const flush = (id) => new Promise(res => terminal.feedReplay(id, '', res));
function gridText(id) {
  const screen = terminal.getSession(id).screen;
  const buf = screen.buffer.active;
  const out = [];
  for (let y = 0; y < screen.rows; y++) {
    const ln = buf.getLine(buf.viewportY + y);
    out.push(ln ? ln.translateToString(true) : '');
  }
  return out.join('\n');
}

(async () => {
  // ===== Record a varied, pane-stable model session =====
  const checkpoint0 = replay.snapshotState();
  sessionLog.enable(true);
  sessionLog.clear();
  capture(() => {
    loop.applyMsg({ type: 'clock_tick', now: 1000 });
    loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: 'groups' }));
    dispatch.navSelect('groups', 1);
    require('../app/state').toggleMultiSel('groups', 'g1');
    loop.applyMsg({ type: 'clock_tick', now: 2000 });
    loop.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' }));
    dispatch.handleKey('down', 'down');
    dispatch.navSelect('groups', 0);
  });
  const log = sessionLog.snapshot();
  sessionLog.enable(false);

  const targets = log.map((_, i) => i);   // every index → covers single-steps AND the full range

  // Incremental: one continuous run, advancing cur→k, snapshot after each k.
  replay.restoreState(checkpoint0);
  const inc = {};
  let cur = -1;
  for (const k of targets) { replay.advance(log, cur, k); cur = k; inc[k] = replay.snapshotState(); }

  // Reference A: replayEntries full-fold of log[0..k] from the clean baseline.
  const refEntries = {};
  for (const k of targets) {
    replay.replayEntries(log.slice(0, k + 1), { fromState: checkpoint0 });
    refEntries[k] = replay.snapshotState();
  }

  // Reference B: replayTo(seq_k) full-fold from the baseline (the backward path).
  const refReplayTo = {};
  for (const k of targets) {
    replay.replayTo(log, log[k].seq, { useCheckpoints: false, fromState: checkpoint0 });
    refReplayTo[k] = replay.snapshotState();
  }

  // ===== Terminal: combined model+term session, grid via advance vs replayTo =====
  // Build two logs identical except for the term session id (independent screens).
  const baseSeq = log.length ? log[log.length - 1].seq : 0;
  const baseT = log.length ? log[log.length - 1].t : 0;
  const cols = 40, rows = 6;
  const chunks = ['hello world\r\n', '\x1b[31mred\x1b[0m line\r\n', 'partial ', '\x1b[1mbold\x1b[0m\r\n'];
  const termLog = (id) => log.concat(
    [{ seq: baseSeq + 1, t: baseT + 1, kind: 'term', id, ev: 'spawn', cols, rows }],
    chunks.map((d, i) => ({ seq: baseSeq + 2 + i, t: baseT + 2 + i, kind: 'term', id, ev: 'out', d })),
  );
  const logA = termLog('adv-a'), logB = termLog('adv-b');
  const lastA = logA.length - 1;

  // Incremental advance over logA (one entry at a time).
  terminal.destroySession('adv-a');
  replay.restoreState(checkpoint0);
  cur = -1;
  for (let k = 0; k <= lastA; k++) { replay.advance(logA, cur, k); cur = k; }
  await flush('adv-a');
  const gridAdvance = gridText('adv-a');

  // Fresh full replayTo over logB.
  terminal.destroySession('adv-b');
  replay.replayTo(logB, logB[logB.length - 1].seq, { useCheckpoints: false, fromState: checkpoint0 });
  await flush('adv-b');
  const gridReplayTo = gridText('adv-b');

  // ===== Assertions =====
  describe('advance ≡ replayEntries full-fold (model + slices)', () => {
    it('recorded a non-trivial session', () => assert(log.length >= 6, `entries: ${log.length}`));
    it('every prefix model matches', () => {
      for (const k of targets) eq(inc[k].model, refEntries[k].model, `model @${k}`);
    });
    it('every prefix slice-set matches', () => {
      for (const k of targets) eq(inc[k].slices, refEntries[k].slices, `slices @${k}`);
    });
  });

  describe('advance ≡ replayTo(seq_k) full-fold (the backward path)', () => {
    it('every prefix model matches', () => {
      for (const k of targets) eq(inc[k].model, refReplayTo[k].model, `model @${k}`);
    });
    it('every prefix slice-set matches', () => {
      for (const k of targets) eq(inc[k].slices, refReplayTo[k].slices, `slices @${k}`);
    });
  });

  describe('advance reconstructs the same terminal grid as replayTo', () => {
    it('grid has the recorded content', () => assert(/hello world/.test(gridAdvance), 'sanity'));
    it('incremental-advance grid == full-replayTo grid', () => eq(gridAdvance, gridReplayTo));
  });

  report();
})();
