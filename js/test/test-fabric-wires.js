/**
 * Fabric runtime wires — the interactively-created wire store
 * (docs/ports-and-wires.md, P1.5 pane wiring). Two layers:
 *   - mergeWires: the pure config+runtime merge leaf (js/fabric/wires.js);
 *   - wire_create / wire_delete: exercised through the ROOT reducer so it also
 *     proves the sub-reducer delegation, with a frozen input to prove purity.
 * Run: node js/test/test-fabric-wires.js
 */
'use strict';

const { describe, it, eq, assert, expectNoMutation, report } = require('./test-runner');
const { mergeWires } = require('../fabric/wires');
const runtime = require('../app/runtime');

function freshModel() {
  const m = runtime.init();
  m.currentGroup = 'g';                     // runtime wires are group-scoped (B3)
  m.register = { history: [], cap: 10 };   // avoid lazy auto-init under freeze
  return m;
}
const A = 'controldata.redo_lsn';
// This group's runtime-wire slice — wires are keyed by currentGroup (B3).
const wr = (m) => (m.fabric.wires[m.currentGroup] || []);
const B = 'xlogminer.start_lsn';

describe('[fabric] mergeWires (pure)', () => {
  it('config-only wires pass through tagged config, in order', () => {
    const out = mergeWires([{ from: A, to: B }, { from: 'p.x', to: 'q.y' }], []);
    eq(out.length, 2);
    eq(out[0].from, A);
    eq(out[0].to, B);
    eq(out[0].source, 'config');
    eq(out[1].source, 'config');
  });

  it('runtime-only wires are tagged runtime', () => {
    const out = mergeWires([], [{ from: A, to: B }]);
    eq(out.length, 1);
    eq(out[0].source, 'runtime');
  });

  it('a runtime wire OVERRIDES a config wire to the same input (by `to`)', () => {
    const out = mergeWires([{ from: A, to: B }], [{ from: 'other.z', to: B }]);
    eq(out.length, 1, 'one wire per input `to`');
    eq(out[0].from, 'other.z', 'runtime wins');
    eq(out[0].source, 'runtime');
  });

  it('preserves first-seen `to` order across the merge', () => {
    const out = mergeWires(
      [{ from: 'a.1', to: 'z.1' }, { from: 'a.2', to: 'z.2' }],
      [{ from: 'b.9', to: 'z.1' }],   // overrides the FIRST — keeps its slot
    );
    eq(out.map((w) => w.to).join(','), 'z.1,z.2');
    eq(out[0].from, 'b.9');
  });

  it('drops malformed entries rather than throwing', () => {
    const out = mergeWires([{ from: A }, null, { to: B }, 5], [{ from: A, to: B }]);
    eq(out.length, 1);
    eq(out[0].from, A);
  });

  it('empty / undefined inputs → []', () => {
    eq(mergeWires().length, 0);
    eq(mergeWires(null, null).length, 0);
  });
});

describe('[fabric] wire_create', () => {
  it('appends a runtime wire on a fresh model (frozen input)', () => {
    const m = freshModel();
    const [next, cmds] = expectNoMutation(
      'wire_create leaves input frozen',
      () => runtime.update(m, { type: 'wire_create', from: A, to: B }),
      m,
    );
    eq(wr(next).length, 1);
    eq(wr(next)[0].from, A);
    eq(wr(next)[0].to, B);
    eq(wr(m).length, 0, 'original untouched');
    eq(cmds.length, 0, 'pure state, no effects');
  });

  it('last-write-wins per input `to` (one wire per input)', () => {
    const m = freshModel();
    const [m1] = runtime.update(m, { type: 'wire_create', from: A, to: B });
    const [m2] = runtime.update(m1, { type: 'wire_create', from: 'other.z', to: B });
    eq(wr(m2).length, 1, 'replaced, not appended');
    eq(wr(m2)[0].from, 'other.z');
  });

  it('wires to different inputs coexist', () => {
    const m = freshModel();
    const [m1] = runtime.update(m, { type: 'wire_create', from: A, to: B });
    const [m2] = runtime.update(m1, { type: 'wire_create', from: A, to: 'xlogminer.end_lsn' });
    eq(wr(m2).length, 2);
  });

  it('re-creating the identical sole edge is a no-op (identity-preserved)', () => {
    const m = freshModel();
    const [m1] = runtime.update(m, { type: 'wire_create', from: A, to: B });
    const [m2] = runtime.update(m1, { type: 'wire_create', from: A, to: B });
    assert(m2 === m1, 'no churn on an identical re-wire');
  });

  it('ignores a non-string / empty endpoint (no-op, same ref)', () => {
    const m = freshModel();
    const [a] = runtime.update(m, { type: 'wire_create', from: A, to: '' });
    assert(a === m, 'empty to → identity-preserved');
    const [b] = runtime.update(m, { type: 'wire_create', from: null, to: B });
    assert(b === m, 'null from → identity-preserved');
  });
});

