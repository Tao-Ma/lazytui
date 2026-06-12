/**
 * Layout geometry — the pure(ish) math half of the render module.
 * (v0.6.4 Theme B: split out of `render/geometry.js`; the painting half
 * lives in `render/paint.js`; `render/geometry.js` is now a thin facade
 * re-exporting both. `panel/layout.js` still owns the arrange/focus/
 * viewMode slice.)
 *
 * Geometry as view-derived data (docs/v0.5-layering.md §5). Two
 * sources during the v0.6.3 P1 migration:
 *
 *   - `layoutSlice.paneBounds` — legacy per-panel `{x,y,w,h}` map
 *     written by renderNormal/Half/Full (in paint.js). Carries the
 *     viewer's tab-bar hit-test cache as `.tabs` on detail's entry.
 *     Retires when P1.4 lands (currently deferred — see
 *     docs/v0.6.3.md §Track A).
 *
 *   - `_currentLayout` — module-local Layout value `{rects, availH,
 *     viewMode, cols, rows}` published by calcLayout (P1.2). The
 *     `rects` array is the per-frame canonical geometry list.
 *
 * The `boundsFor(key)` accessor (P1.3) reads slice first, falls
 * through to `_currentLayout.rects` when slice is empty. Hit-test
 * consumers go through boundsFor; the per-panel height accessor
 * `getPanelViewportH(type)` is view-mode-aware (half/full view's
 * on-screen panel gets full availH, not its normal-view column-share)
 * — direct reads of the column-share height would silently under-
 * report in half/full view; the API hides that footgun (fix arc
 * 2026-06-03).
 *
 * This is the one pattern that sits outside the otherwise-uniform
 * "Component update is the single writer of its slice" rule. The
 * justification is layering: the geometry is a pure function of view
 * state (term size, arrange, viewMode) and would be wasteful to route
 * through a Msg every frame. Pure-TEA freeze tests on the layout slice
 * must whitelist these renderer-written fields.
 *
 * Zero npm dependencies (uses local modules).
 */
'use strict';

const { refreshSize, cols, rows } = require('../io/term');
const { allPanels } = require('../app/state');
const mpool = require('../leaves/pool');
const mpane = require('../leaves/pane');
const { getInstanceSlice } = require('../panel/api');
const { getModel } = require('../app/runtime');

// Lazy route handle — geometry-core is loaded inside the render module;
// requiring route at load time would close the layout ↔ render cycle.
// Mirrors paint.js#_route.
let _routeRef; const _route = () => (_routeRef ||= require('../panel/route'));

