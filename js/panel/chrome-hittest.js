/**
 * Panel-chrome hit-tests — the slice-reading half of the former
 * render/decor.js (the pure glyph derivation moved to leaves/draw.js in the
 * render-exit arc). These read the live layout slice to map a click cell to
 * the pane whose `[_]`/`[+]` or `[X]` glyph sits there. Consumed by
 * dispatch/control/input.js (dispatch→panel, legal).
 *
 * Glyph geometry (all glyphs are 3 cells wide):
 *   [_]/[+]  → cols [b.x+b.w-4 .. b.x+b.w-2]
 *   [X]      → cols [b.x+b.w-8 .. b.x+b.w-6]   (gap left of [_])
 *
 * Min top-border width to host the glyphs:
 *   normal       → 9  cols  (╭(hk)─[_]╮)
 *   free-config  → 13 cols  (╭(hk)─[X] [_]╮)
 */
'use strict';

const { getInstanceSlice } = require('./api');
const mpool = require('../leaves/pool');
const { visibleBoundsFor } = require('../leaves/geometry');

const GLYPH_W = 3;
const COLLAPSE_MIN_W = 9;
const CLOSE_PLUS_COLLAPSE_MIN_W = 13;

function _collapseGlyphX0(b) { return b.x + b.w - 1 - GLYPH_W; }
function _closeGlyphX0(b)    { return b.x + b.w - 1 - GLYPH_W - 1 - GLYPH_W; }

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

/** Hit-test the `[_]`/`[+]` glyphs. Returns the panel id under (mx, my)
 *  or null. */
function hitTestCollapseButton(mx, my) {
  const targets = _placedWidgetTargets();
  if (!targets) return null;
  for (const { p, b } of targets) {
    if (b.w < COLLAPSE_MIN_W) continue;
    const x0 = _collapseGlyphX0(b);
    if (my === b.y && mx >= x0 && mx < x0 + GLYPH_W) return p.id;
  }
  return null;
}

/** Hit-test the `[X]` glyphs. Returns the panel id under (mx, my)
 *  or null. */
function hitTestCloseButton(mx, my) {
  const targets = _placedWidgetTargets();
  if (!targets) return null;
  for (const { p, b } of targets) {
    if (b.w < CLOSE_PLUS_COLLAPSE_MIN_W) continue;
    const x0 = _closeGlyphX0(b);
    if (my === b.y && mx >= x0 && mx < x0 + GLYPH_W) return p.id;
  }
  return null;
}

module.exports = { hitTestCollapseButton, hitTestCloseButton, _placedWidgetTargets };
