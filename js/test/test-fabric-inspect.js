/**
 * Fabric inspection + the component-ports pane (P1.5 slice B). Two layers:
 *   - inspectComponent: the pure operate/check-half row model (js/fabric/inspect.js),
 *     tested with fakes;
 *   - the component-ports pane render over the REAL fabric host + a seeded model,
 *     proving the fabric→pane data path and the follows-focus/pin resolution.
 * Run: node js/test/test-fabric-inspect.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');   // auto-wires panel-host
const { inspectComponent } = require('../fabric/inspect');

describe('[fabric] inspectComponent (pure)', () => {
  const ports = {
    in: {
      start_lsn: { type: 'pg.lsn', required: true },
      end_lsn:   { type: 'pg.lsn', required: true },
      timeline:  { type: 'pg.tli', default: '1' },
    },
    out: { records: { type: 'pg.wal_records', desc: 'WAL records' } },
  };
  const ctx = {
    injects: { 'xlogminer.end_lsn': { value: '0/FFFF' } },
    wires: [{ from: 'controldata.redo_lsn', to: 'xlogminer.start_lsn' }],
    portValue: (c, p) => (c === 'controldata' && p === 'redo_lsn') ? '0/1A2B3C0'
      : (c === 'xlogminer' && p === 'records') ? ['a', 'b', 'c'] : undefined,
  };

  const d = inspectComponent('xlogminer', ports, ctx);

  it('resolves each input source: wire / inject / default', () => {
    const byPort = Object.fromEntries(d.inputs.map((r) => [r.port, r]));
    eq(byPort.start_lsn.source, 'wire');
    eq(byPort.start_lsn.value, '0/1A2B3C0');
    eq(byPort.start_lsn.wireFrom, 'controldata.redo_lsn', 'exposes the wire producer for `← from`');
    eq(byPort.end_lsn.source, 'inject');
    eq(byPort.end_lsn.value, '0/FFFF');
    eq(byPort.timeline.source, 'default');
    eq(byPort.timeline.value, '1');
  });

  it('is ready when every required input resolves', () => {
    assert(d.ready, 'start_lsn(wire) + end_lsn(inject) both present');
    eq(d.missing.length, 0);
  });

  it('projects output values + a present flag', () => {
    eq(d.outputs.length, 1);
    eq(d.outputs[0].port, 'records');
    eq(d.outputs[0].present, true);
    assert(Array.isArray(d.outputs[0].value));
  });

  it('reports a precise reason for an unset required input', () => {
    const d2 = inspectComponent('xlogminer', ports, { injects: {}, wires: [], portValue: () => undefined });
    assert(!d2.ready);
    const missing = d2.missing.map((m) => m.port).sort();
    eq(missing.join(','), 'end_lsn,start_lsn', 'both required inputs unresolved');
    const startRow = d2.inputs.find((r) => r.port === 'start_lsn');
    eq(startRow.source, null);
    assert(startRow.reason, 'carries a readiness reason');
  });

  it('a portless component → empty halves, ready', () => {
    const d3 = inspectComponent('x', null, { injects: {}, wires: [], portValue: () => undefined });
    eq(d3.inputs.length, 0);
    eq(d3.outputs.length, 0);
    assert(d3.ready, 'no required inputs → ready');
  });
});

// ── Pane render over the real host ──────────────────────────────────────────
const { setModel } = require('../app/runtime');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');
const pane = require('../panel/fabric/ports-pane');
const mnav = require('../leaves/wm/nav');

const CD_LINE = "Latest checkpoint's REDO location: 0/1A2B3C0";

function seed() {
  setModel({
    currentGroup: 'pg',
    modes: {},
    fabric: {
      injects: {},
      output: { pg: { controldata: [CD_LINE], xlogminer: ['rec-1', 'rec-2'] } },
      wires: [],
    },
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
              parse: { lines: true },
              ports: {
                in: { start_lsn: { type: 'pg.lsn', required: true } },
                out: { records: { type: 'pg.wal_records' } },
              },
            },
          },
          wires: [{ from: 'controldata.redo_lsn', to: 'xlogminer.start_lsn' }],
        },
      },
    },
  });
  wireFabricHost();
}

describe('[fabric] component-ports pane render', () => {
  seed();
  const panel = { paneId: 'pane-ports', title: 'Ports', hotkey: '' };
  const slice = { nav: mnav.init(), pinned: 'xlogminer' };   // pin → deterministic

  it('renders the pinned component with its resolved input value + readiness', () => {
    const out = pane.panelTypes['component-ports'].render(panel, 80, 20, slice, { focused: true });
    assert(out.includes('xlogminer'), 'component name in title/header');
    assert(out.includes('start_lsn'), 'input port row');
    assert(out.includes('0/1A2B3C0'), 'resolved wire value shown');
    assert(out.includes('controldata.redo_lsn'), 'wire source annotation');
    assert(/ready/.test(out), 'readiness badge');
    assert(out.includes('records'), 'output port row (check-half)');
  });

  it('follows-focus falls back to a helpful empty state with no component', () => {
    const out = pane.panelTypes['component-ports'].render(panel, 80, 20, { nav: mnav.init(), pinned: null }, { focused: false });
    assert(/no fabric component/.test(out), 'empty-state hint');
  });

  it('_resolveComponent honours a runtime pin, ignores a non-fabric name', () => {
    eq(pane._resolveComponent(panel, { pinned: 'xlogminer' }), 'xlogminer');
    eq(pane._resolveComponent(panel, { pinned: 'not-a-component' }), null);
  });

  it('_fmtValue: array → "N lines", object → "N fields", multiline → first + …', () => {
    eq(pane._fmtValue(undefined), '');
    eq(pane._fmtValue(['a', 'b', 'c']), '3 lines');
    eq(pane._fmtValue(['x']), '1 line');
    eq(pane._fmtValue({ a: 1, b: 2 }), '{2 fields}');
    eq(pane._fmtValue('0/1A2B3C0'), '0/1A2B3C0');
    eq(pane._fmtValue('line1\nline2'), 'line1 …');
  });

  it('_sourceLabel: wire shows the producer, others their kind', () => {
    eq(pane._sourceLabel({ source: 'wire', wireFrom: 'controldata.redo_lsn' }), '← controldata.redo_lsn');
    eq(pane._sourceLabel({ source: 'wire', wireFrom: null }), '← wire');
    eq(pane._sourceLabel({ source: 'inject' }), '(inject)');
    eq(pane._sourceLabel({ source: 'default' }), 'default');
    eq(pane._sourceLabel({ source: null }), '(unset)');
  });
});

report();
