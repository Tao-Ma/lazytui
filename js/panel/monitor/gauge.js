/**
 * Core plugin — gauge panel.
 *
 * The third snapshot consumer of hub data (alongside `stats` time-series graphs
 * and the `table` list): it renders a topic's LATEST sample per row as horizontal
 * meter bars — btop's mem/disk/process bars, generic over any topic. Each row is
 * one labeled, colored bar filling `value / max` of the width, with the formatted
 * value on the right; bars order by the metered value (btop-style).
 *
 * Reads model.metrics[topic] (populated by the shared `metrics-mirror` Sub — the
 * same one `stats`/`table` declare), so frame = f(model) (#D5); render never
 * touches the hub live. Returns STRING row keys from getItems, so a `stats` pane
 * can `select_from:` a gauge — click a bar → graph that row's history.
 *
 * YAML shape:
 *   procs:
 *     type: gauge
 *     title: CPU
 *     topic: host.proc          # hub topic (a metrics: producer, or a Component)
 *     column: cpu               # the metered column (default: first percent column)
 *     label: comm               # a string column for the bar label (default: rowKey)
 *     max: 100                  # optional denominator for a non-percent column
 *                               #   (default: auto — the running max across rows)
 *     sort_dir: desc            # bar order by metered value: desc (default) | asc
 *
 * The bar itself is the `meterRow` primitive (eighth-block, left-fill) shared with
 * the stats panel's percent meter; the fill color maps through the theme's percent
 * ramp via `gradient('percent', frac)` (green→red as it fills), like that meter.
 */
'use strict';

const { getModel } = require('../../model/store');
const {
  esc, theme, gradient, renderPanel, visibleLen,
  getSel, getScroll, getItems: apiGetItems,
} = require('../api');
const { truncate } = require('../../leaves/render/draw');
const { fmt: _fmt } = require('../../leaves/metrics/format');   // shared compact cell formatter (see table.js)
const mnav = require('../../leaves/wm/nav');

// Two-tone meter geometry: `fill` = filled cells (eighth-block sub-cell leading
// edge, like stats-graph.meterRow), `track` = the dim remainder. Split so the
// caller can colour the two runs (gradient fill + dim track) — btop's grey track.
const _PARTIAL = '▏▎▍▌▋▊▉';   // 1/8..7/8 left-fill (mirrors stats-graph.meterRow)
function _meter(frac, width) {
  if (width < 1) return { fill: '', track: '' };
  const f = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  const eighths = Math.round(f * width * 8);
  const full = eighths >> 3, rem = eighths & 7;
  const fill = '█'.repeat(full) + (rem ? _PARTIAL[rem - 1] : '');
  const track = '░'.repeat(Math.max(0, width - full - (rem ? 1 : 0)));
  return { fill, track };
}

function _metric(topic) {
  const all = getModel().metrics;
  return (all && all[topic]) || null;
}

function _latest(metric, rowKey) {
  const s = metric && metric.series && metric.series[rowKey];
  return (s && s.length) ? s[s.length - 1] : null;
}

function _typeOf(metric, col) {
  const c = metric && metric.schema && metric.schema.columns && metric.schema.columns[col];
  return (c && c.type) || 'number';
}

// The metered column: config `column:`, else the first `percent` schema column
// (the natural 0–100 gauge), else the first non-string non-meta column.
function _meterColumn(slice, metric) {
  if (slice && slice.column) return slice.column;
  const cols = (metric && metric.schema && metric.schema.columns) || {};
  const entries = Object.entries(cols).filter(([, c]) => c && !c.meta);
  const pct = entries.find(([, c]) => c.type === 'percent');
  if (pct) return pct[0];
  const num = entries.find(([, c]) => c.type !== 'string');
  return num ? num[0] : null;
}

const _VALUE_W = 8;   // right-aligned value column (e.g. "999.9M/s")

// --- Component (TEA) half ---

function subscriptions(paneDef, _model) {
  if (!paneDef || !paneDef.topic) return [];
  // Same Sub the stats/table panels declare — throttle-repaints on publish.
  // A gauge only reads the LATEST sample, so window 1 by default; when a gauge
  // shares a topic with a stats/table pane the mirror's `merge` takes the max
  // window, so a graph pane isn't starved.
  return [{ kind: 'metrics-mirror', topic: paneDef.topic, window: paneDef.window || 1 }];
}

