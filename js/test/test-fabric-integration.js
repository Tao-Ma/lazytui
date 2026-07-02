/**
 * Fabric end-to-end (P1 slice 5c) — the REAL host wiring over a seeded model:
 * a producer's RAW output (model.fabric.output) → parse → output port value →
 * wire → a consumer's input resolves. Proves wireFabricHost's getters read the
 * right model/config fields (not a fake host).
 * Run: node js/test/test-fabric-integration.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');   // auto-wires panel-host
const { setModel, getModel } = require('../app/runtime');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');
const { portValue, listPorts, listWires } = require('../fabric/ports');
const { resolveInputs } = require('../fabric/resolve');

const CD_LINE = "Latest checkpoint's REDO location: 0/1A2B3C0";

setModel({
  currentGroup: 'pg',
  modes: {},
  // Seed controldata's RAW output (what the fabric run path captures on close
  // into model.fabric.output[group][name] — H1, clean of chrome/esc).
  fabric: { injects: {}, output: { pg: { controldata: [CD_LINE] } } },
  config: {
    groups: {
      pg: {
        label: 'pg',
        actions: {
          controldata: {
            label: 'cd', run: ['pg_controldata'],
            parse: { kv: { sep: ':' } },
            ports: { out: { redo_lsn: { type: 'pg.lsn', from: "Latest checkpoint's REDO location" } } },
          },
          xlogminer: {
            label: 'xm', run: ['xlogminer', '--start', '{{start_lsn}}'],
            ports: { in: { start_lsn: { type: 'pg.lsn', required: true } } },
          },
        },
        wires: [{ from: 'controldata.redo_lsn', to: 'xlogminer.start_lsn' }],
      },
    },
  },
});

wireFabricHost();

describe('[fabric-e2e] real host reads config + raw output', () => {
  it('portValue projects a producer field from its streamed output', () => {
    eq(portValue('controldata', 'redo_lsn'), '0/1A2B3C0');
  });
  it('listWires reflects the config wire', () => {
    eq(listWires().length, 1);
    eq(listWires()[0].to, 'xlogminer.start_lsn');
  });
  it('listPorts enumerates producer + consumer ports', () => {
    const ports = listPorts();
    assert(ports.some(p => p.component === 'controldata' && p.port === 'redo_lsn' && p.dir === 'out'));
    assert(ports.some(p => p.component === 'xlogminer' && p.port === 'start_lsn' && p.dir === 'in'));
  });
});

describe('[fabric-e2e] wire resolves through real portValue', () => {
  it('consumer start_lsn resolves from the wired producer output', () => {
    const r = resolveInputs('xlogminer',
      { start_lsn: { type: 'pg.lsn', required: true } },
      { injects: {}, wires: listWires(), portValue });
    assert(r.ready, 'ready once the producer has output');
    eq(r.values.start_lsn, '0/1A2B3C0');
    eq(r.sources.start_lsn, 'wire');
  });

  it('before the producer has output, the consumer is not ready with a precise reason', () => {
    getModel().fabric.output = {};                       // clear controldata's raw output
    const r = resolveInputs('xlogminer',
      { start_lsn: { type: 'pg.lsn', required: true } },
      { injects: {}, wires: listWires(), portValue });
    assert(!r.ready);
    assert(/run controldata first/.test(r.missing[0].reason), r.missing[0].reason);
    getModel().fabric.output = { pg: { controldata: [CD_LINE] } };   // restore
  });

  it('an inject overrides the wire (by value)', () => {
    const r = resolveInputs('xlogminer',
      { start_lsn: { type: 'pg.lsn', required: true } },
      { injects: { 'xlogminer.start_lsn': { value: 'OVERRIDE' } }, wires: listWires(), portValue });
    eq(r.values.start_lsn, 'OVERRIDE');
    eq(r.sources.start_lsn, 'inject');
  });
});

report();
