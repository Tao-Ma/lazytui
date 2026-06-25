/**
 * Core plugin — stats panel.
 *
 * YAML-declarable consumer of hub data. Renders a focused-row deep
 * view: multi-row block-char line graphs (one per metric) for the
 * row currently focused in another panel (`select_from`). Generic
 * over the hub topic — schema column types drive axis scaling.
 *
 * See STATS.md for the design doc; this is the implementation.
 *
 * YAML shape:
 *   - type: stats
 *     title: Stats
 *     topic: docker.stats
 *     select_from: containers
 *     metrics: [cpu, mem]   # optional, defaults to all percent/bytes columns
 *     window: 40            # optional, default 40
 */
'use strict';

const { getModel } = require('../../model/store');
const {
  esc, theme, renderPanel,
  getItems: apiGetItems,
} = require('../api');
const { rasterize } = require('./stats-graph');

// stats DECLARES its hub subscription; the framework owns the hub.subscribe
// side effect. This is the canonical TEA `subscriptions : Model → Sub` seam
// (#D13): the runtime re-evaluates the desired set each dispatch and reconciles
// (app/state.reconcileSubscriptions, via the dispatch finalizer) — subscribe on
// pane-place, unsubscribe on pane-remove. The Component stays a pure function of
// its inputs (render() never touches the hub's subscription list). The `model`
// arg is available for a sub whose existence depends on model state; stats's
// only depends on its pane config, so it ignores it. (v0.6.4 Phase D introduced
// the declared seam wired at mount; #D13 made it a full reconciler with teardown.
// Pre-D, `_ensureSub` ran from render() — a paint-mixed-with-lifecycle exception.)
//
// v0.6.6 Finding B — stats declares a `metrics-mirror` Sub, NOT a bare hub sub.
// The mirror (app/state.js) subscribes to the hub (so it RETAINS `window`
// samples) AND throttle-samples hub.matrix(topic) into model.metrics[topic], so
// render reads the MODEL (frame = f(model), #D5) instead of the off-model hub
// bus live. The throttle (trailing, default 250ms) is the canonical TEA handler
// for a high-frequency external source feeding a graph — sample at a bounded
// cadence, not per publish; it also subsumes the old repaint role (the
// metrics_synced dispatch repaints) without re-introducing the per-publish
// dispatch the hub's #D17 deleted. Multiple stats
// panes on one topic share a single mirror (keyed by topic; render slices to its
// own pane window). Pure projection of the pane config → descriptors:
function subscriptions(paneDef, _model) {
  if (!paneDef || !paneDef.topic) return [];
  return [{ kind: 'metrics-mirror', topic: paneDef.topic, window: paneDef.window || 40 }];
}

function _defaultMetrics(schema) {
  if (!schema || !schema.columns) return [];
  return Object.entries(schema.columns)
    .filter(([, c]) => c && (c.type === 'percent' || c.type === 'bytes') && !c.meta)
    .map(([k]) => k);
}

