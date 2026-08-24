/**
 * Drag-to-zoom (docs/STATS.md §10) — the full harness path: a press→release drag across
 * a sectioned graph FREEZES that column range (a snapshot that survives the live window
 * aging out), the pane renders it STRETCHED to width, hover on the zoomed graph reads the
 * frozen samples, and a reset border chip clears it. A plain click (no drag) does not
 * zoom. Unit-level resample/freezeRange live in test-render-body-adjacent scratch; this
 * pins the wiring.
 *
 * Run: node js/test/test-stats-zoom.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const sm = require('./smoke/_helpers/smoke');
const api = require('../panel/api');
const geo = require('../leaves/wm/geometry');
const route = require('../panel/route');
const mpool = require('../leaves/wm/pool');
const stats = require('../panel/monitor/stats');

for (const c of ['stats']) if (!api.getComponent(c)) api.registerComponent(require('../panel/monitor/' + c));

function setMetric(topic, series, cols) {
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series, schema: { columns: cols } } };
}

const cfg = { id: 'g', type: 'stats', title: 'CPU', config: { topic: 'z.cpu', row: '_', metrics: ['cpu'], window: 300 } };
const det = { id: 'd', type: 'detail', title: 'Out' };

function boot() {
  sm.bootFresh({
    groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
    layout: { pool: { g: cfg, d: det }, columns: [{ width: 80, panels: [cfg] }, { panels: [det] }] },
  });
  sm.resize(120, 30);
  // 300 monotone samples (0..299) so a dragged sub-range has a distinct value signature.
  setMetric('z.cpu', { _: Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 100 })) }, { cpu: { type: 'percent' } });
  // The smoke harness reuses the layout instance across boots, so a prior test's zoom
  // can linger keyed by the (stable) paneId — clear it (production starts each process
  // with an empty zoom map).
  const p = mpool.allPanesInColumns(api.getInstanceSlice('layout').arrange).find((x) => x.type === 'stats');
  api.dispatchMsg(api.wrap('layout', { type: 'graph_zoom', paneId: p.paneId, frozen: null }));
}

function pane() {
  const ls = api.getInstanceSlice('layout');
  const p = mpool.allPanesInColumns(ls.arrange).find((x) => x.type === 'stats');
  return { paneId: p.paneId, b: geo.visibleBoundsFor(ls, p.paneId, route.resolveViewerPaneId()) };
}

describe('[stats-zoom] press→release drag freezes a range; reset clears it', () => {
  it('a drag across the graph freezes that column range', () => {
    boot();
    const { paneId, b } = pane();
    // Drag body col 40 → 50 on a graph row (header 0, meter 1, graph 2+). Screen = b.x+col+2.
    sm.capture(() => sm.handleMouse('press', b.x + 40 + 2, b.y + 2 + 2));
    sm.capture(() => sm.handleMouse('release', b.x + 50 + 2, b.y + 2 + 2));
    const frozen = api.getInstanceSlice('layout').zoom[paneId];
    assert(frozen, 'pane is frozen after the drag');
    assert(frozen.end > frozen.start, `a real range captured (start ${frozen && frozen.start}, end ${frozen && frozen.end})`);
  });

  it('a plain click (no drag) does NOT freeze', () => {
    boot();
    const { paneId, b } = pane();
    sm.capture(() => sm.handleMouse('press', b.x + 40 + 2, b.y + 2 + 2));
    sm.capture(() => sm.handleMouse('release', b.x + 40 + 2, b.y + 2 + 2));   // same column
    eq(api.getInstanceSlice('layout').zoom[paneId], undefined, 'no zoom from a click');
  });

  it('the zoomed graph renders STRETCHED + hover reads the frozen samples', () => {
    boot();
    const { paneId, b } = pane();
    const spec = { paneId, topic: 'z.cpu', row: '_', metrics: ['cpu'], window: 300 };
    const innerW = b.w - 2;
    // Live: col 0 is the oldest of the window. Freeze a narrow later range → col 0 becomes
    // the frozen sub-range's START (stretched), a DIFFERENT value → proves the swap.
    const liveCol0 = stats.valueAt(spec, innerW, 6, 0, 2).value;
    sm.capture(() => sm.handleMouse('press', b.x + 45 + 2, b.y + 2 + 2));
    sm.capture(() => sm.handleMouse('release', b.x + 55 + 2, b.y + 2 + 2));
    const zoomedCol0 = stats.valueAt(spec, innerW, 6, 0, 2).value;
    assert(zoomedCol0 !== liveCol0, `hover reads the frozen range, not live (live ${liveCol0}, zoomed ${zoomedCol0})`);
    // Values increase left→right across the stretched sub-range.
    const a = stats.valueAt(spec, innerW, 6, 5, 2).value;
    const z = stats.valueAt(spec, innerW, 6, innerW - 3, 2).value;
    assert(z > a, `stretched range ascends across the width (${a} → ${z})`);
  });

  it('the reset chip shows only when zoomed and clears the zoom', () => {
    boot();
    const { paneId, b } = pane();
    const ctrl = stats.panelTypes.stats.borderControls[0];
    // Not zoomed → no chip.
    eq(ctrl.render(getModel(), { paneId, type: 'stats' }), null, 'no reset chip when live');
    sm.capture(() => sm.handleMouse('press', b.x + 40 + 2, b.y + 2 + 2));
    sm.capture(() => sm.handleMouse('release', b.x + 52 + 2, b.y + 2 + 2));
    assert(api.getInstanceSlice('layout').zoom[paneId], 'precondition: zoomed');
    const chip = ctrl.render(getModel(), { paneId, type: 'stats' });
    assert(chip && chip.text.includes('1:1'), `reset chip shows when zoomed, got ${JSON.stringify(chip)}`);
    // Its dispatch → a layout graph_zoom clear.
    const act = ctrl.dispatch('reset', { paneId, type: 'stats' });
    eq(act.owner, 'layout');
    sm.capture(() => api.dispatchMsg(api.wrap(act.owner, act.msg)));
    eq(api.getInstanceSlice('layout').zoom[paneId], undefined, 'zoom cleared after reset');
  });
});

report();
