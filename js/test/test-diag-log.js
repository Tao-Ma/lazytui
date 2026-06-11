/**
 * Diagnostics window (leader e) — buffer + collapse producer + reducer arms.
 *
 *   node js/test/test-diag-log.js
 */
'use strict';

const diag = require('../dispatch/diag-log');
const route = require('../panel/route');
const { update } = require('../app/runtime');
const { describe, it, assert, eq, report } = require('./test-runner');

describe('[diag-log] buffer', () => {
  it('record / warn / error normalize level + store fields', () => {
    diag.clear();
    diag.warn('config', 'over soft cap');
    diag.error('throw', 'boom');
    diag.record('bogus-level', 'x', 'y');   // normalizes to warn
    const snap = diag.snapshot();
    eq(snap.length, 3, 'three entries');
    // newest-first
    eq(snap[0].code, 'x', 'newest first');
    eq(snap[2].code, 'config', 'oldest last');
    eq(snap[2].level, 'warn', 'warn level');
    eq(snap[1].level, 'error', 'error level');
    eq(snap[0].level, 'warn', 'bogus level → warn');
    assert(typeof snap[0].t === 'number', 'timestamp stamped');
  });

  it('counts() splits warn / error / total', () => {
    diag.clear();
    diag.warn('a', '1'); diag.warn('b', '2'); diag.error('c', '3');
    const c = diag.counts();
    eq(c.warn, 2, 'warn count'); eq(c.error, 1, 'error count'); eq(c.total, 3, 'total');
  });

  it('cap evicts oldest', () => {
    diag.clear();
    diag.setCap(3);
    for (let i = 0; i < 5; i++) diag.warn('k', `m${i}`);
    eq(diag.size(), 3, 'capped at 3');
    const snap = diag.snapshot();   // newest-first
    eq(snap[0].message, 'm4', 'newest kept');
    eq(snap[2].message, 'm2', 'oldest two evicted');
    diag.setCap(diag.DEFAULT_CAP);
    diag.clear();
  });
});

describe('[diag-log] same-kind collapse producer (route.getInstanceSlice)', () => {
  function reset() { route.eachInstance((inst) => route.disposeInstance(inst.id)); diag.clear(); }

  it('a kind-name read with >1 same-kind instance records a pane-collapse warn (once)', () => {
    reset();
    route.setInstance('amb-a', 'ambk', { v: 'a' });
    route.setInstance('amb-b', 'ambk', { v: 'b' });
    // paneId reads never warn — they resolve directly.
    route.getInstanceSlice('amb-a');
    eq(diag.size(), 0, 'paneId read does not warn');
    // kind-name read collapses onto the primary → one warn.
    const slice = route.getInstanceSlice('ambk');
    eq(slice.v, 'a', 'resolved to primary (insertion order)');
    eq(diag.counts().warn, 1, 'one collapse warning');
    eq(diag.snapshot()[0].code, 'pane-collapse', 'tagged pane-collapse');
    // deduped — a second kind-name read does not re-warn.
    route.getInstanceSlice('ambk');
    eq(diag.counts().warn, 1, 'deduped, still one');
    reset();
  });

  it('a singleton kind-name read does NOT warn', () => {
    reset();
    route.setInstance('solo', 'solok', { v: 'x' });
    route.getInstanceSlice('solok');   // 1 instance → not ambiguous
    eq(diag.size(), 0, 'no warning for a singleton');
    reset();
  });

  it('dispose re-arms the warning for a reconfigure', () => {
    reset();
    route.setInstance('r-a', 'rk', {});
    route.setInstance('r-b', 'rk', {});
    route.getInstanceSlice('rk');
    eq(diag.counts().warn, 1, 'warned once');
    // Tear the kind down + rebuild ambiguous → should warn again.
    route.disposeInstance('r-a'); route.disposeInstance('r-b');
    diag.clear();
    route.setInstance('r-c', 'rk', {});
    route.setInstance('r-d', 'rk', {});
    route.getInstanceSlice('rk');
    eq(diag.counts().warn, 1, 're-armed after dispose');
    reset();
  });
});

describe('[diag-log] reducer arms', () => {
  // A minimal model stub with the modal/modes fields the arms touch.
  function model() {
    return { modes: { diagLogMode: false }, modal: { diagLog: { cursor: 0, scroll: 0 } } };
  }

  it('diag_log_open flips the mode + resets cursor', () => {
    const [m, cmds] = update(model(), { type: 'diag_log_open' });
    eq(m.modes.diagLogMode, true, 'mode on');
    eq(m.modal.diagLog.cursor, 0, 'cursor reset');
    eq(cmds.length, 0, 'no cmds');
  });

  it('diag_log_open is a no-op when already open', () => {
    const open = model(); open.modes.diagLogMode = true;
    const [m] = update(open, { type: 'diag_log_open' });
    eq(m, open, 'same ref, no-op');
  });

  it('diag_log_nav clamps cursor + scroll against count', () => {
    const open = model(); open.modes.diagLogMode = true;
    const [m] = update(open, { type: 'diag_log_nav', dir: +5, count: 3, vh: 2 });
    eq(m.modal.diagLog.cursor, 2, 'clamped to count-1');
    assert(m.modal.diagLog.scroll <= 1, 'scroll within range');
  });

  it('diag_log_nav with count 0 is a no-op', () => {
    const open = model(); open.modes.diagLogMode = true;
    const [m] = update(open, { type: 'diag_log_nav', dir: +1, count: 0, vh: 5 });
    eq(m, open, 'no-op on empty buffer');
  });

  it('diag_log_clear emits a diag_clear Cmd + resets cursor', () => {
    const open = model(); open.modes.diagLogMode = true; open.modal.diagLog = { cursor: 4, scroll: 2 };
    const [m, cmds] = update(open, { type: 'diag_log_clear' });
    eq(m.modal.diagLog.cursor, 0, 'cursor reset');
    eq(cmds.length, 1, 'one cmd'); eq(cmds[0].type, 'diag_clear', 'diag_clear cmd');
  });

  it('diag_log_save emits a diag_save Cmd', () => {
    const open = model(); open.modes.diagLogMode = true;
    const [, cmds] = update(open, { type: 'diag_log_save' });
    eq(cmds.length, 1, 'one cmd'); eq(cmds[0].type, 'diag_save', 'diag_save cmd');
  });

  it('diag_log_close flips the mode off', () => {
    const open = model(); open.modes.diagLogMode = true;
    const [m] = update(open, { type: 'diag_log_close' });
    eq(m.modes.diagLogMode, false, 'mode off');
  });
});

report();
