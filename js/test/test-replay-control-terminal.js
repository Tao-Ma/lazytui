/**
 * v0.6.6 replay arc — `:record-load` must restore LIVE terminal screens on exit.
 *
 * `enter()` snapshots `{model, slices}` aside (liveSnapshot) and `exit()` restores
 * it — but the embedded terminal is the off-model island (#D14). Reconstruction
 * feeds the recorded byte stream into `io/terminal`'s session map, keyed by the
 * RECORDED session id. Terminal ids are deterministic (`group_key`), so a
 * `:record-load` of a session recorded from the same config over a live session
 * COLLIDES: replay writes into the live emulator's screen. Pre-fix, `exit()`
 * restored model+slices but NOT the terminal — the live pane kept showing replay
 * output. This test sets up that collision and asserts exit restores the live grid.
 *
 * Run: node js/test/test-replay-control-terminal.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { describe, it, eq, assert, report } = require('./test-runner');
const sessionLog = require('../io/session-log');
const replayControl = require('../dispatch/runtime/replay-control');
const replayCli = require('../app/replay-cli');
const route = require('../panel/route');
const runtime = require('../app/runtime');
const { getModel, setModel } = require('../model/store');
const state = require('../app/state');
const terminal = require('../io/terminal');
require('../render/paint');   // wires the overlay draw writer so _render() is safe

const TMP = process.env.SCRATCH_DIR || '/tmp';
const wal = path.join(TMP, `replay-term-${process.pid}.jsonl`);
const cap = (fn) => { const o = process.stdout.write; process.stdout.write = () => true; try { fn(); } finally { process.stdout.write = o; } };
const feedSync = (id, d) => new Promise(res => terminal.feedReplay(id, d, res));   // flush the async xterm parse
const gridText = (id) => terminal.sessionViewportRows(id, 24, 80).rows.join('\n');

function boot() {
  route._resetRegistryForTest();
  state._resetSubscriptions();
  setModel(runtime.init());
  replayCli._installRuntime();
  getModel().config = { project_dir: '.', theme: 'monokai', register: {}, files: [], plugins: {}, groups: {} };
  sessionLog.enable(false); sessionLog.clear();
  cap(() => state.initState());
  getModel().projectDir = '.';
}

const SID = 'g1_shell';   // a deterministic group_key id — the colliding case

(async () => {
  // ---- hand-build a WAL that feeds DIFFERENT content into the SAME session id ----
  const entries = [
    { seq: 1, t: 1000, kind: 'msg',  lane: 'root', msg: { type: 'clock_tick', now: 1000 } },
    { seq: 2, t: 1000, kind: 'term', id: SID, ev: 'spawn', cols: 80, rows: 24 },
    { seq: 3, t: 1100, kind: 'term', id: SID, ev: 'out', d: 'REPLAY-CONTENT' },
  ];
  fs.writeFileSync(wal, entries.map(e => JSON.stringify(e)).join('\n') + '\n');

  // ---- establish a LIVE terminal session with known content ----
  boot();
  terminal.ensureReplaySession(SID, 80, 24);
  await feedSync(SID, 'LIVE-CONTENT');
  const liveText = gridText(SID);

  // ---- a session spawned only DURING replay (id NOT live) must not linger ----
  const REPLAY_ONLY = 'g1_other';

  // ---- enter interactive replay; flush the reconstruct + the terminal feed ----
  replayControl.enter(wal);
  await new Promise(res => setImmediate(res));   // flush the reconstruct fold
  terminal.ensureReplaySession(REPLAY_ONLY, 80, 24);   // simulate a replay-only spawn
  await feedSync(REPLAY_ONLY, 'ONLY-IN-REPLAY');
  await feedSync(SID, '');                              // flush queued replay writes into SID
  const duringText = gridText(SID);
  const replayOnlyExistsDuring = !!terminal.getSession(REPLAY_ONLY);

  // ---- exit → live session must be restored (model AND terminal) ----
  replayControl.exit();
  await feedSync(SID, '');                              // flush the restore write
  const afterText = gridText(SID);
  const replayOnlyExistsAfter = !!terminal.getSession(REPLAY_ONLY);

  describe('[1] collision is real (replay writes into the live session screen)', () => {
    it('live terminal shows LIVE content before replay', () => assert(/LIVE-CONTENT/.test(liveText), liveText));
    it('replay output landed in the colliding live session', () => assert(/REPLAY-CONTENT/.test(duringText), duringText));
  });
  describe('[2] exit() restores the live terminal grid', () => {
    it('live content is back', () => assert(/LIVE-CONTENT/.test(afterText), `after exit: ${JSON.stringify(afterText)}`));
    it('replay output is gone', () => assert(!/REPLAY-CONTENT/.test(afterText), `replay content lingered: ${JSON.stringify(afterText)}`));
  });
  describe('[3] replay-only sessions do not linger after exit', () => {
    it('existed during replay', () => assert(replayOnlyExistsDuring, 'replay-only session present during'));
    it('destroyed on exit', () => eq(replayOnlyExistsAfter, false));
  });

  // ---- [4] restoring over a colliding LIVE session disposes it (no leak) ----
  // restoreReplaySession overwrites sessions[id]; without a dispose-before-overwrite
  // the prior screen (and, for a live id, its PTY + onData listener) would leak.
  // This is the worst case: a colliding live PTY-backed session.
  let killed = false, subDisposed = false, screenDisposed = false;
  terminal._setSessionForTest('g1_pty', {
    pty: { kill() { killed = true; } },
    screen: { dispose() { screenDisposed = true; } },
    cmd: 'x', cwd: '.', exited: false, exitCode: null,
    _onDataSub: { dispose() { subDisposed = true; } },
  });
  terminal.restoreLiveSessions({ 'g1_pty': { cols: 80, rows: 24, lines: ['x'], baseY: 0, viewportY: 0 } });
  const restored = terminal.getSession('g1_pty');

  describe('[4] restoreLiveSessions disposes a colliding live session (no leak)', () => {
    it('killed the colliding live PTY before overwrite (no process leak)', () => assert(killed, 'pty.kill called'));
    it('disposed its onData listener and screen (no listener/emulator leak)', () => {
      assert(subDisposed, 'onData disposed'); assert(screenDisposed, 'screen disposed');
    });
    it('the session is now PTY-less (frozen at the live grid)', () => assert(restored && restored.pty === null, 'frozen replay session'));
  });

  try { fs.unlinkSync(wal); } catch {}
  report();
})();