function init(paneId, seed) {
  // Per-pane config is HOISTED onto seed.paneDef (topic/column/label/… at top
  // level — the parser hoists panel fields onto the placed pane); seed.config is
  // the whole model config. Read the pane def.
  const pd = (seed && seed.paneDef) || {};
  return {
    topic: pd.topic,
    column: pd.column || null,
    label: pd.label || null,
    max: (typeof pd.max === 'number' && pd.max > 0) ? pd.max : null,
    barMax: (typeof pd.bar_width === 'number' && pd.bar_width > 0) ? pd.bar_width : 20,   // bounded meter (btop-style)
    sortDir: pd.sort_dir === 'asc' ? 1 : -1,   // bars sort by metered value; desc default
    // The cursor/scroll live in this slice's nav entry (getSel/getScroll read it
    // via mnav.entryOf), so the click/keyboard nav_select can move the selection.
    nav: mnav.init(),
    paneId: paneId == null ? undefined : paneId,
  };
}

// Cursor + scroll are the only runtime state: fold the framework's nav Msgs
// (set_cursor / set_scroll, from nav_select + scroll) into the slice's nav
// entry. Sort is config-fixed, so nothing else to handle.
function update(msg, slice) {
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  return slice;
}

// getItems — the ORDERED row keys (strings): sorted by the metered column so the
// bars read top-down like btop. Missing values sink to the far end. This is the
// list render, the cursor, and a stats `select_from` all read.
function getItems(slice) {
  const topic = slice && slice.topic;
  if (!topic) return [];
  const metric = _metric(topic);
  if (!metric || !metric.series) return [];
  let rows = Object.keys(metric.series);
  const col = _meterColumn(slice, metric);
  if (col) {
    const dir = slice.sortDir < 0 ? -1 : 1;
    const bad = dir < 0 ? -Infinity : Infinity;   // missing → bottom, either dir
    const val = (rk) => {
      const s = _latest(metric, rk);
      const v = s ? s[col] : undefined;
      return Number.isFinite(v) ? v : bad;
    };
    rows = rows.map((r, i) => [r, i]).sort((A, B) => {
      const a = val(A[0]), b = val(B[0]);
      const c = a < b ? -1 : a > b ? 1 : 0;
      return c !== 0 ? c * dir : A[1] - B[1];   // stable
    }).map(p => p[0]);
  }
  return rows;
}

function getInfo(rowKey) {
  return [`row: ${rowKey}`];
}

function _renderEmpty(panel, w, h, msg, chrome, focused) {
  const t = theme();
  return renderPanel({
    width: w, height: h, lines: [`[${t.dim}]${esc(msg)}[/]`],
    title: panel.title, hotkey: panel.hotkey, panelType: 'gauge', focused: !!focused, chrome,
  });
}

