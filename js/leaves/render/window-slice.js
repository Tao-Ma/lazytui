/**
 * Scroll-window slice — the pure math the choices popover and action
 * palette both use to keep an idx-selected item inside the paint budget.
 *
 * **Why this leaf exists (v0.6.47 bug fix).** The fabric-form choices
 * popover (v0.6.38) and the action palette (v0.6.44 Brief 2) are two
 * type-to-filter lists. The popover computed its scroll window inline;
 * the palette shipped with NO window at all — the paint loop walked
 * every row and relied on `renderOverlay`'s truncation, which keeps
 * the TOP of the lines array. On a 97-action config in a 36-row
 * window the `[reverse]>` marker simply walked off the bottom edge
 * once idx > 35, and the operator could Enter-invoke an action they
 * couldn't see. Fix: both consumers call `windowSlice`, so the two
 * can't drift again. Same drift-removal pattern as the v0.6.46 shared
 * resolver fix for the preview surfaces
 * ([[project_v0646_preview_group_resolver_fix]]).
 *
 * The math (reference impl is the popover's inline block, pre-extraction):
 *
 *   - `total <= budget` → full list fits, no window, no overflow.
 *   - `total > budget`  → reserve 1 row for the "N of M" indicator at
 *     the bottom; windowSize = budget - 1; start = max(0, idx - half);
 *     end = min(total, start + windowSize); pull start back so a
 *     near-end idx still shows a FULL window (not a short tail).
 *
 * Pure: no I/O, no model reads. The caller computes `budget` from the
 * viewport + its own chrome rows (filter line, section headers, help
 * line, etc.) and passes it in.
 */
'use strict';

/**
 * Returns `{ start, end, overflow, windowSize }`:
 *   start/end — slice indices into the caller's row array (half-open)
 *   overflow  — true iff the full list didn't fit; caller should paint
 *               an "N of M" indicator row below the window
 *   windowSize — the slice length when overflowing, or `total` otherwise
 *
 * Edge cases:
 *   total <= 0        → empty slice, no overflow
 *   budget <= 0       → treats as "no budget info"; returns full list
 *                       without overflow (safe fallback — the caller
 *                       probably miscomputed; truncation will clip at
 *                       render time but nothing scrolls off invisibly).
 *   budget === 1      → degenerate (reserving 1 for indicator leaves 0
 *                       for content). We still carve out a 1-row window
 *                       (windowSize = max(1, budget - 1)) so at least
 *                       the selected row paints — a tiny viewport is
 *                       extreme and the operator sees SOMETHING.
 */
function windowSlice({ idx, total, budget }) {
  const t = total | 0;
  const b = budget | 0;
  if (t <= 0) return { start: 0, end: 0, overflow: false, windowSize: 0 };
  if (b <= 0 || t <= b) {
    return { start: 0, end: t, overflow: false, windowSize: t };
  }
  const windowSize = Math.max(1, b - 1);     // reserve 1 for "N of M" indicator
  const i = Math.max(0, Math.min(idx | 0, t - 1));
  const half = Math.floor(windowSize / 2);
  let start = Math.max(0, i - half);
  let end = Math.min(t, start + windowSize);
  // Near-end: pull start back so the window stays full-sized rather than
  // showing a short tail. This is what makes "scrolled all the way down"
  // show windowSize rows ending at `total`, not `windowSize - k` rows.
  start = Math.max(0, end - windowSize);
  return { start, end, overflow: true, windowSize };
}

module.exports = { windowSlice };
