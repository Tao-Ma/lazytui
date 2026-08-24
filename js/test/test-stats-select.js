/**
 * mode:multi row SELECTION (j/k cursor) — the full harness path: a `mode: multi` stats
 * pane is now interactive like `gauge`. Exercises the real cursor pipeline (focus →
 * j/k / click → nav_select → set_cursor → the pane's nav slice), that the pane is a
 * `select_from` SOURCE (a drill-down follows its cursor), and that click hit-testing
 * maps a body row to the right index (windowed paint). Unit-level highlight/scroll/
 * getItems live in test-render-body.js; this pins the wiring.
 *
 * Run: node js/test/test-stats-select.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const sm = require('./smoke/_helpers/smoke');
const api = require('../panel/api');
const navState = require('../panel/nav-state');
const geo = require('../leaves/wm/geometry');
const route = require('../panel/route');
const mpool = require('../leaves/wm/pool');

for (const c of ['stats']) if (!api.getComponent(c)) api.registerComponent(require('../panel/monitor/' + c));

function setMetric(topic, series, cols) {
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series, schema: { columns: cols } } };
}

const muCfg = { id: 'mu', type: 'stats', title: 'Procs', config: { topic: 'sm.proc', mode: 'multi', column: 'cpu', label: 'comm' } };
const drillCfg = { id: 'dr', type: 'stats', title: 'Selected', config: { topic: 'sm.proc', select_from: 'mu', metrics: ['cpu'] } };
const detCfg = { id: 'd', type: 'detail', title: 'Out' };

function boot() {
  sm.bootFresh({
    groups: { g: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
    layout: { pool: { mu: muCfg, dr: drillCfg, d: detCfg }, columns: [{ panels: [muCfg] }, { panels: [drillCfg, detCfg] }] },
  });
  sm.resize(120, 30);
  // latest cpu: p2=90, p3=50, p1=30 → sorted desc: p2, p3, p1
  setMetric('sm.proc',
    { p1: [{ cpu: 30, comm: 'alpha' }], p2: [{ cpu: 90, comm: 'beta' }], p3: [{ cpu: 50, comm: 'gamma' }] },
    { cpu: { type: 'percent' }, comm: { type: 'string' } });
}

function muPane() {
  const ls = api.getInstanceSlice('layout');
  const p = mpool.allPanesInColumns(ls.arrange).find((x) => x.type === 'stats' && x.title === 'Procs');
  return { paneId: p.paneId, b: geo.visibleBoundsFor(ls, p.paneId, route.resolveViewerPaneId()) };
}

describe('[stats-select] mode:multi is an interactive, select_from-source list', () => {
  it('exposes the sorted rows + starts at cursor 0', () => {
    boot();
    const { paneId } = muPane();
    eq(api.getItems(paneId), ['p2', 'p3', 'p1'], 'sorted desc by latest cpu');
    eq(navState.getSel(paneId), 0, 'cursor starts at the top row');
  });

  it('j/k move the cursor through the pane (focused)', () => {
    boot();
    const { paneId, b } = muPane();
    sm.capture(() => sm.handleMouse('press', b.x + 3, b.y + 2));   // focus the pane
    eq(api.getInstanceSlice('layout').focus, paneId, 'pane focused');
    sm.capture(() => sm.handleKey('j', 'j'));
    eq(navState.getSel(paneId), 1, 'j → row 1 (p3)');
    sm.capture(() => sm.handleKey('j', 'j'));
    eq(navState.getSel(paneId), 2, 'j → row 2 (p1)');
    sm.capture(() => sm.handleKey('k', 'k'));
    eq(navState.getSel(paneId), 1, 'k → back to row 1 (p3)');
  });

  it('clicking a row selects it (windowed hit-testing)', () => {
    boot();
    const { paneId, b } = muPane();
    // No header → body rows map 1:1. Screen y = b.y + row + 2 (border + 1-based).
    sm.capture(() => sm.handleMouse('press', b.x + 3, b.y + 2 + 2));   // body row 2 → p1
    eq(navState.getSel(paneId), 2, 'clicked the third row');
  });

  it('a select_from drill-down follows the multi cursor', () => {
    boot();
    const { paneId, b } = muPane();
    sm.capture(() => sm.handleMouse('press', b.x + 3, b.y + 2));       // focus + select row 0
    sm.capture(() => sm.handleKey('j', 'j'));                          // move to row 1 → p3
    eq(navState.getSel(paneId), 1);
    // The drill-down stats pane (select_from: mu) resolves the selected key → its title
    // carries it. (Assert via a direct render — the smoke harness doesn't reliably paint
    // a multi-column layout into the captured full frame.)
    const stats = require('../panel/monitor/stats');
    const ls = api.getInstanceSlice('layout');
    const drill = mpool.allPanesInColumns(ls.arrange).find((x) => x.type === 'stats' && x.title === 'Selected');
    const db = geo.visibleBoundsFor(ls, drill.paneId, route.resolveViewerPaneId());
    const title = stats.panelTypes.stats.render(drill, db.w, db.h, null, {}).split('\n')[0].replace(/\[[^\]]*\]/g, '');
    assert(title.includes('Selected: p3'), `drill title follows the cursor to p3, got ${JSON.stringify(title)}`);
  });
});

report();
