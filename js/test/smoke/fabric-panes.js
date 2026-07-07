/**
 * Smoke — the P1.5 dataflow-fabric panes, end-to-end through the REAL
 * input→dispatch→effect→reducer→render pipeline (not unit-level update() calls).
 *
 * Drives the shipped demo/fabric/tui.yml (which places a component-ports pane +
 * a fabric-wires pane) and exercises the interactive surface a user touches:
 * follows-focus retarget, e-edit→inject, w-connect→wire_create, p-pin, x-clear —
 * asserting on the rendered frame AND post-step model state at each key.
 *
 * This is the integration the fabric unit tests can't reach: the key-claim →
 * fabric_* effect → applyMsg → sub-reducer → re-render loop, with focus routing.
 *
 * Run: node js/scripts/run-smoke.js   (or node js/test/smoke/fabric-panes.js)
 */
'use strict';

const path = require('path');
const { describe, it, eq, assert, report } = require('../test-runner');   // auto-registers layout/detail/groups
const sm = require('./_helpers/smoke');
const api = sm.api;
const route = sm.route;
const { parse } = require('../../parser/index');
const { getModel } = require('../../app/runtime');
const { initState } = require('../../app/state');
const { wireFabricHost } = require('../../dispatch/runtime/host-wiring');
const { dispatchMsg } = require('../../dispatch/runtime/loop');
const navState = require('../../panel/nav-state');

// Drivers built from the smoke helper's exported primitives (the top-level module
// exposes capture/handleKey/render; key()/frame() live on a session, but we boot a
// parsed demo config manually rather than via createSession's bootFresh). Focus is
// a layout Component Msg → dispatchMsg (the fan-out), NOT applyMsg (root reducer).
const key = (k, seq) => sm.capture(() => sm.handleKey(k, seq || k));
// Content assertions read a FULL frame: the v0.6.7 cell-diff renderer emits only
// changed cells after the first paint, so a post-keypress capture is sparse (a
// value drawn on an earlier keystroke won't reappear in the diff). forceFullRepaint
// makes the next render a complete frame.
const paint = require('../../render/paint');
const frame = () => { paint.forceFullRepaint(); return sm.capture(() => sm.render()).frame; };

// Register the Components the demo places (layout/detail/groups auto-registered).
for (const p of ['navigator/actions', 'fabric/ports-pane', 'fabric/wire-list']) {
  const c = require('../../panel/' + p);
  if (!api.getInstanceSlice(c.name)) api.registerComponent(c);
}

const DEMO = path.join(__dirname, '..', '..', '..', 'demo', 'fabric', 'tui.yml');
const cfg = parse(DEMO);
getModel().config = cfg;
getModel().projectDir = cfg.project_dir;
initState();
wireFabricHost();

function paneIdOf(type) {
  const layout = api.getInstanceSlice('layout');
  for (const col of (layout.arrange.columns || [])) {
    for (const pn of (col.panels || [])) {
      if (pn && pn.type === type && pn.paneId) return pn.paneId;
      for (const t of ((pn && pn.tabs) || [])) if (t && t.type === type && t.paneId) return t.paneId;
    }
  }
  return null;
}
const PORTS = paneIdOf('component-ports');
const WIRES = paneIdOf('fabric-wires');
const focusPorts = () => dispatchMsg(route.wrap('layout', { type: 'focus_set', focus: PORTS }));

describe('[1] the demo places both fabric panes and they render live', () => {
  it('component-ports + fabric-wires panes were placed', () => {
    assert(PORTS, 'component-ports pane placed');
    assert(WIRES, 'fabric-wires pane placed');
  });
  it('the initial frame shows both panes and the config wire', () => {
    const f = frame();
    assert(/Ports/.test(f), 'Ports pane title');
    assert(/Wires/.test(f), 'Wires pane title');
    assert(/source\.lsn/.test(f) && /mine\.start/.test(f), 'the config wire edge is listed');
  });
});

describe('[2] Ports follows the Actions selection (select_from)', () => {
  it('selecting `mine` in Actions retargets the Ports pane to mine', () => {
    navState.setSel('actions', 1);   // 0=source, 1=mine
    const f = frame();
    assert(/Ports: mine/.test(f), `Ports retargeted to mine\n${f}`);
    assert(/start/.test(f), 'shows mine\'s input port');
  });
});

describe('[3] e edits a field → sticky inject', () => {
  it('e + typing + Enter commits the raw value as an inject on mine.start', () => {
    focusPorts();
    key('e');
    for (const ch of '0/BEEF') key(ch, ch);
    key('return');
    const inj = getModel().fabric.injects['mine.start'];
    assert(inj && inj.value === '0/BEEF', `inject committed: ${JSON.stringify(inj)}`);
    assert(!getModel().modes.fabricFieldMode, 'editor closed after Enter');
    const f = frame();
    assert(/0\/BEEF/.test(f), 'the injected value renders on the row');
    assert(/✓ ready/.test(f), 'readiness flips to ✓ once start resolves');
  });
});

describe('[4] w connects a compatible producer → runtime wire', () => {
  it('w opens the producer picker; selecting it creates the runtime wire', () => {
    focusPorts();
    // clear the inject first so the wire is the resolving source afterwards
    navState.setSel('actions', 1);
    key('w');
    const items = (getModel().modal.menu.items || []).map((r) => r && r[0]);
    assert(items.some((l) => /source\.lsn/.test(l)), `picker offers the compatible producer: ${JSON.stringify(items)}`);
    key('return');   // pick the highlighted producer
    assert(!getModel().modes.menuOpen, 'picker closed');
    const w = getModel().fabric.wires.find((x) => x.to === 'mine.start' && x.from === 'source.lsn');
    assert(w, `runtime wire created: ${JSON.stringify(getModel().fabric.wires)}`);
  });
});

describe('[5] p pins the pane; x clears the inject', () => {
  it('p pins the pane to the current component (title shows it)', () => {
    focusPorts();
    key('p');
    const slice = api.getInstanceSlice(PORTS);
    eq(slice.pinned, 'mine', 'slice.pinned set to the resolved component');
    assert(/\(pinned\)/.test(frame()), 'title shows the pinned marker');
  });
  it('x clears the inject on the selected input', () => {
    focusPorts();
    key('x');
    assert(!('mine.start' in getModel().fabric.injects), 'inject removed');
  });
});

report();
