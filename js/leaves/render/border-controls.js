/**
 * border-controls — pure geometry for a top-border control STRIP: N interactive
 * controls right-anchored on a pane's top border, each one gap-dash apart, the
 * whole strip sitting one gap-dash left of the chrome glyph cluster.
 *
 *   ╭─(hk)[≡]─title────── ctrl0 ─ ctrl1 ─ [_]╮
 *
 * This is the generalization of the single-control slot (the monitor refresh
 * control was the first consumer): a pane declares an ordered list of control
 * SPECS and the framework places them here. The LAST spec sits nearest the
 * glyphs (rightmost); earlier ones step left.
 *
 * Pure — takes visible widths, returns cell math, no model/api/I/O. Both the
 * painter (leaves/render/draw.js, via its assembled rightPart string) and the
 * hit-test (panel/chrome-hittest) derive positions from HERE so they can't drift
 * (the same DRY discipline refresh-control established for the lone control).
 */
'use strict';

// One border dash between adjacent controls, and one before the glyph cluster.
const GAP = 1;

/**
 * Total reserved width of the right cluster on the top border:
 *   controls + one gap after each + the glyph cluster + the corner.
 * Equals the visible width of renderPanel's assembled `rightPart`, so the fit
 * predicate below matches paint exactly.
 * @param {number[]} visibleWs - each control's visible width, registration order
 * @param {number} glyphClusterW - the chrome glyphs' visible width (e.g. `[_]` = 3)
 */
function reservedW(visibleWs, glyphClusterW) {
  const controlsW = visibleWs.reduce((a, w) => a + w, 0);
  return controlsW + visibleWs.length * GAP + glyphClusterW + 1;   // +1 = corner
}

/**
 * Whether the control strip fits on a top border of inner width `innerW` and
 * still leaves room for the opening `╭─`. Mirrors renderPanel's `leftCap >= 2`
 * gate EXACTLY (reservedW === renderPanel's rightVis), so a click can never land
 * where no control drew. Presence is title-INDEPENDENT: the title truncates to
 * reserve this cluster, so it depends only on width + widths.
 */
function fits(innerW, glyphClusterW, visibleWs) {
  return reservedW(visibleWs, glyphClusterW) <= innerW - 1;
}

/**
 * The leftmost cell (x0) of each control, in registration order, given the
 * leftmost chrome glyph cell (`glyphX0`). The LAST control sits one gap-dash
 * left of the glyphs; each earlier control one gap-dash left of the next.
 * Mirrors renderPanel prepending controls right-to-left.
 */
function placeX0s(visibleWs, glyphX0) {
  const xs = new Array(visibleWs.length);
  let leftEdge = glyphX0;
  for (let i = visibleWs.length - 1; i >= 0; i--) {
    xs[i] = leftEdge - GAP - visibleWs[i];
    leftEdge = xs[i];
  }
  return xs;
}

// --- Bottom border, LEFT-anchored single control (the item-action legend) ---
// Layout: `╰` `─`(lead dash) {control} `─…`(≥1 trailing dash) `╯`. Count-
// INDEPENDENT: the count (right-anchored) drops if it can't share the row, so
// the control's presence + position depend only on the pane width — which the
// hit-test also knows. Both the painter (draw.js bottom border) and the hit-test
// derive from these two.

/** Does a left-anchored bottom control of visible width `visibleW` fit on a
 *  bottom border of inner width `innerW` (lead dash + control + ≥1 trailing)? */
function bottomFits(innerW, visibleW) {
  return innerW >= visibleW + 2;
}

/** Leftmost cell (x0) of the bottom control: one lead dash right of the corner
 *  at the pane's left edge `paneX`. */
function bottomX0(paneX) {
  return paneX + 2;   // corner + lead dash
}

module.exports = { GAP, reservedW, fits, placeX0s, bottomFits, bottomX0 };
