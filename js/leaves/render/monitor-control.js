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
 * The control markup + its visible cell width. `text` renders as `- Ns +` with
 * the `-`/`+` dimmed; the caller places it (docker draws it on the top border via
 * renderPanel's `monitorControl` slot). Width = label + the `- ` / ` +` padding.
 */
function refreshControlText(refreshMs) {
  const label = formatRefreshMs(refreshMs);
  return { text: `[dim]-[/] ${label} [dim]+[/]`, visibleW: visibleLen(label) + _PAD_CELLS };
}

/** The `-` / `+` button cell rects, given the control's leftmost cell (x0) and
 *  row (y). Each target is 2 cells (glyph + the space beside it, toward the
 *  label) so it's comfortably clickable; inclusive ranges, never overlapping the
 *  label. Both the hit-test and any renderer derive positions from here. */
function refreshControlHits(x0, y, visibleW) {
  return {
    minus: { x0, x1: x0 + 1, y },
    plus:  { x0: x0 + visibleW - 2, x1: x0 + visibleW - 1, y },
  };
}

/** The control's leftmost cell on a pane's TOP BORDER: one gap dash to the left
 *  of the leftmost chrome glyph (`glyphX0`). renderPanel places it by the same
 *  construction — prepend `control + one dash` to the right-anchored glyph
 *  cluster — so render and hit-test agree without a shared string. */
function refreshControlBorderX0(glyphX0, visibleW) {
  return glyphX0 - 1 - visibleW;
}

/** Pure hit predicate over a `{ minus, plus }` hit-rect pair (from
 *  refreshControlHits). Returns -1 (`-`, faster), +1 (`+`, slower), or 0 (miss).
 *  null → miss. */
function refreshControlDir(mx, my, hits) {
  if (!hits) return 0;
  const on = (r) => my === r.y && mx >= r.x0 && mx <= r.x1;
  if (on(hits.minus)) return -1;
  if (on(hits.plus)) return 1;
  return 0;
}

module.exports = {
  REFRESH_LADDER, MIN_REFRESH_MS, MAX_REFRESH_MS, DEFAULT_REFRESH_MS,
  clampRefreshMs, stepRefreshMs, formatRefreshMs,
  refreshControlText, refreshControlHits, refreshControlBorderX0, refreshControlDir,
};
