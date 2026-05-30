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

const { getModel } = require('../../runtime');
const {
  hub, esc, theme, renderPanel,
  getItems: apiGetItems,
  scheduleRender,
} = require('../api');
const { rasterize } = require('./stats-graph');

// Dedup hub.subscribe calls: one sub per (topic, window). Two stats
// panels on the same topic share a sub; different windows produce
// two subs and the hub keeps the larger window (HUB.md §6).
//
// `onUpdate: scheduleRender` is what makes the panel feel live —
// docker.refresh's `changed` flag only flips when the formatted CPU%
// / mem string actually changes between ticks (e.g. 0.0% → 0.0% does
// not), so the host's render-on-changed loop can miss new samples.
// The hub publishes every tick regardless; the onUpdate hook makes
// sure each one drives a repaint.
const _subKeys = new Set();
function _ensureSub(topic, window) {
  const key = `${topic}:${window}`;
  if (_subKeys.has(key)) return;
  hub.subscribe(topic, { window, onUpdate: () => scheduleRender() });
  _subKeys.add(key);
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
  const m = getModel();
  const sel = (m.ui.sel && m.ui.sel[panel.select_from]) || 0;
  const item = items[sel];
  if (!item) return null;
  // For string-row panels (containers, etc.) the row key IS the item.
  // Future panel types whose items are objects can extend this.
  return typeof item === 'string' ? item : null;
}

function _renderEmpty(panel, w, h, msg) {
  const t = theme();
  return renderPanel({
    width: w, height: h,
    lines: [`[${t.dim}]${esc(msg)}[/]`],
    title: panel.title, hotkey: panel.hotkey,
    panelType: 'stats',
    focused: getModel().focus === 'stats',
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

function render(panel, w, h) {
  if (!panel.topic || !panel.select_from) {
    return _renderEmpty(panel, w, h, '(stats panel needs topic + select_from)');
  }
  const window = panel.window || 40;
  _ensureSub(panel.topic, window);

  const rowKey = _resolveSelection(panel);
  if (!rowKey) return _renderEmpty(panel, w, h, '(no selection)');

  const samples = hub.history(panel.topic, rowKey, window);
  if (!samples.length) return _renderEmpty(panel, w, h, '(no data yet)');

  const schema = hub.schema(panel.topic) || { columns: {} };
  const metrics = panel.metrics || _defaultMetrics(schema);
  if (!metrics.length) return _renderEmpty(panel, w, h, '(no graphable metrics)');

  const innerW = w - 2;
  const innerH = h - 2;
  // Each metric needs: 1 header row + ≥2 graph rows. Inter-metric
  // spacing: 1 blank row between sections. Bail with a friendly empty
  // when the panel doesn't have room.
  const sepRows = Math.max(0, metrics.length - 1);
  const headerRows = metrics.length;
  const graphRowsTotal = innerH - sepRows - headerRows;
  const perMetric = Math.floor(graphRowsTotal / metrics.length);
  if (perMetric < 2) {
    return _renderEmpty(panel, w, h, '(panel too short for graph)');
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
    focused: getModel().focus === 'stats',
  });
}

// Stateless Component — `stats` is a pure render over the hub bus (where
// docker.js publishes docker.stats time series). The data lives in the hub,
// not in a Component slice; the empty slice + no-op update are the API-
// uniformity cost. See docs/v0.5-layering.md.
module.exports = {
  name: 'stats',
  init: () => ({}),
  update: (msg, slice) => slice,
  panelTypes: {
    stats: {
      kind: 'monitor',
      mode: 'content',
      render,
    },
  },
  // Test-only internals.
  _defaultMetrics,
  _fmtBytes,
  _fmtPercent,
};
