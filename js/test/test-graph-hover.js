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
  const paneCfg = { id: 'g', type: 'stats', title: 'CPU', config: { topic: 'gh.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: 'off' } };

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

// --- Follow-ons: composite graph widgets + overlay + mode:multi (Phase 2 completion) ---

for (const c of ['composite']) if (!api.getComponent(c)) api.registerComponent(require('../panel/monitor/' + c));

function paneOf(type) {
  const ls = api.getInstanceSlice('layout');
  const p = mpool.allPanesInColumns(ls.arrange).find((pp) => pp.type === type);
  const b = geo.visibleBoundsFor(ls, p.paneId, route.resolveViewerPaneId());
  return { paneId: p.paneId, b };
}

describe('[graph-hover] composite graph widget → footer value', () => {
  // A composite with a single `graph` widget (no gap/heading): body row 0 header,
  // row 1 percent meter, rows 2+ graph — same stack a standalone stats pane has.
  // window: 300 fills the wide graph so column 0 carries data (else the NaN-padded
  // left edge correctly resolves to nothing — same reason the standalone test does it).
  const cfg = { id: 'nb', type: 'composite', title: 'Box',
    config: { widgets: [{ type: 'graph', topic: 'gh.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: 'off' }] } };

  function boot() {
    sm.bootFresh({
      groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { nb: cfg }, columns: [{ panels: [cfg] }] },
    });
    sm.resize(120, 30);
    setMetric('gh.cpu', { _: Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 100 })) }, { cpu: { type: 'percent' } });
  }

  it('hovering a graph widget publishes the value + shows it in the footer', () => {
    boot();
    const { paneId, b } = paneOf('composite');
    // Body col 0, row 2 (widget header 0, meter 1, graph 2). Screen: +2 for the border.
    sm.capture(() => sm.handleMouse('hover', b.x + 0 + 2, b.y + 2 + 2));
    const hv = hoverRegion.get();
    assert(hv && hv.paneId === paneId, `hover-region published for the box, got ${JSON.stringify(hv)}`);
    assert(/CPU/.test(hv.text), `text names the metric, got ${JSON.stringify(hv.text)}`);
    const footer = require('../render/footer').renderFooter(getModel());
    assert(footer.includes('⌖') && footer.includes(hv.text), `footer shows the value, got ${JSON.stringify(hv.text)}`);
  });

  it('hovering the widget HEADER row (not a data cell) publishes nothing', () => {
    boot();
    const { b } = paneOf('composite');
    sm.capture(() => sm.handleMouse('hover', b.x + 2 + 2, b.y + 0 + 2));   // body row 0 = header
    eq(hoverRegion.get(), null, 'header row → no value');
  });
});

describe('[graph-hover] composite header:bottom mirror SEAM (the net-box case)', () => {
  // The exact reported bug: TX graph (normal) sits flush above an RX graph that is
  // invert + header:bottom — btop's up/down mirror. The seam (RX graph's TOP row) must
  // resolve, and the RX header (moved to the BOTTOM) must not.
  const composite = require('../panel/monitor/composite');
  const cfg = { id: 'net', type: 'composite', title: 'Net', config: { widgets: [
    { type: 'graph', topic: 'gh.net', row: '_', metrics: ['tx'], window: 300, height: '45%', y_axis: 'off' },
    { type: 'graph', topic: 'gh.net', row: '_', metrics: ['rx'], window: 300, invert: true, header: 'bottom', flush: true, height: '45%', y_axis: 'off' },
  ] } };

  function boot() {
    sm.bootFresh({
      groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { net: cfg }, columns: [{ panels: [cfg] }] },
    });
    sm.resize(120, 30);
    setMetric('gh.net', { _: Array.from({ length: 300 }, (_x, i) => ({ tx: 1000 + i, rx: 5000 + i })) },
      { tx: { type: 'bytes' }, rx: { type: 'bytes' } });
  }

  // The RX (second) widget's body-row range, mirroring composite's stacking (flush → no gap).
  function rxRange(b) {
    const innerH = b.h - 2;
    const heights = composite._split(cfg.config.widgets, innerH);
    return { start: heights[0], h1: heights[1] };   // flush + no heading → RX body starts right after TX
  }

  it('the seam (RX graph top row) resolves to RX, not nothing', () => {
    boot();
    const { b } = paneOf('composite');
    const { start } = rxRange(b);
    const col = b.w - 2 - 4;   // a filled right column
    sm.capture(() => sm.handleMouse('hover', b.x + col + 2, b.y + start + 2));
    const hv = hoverRegion.get();
    assert(hv && /RX/.test(hv.text), `seam resolves to RX, got ${JSON.stringify(hv)}`);
  });

  it('the RX header (pushed to the bottom by header:bottom) resolves to nothing', () => {
    boot();
    const { b } = paneOf('composite');
    const { start, h1 } = rxRange(b);
    const col = b.w - 2 - 4;
    sm.capture(() => sm.handleMouse('hover', b.x + col + 2, b.y + (start + h1 - 1) + 2));   // last RX body row = header
    eq(hoverRegion.get(), null, 'RX header row → no value');
  });
});

describe('[graph-hover] overlay graph → all series in the footer', () => {
  const cfg = { id: 'ov', type: 'stats', title: 'Net',
    config: { topic: 'gh.net', row: '_', metrics: ['rx', 'tx'], overlay: true, window: 300, y_axis: 'off' } };

  function boot() {
    sm.bootFresh({
      groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { ov: cfg }, columns: [{ panels: [cfg] }] },
    });
    sm.resize(120, 30);
    setMetric('gh.net', { _: Array.from({ length: 300 }, (_x, i) => ({ rx: i, tx: 1000 + i })) },
      { rx: { type: 'bytes' }, tx: { type: 'bytes' } });
  }

  it('hovering an overlay column shows every series value', () => {
    boot();
    const { b } = paneOf('stats');
    // Overlay body: row 0 legend, rows 1+ graph. Hover a graph row.
    sm.capture(() => sm.handleMouse('hover', b.x + 10 + 2, b.y + 2 + 2));
    const hv = hoverRegion.get();
    assert(hv && hv.text, `overlay hover set, got ${JSON.stringify(hv)}`);
    assert(/RX/.test(hv.text) && /TX/.test(hv.text), `both series in the footer text, got ${JSON.stringify(hv.text)}`);
  });

  it('hovering the legend row (row 0) publishes nothing', () => {
    boot();
    const { b } = paneOf('stats');
    sm.capture(() => sm.handleMouse('hover', b.x + 10 + 2, b.y + 0 + 2));
    eq(hoverRegion.get(), null, 'legend row → no value');
  });
});

