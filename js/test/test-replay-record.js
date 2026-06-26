/**
 * v0.6.6 replay arc — Phase B: the recording layer (session WAL).
 *
 * Verifies io/session-log captures every Msg at the three loop entry points
 * (root/comp/key lanes) under one monotonic global `seq`, that the stream
 * round-trips through JSON (serializability — the file-persistence precondition),
 * that it is a no-op when disabled, and that terminal foreign-component events
 * feed the SAME log via the injected recorder hook.
 *
 * Run: node js/test/test-replay-record.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { initState } = require('../app/state');
const sessionLog = require('../io/session-log');
const loop = require('../dispatch/runtime/loop');
const api = require('../panel/api');

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

describe('[1] records the Msg stream across all three lanes', () => {
  it('captures root / comp / key entries in monotonic seq order', () => {
    sessionLog.enable(true);
    sessionLog.clear();
    loop.applyMsg({ type: 'clock_tick', now: 1717171717 });          // root lane
    loop.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: 'groups' })); // comp lane
    loop.dispatchKeyToFocused('x', 'x');                              // key lane
    const snap = sessionLog.snapshot();

    assert(snap.length >= 3, `recorded entries: ${snap.length}`);
    // seq is strictly increasing across the whole stream.
    for (let i = 1; i < snap.length; i++) {
      assert(snap[i].seq > snap[i - 1].seq, `seq monotonic at ${i}`);
    }
    const root = snap.find(e => e.kind === 'msg' && e.lane === 'root' && e.msg && e.msg.type === 'clock_tick');
    assert(root && root.msg.now === 1717171717, 'root clock_tick recorded with payload');
    const comp = snap.find(e => e.kind === 'msg' && e.lane === 'comp' && e.msg && e.msg.kind === 'layout');
    assert(comp, 'comp wrapped layout Msg recorded');
    const key = snap.find(e => e.kind === 'msg' && e.lane === 'key' && e.key === 'x');
    assert(key && key.keySeq === 'x', 'key entry recorded with key + keySeq');
  });
});

describe('[2] the stream round-trips through JSON (serializable)', () => {
  it('JSON.parse(JSON.stringify(log)) deep-equals the log', () => {
    const snap = sessionLog.snapshot();
    const round = JSON.parse(JSON.stringify(snap));
    eq(round, snap, 'log survives a JSON round-trip unchanged');
  });
});

describe('[3] disabled = no-op (zero recording)', () => {
  it('records nothing when disabled', () => {
    sessionLog.enable(false);
    sessionLog.clear();
    loop.applyMsg({ type: 'clock_tick', now: 42 });
    eq(sessionLog.size(), 0, 'no entries recorded while disabled');
  });
});

describe('[4] terminal events feed the same WAL via the injected hook', () => {
  it('a terminal resize records a kind:term entry sharing the global seq', () => {
    const terminal = require('../io/terminal');
    const { Terminal } = require('@xterm/headless');
    // Wire the same hook tui.js wires at boot (pty-lifecycle.install).
    terminal.setSessionRecorder(sessionLog.recordTerm);
    sessionLog.enable(true);
    sessionLog.clear();

    // A Msg first (so we can prove term entries interleave on the same seq).
    loop.applyMsg({ type: 'clock_tick', now: 99 });
    const afterMsg = sessionLog.snapshot().slice(-1)[0].seq;

    terminal._setSessionForTest('t1', { screen: new Terminal({ cols: 10, rows: 4 }), exited: false });
    terminal.resizeSession('t1', 20, 6);

    const snap = sessionLog.snapshot();
    const term = snap.find(e => e.kind === 'term' && e.id === 't1' && e.ev === 'resize');
    assert(term, 'terminal resize recorded as a term entry');
    eq([term.cols, term.rows], [20, 6], 'resize geometry recorded');
    assert(term.seq > afterMsg, 'term entry shares + advances the global seq');

    terminal.setSessionRecorder(null);
    sessionLog.enable(false);
    sessionLog.clear();
  });
});

report();
