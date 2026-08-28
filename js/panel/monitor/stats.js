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
  esc, theme, gradient, renderPanel, visibleLen, wrapColor,
  getItems: apiGetItems, getInstanceSlice, getSel, getScroll, sliceForPane, borderControlsFor,
} = require('../api');
const hoverRegion = require('../hover-region');
const { truncate } = require('../../leaves/render/draw');
const { fmt: _fmtCell } = require('../../leaves/metrics/format');   // shared compact cell formatter (see gauge/table)
const { fmtDurationMs } = require('../../leaves/text/time');        // shared pure span formatter (jobs/history/status) — time-axis labels
const { rowInfo } = require('../../leaves/metrics/row-info');       // shared row → detail-card projection (gauge/table)
const mnav = require('../../leaves/wm/nav');                        // shared cursor/scroll reducer (mode:multi selection)
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
function renderBody(spec, innerW, innerH, hoverCol = -1, ctx = null, band = null) {
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
  if (spec.mode === 'multi') return _renderMulti(spec, metric, schema, innerW, innerH, window, dim, ctx);

  // Time-axis reserve (docs/STATS.md §10): decide the bottom label row NOW so ALL geometry
  // below (the frozen resample's trace width via the y-axis gutter, overlay/section height)
  // is built against the reduced graph height `gH`; the label row is appended last. `gH`
  // is the single height every hit-test (valueAt / freezeRange / drag-band) also derives,
  // so the reserved row can't drift from the trace.
  const taRows = _timeAxisRows(spec, innerW, innerH);
  const gH = innerH - taRows;

  let samples;
  let rowKey = '_';
  let metrics;
  // Drag-to-zoom (docs/STATS.md §10): a FROZEN pane renders its captured sub-range
  // STRETCHED across the full width instead of the live window. Resolve it FIRST so a
  // frozen `select_from` pane keeps showing the snapshot even after its source loses
  // the selection. Swapping `samples` for the resampled snapshot leaves every downstream
  // step (rasterize / section walk / valueAt) unchanged. Sectioned + overlay; not multi.
  const frozen = _zoomFrozen(spec);
  if (frozen) {
    // Resample to the TRACE width (innerW − gutterW), not innerW: the rasterizer draws only
    // effW columns, so resampling to innerW would let the y-axis gutter clip the OLDEST
    // gutterW/innerW of the frozen range off the left edge (§10). effW === innerW when no
    // gutter shows, so this is a no-op on the pre-y-axis path.
    const effW = innerW - _axisForSpec(spec, innerW, gH).gutterW;
    samples = _resampleFrozen(frozen, effW * (spec.graph === 'blocks' ? 1 : 2));
    metrics = (frozen.metrics && frozen.metrics.length) ? frozen.metrics : _defaultMetrics(schema);
    rowKey = frozen.rowKey || '_';
  } else {
    if (!spec.select_from && spec.row == null && !spec.aggregate) {
      return dim('(stats panel needs topic + select_from / row / aggregate)');
    }
    // `aggregate:` folds ALL rows into one synthetic series (no cursor); otherwise
    // follow the select_from cursor / static row, sliced to this pane's window.
    if (spec.aggregate) {
      samples = _aggregateSamples((metric && metric.series) || {}, schema, window, spec.aggregate);
    } else {
      rowKey = _resolveSelection(spec);
      if (!rowKey) return dim('(no selection)');
      samples = ((metric && metric.series[rowKey]) || []).slice(-window);
    }
    metrics = spec.metrics || _defaultMetrics(schema);
  }
  if (!samples.length) return dim('(no data yet)');
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
    const graphH = gH - 1;                                       // 1 legend row (gH already drops the time-axis row)
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
    // Y-axis gutter — one shared scale (oMin..oMax), so a single tick column labels every
    // series. `effW` is the trace width; gutterW 0 → full-width (byte-identical to before).
    const oAxis = _axisFor(_paneAxisType(metrics, schema), innerW, graphH, spec.y_axis);
    const effW = innerW - oAxis.gutterW;
    const seriesArr = metrics.map((m) => samples.map((s) => s && s[m]));
    const { rows, owners } = rasterizeBrailleMulti(seriesArr, { width: effW, height: graphH, min: oMin, max: oMax });
    let colored = colorizeOverlay(rows, owners, metrics.map((_m, i) => OVERLAY_COLORS[i % OVERLAY_COLORS.length]));
    if (oAxis.gutterW > 0) {
      colored = colored.map((r, i) => _axisGutterCell(i, colored.length, oMin, oMax, _paneAxisType(metrics, schema), oAxis.gutterW, false, t.dim) + r);
    }
    // Hover cursor (Phase 2): highlight the hovered column across the overlaid grid.
    if (hoverCol >= 0 && hoverCol < innerW) colored = colored.map((r) => _highlightColumn(r, hoverCol, t.selected));
    // Live drag-band (§10): highlight the pending zoom range across the overlaid grid.
    if (band) colored = colored.map((r) => _highlightRange(r, band.lo, band.hi, t.selected));
    const lines = [legend, ...colored];
    if (taRows) lines.push(_timeAxisRow(samples, oAxis.gutterW, innerW, !!frozen, t.dim));
    return { lines, rowKey };
  }

  const perMetric = _sectionPerMetric(metrics, schema, gH);
  if (perMetric < 2) return dim('(panel too short for graph)');
  // Pane-uniform y-axis gutter — the WIDEST metric's reserve, shared by every section so
  // all traces start at the same column (and the column→sample map stays pane-uniform).
  const gutterW = _axisFor(_paneAxisType(metrics, schema), innerW, perMetric, spec.y_axis).gutterW;

  const lines = [];
  metrics.forEach((m, i) => {
    if (i > 0) lines.push('');
    lines.push(..._renderSection(m, samples, schema, innerW, perMetric, style, colorMode, hoverCol, spec.invert, spec.header === 'bottom', band, gutterW));
  });
  // Time-axis label row at the very bottom of the pane (docs/STATS.md §10), aligned to the
  // trace via the shared gutterW; `frozen` swaps the now-anchored labels for the duration.
  if (taRows) lines.push(_timeAxisRow(samples, gutterW, innerW, !!frozen, t.dim));
  return { lines, rowKey };
}