function _fmtPercent(v) {
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(1)}%`;
}

function _fmtBytes(v) {
  if (!Number.isFinite(v)) return '—';
  if (v < 1024) return `${Math.round(v)}B`;
  if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)}KiB`;
  if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)}MiB`;
  return `${(v / 1024 ** 3).toFixed(2)}GiB`;
}

function _resolveSelection(panel) {
  if (!panel.select_from) return null;
  const items = apiGetItems(panel.select_from);
  // Phase 4a — read the cursor via the state helper (resolves the
  // owning Component's nav slice).
  const sel = require('../nav-state').getSel(panel.select_from);
  const item = items[sel];
  if (!item) return null;
  // For string-row panels (containers, etc.) the row key IS the item.
  // Future panel types whose items are objects can extend this.
  return typeof item === 'string' ? item : null;
}

function _renderEmpty(panel, w, h, msg, chrome, focused) {
  const t = theme();
  return renderPanel({
    width: w, height: h,
    lines: [`[${t.dim}]${esc(msg)}[/]`],
    title: panel.title, hotkey: panel.hotkey,
    panelType: 'stats',
    focused: !!focused,
    chrome,
  });
}

/**
 * Render one metric's section: header line + graph rows.
 *
 *   CPU                    47.2%  peak 92.1%  avg 38.5%
 *   ▁▁▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▁
 *   ...
 *
 * Axis scaling:
 *   percent → fixed 0–100 (so "30% CPU" reads visually as "around a third")
 *   bytes / number → 0–local-max (shape of change, not absolute scale)
 *
 * `meta: true` schema columns (e.g. memLimit) carry scale info that
 * a consumer could use, but the panel stays scale-of-its-own — empty
 * containers and busy ones both get a graph that fills the rows.
 */
function _renderSection(metric, samples, schema, width, graphHeight) {
  const col = (schema.columns || {})[metric] || {};
  const values = samples.map(s => s && s[metric]);
  const finite = values.filter(Number.isFinite);
  const latest = finite.length ? finite[finite.length - 1] : NaN;
  const peak = finite.length ? Math.max(...finite) : NaN;
  const avg = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN;

  let min = 0;
  let max = 1;
  let fmt = (v) => Number.isFinite(v) ? String(v) : '—';
  if (col.type === 'percent') {
    max = 100;
    fmt = _fmtPercent;
  } else if (col.type === 'bytes') {
    if (finite.length) max = Math.max(1, ...finite);
    fmt = _fmtBytes;
  } else if (finite.length) {
    max = Math.max(1, ...finite);
  }

  const t = theme();
  const label = metric.toUpperCase();
  const stats = `${fmt(latest)}  peak ${fmt(peak)}  avg ${fmt(avg)}`;
  // Header: bold label on the left, stats on the right.
  const labelLen = label.length;
  const statsLen = stats.length;
  const padLen = Math.max(1, width - labelLen - statsLen);
  const header = `[bold]${label}[/]${' '.repeat(padLen)}[${t.dim}]${stats}[/]`;

  const rows = rasterize(values, { width, height: graphHeight, min, max });
  const colored = rows.map(r => `[${t.accent}]${r}[/]`);

  return [header, ...colored];
}

function render(panel, w, h, _slice, opts) {
  const chrome = opts && opts.chrome;
  // v0.6.4 Theme A Phase 5 — per-pane focus (opts.focused). stats reads
  // ANOTHER pane's cursor via panel.select_from (cross-pane by design),
  // so its own slice is empty; only the focus flag is per-pane here.
  const focused = !!(opts && opts.focused);
  if (!panel.topic || !panel.select_from) {
    return _renderEmpty(panel, w, h, '(stats panel needs topic + select_from)', chrome, focused);
  }
  const window = panel.window || 40;

  const rowKey = _resolveSelection(panel);
  if (!rowKey) return _renderEmpty(panel, w, h, '(no selection)', chrome, focused);

  // Finding B — read the store-mirror'd snapshot off the model, not the hub bus
  // live. The metrics-mirror Sub keeps model.metrics[topic] current (throttled);
  // selection changes (a different rowKey) repaint via their own nav dispatch and
  // read the row already present here. Slice to this pane's window.
  const metric = getModel().metrics[panel.topic];
  const samples = ((metric && metric.series[rowKey]) || []).slice(-window);
  if (!samples.length) return _renderEmpty(panel, w, h, '(no data yet)', chrome, focused);

  const schema = (metric && metric.schema) || { columns: {} };
  const metrics = panel.metrics || _defaultMetrics(schema);
  if (!metrics.length) return _renderEmpty(panel, w, h, '(no graphable metrics)', chrome, focused);

  const innerW = w - 2;
  const innerH = h - 2;
  const sepRows = Math.max(0, metrics.length - 1);
  const headerRows = metrics.length;
  const graphRowsTotal = innerH - sepRows - headerRows;
  const perMetric = Math.floor(graphRowsTotal / metrics.length);
  if (perMetric < 2) {
    return _renderEmpty(panel, w, h, '(panel too short for graph)', chrome);
  }

  const lines = [];
  metrics.forEach((m, i) => {
    if (i > 0) lines.push('');
    lines.push(..._renderSection(m, samples, schema, innerW, perMetric));
  });

  return renderPanel({
    width: w, height: h, lines,
    title: `${panel.title}: ${esc(rowKey)}`,
    hotkey: panel.hotkey,
    panelType: 'stats',
    focused,
    chrome,
  });
}

// Stateless Component — `stats` is a pure render over model.metrics[topic]
// (v0.6.6 Finding B; the `metrics-mirror` Sub samples docker.js's hub time series
// into the model). It owns no slice of its own — the empty slice + no-op update
// are the API-uniformity cost; the series it renders is cross-cutting model
// state. See docs/v0.5-layering.md + docs/v0.6.6.md §9.
module.exports = {
  name: 'stats',
  init: () => ({}),
  update: (msg, slice) => slice,
  // v0.6.6 Finding B — declares a `metrics-mirror` Sub (pure projection of the
  // pane config); the framework reconciles it. See the `subscriptions` comment.
  subscriptions,
  panelTypes: {
    stats: {
      render,
    },
  },
  // Test-only internals.
  _defaultMetrics,
  _fmtBytes,
  _fmtPercent,
};
