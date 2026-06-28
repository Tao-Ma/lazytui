/**
 * v0.6.6 replay arc — Phase C: the fold proof (the heart of replay).
 *
 * Two proofs, in-process:
 *   [1] model    = fold(reducer, MsgLog)  — record a session, restore a
 *       checkpoint, re-apply the recorded Msg stream with effects suppressed,
 *       and assert the model + every slice + the rendered frame are identical.
 *   [2] terminal = fold(write, ByteLog)   — re-feed a recorded PTY output byte
 *       stream into a headless xterm (no PTY) and assert the grid matches the
 *       original — the #D14 foreign-component side-channel.
 *
 * Run: node js/test/test-replay.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { Terminal } = require('@xterm/headless');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const api = require('../panel/api');
const loop = require('../dispatch/runtime/loop');
const dispatch = require('../dispatch/control/dispatch');
const sessionLog = require('../io/session-log');
const replay = require('../dispatch/runtime/replay');
const terminal = require('../io/terminal');
const { render } = require('../render/paint');
const { findModalClosure } = require('../dispatch/update/model-ops');

// --- boot a minimal-but-real app ---
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

function stripAnsi(s) { return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b[=>]/g, ''); }
function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { chunks.push(String(s)); return true; };
  try { fn(); } finally { process.stdout.write = orig; }
  return stripAnsi(chunks.join(''));
}
// xterm parses writes asynchronously; flush with the write callback.
function writeSync(xterm, data) { return new Promise(res => xterm.write(data, res)); }
function feedSync(id, data) { return new Promise(res => terminal.feedReplay(id, data, res)); }
function gridText(xterm) {
  const buf = xterm.buffer.active;
  const out = [];
  for (let y = 0; y < xterm.rows; y++) {
    const ln = buf.getLine(buf.viewportY + y);
    out.push(ln ? ln.translateToString(true) : '');
  }
  return out.join('\n');
}

(async () => {
  // ===== Proof 1: model fold =====
  const checkpoint0 = replay.snapshotState();
  sessionLog.enable(true);
  sessionLog.clear();
  // Drive a varied, pane-STABLE session through the real entry points (so it is
  // recorded). Wrapped in capture() to swallow any incidental paint.
  capture(() => {
    loop.applyMsg({ type: 'clock_tick', now: 1234567 });                  // root reducer
    loop.applyMsg({ type: 'jobs_synced', jobs: [                          // a *_synced snapshot
      { id: 1, kind: 'pty', label: 'job-a', status: 'running', startedAt: 1000 }] });
    loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: 'groups' })); // comp + effect cascade
    dispatch.navSelect('groups', 1);                                      // nav helper
    require('../app/state').toggleMultiSel('groups', 'g1');               // mutates a Set in the slice
    loop.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' }));
    dispatch.handleKey('down', 'down');                                   // the real key path
  });
  const liveState = replay.snapshotState();
  const liveFrame = capture(() => render(getModel()));
  const log = sessionLog.snapshot();
  sessionLog.enable(false);

  // Restore the checkpoint and re-apply the recorded stream (effects suppressed).
  replay.replayEntries(log, { fromState: checkpoint0 });
  const replayedState = replay.snapshotState();
  const replayedFrame = capture(() => render(getModel()));

  // ===== Proof 2: terminal grid fold =====
  const cols = 40, rows = 6;
  const chunks = [
    'hello world\r\n',
    '\x1b[31mred line\x1b[0m here\r\n',
    'partial ',
    '\x1b[1mbold\x1b[0m tail\r\n',
  ];
  // Original: feed the bytes to a plain headless xterm.
  const ref = new Terminal({ cols, rows, allowProposedApi: true });
  for (const c of chunks) await writeSync(ref, c);
  const refGrid = gridText(ref);
  // Replay: reconstruct via the recorded `term` WAL (spawn + out chunks).
  const termLog = [{ kind: 'term', id: 'rt', ev: 'spawn', cols, rows }]
    .concat(chunks.map(c => ({ kind: 'term', id: 'rt', ev: 'out', d: c })));
  for (const e of termLog) {
    if (e.ev === 'spawn') terminal.ensureReplaySession(e.id, e.cols, e.rows);
    else if (e.ev === 'out') await feedSync(e.id, e.d);
  }
  const replayGrid = gridText(terminal.getSession('rt').screen);

  // ===== Proof 3: terminal grid snapshot round-trips (the checkpoint snapshot) =====
  const snap = terminal.snapshotSession('rt');
  await new Promise(res => terminal.restoreReplaySession('rt2', snap, res));
  const restoredGrid = gridText(terminal.getSession('rt2').screen);

  // ===== Assertions =====
  describe('[1] model = fold(reducer, MsgLog) from a checkpoint', () => {
    it('the recorded stream is non-trivial', () => assert(log.length >= 6, `entries: ${log.length}`));
    it('replayed model deep-equals the live model', () => eq(replayedState.model, liveState.model));
    it('replayed slices deep-equal the live slices', () => eq(replayedState.slices, liveState.slices));
    it('replayed frame is byte-identical to the live frame', () => eq(replayedFrame, liveFrame));
  });

  // ===== Proof 1b: E14 modal continuation folds (serializable, not a closure) =====
  // Self-contained mini-fold so it doesn't perturb the main frame comparison
  // (an open overlay would shift the painter's module-local diff baseline).
  // Stage a confirm continuation from a fresh checkpoint, fold it, and assert
  // the staged Cmd DESCRIPTOR round-trips — a closure would drop through the
  // checkpoint's JSON snapshot.
  const cpModal = replay.snapshotState();
  sessionLog.enable(true);
  sessionLog.clear();
  capture(() => {
    loop.applyMsg({ type: 'confirm_enter', message: 'Replay me',
      cmd: { type: 'do_run', actionKey: 'a1', action: { script: 'echo hi', type: 'run' } } });
  });
  const liveModal = replay.snapshotState();
  const modalLog = sessionLog.snapshot();
  sessionLog.enable(false);
  replay.replayEntries(modalLog, { fromState: cpModal });
  const replayedModal = replay.snapshotState();

  describe('[1b] E14 modal continuation = fold(reducer, MsgLog)', () => {
    it('a serializable continuation was staged (no closure)', () => {
      assert(liveModal.model.modal.continuation && typeof liveModal.model.modal.continuation === 'object',
        'continuation is a staged object');
      assert(findModalClosure(liveModal.model.modal) === null, 'no closure under model.modal');
    });
    it('the staged continuation folds identically from the checkpoint', () =>
      eq(replayedModal.model.modal.continuation, liveModal.model.modal.continuation));
  });

  describe('[2] terminal grid = fold(write, ByteLog)', () => {
    it('the recorded byte stream reconstructs the original grid', () => {
      assert(/hello world/.test(refGrid), 'sanity: original grid has content');
      eq(replayGrid, refGrid);
    });
  });

  describe('[3] terminal grid snapshot round-trips (checkpoint materialization)', () => {
    it('serialize → restore reproduces the grid text', () => eq(restoredGrid, refGrid));
  });

  report();
})();
