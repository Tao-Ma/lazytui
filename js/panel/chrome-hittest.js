/**
 * The last two legacy in-pane hit-tests — the `✗ cancel` chip and the tree fold
 * markers. Everything else on the pane border (glyphs, border controls) resolves
 * on the hit map (docs/mouse-hit-map.md Release 2); these two follow in step 5,
 * then this file goes. Consumed by dispatch/control/input.js.
 */
'use strict';

const { getInstanceSlice } = require('./api');
const mpool = require('../leaves/wm/pool');
const { visibleBoundsFor } = require('../leaves/wm/geometry');
const treeRegions = require('./tree-regions');

/** Non-detail placed panels in current layout order, with each pane's live
 *  visible bounds (visibleBoundsFor by paneId) attached. Both renderers +
 *  hit-tests walk this same set so the DRY helper avoids the slice-read
 *  fan-out that lived in v0.6 pre-cleanup. Returns null when there's no
 *  layout slice yet (test/boot edge cases) or during a drag. */
function _placedWidgetTargets() {
  const slice = getInstanceSlice('layout');
  if (!slice || !slice.arrange) return null;
  const drag = slice.freeConfig && slice.freeConfig.drag;
  if (drag) return null;  // drag affordance owns the screen; suppress widgets
  const panels = mpool.allPanesInColumns(slice.arrange);
  // visibleBoundsFor — NOT boundsFor — so off-screen panes in half/
  // full view don't show up here. The boundsFor fallback to
  // _currentLayout.rects would return phantom normal-view rects for
  // off-screen panes, letting a click on the visible left half fire
  // panel_collapse_toggle on an off-screen pane (user returns to
  // normal view → that pane is silently collapsed).
  return panels
    .filter(p => p.type !== 'detail')
    // v0.6.4 Phase 2 — hit-test by paneId, not type: two same-kind panes
    // share a type key, so a type lookup would collide.
    .map(p => ({ p, b: visibleBoundsFor(slice, p.paneId) }))
    .filter(({ b }) => b && b.h >= 1);
}

/** Hit-test the LIVE action-status chip's `✗ cancel` affordance. Returns the
 *  running jobId under (mx, my), or null. Unlike the glyphs above, the chip is a
 *  CONTENT line (the running status floated at the pane's tail), not border chrome
 *  — so this walks ALL placed panes (incl. the detail/content slots
 *  `_placedWidgetTargets` excludes) and asks the text-view Component where its
 *  cancel span drew this frame. Presence + geometry come from the SAME
 *  `astatus.runningChip` the render used (via `cancelHitInfo` → bottom-stuck tail
 *  row, right-aligned), so a click can't land where the ✗ cancel didn't paint. */
function hitTestActionCancel(mx, my) {
  const slice = getInstanceSlice('layout');
  if (!slice || !slice.arrange) return null;
  if (slice.freeConfig && slice.freeConfig.drag) return null;   // drag owns the screen
  const textview = require('./text-view/text-view');
  for (const p of mpool.allPanesInColumns(slice.arrange)) {
    const b = visibleBoundsFor(slice, p.paneId);
    if (!b || b.h < 3 || b.w < 3) continue;                     // need a border + ≥1 inner row
    const info = textview.cancelHitInfo(p.paneId, b.w - 2, b.h - 2);
    if (!info) continue;
    const row = b.y + 1 + info.row;                             // pane-local chip row → screen row
    const x0 = b.x + 1 + info.cancelX0;                         // pane-local content col → screen col
    const x1 = b.x + 1 + info.cancelX1;
    if (my === row && mx >= x0 && mx <= x1) return info.jobId;
  }
  return null;
}

/** Hit-test the per-row TREE FOLD MARKERS (`▾`/`▸`) a `table` in tree mode drew.
 *  Returns `{ owner, id }` — the pane and the node whose marker sits under the
 *  cursor — or null. Presence + geometry come from panel/tree-regions, the marker
 *  cells paint ACTUALLY published this frame (a clipped/off-screen marker leaves no
 *  region → no hit), so paint ↔ hit-test can't drift. Pane-local cells (y from the
 *  top border, x from the left border) → screen by adding the pane origin, exactly
 *  as the chrome-region hit-tests above. The caller dispatches
 *  `wrap(owner, { type:'tree_toggle', id })`; a collapsed pane draws no rows. */
function hitTestTreeMarker(mx, my) {
  const targets = _placedWidgetTargets();
  if (!targets) return null;
  for (const { p, b } of targets) {
    if (p.collapsed) continue;
    const markers = treeRegions.get(p.paneId);
    if (!markers) continue;
    for (const g of markers) {
      if (my === b.y + g.y && mx >= b.x + g.x0 && mx <= b.x + g.x1) return { owner: p.paneId, id: g.id };
    }
  }
  return null;
}

module.exports = { hitTestActionCancel, hitTestTreeMarker };
