/**
 * Layout geometry — the WM spatial model: pure layout math, no paint.
 * (v0.6.4 Theme B split this out of the old `render/geometry.js`
 * god-file as `render/geometry-core.js`; the painting half lives in
 * `render/paint.js`. wm-geo P2 deleted the thin facade that re-exported
 * both, and P3 re-homed this file to `leaves/` — its dependency
 * fingerprint (pool/pane only, zero render/overlay imports) is a WM
 * primitive's, not a view's. Math consumers import this module
 * directly, paint consumers import `render/paint`. `panel/layout.js`
 * still owns the arrange/focus/viewMode slice.)
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

// wm-geo P1.2/P1.3 (docs/wm-geometry-refactor.md) — this module is a
// pure spatial model: every reader takes the layout slice (and, where
// screen size matters, a `{cols, rows}` dims value — io/term.dims())
// explicitly. No app/state, no panel/api, no panel/route, no app/runtime,
// no io/term: the impure fetches live at the call sites, which already
// had them. v0.6.5 §3 — the last reach (route.resolveViewerPaneId for
// halfProjection's default-right slot) was retired by threading the
// resolved viewer paneId in as an argument; this leaf now imports only
// sibling leaves.
const mpool = require('./pool');
const mpane = require('./pane');
const { createSelector } = require('./selector');

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
 * focused pane; right = the major viewer, passed in as `viewerPaneId`
 * (callers resolve it via `route.resolveViewerPaneId()` — kept out of this
 * leaf, v0.6.5 §3). A slot pointing at a pane no longer in `arrange` falls
 * back to its default. If both slots resolve to the same pane the right
 * slot collapses to null (render left-only — matches the single-pane path).
 */
function halfProjection(layoutSlice, viewerPaneId) {
  const all = layoutSlice.arrange
    ? mpool.allPanesInColumns(layoutSlice.arrange) : [];
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
  // default-right — the major viewer (focus-first → sticky lastViewerTab),
  // resolved by the caller and threaded in (this leaf does not reach route).
  const defRight = viewerPaneId || null;

  const hv = layoutSlice.halfView || {};
  let left  = placed(hv.left)  ? hv.left  : defLeft;
  let right = placed(hv.right) ? hv.right : defRight;
  if (right && right === left) right = null;
  return { left, right };
}

function getPanelViewportH(layoutSlice, paneId, dims, layout) {
  if (!layoutSlice) return 1;
  const availH = Math.max(6, dims.rows - 1);
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
  // resize-as-Msg P2 — optional precomputed-Layout override. The
  // dispatch finalizer judges against the rects it JUST computed:
  // at dispatch time slice.paneBounds still holds the last render's
  // write (the same staleness class as the resize clamp lag fixed on
  // the render side in 8eea6e9). Callers without a fresh Layout omit
  // the param and keep the boundsFor path below.
  if (layout && layout.rects) {
    const rect = layout.rects.find(r => r.paneId === paneId);
    if (rect) return Math.max(1, (rect.h || 4) - 2);
  }
  // Off-screen / normal-view: the pane's actual bounds, keyed by paneId
  // (boundsFor → slice.paneBounds[paneId], falling through to
  // _currentLayout.rects when the slice is empty).
  const b = boundsFor(layoutSlice, paneId);
  const h = (b && b.h) || 4;
  return Math.max(1, h - 2);
}