function distributeColumnHeights(panels, availH, isLastCol, minH, detailHeightPct) {
  const out = {};
  if (panels.length === 0) return out;

  // v0.6.4 — the height map is keyed by paneId so two same-type panes in
  // one column don't collide (the pre-v0.6.4 `out[p.type]` overwrote the
  // first with the second). Production panes always carry a `pane-*`
  // paneId; hand-built fixtures that omit it fall back to type (they're
  // single-instance, so no collision). calcLayout reads back with the
  // same key.
  const keyOf = (p) => p.paneId || p.type;

  // Collapsed placements get a hard 1-row reservation each. Their share
  // is subtracted from availH BEFORE detail/anchored/flex math so the
  // remaining height splits across the visible panels. detail can't be
  // collapsed (reducer guard), so this never overlaps the detail branch.
  let collapsedTotal = 0;
  for (const p of panels) {
    if (p.collapsed && p.type !== 'detail') {
      out[keyOf(p)] = 1;
      collapsedTotal += 1;
    }
  }
  const innerAvail = Math.max(minH, availH - collapsedTotal);

  let reserved = 0;
  let detailPanel = null;
  if (isLastCol) {
    detailPanel = panels.find(mpool.isDetailPane) || null;
    if (detailPanel) {
      // v0.6.4 — detail height is per-pane (`heightPct`, seeded by the
      // arrange rebuild from the layout default). Fall back to the scalar
      // arg for fixtures that build a detail pane without one. detail
      // stays "reserved" (protected from the anchored overflow-scale)
      // when it's the first detail in the column; additional detail panes
      // self-sized via the anchored heightPct path below.
      const detailPct = (typeof detailPanel.heightPct === 'number' && isFinite(detailPanel.heightPct))
        ? detailPanel.heightPct : detailHeightPct;
      reserved = Math.max(minH, Math.floor(innerAvail * detailPct / 100));
    }
  }

  const anchored = [];   // { p, h }
  const flex = [];       // panel
  let anchoredTotal = 0;
  for (const p of panels) {
    if (p === detailPanel) continue;
    if (p.collapsed) continue;  // already 1-row-reserved above
    if (typeof p.heightPct === 'number' && isFinite(p.heightPct)) {
      const h = Math.max(minH, Math.floor(innerAvail * p.heightPct / 100));
      anchored.push({ p, h });
      anchoredTotal += h;
    } else {
      flex.push(p);
    }
  }

  // If anchored + reserved + (flex × minH) > innerAvail, scale anchored
  // proportionally to the share they each claimed. Each panel still
  // floors at minH — if every anchored is at minH and the column
  // still overflows the terminal, the renderer truncates rather than
  // crashes.
  const flexMin = flex.length * minH;
  if (reserved + anchoredTotal + flexMin > innerAvail && anchoredTotal > 0) {
    const target = Math.max(0, innerAvail - reserved - flexMin);
    const scale = target / anchoredTotal;
    let allocated = 0;
    for (const a of anchored) {
      a.h = Math.max(minH, Math.floor(a.h * scale));
      allocated += a.h;
    }
    // Distribute slack rows (caused by flooring) to the largest panels
    // first so the visual ratios stay close to the requested split.
    let leftover = target - allocated;
    if (leftover > 0) {
      const sorted = anchored.slice().sort((a, b) => b.h - a.h);
      let i = 0;
      while (leftover > 0) { sorted[i % sorted.length].h++; leftover--; i++; }
    }
    anchoredTotal = anchored.reduce((s, a) => s + a.h, 0);
  }

  // Flex panels share whatever's left.
  const flexTotalH = Math.max(0, innerAvail - reserved - anchoredTotal);
  if (flex.length) {
    const baseH = Math.floor(flexTotalH / flex.length);
    flex.forEach((p, i) => {
      const h = i === flex.length - 1 ? flexTotalH - baseH * (flex.length - 1) : baseH;
      out[keyOf(p)] = Math.max(minH, h);
    });
  }
  for (const { p, h } of anchored) out[keyOf(p)] = h;
  if (detailPanel) out[keyOf(detailPanel)] = reserved;

  // Park rounding-leftover rows on the column's last non-collapsed
  // panel so the column exactly fills availH (matches the pre-heightPct
  // behavior and avoids a visually empty strip at the bottom). Collapsed
  // panels are locked at 1 row — never grow them with slack.
  let sum = 0;
  for (const p of panels) sum += out[keyOf(p)];
  if (sum < availH) {
    let lastVisible = null;
    for (let i = panels.length - 1; i >= 0; i--) {
      if (!panels[i].collapsed) { lastVisible = panels[i]; break; }
    }
    if (lastVisible) out[keyOf(lastVisible)] += availH - sum;
  }
  return out;
}

// v0.6.3 P1.2 — module-local Layout publication. calcLayout assigns
// at end of each pass; getCurrentLayout() exposes the most-recent
// Layout to hit-test consumers (mouse, drag math) that today read
// layoutSlice.paneBounds. The boundsFor() shim in P1.3 fronts both
// sources; P1.4 stops the slice write and this becomes the sole
// channel. Null pre-first-render — fallback callers must guard.
//
// v0.6.3 P1.5 — the module-local _panelHeights map (was the prior
// home for per-panel column-share heights) is retired in favor of
// _currentLayout.rects. Inside calcLayout the heights are now a
// function-local intermediate; getPanelViewportH and renderNormal
// read rects via boundsFor / the calcLayout return value.
let _currentLayout = null;

