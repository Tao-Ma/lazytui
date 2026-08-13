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

const { getInstanceSlice, borderControlsFor, getFocus } = require('./api');
const { getModel } = require('../model/store');
const mpool = require('../leaves/wm/pool');
const mpane = require('../leaves/wm/pane');
const { visibleBoundsFor } = require('../leaves/wm/geometry');
const bc = require('../leaves/render/border-controls');

// Which top-border controls a pane type carries is a Component-declared
// capability (`panelTypes[type].borderControls`) resolved via api.borderControlsFor
// — the SAME source the render decision uses, so paint and hit-test can't drift.
// Docker-first; other panes join by declaring their own control specs.

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

/** Hit-test the top-border control strip (refresh `- Ns +`, sort `‹ col ›`, …)
 *  on a placed pane. Returns `{ owner, msg }` — the spec's own click Msg, routed
 *  to its owner Component — or null. The caller dispatches `wrap(owner, msg)`.
 *
 *  Presence + geometry mirror renderPanel EXACTLY so a click can't land where no
 *  control drew: the SAME `borderControlsFor(pane, model)` the render decision
 *  uses returns only the controls visible THIS frame (specs suppress themselves
 *  in free-config + off-focus). Two slots:
 *    - TOP strip (refresh/sort): right-anchored left of `[_]` (glyph cluster =
 *      GLYPH_W since controls only show in normal mode); gate `bc.fits`, positions
 *      `bc.placeX0s`.
 *    - BOTTOM legend (item-actions): left-anchored after `╰─`; gate `bc.bottomFits`
 *      (count-independent), position `bc.bottomX0`, row = pane's last.
 *  `pane.focused` (via paneMatchesFocus) lets a spec show per-focus (the bottom
 *  legend does; top controls ignore it). */
function hitTestBorderControls(mx, my) {
  const targets = _placedWidgetTargets();
  if (!targets) return null;
  const model = getModel();
  const focus = getFocus();
  for (const { p, b } of targets) {
    // A collapsed pane is a 1-row title bar (paint._renderCollapsed) that paints
    // NO border controls — mirror that here so a click on its header dashes can't
    // fire a phantom control (incl. a destructive `kill` confirm). The collapse/
    // close glyph hit-tests DON'T skip collapsed panes — `[+]` must stay clickable.
    if (p.collapsed) continue;
    const pane = { paneId: p.paneId, type: p.type, focused: mpane.paneMatchesFocus(p, focus), innerW: b.w - 2 };
    const controls = borderControlsFor(pane, model);
    if (!controls.length) continue;

    // TOP strip — right-anchored, left of the glyph cluster.
    const top = controls.filter(c => (c.spec.slot || 'top') !== 'bottom');
    if (top.length) {
      const visibleWs = top.map(c => c.visibleW);
      if (bc.fits(b.w - 2, GLYPH_W, visibleWs)) {
        const x0s = bc.placeX0s(visibleWs, _collapseGlyphX0(b));
        for (let i = 0; i < top.length; i++) {
          for (const r of top[i].spec.regions(x0s[i], b.y, top[i].visibleW, pane)) {
            if (my === r.y && mx >= r.x0 && mx <= r.x1) return top[i].spec.dispatch(r.action, pane);
          }
        }
      }
    }

    // BOTTOM legend — left-anchored on the pane's last row.
    const bottom = controls.find(c => (c.spec.slot || 'top') === 'bottom');
    if (bottom && bc.bottomFits(b.w - 2, bottom.visibleW)) {
      const y = b.y + b.h - 1;
      for (const r of bottom.spec.regions(bc.bottomX0(b.x), y, bottom.visibleW, pane)) {
        if (my === r.y && mx >= r.x0 && mx <= r.x1) {
          const hit = bottom.spec.dispatch(r.action, pane);
          if (hit) return hit;   // null = nothing selected → fall through (harmless)
        }
      }
    }
  }
  return null;
}

module.exports = { hitTestCollapseButton, hitTestCloseButton, hitTestBorderControls };
