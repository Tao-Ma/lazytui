/**
 * monitor-control — the pure primitive behind a btop-style refresh-rate control
 * (`- 2s +`) for monitor panes (docker containers first; stats-graph later).
 *
 * This leaf owns the control's DATA + GEOMETRY, nothing stateful and no I/O:
 *   - the step ladder + clamp (the allowed refresh intervals),
 *   - the label formatter,
 *   - the layout: given a pane's inner bounds + the current interval, the markup
 *     to draw and the absolute cell rects of the `-` / `+` click targets.
 *
 * WHY a shared leaf, not a base class: lazytui is TEA — Components compose pure
 * leaves, they don't inherit. Both the renderer (a monitor Component's render())
 * AND the hit-test (panel/chrome-hittest) derive the control's cell positions
 * from THIS one function, so they can't drift (the same DRY discipline the
 * chrome glyphs use — draw.js renders, chrome-hittest hit-tests, both off one
 * geometry source).
 *
 * The interval lives in the model and feeds the Component's `subscriptions()`
 * (an `interval` Sub keyed on `${id}:${ms}`), so changing it re-arms the poll via
 * the #D13 reconciler — see the docker wiring (Phase 2) + docs/DATAFLOW.md.
 */
'use strict';

const { visibleLen } = require('../text/ansi');

// The step stops (ms). `-`/`+` move between adjacent stops; a config value that
// falls between stops is honored on display and snaps to a stop on the first
// step. Ends double as the clamp bounds.
const REFRESH_LADDER = [500, 1000, 2000, 5000, 10000, 30000];
const MIN_REFRESH_MS = REFRESH_LADDER[0];
const MAX_REFRESH_MS = REFRESH_LADDER[REFRESH_LADDER.length - 1];
// Docker's historical POLL_MS — the default when no `refresh_ms:` is configured
// and the never-brick fallback for a garbage config value.
const DEFAULT_REFRESH_MS = 10000;

/** Clamp a (possibly config-supplied) interval to [MIN, MAX]. Non-finite /
 *  missing → DEFAULT (never-brick: a bad config value must not wedge polling). */
function clampRefreshMs(ms) {
  if (!Number.isFinite(ms)) return DEFAULT_REFRESH_MS;
  return Math.min(MAX_REFRESH_MS, Math.max(MIN_REFRESH_MS, Math.round(ms)));
}

/** Step to an adjacent ladder stop. dir > 0 → the next-LARGER interval (slower
 *  refresh, what the `+` button does — it raises the ms number); dir < 0 → the
 *  next-SMALLER interval (faster, `-`). Strictly-greater / strictly-less so an
 *  off-ladder `cur` snaps to the correct neighbouring stop; clamped at the ends;
 *  dir === 0 is a plain clamp. */
function stepRefreshMs(cur, dir) {
  const c = clampRefreshMs(cur);
  if (dir > 0) {
    for (const v of REFRESH_LADDER) if (v > c) return v;
    return MAX_REFRESH_MS;
  }
  if (dir < 0) {
    for (let i = REFRESH_LADDER.length - 1; i >= 0; i--) if (REFRESH_LADDER[i] < c) return REFRESH_LADDER[i];
    return MIN_REFRESH_MS;
  }
  return c;
}

/** The control's label. Sub-second → `Nms`; ≥ 1s → `N[.N]s` (trailing `.0`
 *  dropped by JS number formatting: 2000→"2s", 1500→"1.5s", 10000→"10s").
 *  Label STYLE is deliberately centralized here — the one place to switch to
 *  btop-literal `2000ms` if we decide that (plan open-decision #2). */
function formatRefreshMs(ms) {
  const m = clampRefreshMs(ms);
  return m < 1000 ? `${m}ms` : `${m / 1000}s`;
}

// Cell padding around the label inside the control: `- ` (glyph + space) on the
// left, ` +` (space + glyph) on the right.
const _PAD_CELLS = 4;

/**
 * Lay the control out, right-aligned on the TOP inner row of a monitor pane.
 *   inner      — the pane's inner content bounds { x, y, w, h } (NOT the border).
 *   refreshMs  — the current interval.
 * Returns null when it doesn't fit (inner too narrow / zero height) so the
 * caller simply omits it. Otherwise:
 *   { text, visibleW, x, y, hits: { minus:{x0,x1,y}, plus:{x0,x1,y} } }
 * `text` is the markup to draw at (x, y); the `-`/`+` glyphs are dimmed. Each
 * hit target is 2 cells (glyph + the space beside it, toward the label) so it's
 * comfortably clickable; the ranges are inclusive and never overlap the label.
 */
function refreshControlLayout(inner, refreshMs) {
  if (!inner || !(inner.w > 0) || !(inner.h > 0)) return null;
  const label = formatRefreshMs(refreshMs);
  const visibleW = visibleLen(label) + _PAD_CELLS;
  if (inner.w < visibleW) return null;
  const x = inner.x + inner.w - visibleW;   // right-aligned
  const y = inner.y;                         // top inner row
  const text = `[dim]-[/] ${label} [dim]+[/]`;
  return {
    text,
    visibleW,
    x,
    y,
    hits: {
      minus: { x0: x, x1: x + 1, y },
      plus:  { x0: x + visibleW - 2, x1: x + visibleW - 1, y },
    },
  };
}

/** Pure hit predicate: which button (if any) is at (mx, my) for a laid-out
 *  control. Returns -1 (`-`, faster), +1 (`+`, slower), or 0 (miss). Consumed by
 *  panel/chrome-hittest (Phase 3). null layout → miss. */
function refreshControlDir(mx, my, layout) {
  if (!layout) return 0;
  const on = (r) => my === r.y && mx >= r.x0 && mx <= r.x1;
  if (on(layout.hits.minus)) return -1;
  if (on(layout.hits.plus)) return 1;
  return 0;
}

module.exports = {
  REFRESH_LADDER, MIN_REFRESH_MS, MAX_REFRESH_MS, DEFAULT_REFRESH_MS,
  clampRefreshMs, stepRefreshMs, formatRefreshMs,
  refreshControlLayout, refreshControlDir,
};
