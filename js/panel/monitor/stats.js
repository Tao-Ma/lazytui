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
 *     graph: braille        # optional: braille (default) | blocks
 */
'use strict';

const { getModel } = require('../../model/store');
const {
  esc, theme, gradient, renderPanel,
  getItems: apiGetItems,
} = require('../api');
const { rasterize, rasterizeBraille, columnNorms, colorizeRows, colorizeByHeight, quantizeNorm, meterRow } = require('./stats-graph');

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

// A `rate` column carries a per-second value (a producer's `counter` derivation,
// e.g. net/disk throughput) — format as human bytes/sec.
function _fmtRate(v) {
  if (!Number.isFinite(v)) return '—';
  return `${_fmtBytes(v)}/s`;
}

function _resolveSelection(panel) {
  // Single-stream topic (a headless metrics producer with one row, e.g.
  // host.cpu): render the static `row:` (default '_') when there's no cursor
  // to follow. See docs/metrics-producer.md §9.
  if (!panel.select_from) return panel.row != null ? String(panel.row) : null;
  const items = apiGetItems(panel.select_from);
  if (!items.length) return null;
  // Phase 4a — read the cursor via the state helper (resolves the
  // owning Component's nav slice). Clamp to the list length: a data-derived
  // source (e.g. a `table` of processes) shrinks as rows come and go, and the
  // cursor isn't re-clamped on shrink — an out-of-range index would blank the
  // graph instead of following to the last row.
  const sel = require('../nav-state').getSel(panel.select_from);
  const item = items[Math.min(sel, items.length - 1)];
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
 * Render one metric's section: header line, meter row (percent metrics),
 * graph rows.
 *
 *   CPU                    47.2%  peak 92.1%  avg 38.5%
 *   █████████▍                              ← percent only: current value
 *   ⣠⣴⣾⣿⣿⣷⣄⡀                              ← height-mapped gradient (default)
 *   ...
 *
 * Axis scaling:
 *   percent → fixed 0–100 (so "30% CPU" reads visually as "around a third")
 *   bytes / number → 0–local-max (shape of change, not absolute scale)
 *
 * Truecolor arc Phase 2 (docs/truecolor.md): graphs render braille by
 * default (`graph: blocks` opts out per pane — a plain config choice, P4:
 * render never consults device depth). Color maps through the theme's percent
 * gradient; the mapping is `graph_color:` (default `height`, btop-style, colored
 * by vertical position for wire-byte thrift; `value`/`banded` opt in to
 * value-mapped color). The colorize leaves batch runs and `[/]`-terminate them
 * (P8); this panel only injects `gradient('percent', frac)`.
 *
 * `meta: true` schema columns (e.g. memLimit) carry scale info that
 * a consumer could use, but the panel stays scale-of-its-own — empty
 * containers and busy ones both get a graph that fills the rows.
 */
function _renderSection(metric, samples, schema, width, graphHeight, style, colorMode) {
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
  } else if (col.type === 'rate') {
    if (finite.length) max = Math.max(1, ...finite);
    fmt = _fmtRate;
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

  const opts = { width, height: graphHeight, min, max };
  const rows = style === 'blocks' ? rasterize(values, opts) : rasterizeBraille(values, opts);
  const norms = columnNorms(values, { width, min, max, group: style === 'blocks' ? 1 : 2 });
  let colored;
  if (colorMode === 'value') {
    // value-mapped through the full ramp (highest fidelity, most wire bytes).
    colored = colorizeRows(rows, norms,
      (n) => (Number.isFinite(n) ? gradient('percent', n) : null));
  } else if (colorMode === 'banded') {
    // value-mapped but quantized to 8 bands (fewer SGR changes per tick).
    colored = colorizeRows(rows, norms,
      (n) => (Number.isFinite(n) ? gradient('percent', quantizeNorm(n, 8)) : null));
  } else {
    // height (default): color by vertical position, static per row (byte-thrift).
    colored = colorizeByHeight(rows, (frac) => gradient('percent', frac));
  }

  const out = [header];
  if (col.type === 'percent') {
    // Current-value meter (one value = one color run).
    const frac = Number.isFinite(latest) ? latest / 100 : NaN;
    const meter = meterRow(frac, width);
    out.push(Number.isFinite(frac) ? `[${gradient('percent', frac)}]${meter}[/]` : meter);
  }
  out.push(...colored);
  return out;
}

function render(panel, w, h, _slice, opts) {
  const chrome = opts && opts.chrome;
  // v0.6.4 Theme A Phase 5 — per-pane focus (opts.focused). stats reads
  // ANOTHER pane's cursor via panel.select_from (cross-pane by design),
  // so its own slice is empty; only the focus flag is per-pane here.
  const focused = !!(opts && opts.focused);
  if (!panel.topic || (!panel.select_from && panel.row == null)) {
    return _renderEmpty(panel, w, h, '(stats panel needs topic + select_from or row)', chrome, focused);
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

  // Graph style: braille by default, `graph: blocks` opts out (P4 — a plain
  // per-pane config choice; render never consults the device's color depth).
  const style = panel.graph === 'blocks' ? 'blocks' : 'braille';
  // Graph color mapping. `height` (DEFAULT, btop-style) colors by vertical
  // position — static per row, so a sample shift moves the glyphs but recolors
  // nothing: cell-diff sends only the changed cells (~−81% wire bytes/tick vs
  // `value`). Opt out per pane: `value` colors each column by its value through
  // the full percent ramp (highest signal, but the 101-step ramp recolors nearly
  // every column each tick); `banded` keeps value-mapping quantized to 8 bands
  // (~−38%, a middle ground). See docs/truecolor.md + STATS.md.
  const colorMode = (panel.graph_color === 'value' || panel.graph_color === 'banded')
    ? panel.graph_color : 'height';

  const innerW = w - 2;
  const innerH = h - 2;
  const sepRows = Math.max(0, metrics.length - 1);
  const headerRows = metrics.length;
  // Percent metrics carry a one-row current-value meter under the header.
  const meterRows = metrics
    .filter((m) => ((schema.columns || {})[m] || {}).type === 'percent').length;
  const graphRowsTotal = innerH - sepRows - headerRows - meterRows;
  const perMetric = Math.floor(graphRowsTotal / metrics.length);
  if (perMetric < 2) {
    return _renderEmpty(panel, w, h, '(panel too short for graph)', chrome, focused);
  }

  const lines = [];
  metrics.forEach((m, i) => {
    if (i > 0) lines.push('');
    lines.push(..._renderSection(m, samples, schema, innerW, perMetric, style, colorMode));
  });

  return renderPanel({
    width: w, height: h, lines,
    // Single-stream topics use the sentinel rowKey '_' (no entity to name) —
    // show the bare title; drill-down topics append the selected row.
    title: rowKey === '_' ? panel.title : `${panel.title}: ${esc(rowKey)}`,
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
  _fmtRate,
  _renderSection,
};