/**
 * Inner viewport rows for a panel's CURRENTLY-RENDERED height, view-
 * mode aware. The on-screen panel in half/full view occupies the full
 * `availH = max(6, rows - 1)` rows; otherwise the panel uses its
 * column-share read via `boundsFor(panelType)`. Border + bottom
 * border = 2 rows are subtracted, so the return is the content-row
 * count.
 *
 * Single source of truth for any scroll / page / wheel math that
 * needs "how many rows of content fit in this panel right now".
 * `boundsFor` prefers `slice.paneBounds[key]` (key = paneId; v0.6.4
 * retired the type-keyed write) then falls through
 * to `_currentLayout.rects` (post-P1.5 — the legacy `_panelHeights`
 * module-local was retired). Reading the column-share directly from
 * scroll code is a bug class because it under-reports in half/full
 * view (see fix arc 2026-06-03 around the GPDATA scroll report).
 *
 * Pre-first-render (layout slice empty + no `_currentLayout` yet),
 * returns a 1-row fallback so callers don't divide-by-zero.
 */
/**
 * Resolve the two panes a HALF view projects, as paneIds:
 *   { left: paneId, right: paneId | null }
 *
 * Half/full are runtime PROJECTIONS of the layout state (`arrange`), not
 * declared layouts. The selection is an ephemeral, API-settable override
 * (`slice.halfView = { left, right }`, set by the `view_place_pane` Msg);
 * when a slot is unset it falls back to the historical derivation, so a
 * config that never touches it is a strict no-op. The selection NEVER
 * mutates `arrange` and is not serialized.
 *
 * This is the SINGLE source of truth for "what does half view show" —
 * `renderHalf` (paint.js) and `getPanelViewportH` (below) both consume it,
 * replacing two derivations that previously had to agree but didn't (the
 * left-fallback chain differed). Either slot may hold ANY pane, including a
 * viewer, so two viewers can sit side-by-side.
 *
 * Defaults (the pre-override behavior): left = the focused non-detail pane,
 * else sticky `halfLeftPanel`, else the first non-detail pane, else the
 * focused pane; right = the major viewer (`resolveViewerPaneId`). A slot
 * pointing at a pane no longer in `arrange` falls back to its default. If
 * both slots resolve to the same pane the right slot collapses to null
 * (render left-only — matches the single-pane path).
 */
function halfProjection(layoutSlice) {
  const all = allPanels();
  const placed = (id) => !!id && all.some(p => p.paneId === id);
  const focus = layoutSlice.focus;

  // default-left — faithful to the historical renderHalf chain.
  const focusedPanel = all.find(p => mpane.paneMatchesFocus(p, focus)) || null;
  let defLeft = focusedPanel ? focusedPanel.paneId : null;
  if (focusedPanel && mpool.isDetailPane(focusedPanel)) {
    const lp = all.find(p => mpane.paneMatchesFocus(p, layoutSlice.halfLeftPanel))
            || all.find(p => !mpool.isDetailPane(p))
            || focusedPanel;
    defLeft = lp ? lp.paneId : null;
  }
  // default-right — the major viewer (focus-first → sticky lastViewerTab).
  const defRight = _route().resolveViewerPaneId() || null;

  const hv = layoutSlice.halfView || {};
  let left  = placed(hv.left)  ? hv.left  : defLeft;
  let right = placed(hv.right) ? hv.right : defRight;
  if (right && right === left) right = null;
  return { left, right };
}

