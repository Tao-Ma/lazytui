/**
 * Graph hover-for-value (Phase 2 of the stats interactivity arc, docs/STATS.md).
 * Exercises the real path: a `hover` mouse event (mode 1003, button-less motion) →
 * input._handleHover resolves the body cell → `graph_hover` Msg → layout slice →
 * stats.render resolves the value via valueAt + publishes it to the per-frame
 * hover-region → the footer shows it. Also the layout.update arm in isolation.
 *
 * Run: node js/test/test-graph-hover.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const sm = require('./smoke/_helpers/smoke');
const api = require('../panel/api');
const layout = require('../panel/layout');
const stats = require('../panel/monitor/stats');
const hoverRegion = require('../panel/hover-region');
const geo = require('../leaves/wm/geometry');
const route = require('../panel/route');
const mpool = require('../leaves/wm/pool');

for (const c of ['stats']) if (!api.getComponent(c)) api.registerComponent(require('../panel/monitor/' + c));

function setMetric(topic, series, cols) {
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series, schema: { columns: cols } } };
}

describe('[layout] graph_hover arm — stores the raw position / clears / identity', () => {
  it('stores the hover payload', () => {
    const s0 = layout.init ? layout.init('layout', {}) : {};
    const h = { paneId: 'pane-g', col: 3, row: 4, x: 10, y: 12 };
    const s1 = layout.update({ type: 'graph_hover', hover: h }, { ...s0, hover: null });
    eq(s1.hover, h, 'hover stored verbatim');
  });
  it('null clears; unchanged payload preserves slice identity', () => {
    const h = { paneId: 'pane-g', col: 3, row: 4, x: 10, y: 12 };
    const base = { hover: h };
    const same = layout.update({ type: 'graph_hover', hover: { ...h } }, base);
    assert(same === base, 'identical payload → same slice ref (no thrash)');
    const cleared = layout.update({ type: 'graph_hover', hover: null }, base);
    eq(cleared.hover, null, 'null payload clears');
  });
});

describe('[graph-hover] real hover path → footer value + hover-region', () => {
  const paneCfg = { id: 'g', type: 'stats', title: 'CPU', config: { topic: 'gh.cpu', row: '_', metrics: ['cpu'], window: 300 } };

  function boot() {
    sm.bootFresh({
      groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { g: paneCfg }, columns: [{ panels: [paneCfg] }] },
    });
    sm.resize(120, 30);   // wide enough that the footer isn't truncated before the hover field
    // Fill the whole braille window (innerW≈118 → ~236 sample slots) so EVERY graph
    // column carries data — else the short-data left of the graph is NaN-padded and a
    // hover there correctly resolves to nothing.
    setMetric('gh.cpu', { _: Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 100 })) }, { cpu: { type: 'percent' } });
  }

  function paneBounds() {
    const ls = api.getInstanceSlice('layout');
    const paneId = mpool.allPanesInColumns(ls.arrange).find((p) => p.type === 'stats').paneId;
    const b = geo.visibleBoundsFor(ls, paneId, route.resolveViewerPaneId());
    return { paneId, b };
  }

  it('hovering a graph cell publishes the value + shows it in the footer', () => {
    boot();
    const { paneId, b } = paneBounds();
    // Body col 0, body row 2 (header 0, percent-meter 1, graph 2+). Screen 1-based:
    // x = b.x + col + 2, y = b.y + row + 2.
    const col = 0, row = 2;
    const x = b.x + col + 2, y = b.y + row + 2;
    sm.capture(() => sm.handleMouse('hover', x, y));

    const hv = hoverRegion.get();
    assert(hv && hv.paneId === paneId, `hover-region published for the pane, got ${JSON.stringify(hv)}`);
    assert(/CPU/.test(hv.text), `text names the metric, got ${JSON.stringify(hv.text)}`);
    // renderFooter reads the live hover-region (published during the hover's paint).
    const footer = require('../render/footer').renderFooter(getModel());
    assert(footer.includes('⌖') && footer.includes(hv.text), `footer shows the hovered value, got hv=${JSON.stringify(hv.text)}`);
  });

  it('the value also appears in a floating tooltip box (full frame)', () => {
    boot();
    const { b } = paneBounds();
    sm.capture(() => sm.handleMouse('hover', b.x + 2, b.y + 4));
    const hv = hoverRegion.get();
    assert(hv && hv.text, 'hover set');
    require('../leaves/infra/render-queue').forceFullRepaint();
    const frame = sm.capture(() => sm.render()).frame;
    const n = frame.split(hv.text).length - 1;   // footer + tooltip box
    assert(n >= 2, `value shown in BOTH footer and tooltip box, found ${n}× — ${JSON.stringify(hv.text)}`);
  });

  it('hovering off any graph (top-left corner) clears the hover', () => {
    boot();
    // First hover ON the graph to set state.
    const { b } = paneBounds();
    sm.capture(() => sm.handleMouse('hover', b.x + 2, b.y + 4));
    assert(hoverRegion.get(), 'precondition: a hover is live');
    // Then hover at (1,1) — the very corner (border / nothing selectable).
    sm.capture(() => sm.handleMouse('hover', 1, 1));
    eq(hoverRegion.get(), null, 'hover cleared when off the graph');
    assert(!require('../render/footer').renderFooter(getModel()).includes('⌖'), 'footer no longer shows a hover value');
  });

  it('re-hovering the SAME cell does not thrash (coalesced)', () => {
    boot();
    const { b } = paneBounds();
    const x = b.x + 2, y = b.y + 4;
    sm.capture(() => sm.handleMouse('hover', x, y));
    const first = hoverRegion.get();
    assert(first, 'first hover set');
    // Same cell again — layout arm preserves slice identity; value re-resolves the same.
    sm.capture(() => sm.handleMouse('hover', x, y));
    const second = hoverRegion.get();
    eq(second.text, first.text, 'same cell → same resolved value');
  });
});

report();
