/**
 * Fabric right-click "Send selection to port" (P1 slice 6) — the human inject UI
 * (docs/ports-and-wires.md). The context entry offers the row; the send_to_port
 * handler builds a port picker; port_inject stores the sticky inject.
 * Run: node js/test/test-fabric-menu.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');   // wires panel-host
const { buildContextItems } = require('../leaves/input/context-menu');
const { handleAction } = require('../dispatch/control/actions');
const { init, setModel, getModel } = require('../app/runtime');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');

describe('[fabric-menu] context entry', () => {
  it('offers Send-to-port when a selection exists, carrying the value', () => {
    const items = buildContextItems({ selectionText: '0/1A2B3C0' });
    const row = items.find(r => r && r[1] === 'send_to_port');
    assert(row, 'send_to_port row present');
    eq(row[2], '0/1A2B3C0', 'row arg is the selection');
  });
  it('omits it with no selection', () => {
    const items = buildContextItems({ lineText: 'some line' });
    assert(!items.some(r => r && r[1] === 'send_to_port'));
  });
});

function seed() {
  const m = init();
  m.currentGroup = 'pg';
  m.config = { groups: { pg: { label: 'pg', actions: {
    xlogminer: {
      label: 'xm', run: ['xlogminer', '{{start_lsn}}'],
      ports: { in: { start_lsn: { type: 'pg.lsn', required: true } } },
    },
  } } } };
  setModel(m);
  wireFabricHost();
}

describe('[fabric-menu] handlers', () => {
  it('port_inject stores a sticky inject', () => {
    seed();
    handleAction('port_inject', { port: 'xlogminer.start_lsn', value: '0/1A2B3C0' });
    eq(getModel().fabric.injects['xlogminer.start_lsn'].value, '0/1A2B3C0');
  });

  it('send_to_port opens a port picker whose row carries {port, value}', () => {
    seed();
    handleAction('send_to_port', '0/2000000');
    const items = getModel().modal.menu.items;
    const row = items.find(r => r && r[1] === 'port_inject');
    assert(row, 'picker has a port_inject row');
    eq(row[2].port, 'xlogminer.start_lsn');
    eq(row[2].value, '0/2000000', 'the selection rides in the row arg');
  });

  it('send_to_port with no fabric ports shows a placeholder row', () => {
    const m = init();
    m.currentGroup = 'g';
    m.config = { groups: { g: { label: 'g', actions: { plain: { label: 'p', cmd: 'true' } } } } };
    setModel(m);
    wireFabricHost();
    handleAction('send_to_port', 'x');
    const items = getModel().modal.menu.items;
    assert(items.length === 1 && /no input ports/.test(items[0][0]), 'placeholder row');
  });
});

// Wiring from the component-ports pane's "connect to…" (P1.5 slice D). The picker
// only offers compatible producers, but the wire_create handler validates
// type-equality defensively (a P2 agent could emit the verb).
function seedWire() {
  const m = init();
  m.currentGroup = 'pg';
  m.config = { groups: { pg: { label: 'pg', actions: {
    controldata: {
      label: 'cd', run: ['pg_controldata'],
      ports: { out: { redo_lsn: { type: 'pg.lsn' }, tli: { type: 'pg.tli' } } },
    },
    xlogminer: {
      label: 'xm', run: ['xlogminer', '{{start_lsn}}'],
      ports: { in: { start_lsn: { type: 'pg.lsn', required: true } } },
    },
  } } } };
  setModel(m);
  wireFabricHost();
}

describe('[fabric-menu] wire_create handler', () => {
  it('creates a runtime wire for a type-compatible pick', () => {
    seedWire();
    handleAction('wire_create', { from: 'controldata.redo_lsn', to: 'xlogminer.start_lsn' });
    const wires = getModel().fabric.wires;
    eq(wires.length, 1);
    eq(wires[0].from, 'controldata.redo_lsn');
    eq(wires[0].to, 'xlogminer.start_lsn');
  });

  it('refuses a type-mismatched wire (error-and-tell, no wire)', () => {
    seedWire();
    handleAction('wire_create', { from: 'controldata.tli', to: 'xlogminer.start_lsn' }); // pg.tli → pg.lsn
    eq(getModel().fabric.wires.length, 0, 'mismatch not created');
  });

  it('ignores a malformed arg', () => {
    seedWire();
    handleAction('wire_create', { from: 'controldata.redo_lsn' });   // no `to`
    eq(getModel().fabric.wires.length, 0);
  });
});

report();
