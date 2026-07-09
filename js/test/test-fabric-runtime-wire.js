/**
 * Fabric runtime-wire e2e — proves a RUNTIME wire (model.fabric.wires, what the
 * component-ports pane's "connect to…" writes) is honoured by the ACTUAL run
 * path (doRunFabric), not merely by the UI panes.
 *
 * Regression for the bug where doRunFabric resolved against config-only wires
 * (model.config.groups[g].wires) while the pane / wire-list / readiness badge
 * resolved the merged config+runtime list via the host: an interactively-wired
 * input showed ✓ready in the UI yet ran as "unset". Under the pre-fix code the
 * consumer below (no config wire, no inject) never resolves start → never runs →
 * fabricOut('sink') stays null → this test times out and fails.
 * Run: node js/test/test-fabric-runtime-wire.js
 */
'use strict';

const { eq, assert, section, report } = require('./test-runner');   // auto-wires panel-host
const { init, setModel, getModel } = require('../app/runtime');
const route = require('../panel/route');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');
const { doRunFabric } = require('../dispatch/runtime/action-runner');
const { portValue } = require('../fabric/ports');

// A producer + consumer, echo-based so it runs anywhere. There is NO config
// wire; the only connection is a RUNTIME wire in model.fabric.wires.
const SRC = {
  label: 'src', run: ['echo', 'v: RUNTIME_OK'],
  parse: { kv: { sep: ':' } },
  ports: { out: { val: { type: 't', from: 'v' } } },
};
const SINK = {
  label: 'sink', run: ['echo', 'got {{x}}'],   // embedded hole → concatenated, no shell
  ports: { in: { x: { type: 't', required: true } } },
};

const base = init();
base.currentGroup = 'g';
base.config = { groups: { g: { label: 'g', actions: { src: SRC, sink: SINK } } } };   // note: no `wires:`
base.fabric = { injects: {}, output: {}, wires: [{ from: 'src.val', to: 'sink.x' }] }; // runtime wire only
setModel(base);
route.setInstanceSlice('detail', { actionTabBuffers: {}, tab: 0, scroll: 0, viewerStreamBuffer: { lines: [], cap: 1000 } });
wireFabricHost();

function fabricOut(name) {
  const o = getModel().fabric && getModel().fabric.output && getModel().fabric.output.g;
  return (o && o[name]) || null;
}
function poll(cond, cb, tries = 80) {
  if (cond()) return cb();
  if (tries <= 0) {
    assert(false, 'timed out — consumer never ran (runtime wire not honoured by doRunFabric?)');
    return report();
  }
  setTimeout(() => poll(cond, cb, tries - 1), 25);
}

section('[fabric-runtime-wire] doRunFabric honours a runtime (model.fabric.wires) wire');
doRunFabric('src', SRC);
poll(() => fabricOut('src'), () => {
  eq(portValue('src', 'val'), 'RUNTIME_OK', 'producer output parsed → output port derivable');
  doRunFabric('sink', SINK);
  poll(() => fabricOut('sink'), () => {
    const out = fabricOut('sink').join('\n');
    assert(/got RUNTIME_OK/.test(out),
      'consumer ran with the value from the RUNTIME wire (no config wire, no inject)');
    report();
  });
});
