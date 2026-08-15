/**
 * Core plugin — table panel.
 *
 * A YAML-declarable, generic consumer of hub data: lists the ROWS of a hub
 * topic (Map<rowKey, latest sample>) as a sorted, columnar, selectable table —
 * btop's process list, generic over any topic. The row-history sibling of the
 * `stats` panel (which drills into ONE row); this is the LIST view.
 *
 * Reads model.metrics[topic] (populated by the shared `metrics-mirror` Sub, the
 * same one `stats` declares), so frame = f(model) (#D5) — no live hub reads in
 * render. Returns STRING row keys from getItems, so a `stats` pane can use this
 * table as its `select_from` source (select a process → graph its CPU/mem).
 *
 * YAML shape:
 *   procs:
 *     type: table
 *     title: Processes
 *     topic: host.proc          # hub topic (a metrics: producer, or a Component)
 *     columns: [cpu, rss, comm] # schema columns to show, in order (rowKey shown first)
 *     sort: cpu                 # optional default sort column
 *     sort_dir: desc            # optional: desc (default for a metric) | asc
 *     window: 40                # optional, samples retained per row (default 40)
 *
 * Sort is applied INTERNALLY in getItems (reading nav.sort — the per-pane twin
 * of nav.filter), NOT via api.getItems's central `sortKeys` path: that path bakes
 * the topic into each column's value() closure, which can't serve two table panes
 * on different topics. getItems has the slice (topic + columns), so it sorts
 * per-pane correctly. The clickable border sort control still drives nav.sort via
 * the standard set_sort/sort_reverse Msgs.
 */
'use strict';

const { getModel } = require('../../model/store');
const {
  esc, theme, renderPanel, visibleLen,
  getSel, getScroll, getSort, getFilter,
  getItems: apiGetItems, borderControlsFor,
} = require('../api');
const mnav = require('../../leaves/wm/nav');
const { sortControlText, sortControlHits, NONE_LABEL, ASC, DESC } = require('../../leaves/render/sort-control');

// Render-time cache: the sortable column keys per paneId, stashed by render so
// the border sort control (whose spec only receives {paneId,type}) can cycle
// THIS pane's columns. Overwritten every paint; a stale entry is harmless.
const _colsByPane = new Map();

function _metric(topic) {
  const all = getModel().metrics;
  return (all && all[topic]) || null;
}

function _latest(metric, rowKey) {
  const s = metric && metric.series && metric.series[rowKey];
  return (s && s.length) ? s[s.length - 1] : null;
}

// Resolve the columns to show: config `columns:` (in order), else every
// non-meta schema column. rowKey is always the leading identity column.
function _columns(panel, metric) {
  if (Array.isArray(panel.columns) && panel.columns.length) return panel.columns.slice();
  const cols = (metric && metric.schema && metric.schema.columns) || {};
  return Object.entries(cols).filter(([, c]) => c && !c.meta).map(([k]) => k);
}

function _typeOf(metric, col) {
  const c = metric && metric.schema && metric.schema.columns && metric.schema.columns[col];
  return (c && c.type) || 'number';
}

