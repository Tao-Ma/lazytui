/**
 * kill-signals leaf — the signal catalog + the kill-picker menu builder.
 * Pins the pure facts the killable process table + the `kill_signal` verb both
 * depend on: the row shape, the pid guard, and the whitelist membership.
 *
 * Run: node js/test/test-kill-signals.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { SIGNALS, isSignalablePid, buildKillMenu, killAction } = require('../leaves/proc/kill-signals');

describe('[kill-signals] isSignalablePid — integer pid > 1 only', () => {
  it('accepts plausible pids (number or numeric string)', () => {
    for (const p of [2, 42, 1234, '2', '999999']) assert(isSignalablePid(p), `pid ${p} signalable`);
  });
  it('rejects init (1), 0, negative, non-integer, garbage', () => {
    for (const p of [1, 0, -5, 3.5, 'abc', '', '12x', null, undefined, NaN, {}]) {
      assert(!isSignalablePid(p), `pid ${JSON.stringify(p)} NOT signalable`);
    }
  });
});

describe('[kill-signals] buildKillMenu — [label, verb, arg] rows', () => {
  it('one row per catalogued signal, SIGTERM leads', () => {
    const rows = buildKillMenu(1234);
    eq(rows.length, SIGNALS.length, 'row per signal');
    eq(rows[0], ['SIGTERM (15)', 'kill_signal', { pid: 1234, sig: 'TERM' }], 'SIGTERM first (the safe default the picker opens on)');
  });
  it('includes the forced SIGKILL fallback', () => {
    const rows = buildKillMenu(1234);
    assert(rows.some(r => r[1] === 'kill_signal' && r[2].sig === 'KILL'), 'SIGKILL present');
  });
  it('every row is the kill_signal verb carrying the FROZEN pid', () => {
    const rows = buildKillMenu(4242);
    for (const [label, verb, arg] of rows) {
      eq(verb, 'kill_signal');
      eq(arg.pid, 4242, 'pid frozen into the arg');
      assert(/^SIG[A-Z0-9]+ \(\d+\)$/.test(label), `label formatted: ${label}`);
      assert(SIGNALS.some(([s]) => s === arg.sig), `sig ${arg.sig} is catalogued`);
    }
  });
  it('numeric string pid coerces to a number in the arg', () => {
    eq(buildKillMenu('777')[0][2].pid, 777);
  });
  it('unsignalable rowKey → [] (no menu, so the caller does not claim the key)', () => {
    for (const p of [1, 0, -1, 'kworker', '', null, undefined, 3.14]) {
      eq(buildKillMenu(p), [], `buildKillMenu(${JSON.stringify(p)}) empty`);
    }
  });
});

describe('[kill-signals] killAction — the runAction descriptor for a picked signal', () => {
  it('builds `kill -<sig> <pid>` (type run) for a valid pick', () => {
    eq(killAction({ pid: 4242, sig: 'KILL' }), {
      actionKey: 'kill-KILL-4242',
      action: { type: 'run', script: 'kill -KILL 4242', label: 'kill -KILL 4242' },
    });
  });
  it('numeric-string pid coerces into the command', () => {
    eq(killAction({ pid: '777', sig: 'TERM' }).action.script, 'kill -TERM 777');
  });
  it('whitelists the signal name — an unknown/crafted sig falls back to TERM (no injection)', () => {
    eq(killAction({ pid: 42, sig: 'evil; rm -rf /' }).action.script, 'kill -TERM 42');
    eq(killAction({ pid: 42, sig: '' }).action.script, 'kill -TERM 42');
    eq(killAction({ pid: 42 }).action.script, 'kill -TERM 42', 'missing sig → TERM');
  });
  it('returns null for an unsignalable pid (guard mirrors buildKillMenu)', () => {
    for (const p of [1, 0, -1, 'x', null, undefined, 3.14]) eq(killAction({ pid: p, sig: 'TERM' }), null, `pid ${JSON.stringify(p)}`);
    eq(killAction(null), null, 'no arg');
  });
});

report();
