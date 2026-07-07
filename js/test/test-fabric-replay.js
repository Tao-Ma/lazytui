/**
 * Fabric replay-as-debugger (P1.5 slice G) — the "time-travel dataflow debugger"
 * (docs/ports-and-wires.md, "Replay-as-debugger"). Port/wire values are pure
 * selectors over the model, and the WHOLE fabric state (output + injects + wires)
 * rides the WAL as recorded root Msgs (fabric_output_set / port_inject /
 * wire_create are applyMsg'd — recorded, effect-free). So folding recorded history
 * reconstructs the model, and the derived values track each frame — no special
 * replay code in the fabric.
 *
 * This folds a synthetic WAL through the REAL replay path (replay.replayEntries,
 * effects suppressed) and asserts the derived values at each reconstructed frame,
 * forward AND seeking back.
 * Run: node js/test/test-fabric-replay.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');   // wires panel-host
const { init, setModel, getModel } = require('../app/runtime');
const replay = require('../dispatch/runtime/replay');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');
const { portValue, componentPorts } = require('../fabric/ports');
const { inspectComponent } = require('../fabric/inspect');

const CD = "Latest checkpoint's REDO location: 0/1A2B3C0";

function seed() {
  const m = init();
  m.currentGroup = 'pg';
  m.fabric = { injects: {}, output: {}, wires: [] };
  m.config = { groups: { pg: { label: 'pg', actions: {
    controldata: {
      label: 'cd', run: ['pg_controldata'], parse: { kv: { sep: ':' } },
      ports: { out: { redo_lsn: { type: 'pg.lsn', from: "Latest checkpoint's REDO location" } } },
    },
    xlogminer: {
      label: 'xm', run: ['xlogminer', '{{start_lsn}}', '{{end_lsn}}'],
      ports: { in: {
        start_lsn: { type: 'pg.lsn', required: true },
        end_lsn: { type: 'pg.lsn', required: true },
      } },
    },
  } } } };
  setModel(m);
  wireFabricHost();
}

// The recorded session, as WAL msg entries (lane:'root' — the fabric Msgs are
// applyMsg'd, so this is exactly what the recorder captures).
const WAL = [
  { kind: 'msg', lane: 'root', msg: { type: 'fabric_output_set', group: 'pg', name: 'controldata', lines: [CD] } },
  { kind: 'msg', lane: 'root', msg: { type: 'wire_create', from: 'controldata.redo_lsn', to: 'xlogminer.start_lsn' } },
  { kind: 'msg', lane: 'root', msg: { type: 'port_inject', port: 'xlogminer.end_lsn', value: '0/FF00' } },
];

function xlogminerReady() {
  const ctx = {
    injects: getModel().fabric.injects,
    wires: require('../fabric/ports').listWires(),
    portValue,
  };
  return inspectComponent('xlogminer', componentPorts('xlogminer'), ctx);
}

describe('[fabric-replay] derived values track each reconstructed frame', () => {
  it('frame 0 (nothing recorded yet): no output, consumer not ready', () => {
    seed();
    eq(portValue('controldata', 'redo_lsn'), undefined, 'no producer output');
    assert(!xlogminerReady().ready, 'no inputs resolve');
  });

  it('after the fabric_output_set frame: the output port value is reconstructed', () => {
    seed();
    replay.replayEntries(WAL.slice(0, 1));   // real replay fold (effects suppressed)
    eq(portValue('controldata', 'redo_lsn'), '0/1A2B3C0');
  });

  it('after the wire_create frame: the consumer input resolves via the wire', () => {
    seed();
    replay.replayEntries(WAL.slice(0, 2));
    const d = xlogminerReady();
    const start = d.inputs.find((r) => r.port === 'start_lsn');
    eq(start.source, 'wire');
    eq(start.value, '0/1A2B3C0');
    assert(!d.ready, 'end_lsn still unresolved at this frame');
  });

  it('after the port_inject frame: the consumer is fully ready', () => {
    seed();
    replay.replayEntries(WAL.slice(0, 3));
    const d = xlogminerReady();
    eq(d.inputs.find((r) => r.port === 'end_lsn').source, 'inject');
    assert(d.ready, 'start(wire) + end(inject) both present');
  });

  it('seeking BACK (re-fold a shorter prefix from base) drops the later frame', () => {
    // Capture a clean base, fold to the end, then reconstruct an earlier frame
    // via replayEntries({fromState}) — the reverse-seek path.
    seed();
    const base = replay.snapshotState();
    replay.replayEntries(WAL.slice(0, 3));
    assert(xlogminerReady().ready, 'at the end: ready');
    replay.replayEntries(WAL.slice(0, 1), { fromState: base });   // seek back to frame 1
    assert(!('xlogminer.end_lsn' in getModel().fabric.injects), 'the inject is gone at the earlier frame');
    eq(portValue('controldata', 'redo_lsn'), '0/1A2B3C0', 'but the output is present');
  });
});

report();
