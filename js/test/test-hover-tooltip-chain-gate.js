/**
 * Hover tooltip must not paint over a popup opened by KEYBOARD while the
 * pointer is parked on a graph (docs/mouse-hit-map.md §Adjacent findings 2).
 *
 * Repro (pre-fix): hover a stats graph → tooltip active; open confirm with no
 * further mouse motion → the tooltip stayed active at z 999, ABOVE confirm
 * (z 10), because its gate was modes.isModal (false for confirm & co.) rather
 * than the chain-mode predicate the hover gesture itself uses (pane bodies
 * publish their hover handler only when no chain mode is active).
 *
 * Run: node js/test/test-hover-tooltip-chain-gate.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const sm = require('./smoke/_helpers/smoke');
const api = require('../panel/api');
const geo = require('../leaves/wm/geometry');
const route = require('../panel/route');
const mpool = require('../leaves/wm/pool');
const compositor = require('../render/overlay-compositor');

for (const c of ['stats']) if (!api.getComponent(c)) api.registerComponent(require('../panel/monitor/' + c));

const paneCfg = { id: 'g', type: 'stats', title: 'CPU', config: { topic: 'gh.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: 'off' } };

function hoverGraph() {
  sm.bootFresh({
    groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
    layout: { pool: { g: paneCfg }, columns: [{ panels: [paneCfg] }] },
  });
  sm.resize(120, 30);
  getModel().metrics = { 'gh.cpu': { series: { _: Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 100 })) },
                                     schema: { columns: { cpu: { type: 'percent' } } } } };
  const ls = api.getInstanceSlice('layout');
  const paneId = mpool.allPanesInColumns(ls.arrange).find((p) => p.type === 'stats').paneId;
  const b = geo.visibleBoundsFor(ls, paneId, route.resolveViewerPaneId());
  sm.capture(sm.render);   // hover resolves on the painted hit map (Release 3)
  sm.capture(() => sm.handleMouse('hover', b.x + 58, b.y + 15));   // park over the graph centre
  sm.capture(sm.render);
}

const OPENERS = {
  confirm:          () => sm.applyMsg({ type: 'confirm_enter', message: 'Really?', cmd: null }),
  // terminalMode is modal but NOT a chain mode: every mouse byte goes to the
  // PTY there, so graph_hover can never clear — the tooltip must not freeze.
  terminal:         () => { getModel().modes.terminalMode = true; },
  'register-popup': () => { getModel().register = { history: ['x'], cap: 10 }; sm.applyMsg({ type: 'register_popup_enter' }); },
  'diag-log':       () => sm.applyMsg({ type: 'diag_log_open', now: 0 }),
  jobs:             () => sm.applyMsg({ type: 'jobs_open', now: 0 }),
};

describe('[hover-tooltip] hidden under every popup opened by keyboard, and in terminal mode', () => {
  it('precondition: the parked hover shows the tooltip', () => {
    hoverGraph();
    eq(compositor.activeOverlayIds(getModel()), ['hover-tooltip']);
  });
  for (const [name, open] of Object.entries(OPENERS)) {
    it(`${name} open → no tooltip over it`, () => {
      hoverGraph();
      sm.capture(open);
      sm.capture(sm.render);
      const ids = compositor.activeOverlayIds(getModel());
      if (name !== 'terminal') assert(ids.includes(name), `${name} active`);
      assert(!ids.includes('hover-tooltip'), `tooltip hidden (got ${JSON.stringify(ids)})`);
      getModel().modes.terminalMode = false;
    });
  }
});

report();
