/**
 * Core plugin — composite panel (btop-density boxes).
 *
 * Stacks several border-less widget BODIES — reused verbatim from the stats
 * (line-graph) and gauge (meter-bar) renderers via their `renderBody` seam — in
 * ONE bordered pane. A composite is still a single draggable, focusable pane; the
 * WM sees a flat pane (no nesting). See docs/compact-panes.md.
 *
 * Widget kinds (§5): `graph` → stats body, `bars` → gauge bars, `meter` → a single
 * gauge bar (one scalar). Most widgets are DISPLAY-only — no cursor of their own,
 * so a click inside just focuses the box. Tier-2 adds ONE optional exception: a
 * single `bars` widget marked `interactive: true` gains a live row cursor when the
 * box is focused (this pane then owns a nav slice; j/k, click, and `select_from`
 * drive it). A `graph` widget may also `select_from` an EXTERNAL pane — a cross-pane
 * cursor read, exactly like a standalone stats pane — yielding a follower graph.
 *
 * YAML shape:
 *   cpu_box:
 *     type: composite
 *     title: CPU
 *     widgets:
 *       - { type: graph, topic: host.cpu,  row: _, height: 50% }              # stats body
 *       - { type: meter, topic: host.mem,  column: used_pct }                 # one gauge bar
 *       - { type: bars,  topic: host.core, column: busy, heading: Cores, interactive: true }
 *
 * Each widget is a today-pane's config minus the border, plus `height:` (N% of the
 * box's inner height; omit → flex) and an optional dim `heading:` sub-header. The
 * widget `type` selects the body; a `graph` may add `overlay: true` (all metrics in
 * ONE braille grid). See docs/compact-panes.md §5.
 */
'use strict';

const { getModel } = require('../../model/store');
const { esc, theme, renderPanel, getSel, getScroll, getItems: apiGetItems, borderControlsFor, sliceForPane: _sliceForPane, getInstanceSlice } = require('../api');
const hoverRegion = require('../hover-region');
const { sortControlText, sortControlHits } = require('../../leaves/render/sort-control');
const { distributeColumnHeights } = require('../../leaves/wm/geometry');
const { rowInfo } = require('../../leaves/metrics/row-info');   // shared row → detail-card projection
const mnav = require('../../leaves/wm/nav');
const stats = require('./stats');
const gauge = require('./gauge');

// The ONE interactive widget of a composite (Tier-2 interactive sub-widget): the
// first `bars` widget marked `interactive: true`. It gains a row cursor when the
// box is focused (j/k, click, select_from source) — reusing gauge's interactive
// renderBody path. `meter` is single-value (no cursor); `graph` has no rows; so
// only `bars` qualifies. At most one per box keeps the pane's single cursor
// unambiguous. Returns the widget object (by reference) or null.
function _interactiveWidget(widgets) {
  return (Array.isArray(widgets) ? widgets : [])
    .find((w) => w && w.interactive === true && w.type === 'bars') || null;
}

// A widget's border-less body lines. `graph` → the stats line-graph sections;
// `bars`/`meter` → the gauge meter bars. Normally DISPLAY mode (empty `ctx`, no
// cursor); the ONE `interactive: true` bars widget instead receives the box's live
// cursor via `ctx` = { sel, scroll, focused }, threaded into the gauge body. An
// unknown/mis-typed widget degrades to a dim marker (the lenient-parser
// philosophy: no throw, a visible hint).
function _bodyLines(widget, innerW, innerH, ctx, hoverCol = -1) {
  const type = widget && widget.type;
  if (type === 'graph') return stats.renderBody(widget, innerW, innerH, hoverCol).lines;
  if (type === 'bars')  return gauge.renderBody(gauge.specFrom(widget), innerW, innerH, ctx || {}).lines;
  // `meter` — a SINGLE gauge bar (one scalar), vs `bars`' one-per-row. `single`
  // takes the top-sorted row; `row:` picks one by key. Reuses the gauge body.
  if (type === 'meter') return gauge.renderBody(gauge.specFrom({ ...widget, single: true }), innerW, innerH, {}).lines;
  return [`[${theme().dim}](unknown widget type: ${esc(String(type))})[/]`];
}