// Pure normal-column layout: (arrange, dims) → {ranges, availH, rects,
// cols, rows}. NO side effects (does not publish _currentLayout, does not
// touch any slice). calcLayout wraps this with the _currentLayout publish;
// the paneBounds selector (Phase A.2) consumes it directly so production
// bounds are a pure derived value, not a render-side write.
function _layoutRects(arrange, dims) {
  const COLS = dims.cols, ROWS = dims.rows;
  const columns = arrange.columns || [];
  const ranges = mpool.distributeColumnWidths(arrange, COLS);
  const lastIdx = columns.length - 1;
  // Only the footer is reserved at the bottom; panels fill everything
  // else. The yank register surfaces via the `"` popup, not an
  // always-on chrome strip (retired v0.6).
  const availH = Math.max(6, ROWS - 1);
  // Minimum panel height: 3 rows (border + 1 content line)
  const minH = 3;

  const heights = {};
  const detailHeightPct = arrange.detailHeightPct;
  for (let ci = 0; ci < columns.length; ci++) {
    const colHeights = distributeColumnHeights(
      columns[ci].panels || [], availH, ci === lastIdx, minH, detailHeightPct);
    Object.assign(heights, colHeights);
  }

  // Each Rect carries the column-view geometry for one placed pane (x, y,
  // w, h, paneId, type, collapsed). half/full views describe their own
  // single/double-pane bounds via _halfBoundsMap / _fullBoundsMap below;
  // this rect list is always the NORMAL column layout.
  const rects = [];
  for (let ci = 0; ci < columns.length; ci++) {
    const r = ranges[ci];
    if (!r) continue;
    const colPanels = mpool.columnPanels(arrange, ci);
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
  return { ranges, availH, rects, cols: COLS, rows: ROWS };
}

function calcLayout(layoutSlice, dims, opts) {
  // blessed-exceptions Phase B — the drag-preview arrange is passed AS A
  // PARAMETER, not by swapping `layoutSlice.arrange` in place. Absent
  // override → the real arrange (no-op).
  const arrange = (opts && opts.arrangeOverride) || layoutSlice.arrange;
  const lr = _layoutRects(arrange, dims);

  // P1.5 — publish _currentLayout so getPanelViewportH / boundsFor have a
  // last-resort source at the pre-first-dims boot edge. (Production bounds
  // now derive from the pure selector below; this stays for the boot edge +
  // getCurrentLayout() consumers.)
  _currentLayout = {
    rects: lr.rects, availH: lr.availH,
    viewMode: layoutSlice.viewMode, cols: lr.cols, rows: lr.rows,
  };

  return {
    ranges: lr.ranges, availH: lr.availH,
    rects: lr.rects, viewMode: layoutSlice.viewMode, cols: lr.cols, rows: lr.rows,
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

// blessed-exceptions Phase A.2 — pane bounds are a PURE DERIVED value, no
// longer a render-side write. The map keyed by paneId is computed from
// (arrange, dims) and memoized via the shared selector model (leaves/
// selector.js). `layoutSlice.paneBounds` survives ONLY as a seed/override
// input (boot edge + test fixtures seed it directly); production never
// writes it, so when absent these accessors compute the value.
//
// Normal view = the column layout (memoized; the hot per-pane hit-test +
// per-row decor loops hit it). Half/full = the visible single/double-pane
// projection (cheap, recomputed — few panes, called rarely).
const _normalBoundsMap = createSelector(
  (layoutSlice) => [layoutSlice.arrange, layoutSlice.dims],
  (arrange, dims) => {
    const m = {};
    for (const r of _layoutRects(arrange, dims).rects) {
      if (r.paneId) m[r.paneId] = { x: r.x, y: r.y, w: r.w, h: r.h };
    }
    return m;
  });

// Half view: two slots from halfProjection (mirrors renderHalf exactly —
// leftPanel = projected-left-or-focused, detailPanel = projected-right).
// No focused pane → renderHalf falls back to renderNormal, so do we.
function _halfBoundsMap(layoutSlice) {
  const dims = layoutSlice.dims;
  const COLS = dims.cols, ROWS = dims.rows;
  const all = mpool.allPanesInColumns(layoutSlice.arrange);
  const focusedPanel = all.find(p => mpane.paneMatchesFocus(p, layoutSlice.focus));
  if (!focusedPanel) return _normalBoundsMap(layoutSlice);
  const halfW = Math.floor(COLS / 2), availH = ROWS - 1;
  const proj = halfProjection(layoutSlice);
  const leftPanel = (proj.left && all.find(p => p.paneId === proj.left)) || focusedPanel;
  const detailPanel = proj.right ? all.find(p => p.paneId === proj.right) || null : null;
  const m = {};
  if (leftPanel.paneId) m[leftPanel.paneId] = { x: 0, y: 0, w: halfW, h: availH };
  if (detailPanel && detailPanel.paneId) {
    m[detailPanel.paneId] = { x: halfW, y: 0, w: COLS - halfW, h: availH };
  }
  return m;
}

// Full view: the focused pane fills the screen (mirrors renderFull); no
// focused pane → renderNormal fallback.
function _fullBoundsMap(layoutSlice) {
  const dims = layoutSlice.dims;
  const all = mpool.allPanesInColumns(layoutSlice.arrange);
  const focusedPanel = all.find(p => mpane.paneMatchesFocus(p, layoutSlice.focus));
  if (!focusedPanel) return _normalBoundsMap(layoutSlice);
  const m = {};
  if (focusedPanel.paneId) {
    m[focusedPanel.paneId] = { x: 0, y: 0, w: dims.cols, h: dims.rows - 1 };
  }
  return m;
}

// The full visible-bounds map for the current view mode.
function _visibleBoundsMap(layoutSlice) {
  const vm = layoutSlice.viewMode;
  if (vm === 'half') return _halfBoundsMap(layoutSlice);
  if (vm === 'full') return _fullBoundsMap(layoutSlice);
  return _normalBoundsMap(layoutSlice);
}

/**
 * The rect at <key> (paneId, type, or 'detail'), reporting NORMAL-view
 * geometry even for off-screen panes — used by getPanelViewportH for
 * scroll-viewport clamping. Seed/override (layoutSlice.paneBounds) wins;
 * else the memoized normal selector; else the last published _currentLayout
 * (pre-first-dims boot edge + type-key matching).
 */
function boundsFor(layoutSlice, key) {
  const seed = layoutSlice && layoutSlice.paneBounds && layoutSlice.paneBounds[key];
  if (seed) return seed;
  if (layoutSlice && layoutSlice.dims && layoutSlice.arrange) {
    const rect = _normalBoundsMap(layoutSlice)[key];
    if (rect) return rect;
  }
  if (_currentLayout && _currentLayout.rects) {
    const rect = _currentLayout.rects.find(r => r.paneId === key || r.type === key);
    if (rect) return rect;
  }
  return null;
}

/** Bounds for a CURRENTLY-VISIBLE pane only — half/full view drops
 *  off-screen panes, so callers that need "where the user can actually
 *  click this pane" want this variant (boundsFor() in contrast reports
 *  normal-view geometry for off-screen panes too). Prevents half-mode
 *  click hit-tests from firing on a non-visible pane's phantom rect.
 *  Seed/override wins; else the view-mode-aware visible map. */
function visibleBoundsFor(layoutSlice, key) {
  if (!layoutSlice) return null;
  const seed = layoutSlice.paneBounds && layoutSlice.paneBounds[key];
  if (seed) return seed;
  if (!layoutSlice.dims || !layoutSlice.arrange) return null;
  return _visibleBoundsMap(layoutSlice)[key] || null;
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
