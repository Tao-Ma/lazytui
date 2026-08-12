/**
 * Panel-chrome hit-tests — the slice-reading half of the former
 * render/decor.js (the pure glyph derivation moved to leaves/render/draw.js in the
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

const { getInstanceSlice, serviceSlice } = require('./api');
const { getModel } = require('../model/store');
const mpool = require('../leaves/wm/pool');
const { visibleBoundsFor } = require('../leaves/wm/geometry');
const mc = require('../leaves/render/monitor-control');

// Pane types that carry a top-border refresh control (Phase 3). Docker-first;
// stats-graph would join here when it adopts the control.
const MONITOR_TYPES = new Set(['containers']);

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

/** Hit-test the monitor refresh control (`- Ns +`) on a monitor pane's top
 *  border. Returns `{ dir }` (-1 faster / +1 slower) or null. The control is
 *  host-global (the docker owner's cadence), so a click on ANY monitor pane's
 *  control steps the shared rate — the caller dispatches `set_refresh_ms {dir}`
 *  to the owner.
 *
 *  Presence + geometry mirror renderPanel EXACTLY so a click can't land where no
 *  control drew: docker suppresses the control in free-config (dropped there), so
 *  it only ever shows in normal mode where the sole right glyph is `[_]`
 *  (collapse) — glyph cluster width = GLYPH_W. Presence gates on the shared
 *  `refreshControlFits` (the title-independent predicate renderPanel reserves
 *  for); position is `refreshControlBorderX0(_collapseGlyphX0, visibleW)`. */
function hitTestRefreshControl(mx, my) {
  const targets = _placedWidgetTargets();
  if (!targets) return null;
  if ((getModel().modes || {}).freeConfigMode) return null;   // control suppressed in free-config
  const s = serviceSlice('docker') || {};
  const { visibleW } = mc.refreshControlText(mc.clampRefreshMs(s.refreshMs, s.refreshLadder));
  for (const { p, b } of targets) {
    if (!MONITOR_TYPES.has(p.type)) continue;
    if (!mc.refreshControlFits(b.w - 2, GLYPH_W, visibleW)) continue;   // same gate renderPanel uses
    const x0 = mc.refreshControlBorderX0(_collapseGlyphX0(b), visibleW);
    const dir = mc.refreshControlDir(mx, my, mc.refreshControlHits(x0, b.y, visibleW));
    if (dir) return { dir };
  }
  return null;
}

module.exports = { hitTestCollapseButton, hitTestCloseButton, hitTestRefreshControl };