function getPanelViewportH(paneId) {
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice) return 1;
  refreshSize();
  const availH = Math.max(6, rows() - 1);
  // Half/full view: an on-screen panel takes the full availH — beats any
  // stored height (paneBounds may carry a previous frame's bounds across
  // the viewMode-transition tick). Half view's two slots come from the
  // shared halfProjection so this agrees with renderHalf exactly; BOTH
  // projected panes are full-height (the right viewer too, not just left).
  const { viewMode, focus } = layoutSlice;
  let onScreen = false;
  if (viewMode === 'half') {
    const { left, right } = halfProjection(layoutSlice);
    onScreen = paneId === left || paneId === right;
  } else if (viewMode === 'full') {
    onScreen = paneId === focus;
  }
  if (onScreen) return Math.max(1, availH - 2);
  // Off-screen / normal-view: the pane's actual bounds, keyed by paneId
  // (boundsFor → slice.paneBounds[paneId], falling through to
  // _currentLayout.rects when the slice is empty).
  const b = boundsFor(layoutSlice, paneId);
  const h = (b && b.h) || 4;
  return Math.max(1, h - 2);
}

function calcLayout(model = getModel()) {
  refreshSize();
  const COLS = cols(), ROWS = rows();
  const layoutSlice = getInstanceSlice('layout');

  const columns = layoutSlice.arrange.columns || [];
  const ranges = mpool.distributeColumnWidths(layoutSlice.arrange, COLS);
  const lastIdx = columns.length - 1;
  // Only the footer is reserved at the bottom; panels fill everything
  // else. The yank register surfaces via the `"` popup, not an
  // always-on chrome strip (retired v0.6).
  const availH = Math.max(6, ROWS - 1);
  // Minimum panel height: 3 rows (border + 1 content line)
  const minH = 3;

  // v0.6.3 P1.5 — heights map is now function-local (was module-local
  // `_panelHeights`). Single use: build the Rect list below; nobody
  // else reads it.
  const heights = {};
  const detailHeightPct = layoutSlice.arrange.detailHeightPct;
  for (let ci = 0; ci < columns.length; ci++) {
    const colHeights = distributeColumnHeights(
      columns[ci].panels || [], availH, ci === lastIdx, minH, detailHeightPct);
    Object.assign(heights, colHeights);
  }
  // (v0.6.4 — the prior `if (!('detail' in heights))` synthesis was
  // dropped: `heights` is keyed by paneId now and is function-local, read
  // back only by the rect loop below via each pane's own key. An unplaced
  // detail has no rect to read it, so synthesizing the entry was dead.)

  // v0.6.3 P1.1 — build the Layout value. Each Rect carries the
  // column-view geometry for one placed pane (x, y, w, h, paneId,
  // type, collapsed). Computed by walking each column's panels and
  // accumulating y per the per-panel heights just distributed.
  //
  // `viewMode` reflects the active mode for completeness, but in
  // half/full the Rect list still describes the normal column layout
  // — renderHalf/Full override with their own single-panel bounds.
  // Unification of the rect list across view modes lands in P3
  // (composeRects).
  const rects = [];
  for (let ci = 0; ci < columns.length; ci++) {
    const r = ranges[ci];
    if (!r) continue;
    const colPanels = mpool.columnPanels(layoutSlice.arrange, ci);
    let y = 0;
    for (const p of colPanels) {
      const h = heights[p.paneId || p.type] || 0;
      rects.push({
        paneId: p.paneId,
        type: p.type,
        x: r.x, y, w: r.w, h,
        collapsed: !!p.collapsed,
      });
      y += h;
    }
  }

  // P1.5 — publish _currentLayout BEFORE the scroll-clamp loop so
  // getPanelViewportH (which reads via boundsFor → _currentLayout
  // when no slice fallback) sees this frame's rects, not the prior
  // frame's. Pre-P1.5 the loop read _panelHeights directly from the
  // module-local; the reorder is a no-op for the slice-write fallback
  // path but plugs the hole once that fallback retires.
  _currentLayout = {
    rects, availH,
    viewMode: layoutSlice.viewMode, cols: COLS, rows: ROWS,
  };

  // (wm-geometry P1.1 — the per-pane scroll-clamp loop that lived here
  // moved to paint.js#_syncScrollClamp, called right after calcLayout in
  // all three view modes. Layout math no longer dispatches Msgs.)

  return {
    ranges, availH,
    rects, viewMode: layoutSlice.viewMode, cols: COLS, rows: ROWS,
  };
}