// A widget height (`45`, `"45%"`) → a percent number 1-100, or null (flex share).
function _heightPct(h) {
  if (typeof h === 'number' && Number.isFinite(h) && h > 0) return Math.min(100, h);
  if (typeof h === 'string' && h.endsWith('%')) {
    const n = parseFloat(h);
    return Number.isFinite(n) && n > 0 ? Math.min(100, n) : null;
  }
  return null;
}

// Body-height per widget. Reserve 1 row per `heading:` + a 1-row gap between
// widgets, then split the remainder with distributeColumnHeights — the SAME
// anchored(heightPct)+flex+overflow-scale math a column uses, one level down.
// Returns one body height per widget (excludes its heading/gap rows).
function _split(widgets, innerH) {
  const n = widgets.length;
  if (!n) return [];
  const headingRows = widgets.filter((w) => w && w.heading).length;
  const gapRows = Math.max(0, n - 1);
  const bodyAvail = Math.max(n, innerH - headingRows - gapRows);   // ≥1 body row per widget
  const pseudo = widgets.map((w, i) => {
    const hp = _heightPct(w && w.height);
    return hp != null ? { paneId: `w${i}`, heightPct: hp } : { paneId: `w${i}` };
  });
  const map = distributeColumnHeights(pseudo, bodyAvail, false, 1, 0);
  return widgets.map((_w, i) => map[`w${i}`] || 1);
}

function subscriptions(paneDef) {
  // Union of the widgets' metrics-mirror Subs (dedup by topic+window) so every
  // widget's topic stays current in model.metrics — the one non-obvious wiring
  // (docs/compact-panes.md §7). Mirrors are shared across panes/widgets by key.
  const widgets = (paneDef && Array.isArray(paneDef.widgets)) ? paneDef.widgets : [];
  const seen = new Set();
  const subs = [];
  for (const w of widgets) {
    if (!w || !w.topic) continue;
    const window = w.window || 40;
    const key = `${w.topic}:${window}`;
    if (seen.has(key)) continue;
    seen.add(key);
    subs.push({ kind: 'metrics-mirror', topic: w.topic, window });
  }
  return subs;
}

// Selection-cycler border control (`‹ eth0 ›` in the top border) — the click twin of
// j/k for a composite's interactive list. `‹`/`›` step the box's cursor (a wrapped
// `set_cursor`), and the label shows the current selection (getItems[getSel]); a
// follower graph (`select_from` this pane) then plots that row — btop's net-interface
// switcher. Self-suppresses when the box has no interactive selection (getItems empty,
// e.g. a display-only composite) or in free-config, so paint ↔ hit-test agree. Generic
// over what the list holds (interfaces / mounts / cores).
const _cycleControl = {
  id: 'cycle',
  slot: 'top',
  render(model, pane) {
    if (model && model.modes && model.modes.freeConfigMode) return null;
    const items = apiGetItems(pane.paneId);
    if (!items.length) return null;
    const sel = Math.max(0, Math.min(getSel(pane.paneId), items.length - 1));
    return sortControlText(String(items[sel]));
  },
  regions(x0, y, visibleW) { return sortControlHits(x0, y, visibleW); },
  dispatch(action, pane) {
    const items = apiGetItems(pane.paneId);
    if (!items.length) return null;
    const cur = Math.max(0, Math.min(getSel(pane.paneId), items.length - 1));
    const d = action === 'prev' ? -1 : 1;                 // ‹ = prev; › / label = next
    const index = (cur + d + items.length) % items.length;
    return { owner: pane.paneId, msg: { type: 'set_cursor', index } };
  },
};

// Body-row range of each widget in the assembled `lines`, mirroring render's stacking
// (leading gap unless `flush`, optional heading row, then `heights[i]` body rows). The
// single source both render (where to inject the hover column) and _resolveHover (which
// widget a body row belongs to) read, so the hover cell can't drift from what's drawn.
function _widgetBodyRanges(widgets, heights) {
  const ranges = [];
  let r = 0;
  widgets.forEach((widget, i) => {
    if (i > 0 && !(widget && widget.flush)) r += 1;      // inter-widget gap
    if (widget && widget.heading) r += 1;                // heading row
    ranges.push({ i, start: r, end: r + heights[i] });
    r += heights[i];
  });
  return ranges;
}