const _MULTI_VALUE_W = 8;   // right-hand current-value column (matches gauge's)

/**
 * `mode: multi` body — one height-1 braille sparkline per ROW of the topic, sorted
 * by latest value (desc default, `sort_dir: asc` flips), viewport = the top innerH
 * rows. Like the `bars` gauge but a HISTORY sparkline in place of the current-value
 * bar. One shared value scale (percent → 0–100, else the max across all rows) keeps
 * the rows comparable; the sparkline is value-mapped through the percent ramp so a
 * spike reads hot. Hover-for-value reads a row's value under the cursor (`_valueAtMulti`,
 * sharing `_multiLayout`'s geometry); there's still no j/k row SELECTION. Reuses
 * rasterizeBraille / columnNorms / colorizeRows and the shared truncate + format leaves.
 *
 *   node12   ⣀⣠⣴⣶⣾⣿   62.0%
 *   redis3   ⢀⡠⠔⠊⠉      9.1%
 *
 * `column:` picks the metric to sparkline (default: the first graphable column);
 * `label:` names a string column for the row label (default: the row key).
 */
// Multi-mode ROWS — the sorted per-row series + scale, WIDTH-INDEPENDENT. Single-
// sourced so the renderer, the hover read (`_valueAtMulti`), AND `getItems` (row
// selection) all agree on the row SET + ORDER (the paint↔hittest agreement,
// reference_paint_hittest_agreement). Returns `{ ok:false, reason }` on empty states.
function _multiRows(spec) {
  const metric = getModel().metrics[spec.topic];
  const schema = (metric && metric.schema) || { columns: {} };
  const window = spec.window || 40;
  const series = (metric && metric.series) || {};
  const keys = Object.keys(series);
  if (!keys.length) return { ok: false, reason: 'nodata' };
  const cols = schema.columns || {};
  const col = spec.column || _defaultMetrics(schema)[0];
  if (!col) return { ok: false, reason: 'nometric' };
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

  return { ok: true, rows, min, max, type, col };
}

// Multi-mode GEOMETRY — `_multiRows` PLUS the label/spark column budget (needs `innerW`).
// Used by the renderer + the hover read; `getItems` uses `_multiRows` directly (the row
// SET is width-independent). Returns `{ ok:false, reason }` on the empty states.
function _multiLayout(spec, innerW) {
  if (innerW < 1) return { ok: false, reason: 'small' };
  const base = _multiRows(spec);
  if (!base.ok) return base;
  const { rows } = base;
  // Widths: label left (capped + truncated), value right (fixed), sparkline fills the
  // middle — the same budget the `bars` gauge uses, so composites line up.
  const maxLabel = rows.reduce((m, r) => Math.max(m, visibleLen(esc(r.label))), 3);
  const labelW = Math.max(3, Math.min(16, maxLabel, innerW - _MULTI_VALUE_W - 3));
  const sparkW = Math.max(1, innerW - labelW - _MULTI_VALUE_W - 2);   // two single-space gaps
  return { ...base, labelW, sparkW };
}

// `ctx` (STANDALONE pane only): { sel, scroll, focused } — the live cursor for row
// SELECTION. Present → interactive: clamp + windowed scroll + highlight the selected
// row (exactly gauge's model). Absent (composite widget / no cursor) → DISPLAY mode:
// the top `innerH` rows, no highlight. Returns rowCount/sel/scroll so `render` can
// draw the `N of M` count + scrollbar and click hit-testing reads the painted scroll.
function _renderMulti(spec, metric, schema, innerW, innerH, window, dim, ctx) {
  if (innerH < 1) return dim('(panel too small)');
  const lay = _multiLayout(spec, innerW);
  if (!lay.ok) {
    return dim(lay.reason === 'small' ? '(panel too small)'
      : lay.reason === 'nodata' ? '(no data yet)' : '(no graphable metrics)');
  }
  const { rows, labelW, sparkW, min, max, type } = lay;
  const cell = (text, width, right) => {
    let s = String(text);
    if (visibleLen(s) > width) s = truncate(s, width);
    const pad = ' '.repeat(Math.max(0, width - visibleLen(s)));
    return right ? pad + s : s + pad;
  };

  // Cursor + scroll (mirrors gauge.renderBody): getSel isn't re-clamped on row-shrink,
  // so clamp here; keep the selected row inside the viewport.
  const t = theme();
  const interactive = !!ctx && Number.isFinite(ctx.sel);
  const focused = !!(ctx && ctx.focused);
  let sel = interactive ? Math.max(0, Math.min(ctx.sel, rows.length - 1)) : -1;
  let scroll = interactive ? (ctx.scroll || 0) : 0;
  if (interactive) {
    if (sel < scroll) scroll = sel;
    else if (sel >= scroll + innerH) scroll = sel - innerH + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - innerH)));
  }

  const lines = rows.slice(scroll, scroll + innerH).map((r, vi) => {
    const opts = { width: sparkW, height: 1, min, max };
    const norms = columnNorms(r.vals, { width: sparkW, min, max, group: 2 });
    const spark = colorizeRows(rasterizeBraille(r.vals, opts), norms,
      (n) => (Number.isFinite(n) ? gradient('percent', n) : null))[0] || ' '.repeat(sparkW);
    const label = cell(esc(r.label), labelW, false);
    const value = cell(esc(_fmtCell(r.latest, type || 'number')), _MULTI_VALUE_W, true);
    const line = `${label} ${spark} ${value}`;
    // Selected row: tint the whole row with `selected` while KEEPING the sparkline
    // gradient (wrapColor re-opens the slot after each inner [/]; a fg-only gradient
    // rides the selection bg) — the same treatment as the gauge selected bar.
    return (interactive && scroll + vi === sel && focused) ? wrapColor(t.selected, line) : line;
  });
  return { lines, rowKey: '_', rowCount: rows.length, sel: interactive ? sel : 0, scroll };
}

