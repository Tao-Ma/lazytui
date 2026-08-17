/**
 * Per-frame registry of the ACTUALLY-DRAWN clickable border chrome, keyed by
 * paneId. The paint path publishes each pane's drawn glyph ranges here — from the
 * one place that knows the real title + the all-or-nothing `fits` drop
 * (leaves/render/draw.renderPanel for expanded panes, render/paint._renderCollapsed
 * for collapsed ones) — and the hit-tests READ it instead of re-deriving presence
 * from a width proxy.
 *
 * This is the paint↔hit-test agreement fix (docs reference_paint_hittest_agreement)
 * for the narrow-pane PHANTOM HIT: on a narrow pane renderPanel drops chrome — the
 * whole `[≡]`/`[X]`/`[_]` cluster when the top row can't fit (`fits`), AND the
 * left-anchored `[≡]` on its own when `leftPart` truncation clips it (independent
 * of `fits` — a long title or a border-control strip). The old hit-tests gated on
 * static width floors (`*_MIN_W`, a `triggerX` proxy) that saw neither, so a narrow
 * pane reported a hit where nothing was drawn. Each glyph is published here ONLY
 * where it actually painted (right-anchored close/collapse follow `fits`; the
 * trigger carries its own truncation-survival check), so a dropped/clipped glyph
 * leaves null here → the click finds nothing.
 *
 * Coordinates are PANE-LOCAL columns (0-based, inclusive); the reader adds the
 * pane's screen origin (visibleBoundsFor .x) before comparing to a click. Every
 * chrome glyph sits on the pane's TOP row (pane-local y 0 → screen b.y), so no row
 * is stored. Cleared at the top of each main-frame paint and repopulated in the
 * same synchronous pass, so a hit-test between frames reads exactly the last
 * frame's on-screen chrome (empty before the first paint → every hit-test null).
 */
'use strict';

// paneId -> { trigger: {x0,x1}|null, close: {x0,x1}|null, collapse: {x0,x1}|null }
const _regions = new Map();

/** Drop everything. Called once at the top of every main-frame paint. */
function clear() { _regions.clear(); }

/** Record a pane's drawn chrome (pane-local ranges; null glyph = not drawn).
 *  A null/absent paneId (an overlay's renderPanel, a direct/unit caller with no
 *  ambient pane) is ignored — only placed panes register. */
function publish(paneId, region) {
  if (paneId) _regions.set(paneId, region);
}

/** The drawn-chrome record for a pane this frame, or null if it didn't render
 *  (off-screen in half/full, or before the first paint). */
function get(paneId) {
  return (paneId && _regions.get(paneId)) || null;
}

// Test/introspection only.
function _size() { return _regions.size; }

module.exports = { clear, publish, get, _size };
