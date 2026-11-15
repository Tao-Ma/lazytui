/**
 * v0.6.6 replay arc — `:record-load` must restore LIVE terminal screens on exit.
 *
 * `enter()` snapshots `{model, slices}` aside (liveSnapshot) and `exit()` restores
 * it — but the embedded terminal is the off-model island (#D14). Reconstruction
 * feeds the recorded byte stream into `io/terminal`'s session map, keyed by the
 * RECORDED session id. Terminal ids are deterministic (`pane-<poolId>`), so a
 * `:record-load` of a session recorded from the same config over a live session
 * COLLIDES: the replay takes that id over (a PTY-less replay session replaces
 * the live one). Pre-fix, `exit()` restored model+slices but NOT the terminal —
 * the live pane kept showing replay output. This test sets up that collision
 * and asserts exit restores the live grid, and that replay never reaches a live
 * program ([5]).
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
  // Flush the restore's parse on the screen itself — a feedReplay now would be a
  // replay write, taking the restored live pane over again.
  await new Promise(res => require('../io/term-screen').writeScreen(terminal.getSession(SID).screen, '', res));
  const afterText = gridText(SID);
  const replayOnlyExistsAfter = !!terminal.getSession(REPLAY_ONLY);

  describe('[1] collision is real (the replay takes the live session\'s id over)', () => {
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

  // ---- [4] leaving replay: what was live comes back, and nothing leaks ----
  // A replay session that took a live id over is rebuilt from the live grid
  // (its screen disposed first — no emulator leak), frozen and marked stopped
  // (its program was stopped when the replay took the id). A live session the
  // replay never touched is still the live one: left running (it was killed,
  // and its tab closed by the exit fan-out — round-2 review 2026-11-14).
  let screenDisposed = false, liveKilled = false;
  terminal._setSessionForTest('g1_took', {
    pty: null, screen: { dispose() { screenDisposed = true; } },
    cmd: null, cwd: null, exited: false, exitCode: null, replay: true,
  });
  const untouched = {
    pty: { kill() { liveKilled = true; } }, screen: { dispose() {} },
    cmd: 'x', cwd: '.', exited: false, exitCode: null,
  };
  terminal._setSessionForTest('g1_untouched', untouched);
  const grid = { cols: 80, rows: 24, lines: ['x'], baseY: 0, viewportY: 0 };
  terminal.restoreLiveSessions({ g1_took: grid, g1_untouched: grid });
  const took = terminal.getSession('g1_took');

  describe('[4] restoreLiveSessions: the replaced come back stopped, the untouched keep running', () => {
    it('a replaced session: its replay screen disposed (no leak), rebuilt PTY-less', () => {
      assert(screenDisposed, 'screen disposed'); assert(took && took.pty === null, 'frozen');
    });
    it('… marked stopped, so Enter restarts it and the banner says so', () => eq([took.exited, took.exitCode], [true, null]));
    it('an untouched live session is left running', () => {
      assert(!liveKilled, 'not killed'); assert(terminal.getSession('g1_untouched') === untouched, 'the same live session');
    });
  });
  terminal.destroyAll();

  // ---- [5] a replay never reaches a LIVE program (pre-release review T1-4) ----
  // The live sessions above are PTY-less. With a PTY-backed one, the replayed
  // stream used to be fed INTO it: its emulator answered the RECORDED queries
  // into the live program's stdin (the reply wiring of 19ebbf2b), and a
  // recorded resize resized the live PTY. The first replay entry for a live id
  // now replaces the session (the documented `:record-load` caveat).
  if (terminal.ptyAvailable()) {
    const os = require('os');
    const replay = require('../dispatch/runtime/replay');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-replay-live-'));
    const child = path.join(dir, 'child.js');
    const stdinLog = (n) => path.join(dir, `stdin-${n}`);
    fs.writeFileSync(child, `process.stdin.setRawMode(true); process.stdout.write('READY\\n');
process.stdin.on('data', d => require('fs').appendFileSync(process.argv[2], d.toString('latin1')));`);
    const live = {};
    const exits = [];
    terminal.setExitHandler((id, code) => exits.push(id));
    for (const n of ['a', 'b', 'c']) {
      const id = `g1_live_${n}`;
      terminal.ensureSession(id, `${process.execPath} ${child} ${stdinLog(n)}`, 80, 24, dir);
      live[n] = { id, resized: false };
      const p = terminal.getSession(id).pty;
      const resize = p.resize.bind(p);
      p.resize = (...args) => { live[n].resized = true; return resize(...args); };
    }
    for (let i = 0; i < 150; i++) {
      if (['a', 'b', 'c'].every(n => gridText(live[n].id).includes('READY'))) break;
      await new Promise(res => setTimeout(res, 30));
    }
    const grids = terminal.snapshotAllSessions();   // what enter() snapshots
    const liveC = terminal.getSession(live.c.id);
    const queries = 'hello\x1b[c\x1b[>c\x1b[6n\x1b]11;?\x07';
    replay.replayTo([
      { seq: 1, kind: 'term', ev: 'spawn', id: live.a.id, cols: 80, rows: 24 },   // a: spawned, then fed
      { seq: 2, kind: 'term', ev: 'out', id: live.a.id, d: queries },
      { seq: 3, kind: 'term', ev: 'resize', id: live.b.id, cols: 70, rows: 20 },  // b: no spawn in the log
      { seq: 4, kind: 'term', ev: 'out', id: live.b.id, d: queries },
    ], Infinity, { useCheckpoints: true });
    await new Promise(res => setTimeout(res, 400));
    const read = (n) => { try { return fs.readFileSync(stdinLog(n), 'latin1'); } catch { return ''; } };
    describe('[5] a replay never reaches a live program', () => {
      for (const n of ['a', 'b']) {
        it(`${live[n].id}: its program read nothing from the replay`, () => eq(read(n), ''));
        it(`${live[n].id}: the session is the replay's now (PTY-less)`, () => {
          const s = terminal.getSession(live[n].id);
          assert(s && s.replay && s.pty === null, 'replaced by a replay session');
        });
        it(`${live[n].id}: its live PTY was not resized`, () => eq(live[n].resized, false));
      }
      it('the replay still shows the recorded output', () => assert(/hello/.test(gridText(live.b.id)), gridText(live.b.id)));
      // The live programs it stopped don't report an exit: the fan-out would act
      // on the replay frame (closing the recorded tab, …) — round-2 review.
      it('the replaced programs\' exits reach no exit handler', () => eq(exits.filter(id => id !== live.c.id), []));
    });
    // A replay frame dropping a pane (its layout lacks it) disposes the pane's
    // instance; a live session behind it must survive — only replay-built
    // screens go with their instances under replay.
    const state = require('../app/state');
    replay.setReplaying(true);
    try { state.disposePaneInstance(live.c.id, 'terminal'); } finally { replay.setReplaying(false); }
    const ownC = terminal.getSession(live.c.id);
    terminal.restoreLiveSessions(grids);
    await new Promise(res => setTimeout(res, 200));
    describe('[6] leaving the replay', () => {
      it('a live session the replay never touched survived the replay frame dropping its pane', () => assert(ownC === liveC && ownC.pty, 'still live'));
      it('… and after exit it is still the live one, running', () => {
        const s = terminal.getSession(live.c.id);
        assert(s === liveC && s.pty && !s.exited, 'running');
      });
      it('a replaced one comes back stopped, and restarts with its own command', () => {
        const s = terminal.getSession(live.a.id);
        eq([s.exited, s.exitCode, s.pty], [true, null, null]);
        const own = `${process.execPath} ${child} ${stdinLog('a')}`;
        eq([s.cmd, s.cwd], [own, dir], 'it keeps the live session\'s command and directory');
        const r = terminal.restartSession(live.a.id, 80, 24, { cmd: 'not-this', cwd: '/' });
        assert(r && r.pty && r.cmd === own, 'a live PTY again, running what it ran');
      });
      it('a recorded spawn with no size takes the default (it threw)', () => {
        const s = terminal.ensureReplaySession('g1_sizeless');
        eq(require('../io/term-screen').screenSize(s.screen), { cols: 80, rows: 24 });
      });
    });
    terminal.setExitHandler(null);
    terminal.destroyAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- [7]–[10] round-3 review 2026-11-14 ----
  // [7] The pane a replay took over came back as a REPLAY session (stopped): the
  // next replay found "its own" screen and fed it — its frame showed `Process
  // stopped` on a terminal that ran in the recording. [8] One that had exited on
  // its own came back `Process stopped` (its code lost). [9] A recorded restart
  // (spawn, out, exit, spawn, out) replayed both runs onto one screen, exited.
  // [10] A live program started during the replay (against a replay frame)
  // kept running behind the live tab after exit.
  {
    const emu = require('../io/term-screen');
    const replay = require('../dispatch/runtime/replay');
    const flush = (id) => new Promise(res => emu.writeScreen(terminal.getSession(id).screen, '', res));
    const liveOf = (o) => ({ pty: { kill() {} }, screen: emu.createScreen(40, 5), cwd: '/w', exitCode: null, exited: false, ...o });

    terminal._setSessionForTest('g7', liveOf({ cmd: 'own-7' }));
    let grids = terminal.snapshotAllSessions();
    terminal.ensureReplaySession('g7', 40, 5);          // replay #1 takes it over
    terminal.restoreLiveSessions(grids);
    const back = terminal.getSession('g7');
    const backState = [back.replay, back.exited, back.exitCode, back.cmd, back.cwd];
    grids = terminal.snapshotAllSessions();
    terminal.feedReplay('g7', 'REC');                   // replay #2's first touch
    await flush('g7');
    const second = terminal.getSession('g7');
    const secondState = [second.replay, second.exited, second.exitCode];
    terminal.restoreLiveSessions(grids);
    const again = terminal.getSession('g7');
    describe('[7] a pane a replay took over is the live pane\'s again after it', () => {
      it('back: not a replay screen, stopped, its own command kept', () => eq(backState, [false, true, null, 'own-7', '/w']));
      it('the next replay takes it over afresh: no stale stop on its frame', () => eq(secondState, [true, false, null]));
      it('… and after that one, it is back stopped again', () => eq([again.replay, again.exited, again.exitCode, again.cmd], [false, true, null, 'own-7']));
    });

    terminal._setSessionForTest('g8', liveOf({ cmd: 'own-8', exited: true, exitCode: 3, pty: null }));
    grids = terminal.snapshotAllSessions();
    terminal.feedReplay('g8', 'REC');
    terminal.restoreLiveSessions(grids);
    const g8 = terminal.getSession('g8');
    describe('[8] a pane whose program had exited on its own keeps its exit code', () => {
      it('exited 3, not `stopped`', () => eq([g8.exited, g8.exitCode], [true, 3]));
    });

    const id9 = 'g9';
    replay.replayTo([
      { seq: 1, kind: 'term', id: id9, ev: 'spawn', cmd: 'x', cols: 40, rows: 5 },
      { seq: 2, kind: 'term', id: id9, ev: 'out', d: 'FIRST-RUN\r\n' },
      { seq: 3, kind: 'term', id: id9, ev: 'exit', code: 1 },
      { seq: 4, kind: 'term', id: id9, ev: 'spawn', cmd: 'x', cols: 40, rows: 5 },
      { seq: 5, kind: 'term', id: id9, ev: 'out', d: 'SECOND-RUN\r\n' },
    ]);
    await flush(id9);
    const g9 = terminal.getSession(id9);
    const g9Text = terminal.sessionViewportRows(id9, 5, 40).rows.join('|');
    describe('[9] a recorded restart replays as a new program', () => {
      it('running, as recorded', () => eq([g9.exited, g9.exitCode], [false, null]));
      it('only the second run on its screen', () => assert(/SECOND-RUN/.test(g9Text) && !/FIRST-RUN/.test(g9Text), g9Text));
    });

    let killed = false;
    grids = terminal.snapshotAllSessions();
    terminal._setSessionForTest('g10', liveOf({ cmd: 'started-during', pty: { kill() { killed = true; } } }));
    terminal.restoreLiveSessions(grids);
    describe('[10] a live program started during the replay does not outlive it', () => {
      it('gone, its program killed', () => eq([!!terminal.getSession('g10'), killed], [false, true]));
    });
    terminal.destroyAll();
  }

  try { fs.unlinkSync(wal); } catch {}
  report();
})();
