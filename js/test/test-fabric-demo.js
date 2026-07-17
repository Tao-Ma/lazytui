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
  const A = cfg.groups.demo.actions;
  it('two producers export the SAME type (demo.lsn) — the multi-source case', () => {
    eq(A.primary.parse.kv.sep, ':');
    eq(A.primary.ports.out.lsn.type, 'demo.lsn');
    eq(A.standby.ports.out.lsn.type, 'demo.lsn');
    eq(Array.isArray(A.primary.run), true);
  });
  it('the consumer declares a required input port + the {{start}} hole', () => {
    eq(A.miner.ports.in.start.required, true);
    assert(A.miner.run.join(' ').includes('{{start}}'));
  });
  it('compare is a FAN-IN node — two required inputs of the same type', () => {
    eq(A.compare.ports.in.primary_lsn.type, 'demo.lsn');
    eq(A.compare.ports.in.standby_lsn.type, 'demo.lsn');
    assert(A.compare.run.join(' ').includes('{{primary_lsn}}'));
    assert(A.compare.run.join(' ').includes('{{standby_lsn}}'));
  });
  it('wires connect primary→miner and fan primary+standby into compare', () => {
    const W = cfg.groups.demo.wires;
    assert(W.some((w) => w.from === 'primary.lsn' && w.to === 'miner.start'));
    assert(W.some((w) => w.from === 'primary.lsn' && w.to === 'compare.primary_lsn'));
    assert(W.some((w) => w.from === 'standby.lsn' && w.to === 'compare.standby_lsn'));
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
const A = cfg.groups.demo.actions;
// Run BOTH producers first; each publishes its own typed LSN.
doRunFabric('primary', A.primary);
doRunFabric('standby', A.standby);
poll(() => fabricOut('primary') && fabricOut('standby'), () => {
  eq(portValue('primary', 'lsn'), '0/CAFE', 'primary RAW output parsed → output port derivable');
  eq(portValue('standby', 'lsn'), '0/BEEF', 'standby projects a DIFFERENT value (distinct source)');

  // The consumer resolves from its wire (primary.lsn); the fan-in node resolves
  // BOTH inputs, each from a different producer — zero manual input either way.
  doRunFabric('miner', A.miner);
  doRunFabric('compare', A.compare);
  poll(() => fabricOut('miner') && fabricOut('compare'), () => {
    const mo = fabricOut('miner').join('\n');
    assert(/starting at 0\/CAFE/.test(mo), 'consumer ran with the WIRED value (primary.lsn)');
    assert(!/\[dim\]|\[green\]/.test(mo), 'raw output is free of stream chrome (H1)');
    const co = fabricOut('compare').join('\n');
    assert(/primary=0\/CAFE standby=0\/BEEF/.test(co), 'fan-in: compare ran with BOTH wired inputs');
    report();
  });
});
