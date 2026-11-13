/**
 * border-controls — the bottom-border fit rule for the left-anchored item-action
 * legend (the one control in the `bottomControls` slot):
 *
 *   ╰─{legend}─────────── N of M─╯
 *
 * Count-INDEPENDENT: the right-anchored `N of M` count drops when it can't share
 * the row, so the legend's presence depends only on the pane width. renderPanel
 * (leaves/render/draw.js) gates the legend on it, and action-legend picks its
 * full / compact form with it.
 *
 * (The top-strip placement helpers — fits / placeX0s / reservedW / bottomX0 —
 * existed so a click-time hit-test could re-derive where paint drew each control.
 * Since hit-map Release 2 renderPanel reports where each control actually drew
 * and paint publishes its regions there, so they are gone —
 * docs/mouse-hit-map.md.)
 *
 * Pure — no model/api/I/O.
 */
'use strict';

/** Does a left-anchored bottom control of visible width `visibleW` fit on a
 *  bottom border of inner width `innerW` (lead dash + control + ≥1 trailing)? */
function bottomFits(innerW, visibleW) {
  return innerW >= visibleW + 2;
}

module.exports = { bottomFits };
