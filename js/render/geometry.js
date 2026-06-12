/**
 * Render module facade. (v0.6.4 Theme B: `render/layout.js` was renamed
 * to `render/geometry.js` to kill the dir-twin with `panel/layout.js`,
 * then split into two cohesive halves — this file is now the public
 * entry that re-exports both so the ~30 `require('../render/geometry')`
 * call sites are unchanged.)
 *
 *   - `render/geometry-core.js` — the layout math: calcLayout, the
 *     `_currentLayout` publication, and the hit-test accessors
 *     (boundsFor / visibleBoundsFor / getPanelViewportH /
 *     getCurrentLayout). No dependency on paint.
 *   - `render/paint.js` — the per-frame paint: renderNormal/Half/Full,
 *     Rect compositing + diff cache, panel chrome, terminal overlay,
 *     and `render()` itself. Depends on geometry-core (one direction).
 *   - `render/footer.js` — the bottom footer row (renderFooter).
 *
 * `panel/layout.js` (a different file) owns the arrange/focus/viewMode
 * Component slice.
 */
'use strict';

const core = require('./geometry-core');
const paint = require('./paint');
const { renderFooter } = require('./footer');

module.exports = {
  // Paint
  render: paint.render,
  redraw: paint.redraw,
  renderTerminalOverlay: paint.renderTerminalOverlay,
  forceFullRepaint: paint.forceFullRepaint,
  invalidateRows: paint.invalidateRows,
  _normalizeRender: paint._normalizeRender,
  // Footer
  renderFooter,
  // Geometry math + hit-test accessors
  calcLayout: core.calcLayout,
  getPanelViewportH: core.getPanelViewportH,
  getCurrentLayout: core.getCurrentLayout,
  boundsFor: core.boundsFor,
  visibleBoundsFor: core.visibleBoundsFor,
  halfProjection: core.halfProjection,
  // Test seams
  _distributeColumnHeights: core._distributeColumnHeights,
  _getPanelHeights: core._getPanelHeights,
};
