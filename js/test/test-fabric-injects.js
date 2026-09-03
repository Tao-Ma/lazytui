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
  m.currentGroup = 'g';                     // runtime injects/wires are group-scoped (B3)
  m.register = { history: [], cap: 10 };   // avoid lazy auto-init under freeze
  return m;
}
const P = 'xlogminer.start_lsn';
// This group's inject slice — injects are keyed by currentGroup (B3).
const inj = (m) => (m.fabric.injects[m.currentGroup] || {});

describe('[fabric] port_inject', () => {
  it('stores a sticky by-value inject on a fresh model (frozen input)', () => {
    const m = freshModel();
    m.now = 12345;
    const [next, cmds] = expectNoMutation(
      'port_inject leaves input frozen',
      () => runtime.update(m, { type: 'port_inject', port: P, value: '0/1A2B3C0' }),
      m,
    );
    eq(inj(next)[P].value, '0/1A2B3C0');
    eq(inj(next)[P].at, 12345, 'stamped from model.now (replay-safe)');
    eq(Object.keys(inj(m)).length, 0, 'original untouched');
    eq(cmds.length, 0, 'pure state, no effects');
  });

  it('last-write-wins on the same port', () => {
    const m = freshModel();
    const [m1] = runtime.update(m, { type: 'port_inject', port: P, value: 'a' });
    const [m2] = runtime.update(m1, { type: 'port_inject', port: P, value: 'b' });
    eq(inj(m2)[P].value, 'b');
    eq(Object.keys(inj(m2)).length, 1, 'still one entry for the port');
  });

  it('injects to different ports coexist', () => {
    const m = freshModel();
    const [m1] = runtime.update(m, { type: 'port_inject', port: P, value: 'a' });
    const [m2] = runtime.update(m1, { type: 'port_inject', port: 'xlogminer.end_lsn', value: 'z' });
    eq(inj(m2)[P].value, 'a');
    eq(inj(m2)['xlogminer.end_lsn'].value, 'z');
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
    assert(!(P in inj(m3)), 'cleared');
    eq(inj(m3)['xlogminer.end_lsn'].value, 'z', 'other survives');
  });

  it('clearing an absent port is a no-op (same ref)', () => {
    const m = freshModel();
    const [same] = runtime.update(m, { type: 'port_clear', port: 'nope.x' });
    assert(same === m, 'no-op clear returns the same model ref');
  });
});

describe('[fabric] injects are group-scoped — no cross-group bleed (B3)', () => {
  it('an inject in one group is invisible to another group with the same port name', () => {
    let m = freshModel();
    m.currentGroup = 'staging';
    [m] = runtime.update(m, { type: 'port_inject', port: P, value: 'STAGING' });
    m.currentGroup = 'prod';
    eq(Object.keys(inj(m)).length, 0, 'prod sees NO staging inject for the same port (the B3 bleed)');
    [m] = runtime.update(m, { type: 'port_inject', port: P, value: 'PROD' });
    eq(m.fabric.injects.staging[P].value, 'STAGING', 'each group keeps its own value');
    eq(m.fabric.injects.prod[P].value, 'PROD');
    [m] = runtime.update(m, { type: 'port_clear', port: P });   // currentGroup is prod
    eq(m.fabric.injects.staging[P].value, 'STAGING', 'a prod clear leaves staging intact');
    assert(!(P in (m.fabric.injects.prod || {})), 'prod inject cleared');
  });
});

report();