// Resolve this box's live hover (Phase 2, hover-for-value) → which `graph` widget the
// cursor is over + the value record to publish. Only `graph` widgets carry a value
// (bars/meter are current-value, not a history graph → no hover). Delegates the actual
// value read to stats.valueAt (the single owner of graph geometry), scoped to the
// widget's own body height. null when not hovered / not over a graph data cell.
function _resolveHover(panel, innerW, widgets, heights) {
  const paneId = panel && panel.paneId;
  if (paneId == null) return null;
  const layout = getInstanceSlice('layout');
  const hv = layout && layout.hover;
  if (!hv || hv.paneId !== paneId) return null;
  const hit = _widgetBodyRanges(widgets, heights).find((rg) => hv.row >= rg.start && hv.row < rg.end);
  if (!hit) return null;
  const widget = widgets[hit.i];
  if (!widget || widget.type !== 'graph') return null;
  const res = stats.valueAt(widget, innerW, heights[hit.i], hv.col, hv.row - hit.start);
  if (!res) return null;
  return { widgetIndex: hit.i, col: hv.col, record: stats.hoverRecord(res, paneId, hv.x, hv.y, hv.col) };
}

function render(panel, w, h, _slice, opts) {
  const chrome = opts && opts.chrome;
  const focused = !!(opts && opts.focused);
  const t = theme();
  const innerW = w - 2;
  const innerH = h - 2;
  const widgets = Array.isArray(panel.widgets) ? panel.widgets : [];

  let lines;
  let hover = null;
  // Body-row where the interactive widget's rows begin (0 if none). Reported to
  // renderPanel as `headerRows` so a CLICK maps to a bar only when it lands ON the
  // interactive widget — a click on a graph widget ABOVE it resolves to itemRow < 0
  // (no select), fixing "clicking the TX graph switches the interface".
  let interactiveStart = 0;
  if (!widgets.length) {
    lines = [`[${t.dim}](composite needs a widgets: list)[/]`];
  } else if (innerW < 1 || innerH < 1) {
    // Too small to render any widget body — a full-viewed box on a ≤2-row / ≤1-col
    // terminal hands render() h<2 or w<2, so the inner dims go negative. Emit no
    // content and let renderPanel draw a minimal (clamped) box: the reused stats /
    // gauge bodies aren't hardened for a negative width (the graph rasterizer would
    // `new Array(<negative>)` → RangeError). renderPanel itself is negative-dim safe.
    lines = [];
  } else {
    const heights = _split(widgets, innerH);
    // The interactive widget (if any) gets the box's live cursor threaded in — but
    // only when the pane is really placed (paneId present): the headless render
    // tests call render() with a bare panel, and getSel(undefined) has no entry.
    const iw = _interactiveWidget(widgets);
    const paneId = panel.paneId;
    const iCtx = (iw && paneId != null)
      ? { sel: getSel(paneId), scroll: getScroll(paneId), focused }
      : null;
    if (iw) {
      const rg = _widgetBodyRanges(widgets, heights).find((r) => widgets[r.i] === iw);
      if (rg) interactiveStart = rg.start;
    }
    // Hover-for-value (Phase 2): resolve which graph widget the cursor is over ONCE, so
    // that widget's body draws the highlighted column + we publish its value below.
    hover = _resolveHover(panel, innerW, widgets, heights);
    lines = [];
    widgets.forEach((widget, i) => {
      if (i > 0 && !(widget && widget.flush)) lines.push('');     // 1-row gap between widgets (`flush: true` abuts the previous)
      if (widget && widget.heading) lines.push(`[${t.dim}]${esc(String(widget.heading))}[/]`);
      // Pin each widget to EXACTLY its allocated body height so a short body
      // (rounding / few rows) doesn't shift the widgets below it out of their slots.
      const bh = heights[i];
      const hoverCol = (hover && hover.widgetIndex === i) ? hover.col : -1;
      const body = _bodyLines(widget, innerW, bh, widget === iw ? iCtx : null, hoverCol);
      for (let r = 0; r < bh; r++) lines.push(body[r] != null ? body[r] : '');
    });
    // At a tiny innerH the heading/gap rows push the stack past innerH (`_split`'s
    // bodyAvail floors at one row per widget). A composite has NO scroll, so cap
    // the lines to innerH — otherwise renderPanel infers `totalItems > innerH` and
    // paints a phantom (unscrollable) scrollbar thumb. renderPanel would clip the
    // display anyway; this just keeps the inferred total honest. Clamp at 0: a pane
    // shorter than its own border (innerH < 0 at h < 2 — e.g. a full-viewed box on a
    // ≤2-row terminal) would make `lines.length = <negative>` throw RangeError.
    if (lines.length > innerH) lines.length = Math.max(0, innerH);
  }

  // Publish the resolved hover value (footer + cursor tooltip read the per-frame
  // hover-region), mirroring stats.render — a composite graph widget is hoverable
  // exactly like a standalone stats pane.
  if (hover) hoverRegion.publish(hover.record);

  // Border controls (the selection cycler) — resolved from the Component-declared
  // `borderControls`, same as table/gauge. Self-suppress (null render) → no strip.
  const ctl = borderControlsFor({ paneId: panel.paneId, type: 'composite', focused, innerW }, getModel());
  return renderPanel({
    width: w, height: h, lines,
    title: panel.title, hotkey: panel.hotkey, panelType: 'composite', focused, chrome,
    topControls: ctl.filter((c) => (c.spec.slot || 'top') !== 'bottom').map((c) => c.text),
    bottomControls: ctl.filter((c) => (c.spec.slot || 'top') === 'bottom').map((c) => c.text),
    // Click hit-test: the interactive widget's rows start here, so a click above them
    // (a graph widget) resolves to no row (see interactiveStart above).
    headerRows: interactiveStart,
  });
}