describe('[graph-hover] mode:multi → the hovered row value in the footer', () => {
  const cfg = { id: 'mu', type: 'stats', title: 'Procs',
    config: { topic: 'gh.multi', mode: 'multi', column: 'cpu', window: 300 } };

  function boot() {
    sm.bootFresh({
      groups: { grp: { label: 'G', containers: [], actions: { a: { cmd: 'echo', label: 'A' } } } },
      layout: { pool: { mu: cfg }, columns: [{ panels: [cfg] }] },
    });
    sm.resize(120, 30);
    setMetric('gh.multi',
      { a: Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 50 })), b: Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 90 })) },
      { cpu: { type: 'percent' } });
  }

  it('hovering a sparkline row shows that row label + value', () => {
    boot();
    const { paneId } = paneOf('stats');
    const ls = api.getInstanceSlice('layout');
    const b = geo.visibleBoundsFor(ls, paneId, route.resolveViewerPaneId());
    const lay = stats._multiLayout({ topic: 'gh.multi', mode: 'multi', column: 'cpu', window: 300 }, b.w - 2);
    const sparkMid = lay.labelW + 1 + Math.floor(lay.sparkW / 2);
    sm.capture(() => sm.handleMouse('hover', b.x + sparkMid + 2, b.y + 0 + 2));   // top row (row 0)
    const hv = hoverRegion.get();
    assert(hv && hv.text, `multi hover set, got ${JSON.stringify(hv)}`);
    assert(new RegExp(`^${lay.rows[0].label}\\b`).test(hv.text), `footer names the row, got ${JSON.stringify(hv.text)}`);
  });

  it('hovering the label column (not the spark) publishes nothing', () => {
    boot();
    const { paneId } = paneOf('stats');
    const b = geo.visibleBoundsFor(api.getInstanceSlice('layout'), paneId, route.resolveViewerPaneId());
    sm.capture(() => sm.handleMouse('hover', b.x + 0 + 2, b.y + 0 + 2));   // col 0 = label area
    eq(hoverRegion.get(), null, 'label column → no value');
  });
});

report();
