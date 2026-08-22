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
 *     metrics: [cpu, mem]   # optional; defaults to percent/bytes/rate columns
 *                           # (number is metadata-ambiguous — list it explicitly)
 *     window: 40            # optional, default 40
 *     graph: braille        # optional: braille (default) | blocks
 */
'use strict';

const { getModel } = require('../../model/store');
const {
  esc, theme, gradient, renderPanel, visibleLen,
  getItems: apiGetItems, getInstanceSlice,
} = require('../api');
const hoverRegion = require('../hover-region');
const { truncate } = require('../../leaves/render/draw');
const { fmt: _fmtCell } = require('../../leaves/metrics/format');   // shared compact cell formatter (see gauge/table)
const { rasterize, rasterizeBraille, rasterizeBrailleMulti, columnNorms, colorizeRows, colorizeOverlay, colorizeByHeight, quantizeNorm, meterRow } = require('./stats-graph');

// Distinct-hue palette for overlaid series (net up/down, etc.) — semantic theme
// atoms that resolve to the current theme at paint (docs semantic-theme-tokens).
const OVERLAY_COLORS = ['accent', 'warning', 'success', 'error'];

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

// Auto-selected metrics when a pane omits `metrics:`: percent / bytes / rate
// columns (all unambiguously measurements), minus `string` and `meta:` columns.
// `number` is deliberately NOT auto-graphed — a number column is often metadata
// (a timestamp / id / count), which would draw a useless ramp; graph one by
// listing it in `metrics:` explicitly. `rate` (counter-derived, always a real
// per-second measurement) WAS wrongly excluded — added here.
const _GRAPHABLE = new Set(['percent', 'bytes', 'rate']);
function _defaultMetrics(schema) {
  if (!schema || !schema.columns) return [];
  return Object.entries(schema.columns)
    .filter(([, c]) => c && _GRAPHABLE.has(c.type) && !c.meta)
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
  // B-F3: resolve the bare pool-id to the SPECIFIC pane when one is minted, so a
  // follower graph tracks the intended table even with several same-kind tables
  // placed (else it collapses onto the first-minted). hasInstance-guarded →
  // single-pane / service targets behave exactly as before.
  const src = require('../route').resolveSourcePaneId(panel.select_from);
  const items = apiGetItems(src);
  if (!items.length) return null;
  // Phase 4a — read the cursor via the state helper (resolves the
  // owning Component's nav slice). Clamp to the list length: a data-derived
  // source (e.g. a `table` of processes) shrinks as rows come and go, and the
  // cursor isn't re-clamped on shrink — an out-of-range index would blank the
  // graph instead of following to the last row.
  const sel = require('../nav-state').getSel(src);
  const item = items[Math.min(sel, items.length - 1)];
  if (!item) return null;
  // For string-row panels (containers, etc.) the row key IS the item.
  // Future panel types whose items are objects can extend this.
  return typeof item === 'string' ? item : null;
}