// The interactive widget's gauge spec from a pane def (or null) — the rows source
// for getItems / getInfo / the cursor. Single-sourced so init + getItems agree.
function _interactiveSpec(paneDef) {
  const iw = _interactiveWidget(paneDef && paneDef.widgets);
  return iw ? gauge.specFrom(iw) : null;
}

// Per-pane state: the nav cursor for an interactive widget (if any). A display-
// only composite carries an unused nav entry (getItems → [] makes nav a no-op),
// so its render stays byte-identical. Mirrors gauge's slice shape.
function init(paneId, seed) {
  return {
    nav: mnav.init(),
    paneId: paneId == null ? undefined : paneId,
    interactiveSpec: _interactiveSpec(seed && seed.paneDef),
  };
}

// Fold the framework's cursor/scroll Msgs (j/k, click nav_select, wheel) into the
// nav entry — exactly gauge's update. Nothing else is stateful.
function update(msg, slice) {
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  return slice;
}

// getItems — the interactive widget's ordered row keys (drives the cursor bounds,
// select_from, and getInfo). Empty for a display-only composite → nav no-ops.
function getItems(slice) {
  return slice && slice.interactiveSpec ? gauge.getItems(slice.interactiveSpec) : [];
}

// getInfo — the selected row's detail card (viewer Info tab), same projection as
// gauge/table so all three agree.
function getInfo(rowKey, paneId) {
  const slice = paneId != null ? _sliceForPane(paneId, 'composite') : null;
  const topic = slice && slice.interactiveSpec && slice.interactiveSpec.topic;
  const metric = topic ? (getModel().metrics || {})[topic] : null;
  return metric ? rowInfo(metric, rowKey) : [`row: ${rowKey}`];
}

module.exports = {
  name: 'composite',
  init,
  update,
  subscriptions,
  panelTypes: {
    composite: {
      render,
      getItems,
      getInfo,
      idOf: (rowKey) => String(rowKey),
      borderControls: [_cycleControl],
    },
  },
  // Border-less body helpers reused/tested.
  _split,
  _heightPct,
};