// Wrap every glyph in the VISIBLE column range [lo,hi] of a colorized graph row in a
// highlight atom. Two callers: the Phase 2 hover cursor (a single column — the vertical
// line under the mouse) and the live drag-band (the range being dragged for a zoom, §10).
// Walks the markup string tracking the current color run: at a highlighted column it
// closes the run, emits `[hl]glyph[/]`, and reopens the run. Graph glyphs are single-
// width braille/blocks/space with no literal `[`, so `[` unambiguously starts a markup
// token here. The per-glyph wrap is a touch verbose across a wide band, but a band is
// only painted DURING an active drag (transient), so the wire cost never hits idle
// frames. Pure; a no-op when the range is empty / out of range.
function _highlightRange(row, lo, hi, hlAtom) {
  if (!(hi >= 0) || lo > hi) return row;
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
    if (vis >= lo && vis <= hi) out += `${cur ? '[/]' : ''}[${hlAtom}]${ch}[/]${cur ? `[${cur}]` : ''}`;
    else out += ch;
    vis++;
    i++;
  }
  return out;
}

// Single-column hover cursor — the degenerate lo===hi case (kept as a named seam so the
// hover call sites read as intent, not an off-by-one range).
function _highlightColumn(row, visCol, hlAtom) {
  if (!(visCol >= 0)) return row;
  return _highlightRange(row, visCol, visCol, hlAtom);
}

// --- Y-axis labels (docs/STATS.md §7, §10) -----------------------------------------
// A left gutter of value ticks (`100% ┤` … `0% ┤`) down each graph. `y_axis: auto|off|
// always` per pane, default `auto` (show only when the gutter stays ≤15% of the width).
// The gutter shifts the trace ORIGIN, so its width is the one fact every column consumer
// (paint, hover, drag-zoom) must agree on — kept a pure function of (metric type, width,
// height) here so paint and hit-test can't drift. When hidden, gutterW is 0 → the exact
// full-width trace shipped before this. Sectioned + overlay; not mode:multi (own gutter).

// Terse axis label formatter (round, single-letter units) — an axis wants `100%` / `512M`,
// not the header's `100.0%` / `512.0MiB`. Kept short so the gutter reserve stays narrow.
function _axisFmt(type) {
  if (type === 'percent') return (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : '—');
  if (type === 'bytes' || type === 'rate') {
    const suf = type === 'rate' ? '/s' : '';
    return (v) => {
      if (!Number.isFinite(v)) return '—';
      if (v < 1024) return `${Math.round(v)}B${suf}`;
      if (v < 1024 ** 2) return `${Math.round(v / 1024)}K${suf}`;
      if (v < 1024 ** 3) return `${Math.round(v / 1024 ** 2)}M${suf}`;
      return `${Math.round(v / 1024 ** 3)}G${suf}`;
    };
  }
  return (v) => (!Number.isFinite(v) ? '—' : (Number.isInteger(v) ? String(v) : v.toFixed(1)));
}

// Reserved value-label width per type (the ` ┤` tick adds 2). Constant per type so the
// gutter width — and thus the trace offset — is decided WITHOUT the min/max scale: paint
// and hit-test both derive it from the type alone.
const _AXIS_LABEL_W = { percent: 4, bytes: 5, rate: 7, number: 5 };
function _axisGutterW(type) { return (_AXIS_LABEL_W[type] || _AXIS_LABEL_W.number) + 2; }

// Right-align a label into the gutter, clipping if a value somehow exceeds the reserve —
// so the gutter width stays exactly constant (never pushes the trace off by a column).
function _axisPad(s, w) { s = String(s); return s.length > w ? s.slice(0, w) : s.padStart(w); }

// Per-section graph height (rows). Factored so renderBody, valueAt, and the axis decision
// derive the SAME stacking geometry (header + optional percent meter + separators).
function _sectionPerMetric(metrics, schema, innerH) {
  const cols = schema.columns || {};
  const meterRows = metrics.filter((m) => (cols[m] || {}).type === 'percent').length;
  const sepRows = Math.max(0, metrics.length - 1);
  const headerRows = metrics.length;
  return Math.floor((innerH - sepRows - headerRows - meterRows) / metrics.length);
}

// The pane's widest gutter type — a multi-metric pane shares ONE gutter width, so every
// section's trace starts at the same column and the column→sample map is pane-uniform.
function _paneAxisType(metrics, schema) {
  const cols = schema.columns || {};
  let best = 'number', bestW = -1;
  for (const m of metrics) {
    const ty = (cols[m] || {}).type || 'number';
    const w = _axisGutterW(ty);
    if (w > bestW) { bestW = w; best = ty; }
  }
  return best;
}

// The axis decision: { show, gutterW }. `mode` is y_axis. `auto` shows only when the
// gutter is ≤15% of the width; `always` still needs a usable trace (effW≥8); both need
// ≥2 rows to place ticks. Off / hidden → gutterW 0 (today's full-width trace).
function _axisFor(type, innerW, graphH, mode) {
  const m = (mode === 'off' || mode === 'always') ? mode : 'auto';
  if (m === 'off') return { show: false, gutterW: 0 };
  const gutterW = _axisGutterW(type);
  const effW = innerW - gutterW;
  const widthOK = (m === 'always') ? true : (gutterW <= 0.15 * innerW);
  if (!(widthOK && graphH >= 2 && effW >= 8)) return { show: false, gutterW: 0 };
  return { show: true, gutterW };
}

// The ONE axis entry point — { show, gutterW } for a spec at a given inner size. Handles
// overlay (one grid, N series, 1 legend row) vs sectioned geometry; multi has none. Reads
// only the schema + configured metrics (no sample resolve), so it's a cheap pure decision
// every caller — renderBody, valueAt, freezeRange, the drag-band — computes identically.
function _axisForSpec(spec, innerW, innerH) {
  if (!spec || !spec.topic || spec.mode === 'multi') return { show: false, gutterW: 0 };
  const metricObj = getModel().metrics[spec.topic];
  const schema = (metricObj && metricObj.schema) || { columns: {} };
  const metrics = spec.metrics || _defaultMetrics(schema);
  if (!metrics.length) return { show: false, gutterW: 0 };
  const graphH = spec.overlay ? (innerH - 1) : _sectionPerMetric(metrics, schema, innerH);
  return _axisFor(_paneAxisType(metrics, schema), innerW, graphH, spec.y_axis);
}

