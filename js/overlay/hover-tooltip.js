/**
 * Hover-tooltip overlay — the small tooltip that floats above a graph
 * pane's current hover cell, showing the resolved value for that cell.
 * Factored out of `js/render/paint.js` as the final overlay migration
 * in overlay-compositor Release 3 (docs/overlay-compositor-migration.md
 * §Release 3).
 *
 * UNUSUAL among overlays: it's NOT mode-flagged. The tooltip paints
 * iff:
 *   1. no modal is active (same invariant paint.js enforced before),
 *   2. `hoverRegion.get()` returns a record with a non-empty `text`.
 *
 * `hoverRegion` is populated during the pane pass by `stats.render`
 * (the only owner of graph geometry, which resolves the layout slice's
 * raw hover position to a value for ITS paneId). The footer + this
 * tooltip BOTH read the same per-frame single-slot registry so what
 * the graph drew, what the footer labels, and what this tooltip
 * shows all agree. See `js/panel/hover-region.js`.
 *
 * zIndex=999 — floats over EVERY other overlay. The modal gate keeps
 * it from drawing when a modal is up (otherwise it would paint over
 * confirm/menu/etc. — the pre-migration invariant was the same).
 */
'use strict';

const hoverRegion = require('../panel/hover-region');
const modes = require('../leaves/input/modes');
const { renderOverlay } = require('../leaves/render/draw');
const { esc } = require('../leaves/text/ansi');

function _hv(model) {
  const md = (model && model.modes) || {};
  if (modes.isModal(md)) return null;
  const hv = hoverRegion.get();
  if (!hv || !hv.text) return null;
  return hv;
}

/**
 * Composite the hover tooltip into `newRows` at `cols` width. Called
 * by the compositor's descriptor render fn. No-op if the model's
 * modes are modal or no hover is published.
 */
function render(model, newRows, cols) {
  const hv = _hv(model);
  if (!hv) return;
  // esc() the resolved text (matches the footer) — it may carry user
  // data (a mode:multi row label like `[kworker/0]`) whose `[` would
  // else read as markup.
  renderOverlay({
    lines: [`[accent]${esc(hv.text)}[/]`],
    anchor: { x: hv.x, y: hv.y + 1 },
    maxWidth: Math.min(60, hv.text.length + 4),
    targetRows: newRows,
    targetCols: cols,
  });
}

/**
 * Overlay-compositor R3 descriptor. zIndex=999 so the tooltip floats
 * over EVERY other overlay (preserves the pre-migration "painted LAST"
 * invariant). Non-modal; the modal suppression lives inside `isActive`.
 */
function registerSelf(compositor) {
  compositor.register({
    id: 'hover-tooltip',
    isActive: (m) => !!_hv(m),
    render,
    modal: false,
    zIndex: 999,
  });
}

module.exports = { render, registerSelf };
