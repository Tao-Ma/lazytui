/**
 * Fabric injects — the by-value, sticky port_inject / port_clear store
 * (docs/ports-and-wires.md, decision 1). Exercised through the ROOT reducer
 * (runtime.update) so it also proves the sub-reducer delegation, with a frozen
 * input to prove purity.
 * Run: node js/test/test-fabric-injects.js
 */
'use strict';

const { describe, it, eq, assert, expectNoMutation, report } = require('./test-runner');
const runtime = require('../app/runtime');

function freshModel() {
  const m = runtime.init();
  m.register = { history: [], cap: 10 };   // avoid lazy auto-init under freeze
  return m;
}
const P = 'xlogminer.start_lsn';

describe('[fabric] port_inject', () => {
  it('stores a sticky by-value inject on a fresh model (frozen input)', () => {
    const m = freshModel();
    m.now = 12345;
    const [next, cmds] = expectNoMutation(
      'port_inject leaves input frozen',
      () => runtime.update(m, { type: 'port_inject', port: P, value: '0/1A2B3C0' }),
      m,
    );
    eq(next.fabric.injects[P].value, '0/1A2B3C0');
    eq(next.fabric.injects[P].at, 12345, 'stamped from model.now (replay-safe)');
    eq(Object.keys(m.fabric.injects).length, 0, 'original untouched');
    eq(cmds.length, 0, 'pure state, no effects');
  });

  it('last-write-wins on the same port', () => {
    const m = freshModel();
    const [m1] = runtime.update(m, { type: 'port_inject', port: P, value: 'a' });
    const [m2] = runtime.update(m1, { type: 'port_inject', port: P, value: 'b' });
    eq(m2.fabric.injects[P].value, 'b');
    eq(Object.keys(m2.fabric.injects).length, 1, 'still one entry for the port');
  });

  it('injects to different ports coexist', () => {
    const m = freshModel();
    const [m1] = runtime.update(m, { type: 'port_inject', port: P, value: 'a' });
    const [m2] = runtime.update(m1, { type: 'port_inject', port: 'xlogminer.end_lsn', value: 'z' });
    eq(m2.fabric.injects[P].value, 'a');
    eq(m2.fabric.injects['xlogminer.end_lsn'].value, 'z');
  });

  it('ignores a non-string / empty port (no-op, same ref)', () => {
    const m = freshModel();
    const [a] = runtime.update(m, { type: 'port_inject', port: null, value: 'x' });
    assert(a === m, 'null port → identity-preserved');
    const [b] = runtime.update(m, { type: 'port_inject', port: '', value: 'x' });
    assert(b === m, 'empty port → identity-preserved');
  });
});

describe('[fabric] port_clear', () => {
  it('removes an inject; leaves others', () => {
    const m = freshModel();
    const [m1] = runtime.update(m, { type: 'port_inject', port: P, value: 'a' });
    const [m2] = runtime.update(m1, { type: 'port_inject', port: 'xlogminer.end_lsn', value: 'z' });
    const [m3] = runtime.update(m2, { type: 'port_clear', port: P });
    assert(!(P in m3.fabric.injects), 'cleared');
    eq(m3.fabric.injects['xlogminer.end_lsn'].value, 'z', 'other survives');
  });

  it('clearing an absent port is a no-op (same ref)', () => {
    const m = freshModel();
    const [same] = runtime.update(m, { type: 'port_clear', port: 'nope.x' });
    assert(same === m, 'no-op clear returns the same model ref');
  });
});

report();