describe('[fabric] wire_delete', () => {
  it('removes a runtime wire by exact endpoints; leaves others', () => {
    const m = freshModel();
    const [m1] = runtime.update(m, { type: 'wire_create', from: A, to: B });
    const [m2] = runtime.update(m1, { type: 'wire_create', from: A, to: 'xlogminer.end_lsn' });
    const [m3] = runtime.update(m2, { type: 'wire_delete', from: A, to: B });
    eq(wr(m3).length, 1);
    eq(wr(m3)[0].to, 'xlogminer.end_lsn', 'other survives');
  });

  it('deleting an absent wire is a no-op (same ref)', () => {
    const m = freshModel();
    const [same] = runtime.update(m, { type: 'wire_delete', from: 'nope.x', to: 'nope.y' });
    assert(same === m, 'no-op delete returns the same model ref');
  });

  it('a matching `to` but different `from` is not deleted (exact match)', () => {
    const m = freshModel();
    const [m1] = runtime.update(m, { type: 'wire_create', from: A, to: B });
    const [m2] = runtime.update(m1, { type: 'wire_delete', from: 'other.z', to: B });
    eq(wr(m2).length, 1, 'endpoints must both match');
  });
});

describe('[fabric] runtime wires are group-scoped — no cross-group bleed (B3)', () => {
  it('a wire in one group is invisible to another group with the same input port', () => {
    let m = freshModel();
    m.currentGroup = 'staging';
    [m] = runtime.update(m, { type: 'wire_create', from: 'stg.redo', to: B });
    m.currentGroup = 'prod';
    eq(wr(m).length, 0, 'prod sees NO staging wire to the same input (the B3 bleed)');
    [m] = runtime.update(m, { type: 'wire_create', from: 'prod.redo', to: B });
    eq(m.fabric.wires.staging.length, 1, 'each group keeps its own wire');
    eq(m.fabric.wires.staging[0].from, 'stg.redo');
    eq(m.fabric.wires.prod[0].from, 'prod.redo');
    [m] = runtime.update(m, { type: 'wire_delete', from: 'prod.redo', to: B });   // currentGroup is prod
    eq(m.fabric.wires.staging.length, 1, 'a prod delete leaves staging intact');
    eq(wr(m).length, 0, 'prod wire deleted');
  });

  it('a group named like an Object.prototype member does not crash the wire path (B3 hardening)', () => {
    // Group names are unvalidated YAML keys; a group `constructor`/`__proto__`/`toString`
    // must not read the inherited prototype member as the wire array (which threw on .filter).
    for (const g of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      let m = freshModel();
      m.currentGroup = g;
      let threw = false;
      try {
        [m] = runtime.update(m, { type: 'wire_create', from: 'a.x', to: 'b.y' });
        [m] = runtime.update(m, { type: 'wire_delete', from: 'a.x', to: 'b.y' });
        [m] = runtime.update(m, { type: 'port_inject', port: 'a.x', value: 'v' });
        [m] = runtime.update(m, { type: 'port_clear', port: 'a.x' });
      } catch (e) { threw = true; }
      assert(!threw, `group '${g}' must not throw on the fabric store path`);
    }
    assert(({}).x === undefined, 'no prototype pollution');
  });
});

report();
