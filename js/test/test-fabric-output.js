/**
 * Fabric producer read-path (P1 slice 8 — H1 + M2) — REAL runs through the
 * streaming path, proving output ports parse the producer's CLEAN raw stdout
 * (no stream chrome, no esc() bracket-mangling), and that a no-`from` port on a
 * lines producer yields the whole array. Regression for the review's H1/M2.
 * Run: node js/test/test-fabric-output.js
 */
'use strict';

const { assert, eq, section, report } = require('./test-runner');   // auto-wires panel-host
const { init, setModel, getModel } = require('../app/runtime');
const route = require('../panel/route');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');
const { doRunFabric } = require('../dispatch/runtime/action-runner');
const { portValue } = require('../fabric/ports');

const base = init();
base.currentGroup = 'g';
base.config = { groups: { g: { label: 'g', actions: {
  // JSON with a bracketed array field — pre-H1 this is fatal: chrome lines
  // surround it AND esc() escapes the `[`, so JSON.parse throws → null.
  jp: {
    label: 'jp', run: ['echo', '{"tags":["a","b"],"lsn":"0/1"}'], parse: { json: true },
    ports: { out: { lsn: { type: 't', from: 'lsn' }, tags: { type: 't', from: 'tags' } } },
  },
  // lines producer, no-`from` port → the whole array (M2).
  lp: {
    label: 'lp', run: ['echo', 'record-alpha'], parse: { lines: true },
    ports: { out: { records: { type: 't' } } },
  },
} } } };
setModel(base);
route.setInstanceSlice('detail', { actionTabBuffers: {}, tab: 0, scroll: 0, viewerStreamBuffer: { lines: [], cap: 1000 } });
wireFabricHost();

function out(name) {
  const o = getModel().fabric && getModel().fabric.output && getModel().fabric.output.g;
  return (o && o[name]) || null;
}
function poll(cond, cb, tries = 80) {
  if (cond()) return cb();
  if (tries <= 0) { assert(false, 'timed out waiting for command output'); return report(); }
  setTimeout(() => poll(cond, cb, tries - 1), 25);
}

section('[fabric-output] H1 — JSON (with brackets) parses over a REAL run');
doRunFabric('jp', base.config.groups.g.actions.jp);
poll(() => out('jp'), () => {
  eq(portValue('jp', 'lsn'), '0/1', 'JSON.parse succeeded over raw output (null pre-H1)');
  eq(portValue('jp', 'tags'), ['a', 'b'], 'bracketed JSON survives — esc() not applied to the parse source');
  assert(!/\[dim\]|\[green\]/.test(out('jp').join('\n')), 'raw output carries no stream chrome');

  section('[fabric-output] M2 — no-`from` port on a lines producer = whole array');
  doRunFabric('lp', base.config.groups.g.actions.lp);
  poll(() => out('lp'), () => {
    eq(portValue('lp', 'records'), ['record-alpha'], 'whole-record array port (was undefined pre-M2)');
    report();
  });
});
