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
  getSel, getScroll, sliceForPane,
} = require('../api');
const { truncate } = require('../../leaves/render/draw');
const { fmt: _fmt } = require('../../leaves/metrics/format');   // shared compact cell formatter (see table.js)
const { rowInfo } = require('../../leaves/metrics/row-info');   // shared row → detail-card projection (see table.js)
const mnav = require('../../leaves/wm/nav');

// Meter geometry: how many of `width` cells are FILLED. Whole cells only — a
// partial half-block (`▌`) shows the terminal bg through its empty half, which
// reads as a muddle of colours; a solid block per cell is clean and btop-like.
function _meterFill(frac, width) {
  const f = Number.isFinite(frac) ? Math.max(0, Math.min(1, frac)) : 0;
  let n = Math.round(f * width);
  if (f > 0 && n === 0) n = 1;                 // any nonzero value shows ≥1 cell
  if (f < 1 && n === width) n = width - 1;     // only a true 100% fills the whole bar
  return Math.max(0, Math.min(width, n));
}

// The FILLED run of a bar, each cell coloured by its POSITION along the full bar
// (green→red, btop-style — so a high bar goes green→yellow→red, a low one stays
// green). Adjacent same-colour cells coalesce into one span to limit SGR churn.
// A degenerate 1-cell bar has no position to gradate — colour it by the VALUE
// (`frac`) so it isn't misleadingly red.
function _colouredFill(fillN, width, frac) {
  let out = '', run = '', tag = null;
  for (let i = 0; i < fillN; i++) {
    const c = gradient('percent', width > 1 ? i / (width - 1) : Math.max(0, Math.min(1, frac || 0)));
    if (c !== tag) { if (run) out += `[${tag}]${run}[/]`; run = '█'; tag = c; }
    else run += '█';
  }
  if (run) out += `[${tag}]${run}[/]`;
  return out;
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
    // bounded meter (btop-style). FLOOR to a whole number of cells — a fractional
    // width desyncs the two render paths (`repeat` floors, the fill loop doesn't).
    barMax: (typeof pd.bar_width === 'number' && pd.bar_width >= 1) ? Math.floor(pd.bar_width) : 20,
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

// getInfo — the SELECTED bar's row as a detail card in the viewer's Info tab
// (see table.js: same shared `rowInfo` projection, so the two panels agree).
function getInfo(rowKey, paneId) {
  // sliceForPane arm 1 resolves THIS pane's own slice by paneId (see table.js).
  const slice = paneId != null ? sliceForPane(paneId, 'gauge') : null;
  const metric = _metric(slice && slice.topic);
  return metric ? rowInfo(metric, rowKey) : [`row: ${rowKey}`];
}

// Border-less body — the composable half of render (docs/compact-panes.md §2).
// Builds the meter-bar lines for a topic to fill `innerW × innerH`: one bar per
// row, sorted by the metered value (getItems), coloured by fill position. No
// border, no title, no count — `render` wraps it in renderPanel; a `composite`
// panel stacks it beside other widget bodies.
//
// `spec` is the slice-shaped config (topic / column / label / max / barMax /
// sortDir — the shape init() produces; the composite normalizes each widget to
// it). `ctx` carries the interactive cursor: { sel, scroll, focused } from the
// STANDALONE pane's live nav state (highlight + windowed scroll). A composite
// widget OMITS sel → DISPLAY mode: top rows that fit, no cursor highlight. Pure of
// the paneId read (the impure getSel/getScroll stay in `render`). Returns
// { lines, rowCount, sel, scroll } so the wrapper can draw the `N of M` count +
// scrollbar; an empty state carries a dim message line + rowCount 0 (the wrapper
// then draws a plain bordered box with no count — matching the pre-split
// _renderEmpty).
function renderBody(spec, innerW, innerH, ctx) {
  ctx = ctx || {};
  const t = theme();
  const dim = (msg) => ({ lines: [`[${t.dim}]${esc(msg)}[/]`], rowCount: 0, sel: 0, scroll: 0 });
  if (!spec.topic) return dim('(gauge needs a topic)');
  const metric = _metric(spec.topic);
  const rows = getItems(spec);                    // sorted row keys — pure over spec
  if (!metric || !rows.length) return dim(metric ? '(no rows)' : '(no data yet)');
  const col = _meterColumn(spec, metric);
  if (!col) return dim('(gauge needs a numeric column)');
  const type = _typeOf(metric, col);

  // Cursor + scroll. No header row, so the whole inner region is the data window.
  // A standalone pane threads its live cursor (interactive: highlight + windowed
  // scroll); a composite widget omits it → display mode (top rows, no highlight).
  // getSel isn't re-clamped on row-shrink (processes come and go), so clamp here.
  const interactive = Number.isFinite(ctx.sel);
  const focused = !!ctx.focused;
  let sel = interactive ? Math.max(0, Math.min(ctx.sel, rows.length - 1)) : -1;
  let scroll = interactive ? (ctx.scroll || 0) : 0;
  if (interactive) {
    if (sel < scroll) scroll = sel;
    else if (sel >= scroll + innerH) scroll = sel - innerH + 1;
    scroll = Math.max(0, Math.min(scroll, Math.max(0, rows.length - innerH)));
  }

  const valueOf = (rk) => { const s = _latest(metric, rk); return s ? s[col] : NaN; };
  const labelCol = spec.label && _typeOf(metric, spec.label) === 'string' ? spec.label : null;
  const labelText = (rk) => {
    if (labelCol) { const s = _latest(metric, rk); const lv = s ? s[labelCol] : null; if (lv != null) return String(lv); }
    return String(rk);
  };

  // Fill denominator: percent → fixed 0–100 (so "45%" reads as ~half a bar);
  // else the config `max:`, else the running max across ALL rows this frame
  // (auto-scale, stable under scroll).
  let denom;
  if (type === 'percent') denom = 100;
  else if (spec.max) denom = spec.max;
  else {
    // reduce, not Math.max(...spread) — a huge topic would blow the arg limit.
    denom = rows.reduce((m, rk) => { const v = valueOf(rk); return Number.isFinite(v) && v > m ? v : m; }, 1);
  }

  // Widths: label left (capped + truncated), value right (fixed). The bar is a
  // BOUNDED meter (btop-style) — capped at `bar_width` (default 20) so it doesn't
  // sprawl across a wide pane; it still shrinks to fit a narrow one. The row is
  // padded to full width after the value so the selection highlight spans it.
  // Label width from ALL rows (stable while scrolling), not just the window.
  // reduce, not Math.max(...spread) — a huge topic would blow the arg limit.
  const maxLabel = rows.reduce((m, rk) => Math.max(m, visibleLen(esc(labelText(rk)))), 3);
  // Cap the label so a narrow pane keeps room for a ≥1-cell bar AND the value
  // (else a long label would push the value off-screen — the bar/value matter
  // more than a full label). `innerW - _VALUE_W - 3` = 2 gaps + a 1-cell bar.
  const labelW = Math.max(3, Math.min(16, maxLabel, innerW - _VALUE_W - 3));
  const avail = innerW - labelW - _VALUE_W - 2;               // two single-space gaps
  const barW = Math.max(1, Math.min(spec.barMax || 20, avail));
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
    const fillN = _meterFill(frac, barW);
    const trackN = barW - fillN;
    const label = cell(esc(labelText(rk)), labelW, false);
    const value = cell(esc(_fmt(v, type)), _VALUE_W, true);
    const trail = ' '.repeat(trailW);
    const track = '░'.repeat(trackN);   // dim grey remainder — btop's "grey part";
                                        // a DIFFERENT glyph from the fill █ so the
                                        // fill level stays readable (a dim solid █
                                        // track would make a low bar look full).
    // Selected row: ONE `[selected]` span over a PLAIN line (flat markup can't
    // nest colour under it — PRINCIPLES §8). Fill █ vs track ░ stay distinct by
    // glyph on the selection bg.
    if (selected && focused) return `[${t.selected}]${label} ${'█'.repeat(fillN)}${track} ${value}${trail}`;
    // Position-gradient fill (colourful, green→red along the bar) + dim ░ track.
    const bar = _colouredFill(fillN, barW, frac) + (trackN > 0 ? `[${t.dim}]${track}[/]` : '');
    return `${label} ${bar} ${value}${trail}`;
  };

  const lines = [];
  rows.slice(scroll, scroll + innerH).forEach((rk, vi) => {
    const abs = scroll + vi;
    lines.push(buildBar(rk, abs === sel));
  });
  return { lines, rowCount: rows.length, sel: interactive ? sel : 0, scroll };
}

function render(panel, w, h, slice, opts) {
  const focused = !!(opts && opts.focused);
  const chrome = opts && opts.chrome;
  // Live cursor/scroll (impure per-pane nav reads) stay here; renderBody is pure
  // of the paneId. `slice` is this pane's own slice (topic/column/… from init()).
  const { lines, rowCount, sel, scroll } = renderBody(slice, w - 2, h - 2, {
    sel: getSel(panel.paneId), scroll: getScroll(panel.paneId), focused,
  });
  return renderPanel({
    width: w, height: h, lines,
    title: panel.title, hotkey: panel.hotkey, panelType: 'gauge', focused, chrome,
    // Empty (rowCount 0) draws a plain bordered box — no count/scrollbar/windowing
    // — exactly as the pre-split _renderEmpty did (these all fall to renderPanel's
    // defaults). Data rows get the windowed `N of M` count + scrollbar.
    windowed: rowCount > 0,
    count: rowCount > 0 ? [sel + 1, rowCount] : null,
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
  // Border-less body reused by the `composite` panel (docs/compact-panes.md).
  renderBody,
  // Test-only internals.
  _fmt,
  getItems,
  _meterColumn,
  _meterFill,
};
