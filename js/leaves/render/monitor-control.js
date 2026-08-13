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

// The DEFAULT step stops (ms) — tuned for docker's cost: each poll spawns
// `docker inspect` + `docker stats` subprocesses, so no aggressive sub-second
// floor (unlike a btop-style local read) and a 60s ceiling for occasional
// checks. `-`/`+` move between adjacent stops; a value between stops is honored
// on display and snaps to a stop on the first step. A per-pane `refresh_ladder:`
// config overrides this (normalizeLadder); every ladder helper takes the ladder
// so it works for the configured one too.
const REFRESH_LADDER = [1000, 2000, 5000, 10000, 30000, 60000];
const MIN_REFRESH_MS = REFRESH_LADDER[0];
const MAX_REFRESH_MS = REFRESH_LADDER[REFRESH_LADDER.length - 1];
// Docker's historical POLL_MS — the default when no `refresh_ms:` is configured
// and the never-brick fallback for a garbage config value.
const DEFAULT_REFRESH_MS = 10000;

/** Sanitize a config-supplied ladder into a sorted, deduped list of positive
 *  integers. Anything invalid (not an array, <2 usable stops) → the default
 *  ladder (never-brick: a bad `refresh_ladder:` must not disable stepping). */
function normalizeLadder(raw) {
  if (!Array.isArray(raw)) return REFRESH_LADDER;
  const stops = [...new Set(raw.filter(n => Number.isFinite(n) && n > 0).map(n => Math.round(n)))]
    .sort((a, b) => a - b);
  return stops.length >= 2 ? stops : REFRESH_LADDER;
}

/** Clamp a (possibly config-supplied) interval to the ladder's [min, max].
 *  Non-finite / missing / non-positive → DEFAULT (never-brick: a garbage or
 *  `0`/negative config value must not wedge polling into a spawn storm),
 *  itself clamped into the ladder so it's always an in-range value. */
function clampRefreshMs(ms, ladder = REFRESH_LADDER) {
  const min = ladder[0], max = ladder[ladder.length - 1];
  const v = (Number.isFinite(ms) && ms > 0) ? ms : DEFAULT_REFRESH_MS;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Step to an adjacent stop in `ladder`. dir > 0 → the next-LARGER interval
 *  (slower refresh, what the `+` button does — it raises the ms number); dir < 0
 *  → the next-SMALLER interval (faster, `-`). Strictly-greater / strictly-less
 *  so an off-ladder `cur` snaps to the correct neighbouring stop; clamped at the
 *  ends; dir === 0 is a plain clamp. */
function stepRefreshMs(cur, dir, ladder = REFRESH_LADDER) {
  const c = clampRefreshMs(cur, ladder);
  if (dir > 0) {
    for (const v of ladder) if (v > c) return v;
    return ladder[ladder.length - 1];
  }
  if (dir < 0) {
    for (let i = ladder.length - 1; i >= 0; i--) if (ladder[i] < c) return ladder[i];
    return ladder[0];
  }
  return c;
}

/** The control's label. Sub-second → `Nms`; ≥ 1s → `N[.N]s` (trailing `.0`
 *  dropped by JS number formatting: 2000→"2s", 1500→"1.5s", 60000→"60s").
 *  Formats the value AS GIVEN (callers pass an already-clamped ms) so a custom
 *  ladder's larger stops render correctly; non-finite → DEFAULT. Label STYLE is
 *  centralized here — the one place to switch to btop-literal `2000ms`. */
function formatRefreshMs(ms) {
  const m = (Number.isFinite(ms) && ms > 0) ? Math.round(ms) : DEFAULT_REFRESH_MS;
  return m < 1000 ? `${m}ms` : `${m / 1000}s`;
}

// Cell padding around the label inside the control: `- ` (glyph + space) on the
// left, ` +` (space + glyph) on the right.
const _PAD_CELLS = 4;

/**
 * The control markup + its visible cell width. `text` renders as `- Ns +` with
 * the `-`/`+` dimmed; the caller places it (docker draws it on the top border via
 * renderPanel's `borderControl` slot). Width = label + the `- ` / ` +` padding.
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

/** Whether the control is drawn on the top border — the SINGLE source both
 *  renderPanel and panel/chrome-hittest gate on, so a click can never land where
 *  no control was drawn. TITLE-INDEPENDENT by design: renderPanel reserves the
 *  full right cluster (control + gap + glyphs + corner) and truncates the TITLE
 *  to fit it, so presence depends only on pane width + cluster width — which the
 *  hit-test also knows. `innerW` = pane width − 2; `glyphClusterW` = the chrome
 *  glyphs' visible width (a `[_]` = 3; add `[X] ` = 4 more in free-config).
 *  Renders iff there's room for `╭─` + one separator dash + the right cluster. */
function refreshControlFits(innerW, glyphClusterW, visibleW) {
  const rightVis = visibleW + 1 + glyphClusterW + 1;   // control + gap + glyphs + corner
  return innerW >= rightVis + 1;                        // + one separator dash before the cluster
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
  normalizeLadder, clampRefreshMs, stepRefreshMs, formatRefreshMs,
  refreshControlText, refreshControlHits, refreshControlBorderX0, refreshControlFits, refreshControlDir,
};
