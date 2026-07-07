/**
 * Fabric wire-list pane (P1.5 slice E) — the global edge view + delete. Layers:
 *   - inspectWires: the pure row model (edge + value-on-wire + validity + source);
 *   - the pane render over the real host + a seeded model;
 *   - the delete key-claim + the fabric_wire_delete effect (runtime vs config).
 * Run: node js/test/test-fabric-wire-list.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');   // wires panel-host
const { inspectWires } = require('../fabric/inspect');

describe('[fabric] inspectWires (pure)', () => {
  const pv = (c, p) => (c === 'controldata' && p === 'redo_lsn') ? '0/1A2B3C0' : undefined;

  it('annotates each edge with the value on the wire + a present flag', () => {
    const rows = inspectWires([
      { from: 'controldata.redo_lsn', to: 'xlogminer.start_lsn', source: 'runtime' },
      { from: 'elsewhere.x', to: 'xlogminer.end_lsn', source: 'config' },
    ], pv);
    eq(rows.length, 2);
    eq(rows[0].value, '0/1A2B3C0');
    eq(rows[0].present, true);
    eq(rows[0].source, 'runtime');
    eq(rows[1].present, false, 'upstream produced nothing yet');
    eq(rows[1].source, 'config');
  });

  it('defaults an untagged wire to source=config; empty → []', () => {
    eq(inspectWires([{ from: 'a.b', to: 'c.d' }], pv)[0].source, 'config');
    eq(inspectWires().length, 0);
  });
});

// ── Pane render + delete over the real host ─────────────────────────────────
const { setModel, getModel } = require('../app/runtime');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');
const pane = require('../panel/fabric/wire-list');
const mnav = require('../leaves/wm/nav');

const CD = "Latest checkpoint's REDO location: 0/1A2B3C0";

function seed(runtimeWires) {
  setModel({
    currentGroup: 'pg', modes: {},
    fabric: { injects: {}, output: { pg: { controldata: [CD] } }, wires: runtimeWires || [] },
    config: {
      groups: {
        pg: {
          label: 'pg',
          actions: {
            controldata: { label: 'cd', run: ['pg_controldata'], parse: { kv: { sep: ':' } },
              ports: { out: { redo_lsn: { type: 'pg.lsn', from: "Latest checkpoint's REDO location" } } } },
            xlogminer: { label: 'xm', run: ['xlogminer'],
              ports: { in: { start_lsn: { type: 'pg.lsn', required: true } } } },
          },
          wires: [{ from: 'controldata.redo_lsn', to: 'xlogminer.start_lsn' }],   // config wire
        },
      },
    },
  });
  wireFabricHost();
}

describe('[fabric] wire-list render', () => {
  it('renders the edge, the value on the wire, and validity', () => {
    seed();
    const out = pane.panelTypes['fabric-wires'].render(
      { paneId: 'w', title: 'Wires', hotkey: '' }, 70, 12, { nav: mnav.init(), paneId: 'w' }, { focused: true });
    assert(out.includes('controldata.redo_lsn'), 'from endpoint');
    assert(out.includes('xlogminer.start_lsn'), 'to endpoint');
    assert(out.includes('0/1A2B3C0'), 'value currently on the wire');
    assert(out.includes('cfg'), 'config-sourced wire tagged');
  });

  it('empty wire set → helpful empty state', () => {
    setModel({ currentGroup: 'g', modes: {}, fabric: { injects: {}, output: {}, wires: [] },
      config: { groups: { g: { label: 'g', actions: {} } } } });
    wireFabricHost();
    const out = pane.panelTypes['fabric-wires'].render(
      { paneId: 'w', title: 'Wires', hotkey: '' }, 70, 12, { nav: mnav.init(), paneId: 'w' }, { focused: true });
    assert(/no wires/.test(out));
  });
});

describe('[fabric] wire-list delete', () => {
  it('d claims + emits fabric_wire_delete for the cursor row', () => {
    const slice = { paneId: 'w', nav: { cursor: 0, scroll: 0, multiSel: new Set(), filter: '' } };
    const [, cmds] = pane.update({ type: 'key', key: 'd' }, slice);
    assert(cmds.some((c) => c.type === '_claimed'));
    const del = cmds.find((c) => c.type === 'fabric_wire_delete');
    assert(del && del.paneId === 'w' && del.cursor === 0);
  });

  it('the delete effect removes a RUNTIME wire, warns on a config wire', () => {
    // runtime wire present + the config wire; deleting the runtime one works.
    seed([{ from: 'controldata.redo_lsn', to: 'xlogminer.start_lsn' }]);   // runtime overrides config on same `to`
    let captured = null;
    pane.installEffects((type, fn) => { if (type === 'fabric_wire_delete') captured = fn; });
    // The merged list has one row (runtime overrides config by `to`), source runtime.
    const host = { applyMsg: (m) => { getModel()._last = m; } };
    captured({ paneId: 'w', cursor: 0 }, host);
    eq(getModel()._last.type, 'wire_delete', 'runtime wire → wire_delete dispatched');
    eq(getModel()._last.to, 'xlogminer.start_lsn');
  });
});

report();
