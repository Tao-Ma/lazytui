/**
 * Per-frame registry of the ACTUALLY-DRAWN clickable TREE FOLD MARKERS (the
 * `▾`/`▸` expand glyphs a `table` in tree mode prefixes onto foldable rows),
 * keyed by paneId. The sibling of panel/chrome-regions: same paint↔hit-test
 * agreement discipline (docs reference_paint_hittest_agreement), but for
 * PER-ROW content glyphs rather than the single top-row border chrome.
 *
 * Why a second registry and not chrome-regions: a fold marker is not border
 * chrome — there is one per foldable row, at a DEPTH-dependent column, on a DATA
 * row (not the top border). chrome-regions stores one fixed-slot record per pane
 * on row 0; this stores a LIST of `{y, x0, x1, id}` per pane.
 *
 * The table's render (panel/monitor/table.render) publishes a marker region ONLY
 * for a row that (a) has children — so it drew a glyph at all — and (b) whose
 * marker survived the identity-column truncation (a deep row can push the glyph
 * past the column; a clipped glyph publishes nothing, so the click finds nothing).
 * The hit-test (panel/chrome-hittest.hitTestTreeMarker) reads it, adds the pane's
 * screen origin, and returns the node id under the cursor.
 *
 * Coordinates are PANE-LOCAL (0-based, inclusive): x is the column from the pane's
 * left border, y the row from the pane's top border (the reader adds the pane's
 * screen origin .x/.y). Cleared at the top of each main-frame paint and
 * repopulated in the same synchronous pass, so a hit-test between frames reads
 * exactly the last frame's on-screen markers (empty before the first paint, and
 * a pane that left tree mode / went off-screen leaves no stale region → null).
 */
'use strict';

// paneId -> [ { y, x0, x1, id } ]   (pane-local cells; y/x0/x1 inclusive)
const _regions = new Map();

/** Drop everything. Called once at the top of every main-frame paint. */
function clear() { _regions.clear(); }

/** Record a pane's drawn fold markers (pane-local ranges). An empty list clears
 *  the pane's entry (a tree that folded down to no foldable visible row). A
 *  null/absent paneId (an overlay/unit caller with no ambient pane) is ignored. */
function publish(paneId, markers) {
  if (!paneId) return;
  if (markers && markers.length) _regions.set(paneId, markers);
  else _regions.delete(paneId);
}

/** The drawn markers for a pane this frame (array), or null if none. */
function get(paneId) {
  return (paneId && _regions.get(paneId)) || null;
}

module.exports = { clear, publish, get };
