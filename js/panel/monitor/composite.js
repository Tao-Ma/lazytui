/**
 * Core plugin — composite panel (btop-density boxes).
 *
 * Stacks several border-less widget BODIES — reused verbatim from the stats
 * (line-graph) and gauge (meter-bar) renderers via their `renderBody` seam — in
 * ONE bordered pane. A composite is still a single draggable, focusable pane; the
 * WM sees a flat pane (no nesting). This is Tier 1: DISPLAY-only widgets — the box
 * has no cursor of its own, so a widget's OWN rows aren't selectable and a click
 * inside just focuses the box. (A `graph` widget may still `select_from` an
 * EXTERNAL pane — that's a cross-pane cursor read, exactly like a standalone stats
 * pane, so it works and yields a follower graph inside the box.) See
 * docs/compact-panes.md.
 *
 * YAML shape:
 *   cpu_box:
 *     type: composite
 *     title: CPU
 *     widgets:
 *       - { type: graph, topic: host.cpu,  row: _, height: 50% }   # stats body
 *       - { type: bars,  topic: host.core, column: busy, label: core, heading: Cores }
 *
 * Each widget is a today-pane's config minus the border, plus `height:` (N% of the
 * box's inner height; omit → flex) and an optional dim `heading:` sub-header. The
 * widget `type` selects the body: `graph` → stats, `bars` → gauge (display mode).
 */
'use strict';

const { esc, theme, renderPanel } = require('../api');
const { distributeColumnHeights } = require('../../leaves/wm/geometry');
const stats = require('./stats');
const gauge = require('./gauge');

// A widget's border-less body lines. `graph` → the stats line-graph sections;
// `bars` → the gauge meter bars in DISPLAY mode (no cursor — a composite widget
// owns no paneId). An unknown/mis-typed widget degrades to a dim marker (the
// lenient-parser philosophy: no throw, a visible hint).
function _bodyLines(widget, innerW, innerH) {
  const type = widget && widget.type;
  if (type === 'graph') return stats.renderBody(widget, innerW, innerH).lines;
  if (type === 'bars')  return gauge.renderBody(gauge.specFrom(widget), innerW, innerH, {}).lines;
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

function render(panel, w, h, _slice, opts) {
  const chrome = opts && opts.chrome;
  const focused = !!(opts && opts.focused);
  const t = theme();
  const innerW = w - 2;
  const innerH = h - 2;
  const widgets = Array.isArray(panel.widgets) ? panel.widgets : [];

  let lines;
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
    lines = [];
    widgets.forEach((widget, i) => {
      if (i > 0) lines.push('');                                   // 1-row gap between widgets
      if (widget && widget.heading) lines.push(`[${t.dim}]${esc(String(widget.heading))}[/]`);
      // Pin each widget to EXACTLY its allocated body height so a short body
      // (rounding / few rows) doesn't shift the widgets below it out of their slots.
      const bh = heights[i];
      const body = _bodyLines(widget, innerW, bh);
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

  return renderPanel({
    width: w, height: h, lines,
    title: panel.title, hotkey: panel.hotkey, panelType: 'composite', focused, chrome,
  });
}

// Stateless Component — a composite is a pure render over model.metrics (each
// widget body reads its own topic; the metrics-mirror Subs keep them current). No
// slice of its own (display-only; no cursor). Same shape as `stats`.
module.exports = {
  name: 'composite',
  init: () => ({}),
  update: (_msg, slice) => slice,
  subscriptions,
  panelTypes: {
    composite: { render },
  },
  // Test-only internals.
  _split,
  _heightPct,
};
