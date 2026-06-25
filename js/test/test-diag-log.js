/**
 * Diagnostics window (leader e) — buffer + collapse producer + reducer arms.
 *
 *   node js/test/test-diag-log.js
 */
'use strict';

const diag = require('../io/diag-log');
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

  it('yankText is a stable [level] code: message one-liner', () => {
    eq(diag.yankText({ level: 'error', code: 'throw', message: 'boom' }),
       '[error] throw: boom', 'formatted line');
    eq(diag.yankText(null), '', 'null entry → empty string');
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

describe('[diag-log] setOnChange contract (store-mirror seam, FIX-1)', () => {
  it('fires cb on every mutation (record / clear); null unregisters', () => {
    diag.clear();
    let fires = 0;
    diag.setOnChange(() => { fires++; });
    diag.warn('a', '1');            // record → fire
    diag.error('b', '2');           // record → fire
    eq(fires, 2, 'each record fired the change cb');
    diag.clear();                   // clear → fire
    eq(fires, 3, 'clear fired the change cb');
    diag.setOnChange(null);         // unregister
    diag.warn('c', '3');
    eq(fires, 3, 'no fire after setOnChange(null)');
    diag.clear();
  });
});

describe('[diag-log] deferred lane (render-path producers, v0.6.6 §9)', () => {
  it('warnDeferred queues without notifying or appearing in the buffer', () => {
    diag.clear();
    let fires = 0;
    diag.setOnChange(() => { fires++; });
    diag.warnDeferred('strict-miss', 'a');
    diag.warnDeferred('plugin-slow', 'b');
    eq(diag.size(), 0, 'nothing in the buffer yet');
    eq(fires, 0, 'no change-notify from a deferred record');
    diag.setOnChange(null);
    diag.clear();
  });

  it('flushDeferred drains the batch in order and fires ONE notify', () => {
    diag.clear();
    let fires = 0;
    diag.setOnChange(() => { fires++; });
    diag.warnDeferred('a', '1');
    diag.warnDeferred('b', '2');
    diag.flushDeferred();
    eq(diag.size(), 2, 'both landed');
    eq(fires, 1, 'one notify for the whole batch (one diag_synced)');
    const snap = diag.snapshot();   // newest-first
    eq(snap[0].code, 'b', 'detection order preserved (newest last-detected)');
    eq(snap[1].code, 'a', 'oldest first-detected');
    assert(typeof snap[0].t === 'number', 'timestamp stamped at flush');
    diag.setOnChange(null);
    diag.clear();
  });

  it('flushDeferred on an empty queue is a no-op (no notify)', () => {
    diag.clear();
    let fires = 0;
    diag.setOnChange(() => { fires++; });
    diag.flushDeferred();
    eq(fires, 0, 'no notify when nothing is pending');
    diag.setOnChange(null);
    diag.clear();
  });

  it('clear() empties the pending queue too', () => {
    diag.clear();
    diag.warnDeferred('x', 'pending');
    diag.clear();                   // must drop the pending entry
    diag.flushDeferred();
    eq(diag.size(), 0, 'cleared pending did not resurface on flush');
  });
});

describe('[diag-log] strict-miss producer (route get/setInstanceSlice)', () => {
  // Split-arc P2 — the silent kind-name fallback is DELETED; a miss
  // whose id names a known kind records `strict-miss` (once per id)
  // and resolves nothing. Replaces the old `pane-collapse` band-aid,
  // which warned but returned the collapsed slice anyway.
  //
  // v0.6.6 §9 follow-up: the tripwire sits on per-frame read paths, so it
  // recordDeferred()s rather than warn()s — the warn lands only after a
  // flushDeferred() (the dispatch finalizer's drain). These tests call it
  // explicitly to model that drain.
  function reset() { route._resetRegistryForTest(); diag.clear(); }

  it('a kind-name read records a strict-miss warn (once) and returns undefined', () => {
    reset();
    route.setInstance('amb-a', 'ambk', { v: 'a' });
    route.setInstance('amb-b', 'ambk', { v: 'b' });
    // paneId reads never warn — they resolve directly (nothing queued).
    route.getInstanceSlice('amb-a');
    diag.flushDeferred();
    eq(diag.size(), 0, 'paneId read does not warn');
    // kind-name read: strict → undefined; queues one warn, no collapse.
    assert(route.getInstanceSlice('ambk') === undefined, 'kind-name read resolves nothing');
    diag.flushDeferred();   // drain (the finalizer's job in production)
    eq(diag.counts().warn, 1, 'one strict-miss warning');
    eq(diag.snapshot()[0].code, 'strict-miss', 'tagged strict-miss');
    // deduped — a second kind-name read queues nothing more.
    route.getInstanceSlice('ambk');
    diag.flushDeferred();
    eq(diag.counts().warn, 1, 'deduped, still one');
    reset();
  });

  it('a kind-name WRITE warns and mutates nothing', () => {
    reset();
    route.setInstance('w-a', 'wk', { v: 'a' });
    route.setInstance('w-b', 'wk', { v: 'b' });
    route.setInstanceSlice('wk', { v: 'clobber' });
    diag.flushDeferred();
    eq(diag.counts().warn, 1, 'strict-miss warned');
    eq(diag.snapshot()[0].code, 'strict-miss', 'tagged strict-miss');
    eq(route.getInstanceSlice('w-a').v, 'a', 'primary NOT written (was the silent-write bug)');
    eq(route.getInstanceSlice('w-b').v, 'b', 'other pane untouched');
    reset();
  });

  it('the detection does NOT write synchronously (render-path purity)', () => {
    reset();
    route.setInstance('p-a', 'pk', { v: 'a' });
    route.setInstance('p-b', 'pk', { v: 'b' });
    let fires = 0;
    diag.setOnChange(() => { fires++; });
    route.getInstanceSlice('pk');   // kind-name read on a "render path"
    eq(diag.size(), 0, 'buffer untouched before the drain');
    eq(fires, 0, 'no change-notify (no re-entrant diag_synced) from the read');
    diag.flushDeferred();
    eq(diag.size(), 1, 'lands on the drain');
    eq(fires, 1, 'exactly one notify for the drained batch');
    diag.setOnChange(null);
    reset();
  });

  it('an unknown-id miss stays quiet (normal pre-init read)', () => {
    reset();
    assert(route.getInstanceSlice('nope') === undefined, 'undefined, no throw');
    route.setInstanceSlice('nope', { x: 1 });
    diag.flushDeferred();
    eq(diag.size(), 0, 'no warning for an id that names no kind');
    reset();
  });
});

describe('[diag-log] reducer arms', () => {
  // A minimal model stub with the modal/modes fields the arms touch.
  function model() {
    return { modes: { diagLogMode: false }, modal: { diagLog: { cursor: 0, scroll: 0 } } };
  }

  it('diag_log_open flips the mode + resets cursor + seeds model.now', () => {
    const [m, cmds] = update(model(), { type: 'diag_log_open', now: 777 });
    eq(m.modes.diagLogMode, true, 'mode on');
    eq(m.modal.diagLog.cursor, 0, 'cursor reset');
    // Age overlay open seeds model.now; the frame clock ticks via the
    // model-conditional `clock` interval Sub (FIX-3 Phase 6), so the open arm
    // emits NO Cmd (was an arm_clock).
    eq(m.now, 777, 'now seeded from msg.now');
    eq(cmds.length, 0, 'no Cmd — the clock is a declared Sub');
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

  it('diag_synced lands the whole snapshot on model.diagLog (FIX-1)', () => {
    const snap = [{ level: 'warn', code: 'x', message: 'y', t: 1 }];
    const [m, cmds] = update(model(), { type: 'diag_synced', diagLog: snap });
    eq(m.diagLog, snap, 'model.diagLog is the synced snapshot');
    eq(cmds.length, 0, 'no Cmd — pure model write');
  });
});

report();