// Border-less body — the composable half of render (docs/compact-panes.md §2).
// Resolves this pane's samples (aggregate / select_from cursor / static row) and
// builds the stacked line-graph SECTIONS to fit `innerW × innerH` — no border, no
// title. `render` wraps it in renderPanel; a `composite` panel stacks it beside
// other widget bodies. Returns { lines, rowKey } — rowKey is the resolved row
// ('_' for aggregate / single-stream / any empty case) so the caller can suffix a
// drill-down title; the border-less lines carry every empty/short state as a dim
// message (so the wrapper draws a bordered box either way). Pure of chrome/focus:
// the height-mapped graph colour doesn't depend on focus. `spec` is the pane/widget
// config (topic, row/select_from/aggregate, metrics, window, graph, graph_color).
function renderBody(spec, innerW, innerH, hoverCol = -1) {
  const t = theme();
  const dim = (msg) => ({ lines: [`[${t.dim}]${esc(msg)}[/]`], rowKey: '_' });
  if (!spec.topic) {
    return dim('(stats panel needs topic + select_from / row / aggregate)');
  }
  const window = spec.window || 40;
  const metric = getModel().metrics[spec.topic];
  const schema = (metric && metric.schema) || { columns: {} };

  // `mode: multi` — ONE height-1 sparkline per ROW of the topic (btop process-list
  // style: one metric across all rows), instead of one series across N metrics. It
  // needs only a topic — no select_from / row / aggregate — so it branches ahead of
  // that guard. See docs/STATS.md + docs/compact-panes.md (works as a composite
  // `graph` widget too).
  if (spec.mode === 'multi') return _renderMulti(spec, metric, schema, innerW, innerH, window, dim);

  if (!spec.select_from && spec.row == null && !spec.aggregate) {
    return dim('(stats panel needs topic + select_from / row / aggregate)');
  }

  // `aggregate:` folds ALL rows into one synthetic series (no cursor); otherwise
  // follow the select_from cursor / static row, sliced to this pane's window.
  let samples;
  let rowKey = '_';
  if (spec.aggregate) {
    samples = _aggregateSamples((metric && metric.series) || {}, schema, window, spec.aggregate);
  } else {
    rowKey = _resolveSelection(spec);
    if (!rowKey) return dim('(no selection)');
    samples = ((metric && metric.series[rowKey]) || []).slice(-window);
  }
  if (!samples.length) return dim('(no data yet)');
  const metrics = spec.metrics || _defaultMetrics(schema);
  if (!metrics.length) return dim('(no graphable metrics)');

  // Graph style: braille by default, `graph: blocks` opts out (P4 — a plain
  // per-pane config choice; render never consults the device's color depth).
  const style = spec.graph === 'blocks' ? 'blocks' : 'braille';
  // Graph color mapping. `height` (DEFAULT, btop-style) colors by vertical
  // position — static per row, so a sample shift moves the glyphs but recolors
  // nothing (cell-diff sends only the changed cells). `value` colors each column
  // by its value through the full percent ramp (highest signal, most wire bytes);
  // `banded` keeps value-mapping quantized to 8 bands (a middle ground). See
  // docs/truecolor.md + STATS.md.
  const colorMode = (spec.graph_color === 'value' || spec.graph_color === 'banded')
    ? spec.graph_color : 'height';

  // `overlay: true` — draw ALL metrics in ONE braille grid (each a distinct
  // colour) under a coloured legend, instead of a section per metric. The payoff
  // is a 2-series read (e.g. network rx/tx up/down in one trace). Overlay implies
  // braille (blocks can't OR two dots in a cell) + one shared value scale so the
  // series are comparable. See docs/compact-panes.md §5 + STATS.md.
  if (spec.overlay) {
    const legend = metrics.map((m, i) => `[${OVERLAY_COLORS[i % OVERLAY_COLORS.length]}]${esc(m.toUpperCase())}[/]`).join('  ');
    const graphH = innerH - 1;                                   // 1 legend row
    if (graphH < 2) return dim('(panel too short for graph)');
    // Shared scale: all-percent → 0..100; else 0..max-finite-across-all-series.
    let oMin = 0, oMax = 1;
    const cols = schema.columns || {};
    if (metrics.every((m) => (cols[m] || {}).type === 'percent')) oMax = 100;
    else {
      let mx = 1;
      for (const m of metrics) for (const s of samples) { const v = s && s[m]; if (Number.isFinite(v) && v > mx) mx = v; }
      oMax = mx;
    }
    const seriesArr = metrics.map((m) => samples.map((s) => s && s[m]));
    const { rows, owners } = rasterizeBrailleMulti(seriesArr, { width: innerW, height: graphH, min: oMin, max: oMax });
    const colored = colorizeOverlay(rows, owners, metrics.map((_m, i) => OVERLAY_COLORS[i % OVERLAY_COLORS.length]));
    return { lines: [legend, ...colored], rowKey };
  }

  const sepRows = Math.max(0, metrics.length - 1);
  const headerRows = metrics.length;
  // Percent metrics carry a one-row current-value meter under the header.
  const meterRows = metrics
    .filter((m) => ((schema.columns || {})[m] || {}).type === 'percent').length;
  const graphRowsTotal = innerH - sepRows - headerRows - meterRows;
  const perMetric = Math.floor(graphRowsTotal / metrics.length);
  if (perMetric < 2) return dim('(panel too short for graph)');

  const lines = [];
  metrics.forEach((m, i) => {
    if (i > 0) lines.push('');
    lines.push(..._renderSection(m, samples, schema, innerW, perMetric, style, colorMode, hoverCol));
  });
  return { lines, rowKey };
}

