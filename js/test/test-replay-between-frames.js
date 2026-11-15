/**
 * An interactive replay (`:record-load`) between its frames: the stores hold the
 * RECORDING's model, so nothing live may run from it.
 *
 * Round-3 review 2026-11-14: the replay flag was set only inside a fold. A Msg
 * dispatched between frames — the user resizing the outer terminal, an agent
 * event, an async result — ran the full finalizer against the replay frame:
 * the subscription reconcile started the recording's `metrics:` producers on
 * this host, the PTY reconcile spawned a recorded terminal with the recording's
 * command, and that program kept running after the replay ended. And loading a
 * recording while recording replaced the recorder's buffer and seq counter.
 *
 *   [1] isReplaying() holds from enter() until exit() put the live session back
 *   [2] a between-frame Msg starts no recorded metrics producer
 *   [3] a between-frame Msg spawns no recorded terminal; nothing it could have
 *       started outlives the replay
 *   [4] `:record-load` while recording: the live stream's seqs stay monotonic
 *
 * Run: node js/test/test-replay-between-frames.js
 */
'use strict';

const { section, eq, report } = require('./test-runner');
const tl = require('./_helpers/terminal-layout');
const sm = require('./smoke/_helpers/smoke');
const fs = require('fs');
const os = require('os');
const path = require('path');
const terminal = require('../io/terminal');
const route = require('../panel/route');
const mpool = require('../leaves/wm/pool');
const replay = require('../dispatch/runtime/replay');
const replayControl = require('../dispatch/runtime/replay-control');
const sessionLog = require('../io/session-log');
const finalize = require('../dispatch/runtime/finalize');
const state = require('../app/state');
const { effectHost } = require('../dispatch/runtime/effects');
require('../panel/content/pty-lifecycle').install(effectHost());
finalize.setSubscriptionReconciler(state.reconcileSubscriptions);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lazytui-replay-bf-'));
const ran = (f) => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '';
const writeWal = (file, snap) => fs.writeFileSync(file, [
  { seq: 1, t: 1000, kind: 'checkpoint', state: sessionLog.encodeJson(snap), grids: {} },
  { seq: 2, t: 1100, kind: 'msg', lane: 'root', msg: { type: 'clock_tick', now: 1100 } },
].map(e => JSON.stringify(e)).join('\n') + '\n');
const enter = async (wal) => {
  sm.capture(() => replayControl.enter(wal));
  await new Promise(r => setImmediate(r));   // the reconstruct fold
};
const between = () => sm.capture(() => sm.api.dispatchMsg(sm.api.wrap('layout', { type: 'term_resized', cols: 141, rows: 40 })));

(async () => {
  // ---- [1] + [2] a recording whose config declares a metrics producer ----
  {
    const marker = path.join(dir, 'metrics.log');
    sm.bootFresh(); sm.resize(140, 40);
    const snap = replay.snapshotState();
    snap.model.config = { ...snap.model.config, metrics: { rec: { cmd: `echo RECORDED-METRICS-RAN >> ${marker}`, interval: 100,
      extract: { mode: 'regex', pattern: '(\\d+)', fields: { n: { group: 1, type: 'number' } } } } } };
    const wal = path.join(dir, 'metrics.jsonl');
    writeWal(wal, snap);
    const before = replay.isReplaying();
    await enter(wal);
    const during = replay.isReplaying();
    between();
    await sleep(500);
    const metricsRan = ran(marker);
    sm.capture(() => replayControl.exit());
    section('[1] the replay flag spans the whole interactive replay');
    eq([before, during, replay.isReplaying()], [false, true, false], 'off before, on between frames, off after exit');
    section('[2] a between-frame Msg starts no recorded metrics producer');
    eq(metricsRan, '', 'the recording\'s producer command never ran here');
  }

  // ---- [3] a recorded terminal visible in the frame, never spawned ----
  {
    const marker = path.join(dir, 'term.log');
    const fx = tl.boot({ cmd: 'cat' });
    sm.capture(() => sm.render());
    const L = () => route.getInstanceSlice('layout');
    const layout = (m) => sm.api.dispatchMsg(sm.api.wrap('layout', m));
    const viewer = () => mpool.allPanesInColumns(L().arrange).find(p => p.role === 'content');
    // The recorded frame: a terminal tab in the viewer (built with the flag on,
    // so it is not spawned while the fixture is made).
    replay.setReplaying(true);
    layout({ type: 'mint_tab', paneId: viewer().paneId, paneType: 'terminal', poolId: 'term-1', title: 'rec',
      config: { cmd: `echo RECORDED-CMD-RAN >> ${marker}; cat` } });
    const snap = replay.snapshotState();
    layout({ type: 'remove_tab', paneId: viewer().paneId, tabPoolId: 'term-1' });
    replay.setReplaying(false);
    const wal = path.join(dir, 'term.jsonl');
    writeWal(wal, snap);
    await enter(wal);
    const placed = mpool.allPanesInColumns(L().arrange).some(p => (p.tabs || []).some(t => t.poolId === 'term-1'));
    between();
    await sleep(400);
    const during = terminal.getSession('pane-term-1');
    const cmdRan = ran(marker);
    sm.capture(() => replayControl.exit());
    await sleep(100);
    section('[3] a between-frame Msg spawns no recorded terminal');
    eq(placed, true, 'precondition: the frame shows the recorded terminal tab');
    eq([!!(during && during.pty), cmdRan], [false, ''], 'no PTY, the recording\'s command never ran');
    eq(terminal.getSession('pane-term-1') || null, null, 'nothing of it after the replay');
    terminal.destroyAll(); fx.cleanup();
  }

  // ---- [4] loading a recording while recording ----
  {
    sm.bootFresh(); sm.resize(120, 30);
    const live = path.join(dir, 'live.jsonl');
    sessionLog.clear(); sessionLog.enable(true); sessionLog.attachStream(live);
    const tick = (n) => sm.capture(() => require('../dispatch/control/dispatch').applyMsg({ type: 'clock_tick', now: n }));
    for (let i = 0; i < 5; i++) tick(1000 + i);
    const old = path.join(dir, 'old.jsonl');
    fs.writeFileSync(old, [1, 2, 3].map(s => JSON.stringify({ seq: s, t: s, kind: 'msg', lane: 'root', msg: { type: 'clock_tick', now: s } })).join('\n') + '\n');
    const bufBefore = sessionLog.size();
    await enter(old);
    const bufDuring = sessionLog.size();
    sm.capture(() => replayControl.exit());
    for (let i = 0; i < 3; i++) tick(5000 + i);
    sessionLog.enable(false); sessionLog.detachStream();
    const seqs = fs.readFileSync(live, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.seq).map(e => e.seq);
    section('[4] `:record-load` while recording leaves the recorder alone');
    eq(bufDuring >= bufBefore, true, 'the live buffer is not replaced by the loaded file');
    eq(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), true, `the live stream's seqs stay monotonic (${seqs.join(',')})`);
    sessionLog.clear();
  }

  fs.rmSync(dir, { recursive: true, force: true });
  report();
  setTimeout(() => process.exit(0), 50);
})();
