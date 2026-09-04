/**
 * Pane bounds (blessed-exceptions Phase A.2; field deleted by #D7 2026-06-18)
 * — bounds are a PURE DERIVED value, not a render-side write, and there is no
 * `slice.paneBounds` production field at all. A real render adds none;
 * `visibleBoundsFor` / `boundsFor` compute the answer via the memoized
 * selector (leaves/selector.js) from (arrange, dims, viewMode).
 *
 * Two accessors, two roles:
 *   - `visibleBoundsFor(paneId)` — the CURRENTLY-VISIBLE pane's bounds, view-
 *     mode-aware (normal column rect / full screen / half slot); null for an
 *     off-screen pane. The hit-test + overlay-positioning accessor.
 *   - `boundsFor(paneId)` — NORMAL-view geometry even for off-screen panes
 *     (getPanelViewportH's scroll-clamp source). Stays the column rect in
 *     half/full (getPanelViewportH handles the on-screen full-height case
 *     before it ever calls boundsFor).
 *
 * Both are keyed by CONTAINER paneId (resolveViewerPaneId bridges the viewer
 * tab-id → its hosting paneId); a bare type key resolves to null. Regression
 * guard for the full/half "small normal-layout rect leaks through" bug and
 * for render accidentally resurrecting a paneBounds slice write.
 *
 * Run: node js/test/test-viewer-pane-bounds.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const geo = require('../leaves/wm/geometry');
const { getInstanceSlice } = require('../panel/api');

function renderIn(viewMode, focus) {
  sm.bootFresh();
  const layout = getInstanceSlice('layout');
  layout.viewMode = viewMode;
  if (focus) layout.focus = focus;
  sm.capture(() => sm.render());
  return layout;
}

describe('A.2 paneBounds is DERIVED, not a render write', () => {
  it('a real render adds NO slice.paneBounds (bounds are derived)', () => {
    const layout = renderIn('normal', 'pane-groups');
    // #D7 2026-06-18 — paneBounds is no longer a production slice field at all
    // (was retired as a render-write by A.2; the field itself is now gone). A
    // real render must not resurrect it; the geometry accessors derive instead.
    eq(layout.paneBounds, undefined,
      'render does not write paneBounds, and it is not a production field');
  });

  it('the derived bounds are keyed by container paneId; a bare type key → null', () => {
    const layout = renderIn('normal', 'pane-groups');
    assert(geo.visibleBoundsFor(layout, 'pane-detail'), 'container paneId resolves');
    eq(geo.visibleBoundsFor(layout, 'detail'), null, 'no bare type key (detail)');
    eq(geo.visibleBoundsFor(layout, 'groups'), null, 'no bare type key (groups)');
  });

  it("resolveViewerPaneId() returns the viewer's CONTAINER paneId", () => {
    renderIn('normal', 'pane-groups');
    eq(route.resolveViewerPaneId(), 'pane-detail');
  });
});

describe('visibleBoundsFor tracks the VISIBLE pane per view mode (derived)', () => {
  it('normal: the column-positioned detail rect', () => {
    const layout = renderIn('normal', 'pane-groups');
    const b = geo.visibleBoundsFor(layout, route.resolveViewerPaneId());
    assert(b, 'bounds resolved');
    assert(b.x > 0, `right-column x (saw x=${b.x})`);
  });

  it('full (focus detail): bounds fill the screen — NOT the small normal rect', () => {
    const layout = renderIn('full', 'pane-detail');
    const b = geo.visibleBoundsFor(layout, route.resolveViewerPaneId());
    assert(b, 'bounds resolved');
    eq(b.x, 0);
    eq(b.y, 0);
    // Full-screen width spans the whole terminal — wider than a column.
    assert(b.w >= 40, `full width (saw w=${b.w})`);
  });

  it('half (focus detail): bounds are the right half at full height', () => {
    const layout = renderIn('half', 'pane-detail');
    // Half view: the caller threads viewerPaneId so the right (viewer) slot
    // resolves — the leaf can't reach route.resolveViewerPaneId() (§3). This
    // mirrors how paint.js / layout.js / input.js call it.
    const b = geo.visibleBoundsFor(layout, route.resolveViewerPaneId(), route.resolveViewerPaneId());
    assert(b, 'bounds resolved');
    assert(b.x > 0, `right half starts past mid-screen (saw x=${b.x})`);
    assert(b.y === 0, 'spans from top');
  });
});

describe('B8(c) — the availH floor agrees between viewport + painted bounds on a ≤6-row terminal', () => {
  // On a tiny terminal (rows-1 < 6) the availH floor (max(6, rows-1)) engages.
  // getPanelViewportH floored while the half/full bounds maps used RAW rows-1 —
  // so the scroll/hit-test viewport disagreed with the painted pane height. Both
  // read geo.availRows now (the single source), so they agree at any size.
  function assertAgree(viewMode) {
    sm.bootFresh();
    sm.resize(40, 5);   // rows-1 = 4 < 6 → the floor engages
    const layout = getInstanceSlice('layout');
    layout.viewMode = viewMode;
    layout.focus = 'pane-detail';
    sm.capture(() => sm.render());
    const pid = route.resolveViewerPaneId();
    const b = geo.visibleBoundsFor(layout, pid, pid);
    assert(b, `${viewMode}: onscreen bounds resolved`);
    eq(b.h, geo.availRows(layout.dims),
      `${viewMode}: painted pane height uses the floored availH max(6,rows-1)=${geo.availRows(layout.dims)} (saw ${b.h})`);
    const vh = geo.getPanelViewportH(layout, pid, layout.dims, null, pid);
    eq(vh, b.h - 2,
      `${viewMode}: getPanelViewportH (scroll/hit-test viewport ${vh}) == painted inner height ${b.h - 2} — no ≤6-row drift`);
  }
  it('full view: viewport height matches painted bounds', () => assertAgree('full'));
  it('half view: viewport height matches painted bounds', () => assertAgree('half'));
});

describe('boundsFor reports NORMAL geometry (the off-screen scroll-clamp accessor)', () => {
  it('full mode: boundsFor returns the normal column rect, not the full-screen one', () => {
    const layout = renderIn('full', 'pane-detail');
    const b = geo.boundsFor(layout, route.resolveViewerPaneId());
    assert(b, 'bounds resolved');
    // getPanelViewportH handles the on-screen full-height case before ever
    // calling boundsFor, so boundsFor staying normal-geometry is correct.
    assert(b.x > 0, `normal column x, not full-screen 0 (saw x=${b.x})`);
  });
});

report();