// Build the gutter cell for graph row `r` of `graphH` (0 = top): a right-aligned value
// tick on the top / bottom (and the middle, if ≥5 rows tall), a plain axis line elsewhere.
// `invert` flips the value order (an inverted graph fills from the top, so max sits at the
// bottom). Dim so the trace stays the focus. Pure; returns a markup string `gutterW` wide.
function _axisGutterCell(r, graphH, min, max, type, gutterW, invert, dimAtom) {
  const labelW = gutterW - 2;
  const midR = graphH >= 5 ? Math.floor((graphH - 1) / 2) : -1;
  let val = null;
  if (r === 0) val = invert ? min : max;
  else if (r === graphH - 1) val = invert ? max : min;
  else if (r === midR) val = (min + max) / 2;
  if (val == null) return `[${dimAtom}]${' '.repeat(labelW)} │[/]`;
  return `[${dimAtom}]${_axisPad(_axisFmt(type)(val), labelW)} ┤[/]`;
}

// --- Time-axis labels (docs/STATS.md §1, §10) --------------------------------------
// The horizontal twin of the y-axis gutter: reserve ONE bottom row for time-span labels
// (`-6m00s` … `now`) so a graph carries scale on the time axis. `x_axis: auto|off|always`
// per pane, default `auto`. Unlike the y-axis (a per-metric LEFT gutter — a WIDTH cost),
// the whole pane shares ONE window, so this is a single BOTTOM row (a HEIGHT cost). The
// reserve shrinks the graph's available HEIGHT — the one fact every geometry consumer
// (paint, hover, drag-zoom, freeze) must agree on — so it's a pure function of (spec,w,h)
// here, the vertical mirror of `_axisForSpec`'s gutterW. Labels are PURE from the sample
// `ts` (metrics-poll stamps it, app/state.js): the trace spans oldest→newest ts, the right
// edge ≈ now. A frozen (zoomed) pane's right edge is NOT now → it shows the range DURATION
// instead. No render-side wall-clock read (docs/model-now-tick.md). Sectioned + overlay
// STANDALONE panes only; NOT mode:multi, NOT composite widgets (display-only + only 2–4
// rows tall — the same call as zoom-won't-do: a bottom row would eat a third of the box).

const _TIME_AXIS_MIN_H = 6;    // `auto`: a pane shorter than this keeps the full-height graph
const _TIME_AXIS_MIN_W = 12;   // need room for two end labels (`-6m00s` + gap + `now`)

// Does this topic's data carry capture timestamps? metrics-poll stamps every published
// sample with `ts`; a topic fed another way (e.g. docker per-pane stats) may not — then
// `auto`/`always` draw no time-axis (nothing to label). Cheap: probe the newest sample of
// each row, not the whole window.
function _hasSampleTs(topic) {
  const m = getModel().metrics[topic];
  const series = m && m.series;
  if (!series) return false;
  for (const k in series) {
    const arr = series[k];
    const s = arr && arr[arr.length - 1];
    if (s && Number.isFinite(s.ts)) return true;
  }
  return false;
}

// Rows the time-axis reserves at the BOTTOM (0 or 1) — the SINGLE source every geometry
// consumer subtracts, so paint / hover / drag-zoom / freeze can't drift on the graph's
// available height (mirrors `_axisForSpec`). `auto` shows only when reserving the row
// leaves the graph at its ≥2 floor AND the pane clears the min height/width AND the data
// carries `ts`; `always` drops the min-height gate but still needs the floor + `ts`; `off`
// never. Composite widgets (no paneId) and mode:multi are excluded outright.
function _timeAxisRows(spec, innerW, innerH) {
  if (!spec || !spec.topic || spec.mode === 'multi' || spec.paneId == null) return 0;
  const mode = (spec.x_axis === 'off' || spec.x_axis === 'always') ? spec.x_axis : 'auto';
  if (mode === 'off') return 0;
  if (innerW < _TIME_AXIS_MIN_W) return 0;
  if (!_hasSampleTs(spec.topic)) return 0;
  const metricObj = getModel().metrics[spec.topic];
  const schema = (metricObj && metricObj.schema) || { columns: {} };
  const metrics = spec.metrics || _defaultMetrics(schema);
  if (!metrics.length) return 0;
  const gH = innerH - 1;   // graph height if we reserve the row
  const graphFits = spec.overlay ? (gH - 1 >= 2) : (_sectionPerMetric(metrics, schema, gH) >= 2);
  if (!graphFits) return 0;
  if (mode === 'auto' && innerH < _TIME_AXIS_MIN_H) return 0;
  return 1;
}

// The effective inner height available to the GRAPH stack — innerH minus the time-axis
// reserve. EVERY geometry site (section stacking, overlay graphH, the y-axis decision, the
// frozen resample, the hover walk, freeze) uses THIS in place of raw innerH, so the
// reserved bottom row never overlaps the trace and the column/row maps stay in lockstep.
function _graphInnerH(spec, innerW, innerH) {
  return innerH - _timeAxisRows(spec, innerW, innerH);
}

// Newest / oldest finite `ts` in a sample window (scanning inward from the end / start).
function _lastFiniteTs(samples) {
  for (let i = samples.length - 1; i >= 0; i--) { const t = samples[i] && samples[i].ts; if (Number.isFinite(t)) return t; }
  return null;
}
function _firstFiniteTs(samples) {
  for (let i = 0; i < samples.length; i++) { const t = samples[i] && samples[i].ts; if (Number.isFinite(t)) return t; }
  return null;
}