// Format one cell by its schema type. Numbers → compact; string → as-is.
function _fmt(v, type) {
  if (type === 'string') return v == null ? '' : String(v);
  if (!Number.isFinite(v)) return '—';
  if (type === 'percent') return `${v.toFixed(1)}%`;
  if (type === 'bytes') {
    if (v < 1024) return `${Math.round(v)}B`;
    if (v < 1024 ** 2) return `${(v / 1024).toFixed(0)}K`;
    if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)}M`;
    return `${(v / 1024 ** 3).toFixed(1)}G`;
  }
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

const _NUM_W = 7;   // fixed width for a value column (right-aligned)

// --- Component (TEA) half ---

function subscriptions(paneDef, _model) {
  if (!paneDef || !paneDef.topic) return [];
  // Same Sub the stats panel declares — retains `window` samples + throttle-
  // repaints on publish. Multiple panes on one topic share one mirror.
  return [{ kind: 'metrics-mirror', topic: paneDef.topic, window: paneDef.window || 40 }];
}

function init(paneId, seed) {
  // The per-pane config is HOISTED onto seed.paneDef (topic/columns/sort at top
  // level — the parser hoists panel fields onto the placed pane); seed.config is
  // the whole model config. Read the pane def.
  const pd = (seed && seed.paneDef) || {};
  const nav = mnav.init();
  // Seed the default sort into nav so the table opens ordered (config intent),
  // while a user's later set_sort/reverse still wins (they replace nav.sort).
  if (pd.sort) nav.sort = { key: pd.sort, dir: pd.sort_dir === 'asc' ? 1 : -1 };
  return {
    topic: pd.topic,
    columns: Array.isArray(pd.columns) ? pd.columns.slice() : null,
    nav,
    paneId: paneId == null ? undefined : paneId,
  };
}

function update(msg, slice) {
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  return slice;
}

// getItems — the ORDERED row keys (strings). Internal sort by nav.sort; missing
// values sink to the far end for either direction. This is the canonical list
// render + the cursor + a stats `select_from` all read.
function getItems(slice) {
  const topic = slice && slice.topic;
  if (!topic) return [];
  const metric = _metric(topic);
  if (!metric || !metric.series) return [];
  let rows = Object.keys(metric.series);
  const sort = slice.nav && slice.nav.sort;
  if (sort && sort.key) {
    const type = _typeOf(metric, sort.key);
    const dir = sort.dir < 0 ? -1 : 1;
    const bad = dir < 0 ? -Infinity : Infinity;   // missing → bottom, either dir
    const val = (rk) => {
      const s = _latest(metric, rk);
      const v = s ? s[sort.key] : undefined;
      if (type === 'string') return v == null ? '' : String(v);
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
    title: panel.title, hotkey: panel.hotkey, panelType: 'table', focused: !!focused, chrome,
  });
}

function render(panel, w, h, slice, opts) {
  const focused = !!(opts && opts.focused);
  const chrome = opts && opts.chrome;
  const topic = panel.topic;
  if (!topic) return _renderEmpty(panel, w, h, '(table needs a topic)', chrome, focused);
  const metric = _metric(topic);
  const cols = _columns(panel, metric);
  _colsByPane.set(panel.paneId, cols);           // for the sort control (per-pane cycle)

  const rows = apiGetItems(panel.paneId);        // sorted + filtered row keys
  if (!metric || !rows.length) {
    return _renderEmpty(panel, w, h, metric ? '(no rows)' : '(no data yet)', chrome, focused);
  }
  const sel = getSel(panel.paneId);
  const t = theme();
  const innerW = w - 2;

  // Column widths: each value column is fixed (_NUM_W); string columns get a bit
  // more; the leading identity (rowKey) column takes the remainder.
  const colW = cols.map(c => (_typeOf(metric, c) === 'string' ? 12 : _NUM_W));
  const used = colW.reduce((a, b) => a + b + 1, 0);   // +1 gutter each
  const idW = Math.max(3, innerW - used - 1);

  const cell = (text, width, right) => {
    const s = String(text);
    const vis = visibleLen(s);
    if (vis > width) return s.slice(0, width);        // plain text here (esc'd by caller); simple clip
    const pad = ' '.repeat(width - vis);
    return right ? pad + s : s + pad;
  };

  // Header (dim) — column names. Line 0; scrolls with the list (sticky header
  // is a deferred refinement).
  const sort = (slice && slice.nav && slice.nav.sort) || null;
  const hdrCells = [cell('', idW, false)];
  cols.forEach((c, i) => {
    const mark = sort && sort.key === c ? (sort.dir < 0 ? DESC : ASC) : '';
    hdrCells.push(cell(c + mark, colW[i], _typeOf(metric, c) !== 'string'));
  });
  const header = `[${t.dim}]${esc(hdrCells.join(' '))}[/]`;

  const lines = [header];
  rows.forEach((rk, i) => {
    const s = _latest(metric, rk);
    const cells = [cell(esc(String(rk)), idW, false)];
    cols.forEach((c, ci) => {
      const type = _typeOf(metric, c);
      cells.push(cell(esc(_fmt(s ? s[c] : NaN, type)), colW[ci], type !== 'string'));
    });
    const rowStr = cells.join(' ');
    // Selected row: open the theme `selected` span over the whole line, no inner
    // markup (PRINCIPLES §8) — cells are already plain (esc'd, no color).
    lines.push(i === sel && focused ? `[${t.selected}]${rowStr}` : rowStr);
  });

  const m = getModel();
  const ctl = borderControlsFor({ paneId: panel.paneId, type: 'table', focused, innerW }, m);
  const filterText = getFilter(panel.paneId);
  const title = filterText ? `${panel.title} /${esc(filterText)}` : panel.title;

  return renderPanel({
    width: w, height: h, lines,
    title, hotkey: panel.hotkey, panelType: 'table', focused, chrome,
    count: rows.length ? [sel + 1, rows.length] : null,
    scrollOffset: getScroll(panel.paneId),
    topControls: ctl.filter(c => (c.spec.slot || 'top') !== 'bottom').map(c => c.text),
    bottomControls: ctl.filter(c => (c.spec.slot || 'top') === 'bottom').map(c => c.text),
  });
}

// --- Border sort control — per-pane columns from the render-time cache -------
// A table-specific spec (not the generic sortControlSpec): its keys vary per
// pane (config-driven columns), so it resolves them from `_colsByPane` at
// render/dispatch time instead of capturing a static list at construction.
function _colsFor(pane) { return _colsByPane.get(pane && pane.paneId) || []; }

const _sortControl = {
  id: 'sort',
  slot: 'top',
  render(model, pane) {
    if (model && model.modes && model.modes.freeConfigMode) return null;
    const sort = getSort(pane.paneId);   // per-pane nav.sort
    const label = sort && sort.key ? `${sort.key}${sort.dir < 0 ? DESC : ASC}` : NONE_LABEL;
    return sortControlText(label);
  },
  regions(x0, y, visibleW) { return sortControlHits(x0, y, visibleW); },
  dispatch(action, pane) {
    if (action === 'reverse') return { owner: pane.paneId, msg: { type: 'sort_reverse', panel: pane.type } };
    const cycle = [null, ..._colsFor(pane)];
    const cur = getSort(pane.paneId) || { key: null, dir: 1 };
    const i = Math.max(0, cycle.indexOf(cur.key));
    const d = action === 'next' ? 1 : -1;
    const key = cycle[(i + d + cycle.length) % cycle.length];
    return { owner: pane.paneId, msg: { type: 'set_sort', panel: pane.type, key } };
  },
};

module.exports = {
  name: 'table',
  init,
  update,
  subscriptions,
  panelTypes: {
    table: {
      render,
      getItems,
      getInfo,
      filterable: true,
      filterText: (rowKey) => String(rowKey),
      idOf: (rowKey) => String(rowKey),
      borderControls: [_sortControl],
      keyHints: 'sort: click ‹col›',
    },
  },
  // Test-only internals.
  _fmt,
  getItems,
  _columns,
};
