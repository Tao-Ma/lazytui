/**
 * Shared per-pane viewport height (U2c P0, docs/one-tab-system.md).
 *
 * The pane's inner content height, computed in the impure dispatch shell so a
 * Component's reducer reads it as a stamped Msg fact (`msg.innerH`) via its
 * `augmentMsg` hook rather than from a finalizer-written slice field (v0.6.6
 * FIX-2, retiring blessed-exception B). Extracted from the viewer so the viewer
 * AND any minted `text-view` instance share ONE implementation — the two can't
 * drift, which matters because an off-tab (background-streaming) text-view must
 * clamp scroll against its CONTAINER slot's height, not the innerH=1 fallback.
 *
 * Per-pane via the slice's own (column) paneId, falling back to the resolved
 * primary viewer for the singleton. Returns 0 when geometry is unavailable
 * (pre-boot / no layout) → augmentMsg leaves msg.innerH unset and the slice
 * fallback (1) wins.
 */
'use strict';

// Lazy requires keep the panel-layer edges cycle-safe (deferred, like the rest
// of panel/).
let _routeRef, _geoRef;
function paneInnerH(slice) {
  const route = (_routeRef || (_routeRef = require('./route')));
  const geo = (_geoRef || (_geoRef = require('../leaves/wm/geometry')));
  const ls = route.serviceSlice('layout');
  if (!ls || !ls.dims) return 0;
  const viewerPaneId = route.resolveViewerPaneId();
  const paneId = (slice && slice.paneId) || viewerPaneId;
  if (!paneId) return 0;
  // `undefined` = no precomputed-layout override. On-screen panes (half/full
  // view — the interactive case) get a fresh `availH-2` directly. An OFF-screen
  // pane in normal multi-column view reads boundsFor→_currentLayout, which lags
  // one dispatch during a resize. Accepted by design (v0.6.6 pre-release review,
  // RISK): that pane isn't visible and the next dispatch corrects it; threading
  // a fresh layout here would mean a calcLayout on every Msg (a hot path) to fix
  // an invisible frame.
  return geo.getPanelViewportH(ls, paneId, ls.dims, undefined, viewerPaneId) || 0;
}

module.exports = { paneInnerH };