// Build the bottom time-axis row: `[dim]` span labels aligned to the TRACE region (the
// `gutterW` left cols stay blank so labels sit under the trace, never the y-axis gutter).
// LIVE → left `-<span>` (oldest→newest ts) + right `now` (newest ≈ now) + a centred mid
// tick when the trace is wide enough to clear both ends. FROZEN (zoomed) → the right edge
// isn't now, so show the range DURATION centred (`‹ 2m30s ›`). Pure of the clock — reads
// only sample `ts`. All glyphs are width-1 (ASCII + `‹ ›`), so length === visible width.
function _timeAxisRow(samples, gutterW, innerW, frozen, dimAtom) {
  const effW = Math.max(1, innerW - gutterW);
  const first = _firstFiniteTs(samples);
  const last = _lastFiniteTs(samples);
  const buf = new Array(effW).fill(' ');
  const put = (str, at) => { for (let i = 0; i < str.length; i++) { const c = at + i; if (c >= 0 && c < effW) buf[c] = str[i]; } };
  if (first != null && last != null && last >= first) {
    const span = last - first;
    if (frozen) {
      // Centred range duration; drop it wholesale if the trace is too narrow to hold it
      // (a y-axis gutter can shrink effW below the label) rather than truncate mid-glyph.
      const label = `‹ ${fmtDurationMs(span)} ›`;
      if (label.length <= effW) put(label, Math.floor((effW - label.length) / 2));
    } else {
      const left = `-${fmtDurationMs(span)}`;
      const right = 'now';
      put(right, effW - right.length);
      if (left.length + 1 <= effW - right.length) put(left, 0);
      // A centred mid tick, only if it clears both ends with a gap on each side.
      const mid = `-${fmtDurationMs(span / 2)}`;
      const midAt = Math.floor((effW - mid.length) / 2);
      if (midAt > left.length && midAt + mid.length < effW - right.length) put(mid, midAt);
    }
  }
  return `[${dimAtom}]${' '.repeat(gutterW)}${buf.join('')}[/]`;
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
function _renderSection(metric, samples, schema, width, graphHeight, style, colorMode, hoverCol, invert, headerBottom, band, gutterW = 0) {
  const col = (schema.columns || {})[metric] || {};
  // Y-axis gutter (docs/STATS.md §10): reserve `gutterW` cols on the left for value ticks
  // and rasterize the trace into the remainder. `effW` is the trace width; when gutterW is
  // 0 (axis off / too narrow) effW === width, so every step below is byte-identical to the
  // pre-axis path. Header spans the FULL width; the meter + graph rows share the gutter.
  const effW = Math.max(1, width - gutterW);
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

  // `invert` (braille only — blocks have no upper-eighths ramp): hang the trace from
  // the top edge downward instead of rising from the bottom (btop's mirrored net
  // shape). The height-gradient flips with it so value→colour stays consistent.
  const inv = !!invert && style !== 'blocks';
  const opts = { width: effW, height: graphHeight, min, max, invert: inv };
  const rows = style === 'blocks' ? rasterize(values, opts) : rasterizeBraille(values, opts);
  const norms = columnNorms(values, { width: effW, min, max, group: style === 'blocks' ? 1 : 2 });
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
    colored = colorizeByHeight(rows, (frac) => gradient('percent', frac), inv);
  }

  // Y-axis gutter: prepend the value-tick column to each graph row BEFORE the highlights,
  // so hover/band (body-relative cols) index the full row (gutter + trace) without an
  // offset — the gutter's `[dim]…┤[/]` markup isn't counted as visible cols by the walker,
  // and hover/band never resolve into the gutter (valueAt / _resolveDragBand exclude it).
  if (gutterW > 0) {
    colored = colored.map((r, i) => _axisGutterCell(i, colored.length, min, max, col.type || 'number', gutterW, inv, t.dim) + r);
  }

  // Hover cursor (Phase 2): highlight the hovered column across this section's graph
  // rows — a vertical line under the mouse. Only the graph rows (not header/meter).
  if (hoverCol >= 0 && hoverCol < width) {
    colored = colored.map((r) => _highlightColumn(r, hoverCol, t.selected));
  }
  // Live drag-band (§10): highlight the pending zoom range across the graph rows.
  if (band) colored = colored.map((r) => _highlightRange(r, band.lo, band.hi, t.selected));

  // Percent metrics carry a one-row current-value meter next to the header. It aligns
  // UNDER the trace, so it shares the gutter (blank there) and spans the trace width.
  const extras = [];
  if (col.type === 'percent') {
    const frac = Number.isFinite(latest) ? latest / 100 : NaN;
    const meter = meterRow(frac, effW);
    const bar = Number.isFinite(frac) ? `[${gradient('percent', frac)}]${meter}[/]` : meter;
    extras.push(gutterW > 0 ? ' '.repeat(gutterW) + bar : bar);
  }
  // `header: bottom` — put the header (+ its meter) BELOW the graph instead of above.
  // Pairs with `invert` for a btop net mirror: the inverted (bottom) graph's label
  // reads on the outer edge, and its graph rows sit flush against the graph above.
  return headerBottom
    ? [...colored, ...extras, header]
    : [header, ...extras, ...colored];
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

// A pane's FROZEN zoom snapshot (docs/STATS.md §10) or null. Only standalone panes
// (a real paneId) can be zoomed; a composite widget's spec has none.
function _zoomFrozen(spec) {
  const paneId = spec && spec.paneId;
  if (paneId == null) return null;
  const layout = getInstanceSlice('layout');
  const z = layout && layout.zoom;
  return (z && z[paneId]) || null;
}

// Stretch/shrink a frozen snapshot's dragged sub-range across `targetLen` slots by
// nearest-neighbour, so a narrow drag fills the width (zoom-IN). Returns sample objects.
function _resampleFrozen(frozen, targetLen) {
  const sub = frozen.samples.slice(frozen.start, frozen.end + 1);
  if (!sub.length || targetLen < 1) return sub;
  return Array.from({ length: targetLen }, (_x, i) => sub[Math.floor(i * sub.length / targetLen)]);
}

// Reset-zoom border chip (docs/STATS.md §10) — shown ONLY on a zoomed pane. One
// clickable region → the `reset` action → a `graph_zoom` clear routed to the layout
// reducer (owner: 'layout'), returning the pane to the live window. Same border-control
// facility as the composite cycler / table sort selector (paint ↔ hit-test single source).
const _RESET_TEXT = '⤢ 1:1';
const _zoomResetControl = {
  id: 'zoom-reset',
  slot: 'top',
  render(model, pane) {
    if (model && model.modes && model.modes.freeConfigMode) return null;
    if (!_zoomFrozen({ paneId: pane.paneId })) return null;
    return { text: `[accent]${_RESET_TEXT}[/]`, visibleW: visibleLen(_RESET_TEXT) };
  },
  regions(x0, y, visibleW) {
    return [{ x0, x1: x0 + visibleW - 1, y, action: 'reset' }];
  },
  dispatch(_action, pane) {
    return { owner: 'layout', msg: { type: 'graph_zoom', paneId: pane.paneId, frozen: null } };
  },
};

// Resolve a NON-multi graph's series (the same steps renderBody uses): the samples
// array (aggregate / select_from cursor / static row, sliced to window) + the metric
// list + schema. null when there's nothing to graph. valueAt uses this so the hover
// value maps the SAME samples the graph drew; renderBody keeps its own inline version
// (which carries the distinct per-case dim messages). Both call the same building
// blocks (_aggregateSamples / _resolveSelection / _defaultMetrics). When `innerW` is
// passed AND the pane is zoomed, returns the resampled frozen snapshot instead (so hover
// reads the same stretched samples the graph drew) — the seam that keeps zoom + hover in
// agreement.
function _resolveSeries(spec, innerW, innerH) {
  const metric = getModel().metrics[spec.topic];
  const schema = (metric && metric.schema) || { columns: {} };
  const frozen = (innerW != null) ? _zoomFrozen(spec) : null;
  if (frozen) {
    // Resample to the TRACE width, not innerW — see the same fix in renderBody's frozen
    // branch. innerH lets `_axisForSpec` derive the gutter that the hover read must honour so
    // the frozen range it reads matches the range the graph drew.
    const effW = innerW - _axisForSpec(spec, innerW, innerH).gutterW;
    const samples = _resampleFrozen(frozen, effW * (spec.graph === 'blocks' ? 1 : 2));
    const metrics = (frozen.metrics && frozen.metrics.length) ? frozen.metrics : _defaultMetrics(schema);
    return (samples.length && metrics.length) ? { samples, metrics, schema } : null;
  }
  const window = spec.window || 40;
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

// Compute a FROZEN zoom snapshot from a drag [startCol,endCol] on a pane — the impure
// read the input shell runs on release, handed to the `graph_zoom` reducer as DATA.
// Maps the two columns → sample indices via the SAME _cut front-pad the rasterizer uses,
// captures the current resolved series + the range, or null for a click / degenerate
// drag / a non-sectioned pane. (Overlay is included — it resolves via _resolveSeries;
// multi is not.)
function freezeRange(spec, innerW, innerH, startCol, endCol) {
  if (!spec || !spec.topic || spec.mode === 'multi') return null;
  const resolved = _resolveSeries(spec);   // LIVE (no innerW → ignore any existing zoom)
  if (!resolved) return null;
  const { samples, metrics } = resolved;
  const group = spec.graph === 'blocks' ? 1 : 2;
  // Y-axis gutter: the drag cols are body-relative; shift into trace-space and size the
  // cut to the trace width, so the frozen range matches what the offset trace drew. Use the
  // reduced height (§10) so the gutter agrees with the paint even when a time-axis shows.
  const { gutterW } = _axisForSpec(spec, innerW, _graphInnerH(spec, innerW, innerH));
  const effW = innerW - gutterW;
  const cutLen = effW * group;
  const idxAt = (col) => {
    const tc = Math.max(0, Math.min(effW - 1, col - gutterW));   // body → trace col
    const i = samples.length - cutLen + (group === 2 ? tc * 2 + 1 : tc);
    return Math.max(0, Math.min(samples.length - 1, i));
  };
  const a = idxAt(Math.min(startCol, endCol));
  const b = idxAt(Math.max(startCol, endCol));
  if (b - a < 1) return null;   // a click or a range too small to zoom
  const rowKey = spec.aggregate ? '_' : _resolveSelection(spec);
  return { samples, start: a, end: b, metrics, rowKey: rowKey || '_' };
}

// The value under a hovered body cell (Phase 2, hover-for-value). Given the pane
// spec + its inner size + a body-relative (col, row), map back to the underlying
// sample the graph drew and return a hover result or null. PURE (recomputes from
// model.metrics via the same window/geometry renderBody uses — the rasterizer needn't
// retain per-column samples). Three shapes, one per graph kind (all fed to
// `hoverText`): sectioned → `{ metric, value, type, ago, col }`; overlay →
// `{ overlay: [{metric,value,type}], col }` (all series at the column, since the point
// of an overlay is comparing them); multi → `{ multi, label, metric, value, type, col }`
// (the hovered ROW's value). A row on a header / meter / separator / legend / off the
// sparkline (not a data cell) → null.
function valueAt(spec, innerW, innerH, col, row) {
  if (!spec || !spec.topic) return null;
  if (!(col >= 0 && col < innerW) || !(row >= 0)) return null;
  if (spec.mode === 'multi') return _valueAtMulti(spec, innerW, innerH, col, row);
  if (spec.overlay) return _valueAtOverlay(spec, innerW, innerH, col, row);
  // Time-axis reserve (docs/STATS.md §10): the graph occupies the top `gH` rows; a hover on
  // the reserved bottom label row carries no value. Every geometry read below uses `gH`, the
  // same reduced height renderBody built the trace against.
  const gH = _graphInnerH(spec, innerW, innerH);
  if (row >= gH) return null;
  const resolved = _resolveSeries(spec, innerW, gH);   // innerW+gH → zoom-aware (frozen resample honours the y-axis gutter)
  if (!resolved) return null;
  const { samples, metrics, schema } = resolved;

  // Y-axis gutter (docs/STATS.md §10): a hover in the left tick column is not a data
  // cell → null; otherwise shift into trace-space (the SAME { gutterW } the paint used).
  const { gutterW } = _axisForSpec(spec, innerW, gH);
  if (col < gutterW) return null;
  const traceCol = col - gutterW;
  const effW = innerW - gutterW;

  // Section geometry — MUST match renderBody's stacking exactly.
  const cols = schema.columns || {};
  const isPct = (m) => (cols[m] || {}).type === 'percent';
  const perMetric = _sectionPerMetric(metrics, schema, gH);
  if (perMetric < 2) return null;

  // Walk the stack to find which metric's GRAPH rows `row` falls in (headers,
  // percent meter rows, and the 1-row separators between sections don't carry a
  // per-column value). Each section mirrors _renderSection's layout: `header: bottom`
  // → [graph, meter, header] (graph leads); default → [header, meter, graph]. Only the
  // graph's offset within the section differs — the section is the same height either way.
  const headerBottom = spec.header === 'bottom';
  let off = 0;
  let metric = null;
  for (let i = 0; i < metrics.length; i++) {
    if (i > 0) off += 1;                                  // separator between sections
    const meter = isPct(metrics[i]) ? 1 : 0;
    const graphStart = off + (headerBottom ? 0 : 1 + meter);
    if (row >= graphStart && row < graphStart + perMetric) { metric = metrics[i]; break; }
    off += 1 + meter + perMetric;                         // whole section: header + meter + graph
  }
  if (!metric) return null;

  // Column → sample (blocks = group 1, braille = group 2). `ago` = samples back from newest.
  const values = samples.map((s) => (s ? s[metric] : NaN));
  const hit = _hitAt(values, effW, traceCol, spec.graph === 'blocks' ? 1 : 2);
  if (!hit) return null;
  return { metric, value: hit.v, type: (cols[metric] || {}).type, ago: Math.max(0, values.length - 1 - hit.origIdx), col };
}

// Map a graph column to its (newest-preferred) sample value in a `values` array,
// mirroring stats-graph._cut's front NaN-pad: the window is the newest `width*group`
// values (`group` 2 for braille, 1 for blocks). For braille prefers the RIGHT (newer)
// dot of the cell, falling back to the left. The one column→sample map, shared by all
// three hover reads (sectioned/overlay/multi). Returns `{ v, origIdx }` or null.
function _hitAt(values, width, col, group = 2) {
  const cutLen = width * group;
  const pick = (cutIdx) => {
    const origIdx = values.length - cutLen + cutIdx;
    return (origIdx >= 0 && origIdx < values.length) ? { v: values[origIdx], origIdx } : null;
  };
  let hit = group === 2 ? pick(col * 2 + 1) : pick(col);
  if ((!hit || !Number.isFinite(hit.v)) && group === 2) hit = pick(col * 2) || hit;   // fall back to older dot
  return (hit && Number.isFinite(hit.v)) ? hit : null;
}

// Overlay hover — one braille grid, N series, 1 legend row on top. Every graph row
// shares the same column→sample mapping, so ANY graph row resolves the column; the
// legend row (row 0) and a too-short panel carry no value. Returns EVERY series'
// finite value at the column (the overlay exists to compare them), or null.
function _valueAtOverlay(spec, innerW, innerH, col, row) {
  const gH = _graphInnerH(spec, innerW, innerH);         // drop the time-axis reserve (§10)
  const graphH = gH - 1;                                  // 1 legend row (matches renderBody)
  if (graphH < 2 || !(row >= 1 && row < 1 + graphH)) return null;
  // Y-axis gutter — same shift as the sectioned read (the overlay shares one tick column).
  const { gutterW } = _axisForSpec(spec, innerW, gH);
  if (col < gutterW) return null;
  const traceCol = col - gutterW;
  const effW = innerW - gutterW;
  const resolved = _resolveSeries(spec, innerW, gH);            // zoom-aware (gutter-honouring frozen)
  if (!resolved) return null;
  const { samples, metrics, schema } = resolved;
  const cols = schema.columns || {};
  const series = [];
  for (const m of metrics) {
    const hit = _hitAt(samples.map((s) => (s ? s[m] : NaN)), effW, traceCol);
    if (hit) series.push({ metric: m, value: hit.v, type: (cols[m] || {}).type });
  }
  return series.length ? { overlay: series, col } : null;
}

// Multi hover — one height-1 sparkline per ROW (`label spark value`). `row` indexes
// the sorted/viewport rows (`_multiLayout`, the same list the renderer draws); `col`
// must fall inside that row's sparkline span. Returns the hovered ROW's value at the
// column (the row is the identity in multi mode). Off a row / off the spark → null.
function _valueAtMulti(spec, innerW, innerH, col, row) {
  const lay = _multiLayout(spec, innerW);
  if (!lay.ok) return null;
  const { rows, labelW, sparkW, type, col: metricCol } = lay;
  if (!(row < Math.min(rows.length, innerH))) return null;
  const localCol = col - (labelW + 1);                   // spark starts after `label` + one space
  if (!(localCol >= 0 && localCol < sparkW)) return null;
  const r = rows[row];
  const hit = _hitAt(r.vals, sparkW, localCol);
  if (!hit) return null;
  return { multi: true, label: r.label, metric: metricCol, value: hit.v, type, ago: Math.max(0, r.vals.length - 1 - hit.origIdx), col };
}

// A hover result (valueAt's three shapes) → the one-line label shown in the footer +
// the cursor tooltip. Sectioned/multi are single-value (`METRIC value` / `row value`);
// overlay joins every series (`RX 1.2MiB  TX 800KiB`).
function hoverText(res) {
  if (!res) return '';
  if (res.overlay) return res.overlay.map((s) => `${s.metric.toUpperCase()} ${_fmtCell(s.value, s.type || 'number')}`).join('  ');
  if (res.multi) return `${res.label} ${_fmtCell(res.value, res.type || 'number')}`;
  return `${res.metric.toUpperCase()} ${_fmtCell(res.value, res.type || 'number')}`;
}

// Build the hover-region record for a resolved value at (x, y) on a pane. Single-value
// results carry metric/value metadata; overlay is text-only (multi-series). Shared by
// the standalone stats pane (`_resolveHover`) and composite graph widgets.
function hoverRecord(res, paneId, x, y, col) {
  const rec = { paneId, x, y, text: hoverText(res), col };
  if (res.metric != null && !res.overlay) { rec.metric = res.metric; rec.value = res.value; }
  return rec;
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
  return { col: hv.col, record: hoverRecord(res, paneId, hv.x, hv.y, hv.col) };
}

// If this pane owns the in-flight zoom drag, resolve the pending column band to highlight
// (docs/STATS.md §10). Clamped to the TRACE region ([gutterW, innerW-1]) so the highlight
// never paints into the y-axis label gutter; a drag past the right edge yields an over-wide
// `hi`. Returns `{ lo, hi }` (visible cols) or null. Sectioned + overlay (multi isn't zoomable).
function _resolveDragBand(panel, innerW, innerH) {
  const paneId = panel && panel.paneId;
  if (!paneId) return null;
  const layout = getInstanceSlice('layout');
  const db = layout && layout.dragBand;
  if (!db || db.paneId !== paneId) return null;
  const { gutterW } = _axisForSpec(panel, innerW, _graphInnerH(panel, innerW, innerH));   // gutter on the reduced height (§10)
  const lo = Math.max(gutterW, Math.min(db.lo, db.hi));
  const hi = Math.min(innerW - 1, Math.max(db.lo, db.hi));
  if (hi < lo || lo > innerW - 1) return null;
  return { lo, hi };
}

function render(panel, w, h, _slice, opts) {
  const chrome = opts && opts.chrome;
  // v0.6.4 Theme A Phase 5 — per-pane focus (opts.focused). A sectioned/overlay stats
  // reads ANOTHER pane's cursor via panel.select_from (cross-pane by design); only
  // `mode: multi` owns its OWN row cursor (interactive selection), threaded below.
  const focused = !!(opts && opts.focused);
  // Finding B — renderBody reads the store-mirror'd model.metrics[topic] (kept
  // current by the metrics-mirror Sub), so this is a pure render over the model.
  // Live drag-band (§10): if a zoom drag is in flight on THIS pane, resolve the pending
  // column range to highlight. While dragging we suppress the hover cursor + its value
  // tooltip — a range is being SELECTED, so a lingering single-column read (from the
  // hover position before the press) would compete with the band and publish a stale
  // footer value.
  const band = _resolveDragBand(panel, w - 2, h - 2);
  // Phase 2 (hover-for-value): resolve this pane's hover ONCE → the column to
  // highlight in the graph + the value record to publish to the per-frame hover-region
  // (read by the footer + the cursor tooltip, both painted after the pane pass).
  const hover = band ? null : _resolveHover(panel, w - 2, h - 2);
  // `mode: multi` selection: thread this pane's live cursor (getSel/getScroll) so the
  // selected row highlights + scrolls, and click hit-testing reads the painted scroll.
  const ctx = (panel.mode === 'multi' && panel.paneId != null)
    ? { sel: getSel(panel.paneId), scroll: getScroll(panel.paneId), focused } : null;
  const body = renderBody(panel, w - 2, h - 2, hover ? hover.col : -1, ctx, band);
  const { lines, rowKey } = body;
  if (hover) hoverRegion.publish(hover.record);
  // A selectable multi list reports windowed paint (count + scrollbar + click scroll);
  // every other stats shape draws a plain box (renderPanel defaults).
  const windowed = ctx && body.rowCount > 0;
  // Border controls — the reset-zoom chip (self-suppresses unless the pane is zoomed).
  const ctl = borderControlsFor({ paneId: panel.paneId, type: 'stats', focused, innerW: w - 2 }, getModel());
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
    topControls: ctl.map((c) => c.text),
    windowed: windowed || undefined,
    count: windowed ? [body.sel + 1, body.rowCount] : undefined,
    scrollOffset: windowed ? body.scroll : undefined,
  });
}

