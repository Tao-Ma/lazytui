/**
 * Fabric capstone (P1 slice 7) — the self-contained demo/fabric/tui.yml pipe,
 * validated by config alone: it PARSES with fabric declarations, and it RUNS
 * end-to-end through the real no-shell path (producer → parse → output port →
 * wire → consumer's argv), with no infra (echo-based).
 * Run: node js/test/test-fabric-demo.js
 */
'use strict';

const path = require('path');
const { describe, it, eq, assert, section, report } = require('./test-runner');   // auto-wires panel-host
const { parse } = require('../parser');
const { init, setModel, getModel } = require('../app/runtime');
const route = require('../panel/route');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');
const { doRunFabric } = require('../dispatch/runtime/action-runner');
const { portValue } = require('../fabric/ports');

const cfg = parse(path.join(__dirname, '../../demo/fabric/tui.yml'));

describe('[fabric-demo] config parses with fabric declarations', () => {
  const src = cfg.groups.demo.actions.source;
  it('producer declares parse + a typed output port', () => {
    eq(src.parse.kv.sep, ':');
    eq(src.ports.out.lsn.type, 'demo.lsn');
    eq(Array.isArray(src.run), true);
  });
  it('consumer declares a required input port + the {{start}} hole', () => {
    const mine = cfg.groups.demo.actions.mine;
    eq(mine.ports.in.start.required, true);
    assert(mine.run.join(' ').includes('{{start}}'));
  });
  it('the wire connects source.lsn → mine.start', () => {
    eq(cfg.groups.demo.wires[0].from, 'source.lsn');
    eq(cfg.groups.demo.wires[0].to, 'mine.start');
  });
});

describe('[fabric-demo] the pg pipe in demo/postgres parses + type-checks', () => {
  const pg = parse(path.join(__dirname, '../../demo/postgres/tui.yml'));
  const acts = pg.groups.pg.actions;
  it('declares the controldata producer + waldump consumer', () => {
    eq(acts.controldata.ports.out.redo_lsn.type, 'pg.lsn');
    eq(acts.waldump.ports.in.start_lsn.required, true);
    assert(acts.waldump.run.join(' ').includes('{{start_lsn}}'));
  });
  it('wires controldata.redo_lsn → waldump.start_lsn (parse enforces type-equality)', () => {
    const w = pg.groups.pg.wires.find(x => x.to === 'waldump.start_lsn');
    assert(w && w.from === 'controldata.redo_lsn');
  });
});

// --- end-to-end run through the real dispatch (async) ---
const base = init();
base.config = cfg;
base.currentGroup = 'demo';
setModel(base);
route.setInstanceSlice('detail', { actionTabBuffers: {}, tab: 0, scroll: 0, viewerStreamBuffer: { lines: [], cap: 1000 } });
wireFabricHost();

// The producer's RAW output lands in model.fabric.output[group][name] on process
// CLOSE — the correct completion signal to poll (the display buffer fills mid-
// stream, before the port value is published).
function fabricOut(name) {
  const o = getModel().fabric && getModel().fabric.output && getModel().fabric.output.demo;
  return (o && o[name]) || null;
}
function poll(cond, cb, tries = 80) {
  if (cond()) return cb();
  if (tries <= 0) { assert(false, 'timed out waiting for command output'); return report(); }
  setTimeout(() => poll(cond, cb, tries - 1), 25);
}

section('[fabric-demo] end-to-end run (real execve, no shell)');
doRunFabric('source', cfg.groups.demo.actions.source);
poll(() => fabricOut('source'), () => {
  eq(portValue('source', 'lsn'), '0/CAFE', 'producer RAW output parsed → output port derivable');

  doRunFabric('mine', cfg.groups.demo.actions.mine);
  poll(() => fabricOut('mine'), () => {
    const out = fabricOut('mine').join('\n');
    assert(/starting at 0\/CAFE/.test(out), 'consumer ran with the WIRED value (zero manual input)');
    assert(!/\[dim\]|\[green\]/.test(out), 'raw output is free of stream chrome (H1)');
    report();
  });
});