const _MULTI_VALUE_W = 8;   // right-hand current-value column (matches gauge's)

/**
 * `mode: multi` body — one height-1 braille sparkline per ROW of the topic, sorted
 * by latest value (desc default, `sort_dir: asc` flips), viewport = the top innerH
 * rows. Like the `bars` gauge but a HISTORY sparkline in place of the current-value
 * bar. One shared value scale (percent → 0–100, else the max across all rows) keeps
 * the rows comparable; the sparkline is value-mapped through the percent ramp so a
 * spike reads hot. Display-only in v1 (no per-row cursor). Reuses rasterizeBraille /
 * columnNorms / colorizeRows and the shared truncate + format leaves.
 *
 *   node12   ⣀⣠⣴⣶⣾⣿   62.0%
 *   redis3   ⢀⡠⠔⠊⠉      9.1%
 *
 * `column:` picks the metric to sparkline (default: the first graphable column);
 * `label:` names a string column for the row label (default: the row key).
 */
function _renderMulti(spec, metric, schema, innerW, innerH, window, dim) {
  if (innerW < 1 || innerH < 1) return dim('(panel too small)');
  const series = (metric && metric.series) || {};
  const keys = Object.keys(series);
  if (!keys.length) return dim('(no data yet)');
  const cols = schema.columns || {};
  const col = spec.column || _defaultMetrics(schema)[0];
  if (!col) return dim('(no graphable metrics)');
  const type = (cols[col] || {}).type;
  const labelCol = spec.label && (cols[spec.label] || {}).type === 'string' ? spec.label : null;

  // Per-row windowed value series + latest + label. A shorter (just-appeared) row
  // right-aligns inside its own sparkline (the rasterizer NaN-pads the front).
  const rows = keys.map((k) => {
    const s = (series[k] || []).slice(-window);
    const vals = s.map((x) => (x ? x[col] : NaN));
    const finite = vals.filter(Number.isFinite);
    const last = s.length ? s[s.length - 1] : null;
    const label = (labelCol && last && last[labelCol] != null) ? String(last[labelCol]) : String(k);
    return { key: k, vals, latest: finite.length ? finite[finite.length - 1] : NaN, label };
  });

  // Sort by latest value; NaN sinks to the bottom regardless of direction. Tie-break
  // on key so the order is stable frame-to-frame.
  const dir = spec.sort_dir === 'asc' ? 1 : -1;
  const rank = (v) => (Number.isFinite(v) ? v : -Infinity);
  rows.sort((a, b) => {
    const c = rank(a.latest) - rank(b.latest);
    return c !== 0 ? c * dir : (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });

  // Shared scale: percent → fixed 0–100; else 0–max-finite across ALL rows (reduce,
  // not Math.max(...spread) — a huge topic would blow the arg limit).
  let min = 0, max = 1;
  if (type === 'percent') max = 100;
  else max = rows.reduce((m, r) => r.vals.reduce((mm, v) => (Number.isFinite(v) && v > mm ? v : mm), m), 1);

  // Widths: label left (capped + truncated), value right (fixed), sparkline fills the
  // middle — the same budget the `bars` gauge uses, so composites line up.
  const maxLabel = rows.reduce((m, r) => Math.max(m, visibleLen(esc(r.label))), 3);
  const labelW = Math.max(3, Math.min(16, maxLabel, innerW - _MULTI_VALUE_W - 3));
  const sparkW = Math.max(1, innerW - labelW - _MULTI_VALUE_W - 2);   // two single-space gaps
  const cell = (text, width, right) => {
    let s = String(text);
    if (visibleLen(s) > width) s = truncate(s, width);
    const pad = ' '.repeat(Math.max(0, width - visibleLen(s)));
    return right ? pad + s : s + pad;
  };

  const lines = rows.slice(0, innerH).map((r) => {
    const opts = { width: sparkW, height: 1, min, max };
    const norms = columnNorms(r.vals, { width: sparkW, min, max, group: 2 });
    const spark = colorizeRows(rasterizeBraille(r.vals, opts), norms,
      (n) => (Number.isFinite(n) ? gradient('percent', n) : null))[0] || ' '.repeat(sparkW);
    const label = cell(esc(r.label), labelW, false);
    const value = cell(esc(_fmtCell(r.latest, type || 'number')), _MULTI_VALUE_W, true);
    return `${label} ${spark} ${value}`;
  });
  return { lines, rowKey: '_' };
}

// Wrap the glyph at VISIBLE column `visCol` of a colorized graph row in a highlight
// atom (Phase 2 hover — the vertical cursor line under the mouse). Walks the markup
// string tracking the current color run: at the target column it closes the run,
// emits `[hl]glyph[/]`, and reopens the run for the rest. Graph glyphs are single-
// width braille/blocks/space with no literal `[`, so `[` unambiguously starts a
// markup token here. Pure; a no-op when visCol is out of range.
function _highlightColumn(row, visCol, hlAtom) {
  if (!(visCol >= 0)) return row;
  let out = '', vis = 0, cur = null, i = 0;
  while (i < row.length) {
    const ch = row[i];
    if (ch === '[') {
      const end = row.indexOf(']', i);
      if (end === -1) { out += row.slice(i); break; }
      const inner = row.slice(i + 1, end);
      cur = inner === '/' ? null : inner;
      out += row.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (vis === visCol) out += `${cur ? '[/]' : ''}[${hlAtom}]${ch}[/]${cur ? `[${cur}]` : ''}`;
    else out += ch;
    vis++;
    i++;
  }
  return out;
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
function _renderSection(metric, samples, schema, width, graphHeight, style, colorMode, hoverCol) {
  const col = (schema.columns || {})[metric] || {};
  const values = samples.map(s => s && s[metric]);
  const finite = values.filter(Number.isFinite);
  const latest = finite.length ? finite[finite.length - 1] : NaN;
  const peak = finite.length ? Math.max(...finite) : NaN;
  const avg = finite.length ? finite.reduce((a, b) => a + b, 0) / finite.length : NaN;

  let min = 0;
  let max = 1;
  // Default (`number` type): integers verbatim, floats to 2 decimals — a raw
  // String(v) would spill a load average as `0.6995630036…`. percent/bytes/rate
  // override below with their own compact formatters.
  let fmt = (v) => (!Number.isFinite(v) ? '—' : (Number.isInteger(v) ? String(v) : v.toFixed(2)));
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

  // Hover cursor (Phase 2): highlight the hovered column across this section's graph
  // rows — a vertical line under the mouse. Only the graph rows (not header/meter).
  if (hoverCol >= 0 && hoverCol < width) {
    colored = colored.map((r) => _highlightColumn(r, hoverCol, t.selected));
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

// Reduce a set of aligned values for one column. `mode` 'avg'|'sum'|'max' forces
// that reducer; `true` (or anything else truthy) uses the per-type default:
// percent → avg (mean load across rows), everything else → sum (total).
function _reduceVals(vals, type, mode) {
  const red = (mode === 'avg' || mode === 'sum' || mode === 'max')
    ? mode : (type === 'percent' ? 'avg' : 'sum');
  if (red === 'max') return Math.max(...vals);
  const sum = vals.reduce((a, b) => a + b, 0);
  return red === 'avg' ? sum / vals.length : sum;
}

// Aggregate mode: fold ALL rows of a topic into ONE synthetic series (e.g.
// per-core CPU → a single avg/total line), so a stats pane can graph the whole
// topic without a select_from cursor. Reduces each numeric column across rows at
// each sample index, right-anchored so a shorter (just-appeared) row aligns to the
// most-recent end. Meta/string columns are skipped (not graphable). Pure.
function _aggregateSamples(series, schema, window, mode) {
  const rows = Object.values(series || {}).map((s) => (s || []).slice(-window)).filter((s) => s.length);
  if (!rows.length) return [];
  const maxLen = Math.max(...rows.map((r) => r.length));
  const cols = schema.columns || {};
  const out = [];
  for (let i = 0; i < maxLen; i++) {
    const sample = {};
    for (const [col, cdef] of Object.entries(cols)) {
      if (cdef && (cdef.type === 'string' || cdef.meta)) continue;
      const vals = [];
      for (const r of rows) {
        const idx = i - (maxLen - r.length);   // right-align shorter rows
        const v = idx >= 0 && r[idx] ? r[idx][col] : undefined;
        if (Number.isFinite(v)) vals.push(v);
      }
      sample[col] = vals.length ? _reduceVals(vals, cdef && cdef.type, mode) : NaN;
    }
    out.push(sample);
  }
  return out;
}

// Resolve a NON-multi graph's series (the same steps renderBody uses): the samples
// array (aggregate / select_from cursor / static row, sliced to window) + the metric
// list + schema. null when there's nothing to graph. valueAt uses this so the hover
// value maps the SAME samples the graph drew; renderBody keeps its own inline version
// (which carries the distinct per-case dim messages). Both call the same building
// blocks (_aggregateSamples / _resolveSelection / _defaultMetrics).
function _resolveSeries(spec) {
  const window = spec.window || 40;
  const metric = getModel().metrics[spec.topic];
  const schema = (metric && metric.schema) || { columns: {} };
  let samples;
  if (spec.aggregate) {
    samples = _aggregateSamples((metric && metric.series) || {}, schema, window, spec.aggregate);
  } else {
    const rowKey = _resolveSelection(spec);
    if (!rowKey) return null;
    samples = ((metric && metric.series[rowKey]) || []).slice(-window);
  }
  if (!samples || !samples.length) return null;
  const metrics = spec.metrics || _defaultMetrics(schema);
  if (!metrics.length) return null;
  return { samples, metrics, schema };
}

// The value under a hovered body cell (Phase 2, hover-for-value). Given the pane
// spec + its inner size + a body-relative (col, row), map back to the underlying
// sample the graph drew and return `{ metric, value, type, ago, col }` or null. PURE
// (recomputes from model.metrics via the same window/geometry renderBody uses — the
// rasterizer needn't retain per-column samples). v1 scope: the standard sectioned
// graph only (overlay / multi have their own column semantics → null for now); a row
// on a header / meter / separator (not the graph area) → null.
function valueAt(spec, innerW, innerH, col, row) {
  if (!spec || !spec.topic || spec.overlay || spec.mode === 'multi') return null;
  if (!(col >= 0 && col < innerW) || !(row >= 0)) return null;
  const resolved = _resolveSeries(spec);
  if (!resolved) return null;
  const { samples, metrics, schema } = resolved;

  // Section geometry — MUST match renderBody's stacking exactly.
  const cols = schema.columns || {};
  const isPct = (m) => (cols[m] || {}).type === 'percent';
  const sepRows = Math.max(0, metrics.length - 1);
  const headerRows = metrics.length;
  const meterRows = metrics.filter(isPct).length;
  const perMetric = Math.floor((innerH - sepRows - headerRows - meterRows) / metrics.length);
  if (perMetric < 2) return null;

  // Walk the stack to find which metric's GRAPH rows `row` falls in (headers,
  // percent meter rows, and the 1-row separators between sections don't carry a
  // per-column value).
  let off = 0;
  let metric = null;
  for (let i = 0; i < metrics.length; i++) {
    if (i > 0) off += 1;                                  // separator
    const graphStart = off + 1 + (isPct(metrics[i]) ? 1 : 0);
    const graphEnd = graphStart + perMetric;
    if (row >= graphStart && row < graphEnd) { metric = metrics[i]; break; }
    off = graphEnd;
  }
  if (!metric) return null;

  // Column → sample. Braille packs 2 samples/cell (group 2); blocks 1. The window
  // is the newest `innerW * group` values, front NaN-padded when short (mirrors
  // stats-graph._cut). For braille prefer the RIGHT (newer) dot of the cell, else
  // the left. `ago` = samples back from newest.
  const values = samples.map((s) => (s ? s[metric] : NaN));
  const group = spec.graph === 'blocks' ? 1 : 2;
  const cutLen = innerW * group;
  const at = (cutIdx) => {
    const origIdx = values.length - cutLen + cutIdx;
    return (origIdx >= 0 && origIdx < values.length) ? { v: values[origIdx], origIdx } : null;
  };
  let hit = group === 2 ? at(col * 2 + 1) : at(col);
  if ((!hit || !Number.isFinite(hit.v)) && group === 2) hit = at(col * 2) || hit;   // fall back to older dot
  if (!hit || !Number.isFinite(hit.v)) return null;
  return { metric, value: hit.v, type: (cols[metric] || {}).type, ago: Math.max(0, values.length - 1 - hit.origIdx), col };
}

// If this pane is the hovered one, resolve the value ONCE for render(): the column to
// highlight + the record to publish to the per-frame hover-region (footer + tooltip).
// null when not hovered / not over a resolvable graph cell. Keeps all graph-value
// knowledge in stats (the single owner).
function _resolveHover(panel, innerW, innerH) {
  const paneId = panel && panel.paneId;
  if (!paneId) return null;
  const layout = getInstanceSlice('layout');
  const hv = layout && layout.hover;
  if (!hv || hv.paneId !== paneId) return null;
  const res = valueAt(panel, innerW, innerH, hv.col, hv.row);
  if (!res) return null;
  const text = `${res.metric.toUpperCase()} ${_fmtCell(res.value, res.type || 'number')}`;
  return { col: hv.col, record: { paneId, x: hv.x, y: hv.y, text, metric: res.metric, value: res.value, col: hv.col } };
}

function render(panel, w, h, _slice, opts) {
  const chrome = opts && opts.chrome;
  // v0.6.4 Theme A Phase 5 — per-pane focus (opts.focused). stats reads
  // ANOTHER pane's cursor via panel.select_from (cross-pane by design),
  // so its own slice is empty; only the focus flag is per-pane here.
  const focused = !!(opts && opts.focused);
  // Finding B — renderBody reads the store-mirror'd model.metrics[topic] (kept
  // current by the metrics-mirror Sub), so this is a pure render over the model.
  // Phase 2 (hover-for-value): resolve this pane's hover ONCE → the column to
  // highlight in the graph + the value record to publish to the per-frame hover-region
  // (read by the footer + the cursor tooltip, both painted after the pane pass).
  const hover = _resolveHover(panel, w - 2, h - 2);
  const { lines, rowKey } = renderBody(panel, w - 2, h - 2, hover ? hover.col : -1);
  if (hover) hoverRegion.publish(hover.record);
  return renderPanel({
    width: w, height: h, lines,
    // Single-stream topics use the sentinel rowKey '_' (no entity to name) — show
    // the bare title; a drill-down row (select_from) appends the selected row. Any
    // empty state resolves rowKey '_' too, so its box keeps the plain title.
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
  // Border-less body reused by the `composite` panel (docs/compact-panes.md).
  renderBody,
  // Test-only internals.
  _defaultMetrics,
  _aggregateSamples,
  _fmtBytes,
  _fmtPercent,
  _fmtRate,
  _renderSection,
  _renderMulti,
  _highlightColumn,
  valueAt,
};