// Per-pane slice: a nav cursor for `mode: multi` row SELECTION. A sectioned/overlay/
// aggregate stats pane carries an unused cursor (getItems → [] makes nav a no-op), so
// it stays effectively stateless — the series it renders is still cross-cutting model
// state read cross-pane. getItems reads the SLICE (all it's given), so the multi-row
// fields `_multiRows` needs are hoisted here from the placed pane def.
function init(paneId, seed) {
  const pd = (seed && seed.paneDef) || {};
  return {
    nav: mnav.init(),
    paneId: paneId == null ? undefined : paneId,
    mode: pd.mode || null,
    topic: pd.topic || null,
    column: pd.column || null,
    sort_dir: pd.sort_dir || null,
    label: pd.label || null,
    window: pd.window || null,
  };
}

// Cursor + scroll are the only runtime state (mode:multi selection) — fold the nav
// Msgs (set_cursor / set_scroll from nav_select + scroll). Everything else is a pure
// render over model.metrics; a non-multi pane never gets nav Msgs (getItems → []).
function update(msg, slice) {
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  return slice;
}

// getItems — the ORDERED row keys for a `mode: multi` pane (the selectable list; drives
// the cursor bounds, click hit-testing, and a `select_from` follower). Empty for every
// other stats shape, so they stay non-list. Row SET/ORDER is width-independent
// (`_multiRows`), so it agrees with what the renderer paints.
function getItems(slice) {
  if (!slice || slice.mode !== 'multi' || !slice.topic) return [];
  const base = _multiRows(slice);
  return base.ok ? base.rows.map((r) => r.key) : [];
}