function render(panel, w, h, slice, opts) {
  const focused = !!(opts && opts.focused);
  const chrome = opts && opts.chrome;
  const topic = panel.topic;
  if (!topic) return _renderEmpty(panel, w, h, '(gauge needs a topic)', chrome, focused);
  const metric = _metric(topic);
  const rows = apiGetItems(panel.paneId);        // sorted row keys
  if (!metric || !rows.length) {
    return _renderEmpty(panel, w, h, metric ? '(no rows)' : '(no data yet)', chrome, focused);
  }
  const col = _meterColumn(slice, metric);
  if (!col) return _renderEmpty(panel, w, h, '(gauge needs a numeric column)', chrome, focused);
  const type = _typeOf(metric, col);
  const t = theme();
  const innerW = w - 2;
  const innerH = h - 2;

  // Cursor + scroll (windowed render below). No header row, so the whole inner
  // region is the data window; scroll follows the cursor. getSel isn't re-clamped
  // on row-shrink (processes come and go), so clamp it to the row count here.
  const sel = Math.max(0, Math.min(getSel(panel.paneId), rows.length - 1));
  let scroll = getScroll(panel.paneId);
  if (sel < scroll) scroll = sel;
  else if (sel >= scroll + innerH) scroll = sel - innerH + 1;
  scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - innerH)));

  const valueOf = (rk) => { const s = _latest(metric, rk); return s ? s[col] : NaN; };
  const labelCol = slice.label && _typeOf(metric, slice.label) === 'string' ? slice.label : null;
  const labelText = (rk) => {
    if (labelCol) { const s = _latest(metric, rk); const lv = s ? s[labelCol] : null; if (lv != null) return String(lv); }
    return String(rk);
  };

  // Fill denominator: percent → fixed 0–100 (so "45%" reads as ~half a bar);
  // else the config `max:`, else the running max across ALL rows this frame
  // (auto-scale, stable under scroll).
  let denom;
  if (type === 'percent') denom = 100;
  else if (slice.max) denom = slice.max;
  else {
    const finite = rows.map(valueOf).filter(Number.isFinite);
    denom = finite.length ? Math.max(1, ...finite) : 1;
  }

  // Widths: label left (capped + truncated), value right (fixed). The bar is a
  // BOUNDED meter (btop-style) — capped at `bar_width` (default 20) so it doesn't
  // sprawl across a wide pane; it still shrinks to fit a narrow one. The row is
  // padded to full width after the value so the selection highlight spans it.
  // Label width from ALL rows (stable while scrolling), not just the window.
  const maxLabel = Math.max(3, ...rows.map(rk => visibleLen(esc(labelText(rk)))));
  const labelW = Math.max(3, Math.min(16, maxLabel));
  const avail = innerW - labelW - _VALUE_W - 2;               // two single-space gaps
  const barW = Math.max(1, Math.min(slice.barMax || 20, avail));
  const trailW = Math.max(0, innerW - (labelW + 1 + barW + 1 + _VALUE_W));

  // Width-aware, markup-safe cell (respects esc'd brackets + wide/emoji glyphs;
  // a raw String.slice would corrupt both) — same clip the table cell uses.
  const cell = (text, width, right) => {
    let s = String(text);
    if (visibleLen(s) > width) s = truncate(s, width);
    const pad = ' '.repeat(Math.max(0, width - visibleLen(s)));
    return right ? pad + s : s + pad;
  };

  const buildBar = (rk, selected) => {
    const v = valueOf(rk);
    const frac = Number.isFinite(v) ? v / denom : NaN;
    // Two-tone meter (btop-style): the filled portion in the gradient colour, the
    // remainder a DIM track — so the whole bar width reads as a meter, not a
    // colour stub floating in blank space. Distinct GLYPHS (█ fill vs ░ track)
    // keep the fill legible on the selected row too, where inner colour is dropped.
    const { fill, track } = _meter(frac, barW);
    const label = cell(esc(labelText(rk)), labelW, false);
    const value = cell(esc(_fmt(v, type)), _VALUE_W, true);
    const trail = ' '.repeat(trailW);
    // Selected row: ONE `[selected]` span over a PLAIN line (no inner colour —
    // PRINCIPLES §8); the fill/track glyphs still distinguish filled from empty.
    // The trailing pad is inside the span so the highlight spans the full width.
    if (selected && focused) return `[${t.selected}]${label} ${fill}${track} ${value}${trail}`;
    const gradTag = Number.isFinite(frac) ? gradient('percent', Math.max(0, Math.min(1, frac))) : t.dim;
    return `${label} [${gradTag}]${fill}[/][${t.dim}]${track}[/] ${value}${trail}`;
  };

  const lines = [];
  rows.slice(scroll, scroll + innerH).forEach((rk, vi) => {
    const abs = scroll + vi;
    lines.push(buildBar(rk, abs === sel));
  });

  return renderPanel({
    width: w, height: h, lines,
    title: panel.title, hotkey: panel.hotkey, panelType: 'gauge', focused, chrome,
    windowed: true,
    count: [sel + 1, rows.length],
    scrollOffset: scroll,
  });
}

module.exports = {
  name: 'gauge',
  init,
  update,
  subscriptions,
  panelTypes: {
    gauge: {
      render,
      getItems,
      getInfo,
      idOf: (rowKey) => String(rowKey),
    },
  },
  // Test-only internals.
  _fmt,
  getItems,
  _meterColumn,
};