/**
 * v0.6.3 P1.2 — read the most-recent Layout. Null before the first
 * calcLayout pass (test fixtures that seed `layoutSlice.paneBounds`
 * directly without a render pass get null here; boundsFor() in P1.3
 * handles the fallback). Treat as read-only; the renderer is the
 * single writer.
 */
function getCurrentLayout() {
  return _currentLayout;
}

/**
 * v0.6.3 P1.3 — single accessor for "the rect at <key>", where <key>
 * is a paneId, a panel type, or 'detail'. Bridges the two geometry
 * sources during the P1 migration:
 *
 *   1. `_currentLayout.rects` — the per-frame Rect list produced by
 *      calcLayout (P1.1). Preferred source.
 *   2. `layoutSlice.paneBounds[key]` — legacy slice write produced
 *      by renderNormal/Half/Full. Used as fallback when no Layout
 *      has been published yet (pre-first-render boot edge; tests
 *      that seed bounds without calling render).
 *
 * v0.6.3 P4.1 — tabBounds cache moved off layoutSlice.paneBounds.detail.tabs
 * onto the viewer's own slice. Hit-test consumers read it directly
 * via `getInstanceSlice(_route().resolveTarget('viewer') || 'detail').tabBounds`; boundsFor() no longer
 * surfaces tabs.
 */
function boundsFor(layoutSlice, key) {
  const sliceBounds = layoutSlice && layoutSlice.paneBounds && layoutSlice.paneBounds[key];
  // P1.3 priority: slice first. Production still writes paneBounds
  // every frame, but v0.6.4 re-keyed those writes by paneId (was by
  // type) — so the originally-planned P1.4 "stop the slice writes,
  // fall through to rects" never happened; the writes were migrated,
  // not retired. The rect path below remains the fallback for the
  // pre-first-render boot edge and for tests that seed paneBounds
  // without rendering.
  if (sliceBounds) return sliceBounds;
  if (_currentLayout && _currentLayout.rects) {
    const rect = _currentLayout.rects.find(r => r.paneId === key || r.type === key);
    if (rect) return rect;
  }
  return null;
}

/** Bounds for a CURRENTLY-VISIBLE pane only — half/full view drops
 *  off-screen panes from layoutSlice.paneBounds, so callers that
 *  need "where the user can actually click this pane" want this
 *  variant. boundsFor() in contrast also reports normal-view
 *  geometry for off-screen panes (used by getPanelViewportH for
 *  scroll-viewport clamping). The split prevents half-mode click
 *  hit-tests from firing on a non-visible pane's phantom rect. */
function visibleBoundsFor(layoutSlice, key) {
  return (layoutSlice && layoutSlice.paneBounds && layoutSlice.paneBounds[key]) || null;
}

module.exports = {
  distributeColumnHeights, getPanelViewportH, calcLayout,
  getCurrentLayout, boundsFor, visibleBoundsFor, halfProjection,
  // Test seam: distributeColumnHeights is a pure function that returns
  // a { [type]: rows } map. Exposed so collapsed-honor + heightPct
  // math can be unit-tested without bringing up the whole runtime.
  _distributeColumnHeights: distributeColumnHeights,
  // Test seam: a {[type]: rows} map derived from _currentLayout.rects
  // (the column-share heights calcLayout last produced). NOT for
  // production use — production callers go through
  // `getPanelViewportH(type)` which is view-mode-aware. Exists so
  // tests can assert calcLayout's column distribution math directly.
  //
  // v0.6.3 P1.5 — was a copy of the now-retired _panelHeights module-
  // local; rebuilt per-call from rects to preserve the same shape.
  _getPanelHeights: () => {
    if (!_currentLayout || !_currentLayout.rects) return {};
    const m = {};
    for (const r of _currentLayout.rects) m[r.type] = r.h;
    return m;
  },
};