// getInfo — the SELECTED row's detail card (viewer Info tab), same shared `rowInfo`
// projection as gauge/table so all three agree.
function getInfo(rowKey, paneId) {
  const slice = paneId != null ? sliceForPane(paneId, 'stats') : null;
  const metric = getModel().metrics[(slice && slice.topic)];
  return metric ? rowInfo(metric, rowKey) : [`row: ${rowKey}`];
}

// `stats` is a pure render over model.metrics[topic] (v0.6.6 Finding B; the
// `metrics-mirror` Sub samples the hub time series into the model). Its ONLY runtime
// state is the `mode: multi` row cursor (above) — a sectioned/overlay pane's cursor is
// inert. See docs/v0.5-layering.md + docs/v0.6.6.md §9 + STATS.md.
module.exports = {
  name: 'stats',
  init,
  update,
  // v0.6.6 Finding B — declares a `metrics-mirror` Sub (pure projection of the
  // pane config); the framework reconciles it. See the `subscriptions` comment.
  subscriptions,
  panelTypes: {
    stats: {
      render,
      getItems,
      getInfo,
      idOf: (rowKey) => String(rowKey),
      borderControls: [_zoomResetControl],   // reset-zoom chip (self-suppresses unless zoomed)
    },
  },
  // Border-less body reused by the `composite` panel (docs/compact-panes.md).
  renderBody,
  getItems,
  _multiRows,
  // Test-only internals.
  _defaultMetrics,
  _aggregateSamples,
  _fmtBytes,
  _fmtPercent,
  _fmtRate,
  _renderSection,
  _renderMulti,
  _multiLayout,
  _highlightColumn,
  valueAt,
  hoverText,
  hoverRecord,
  freezeRange,
  _zoomFrozen,
  _resampleFrozen,
  _axisFor,
  _axisForSpec,
  _axisGutterW,
  _timeAxisRows,
  _timeAxisRow,
  _hasSampleTs,
};
