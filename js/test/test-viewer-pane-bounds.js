/**
 * Pane bounds (blessed-exceptions Phase A.2) — bounds are a PURE DERIVED
 * value, not a render-side write. A real render leaves `slice.paneBounds`
 * EMPTY; `visibleBoundsFor` / `boundsFor` compute the answer via the
 * memoized selector (leaves/selector.js) from (arrange, dims, viewMode).
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
 * for render accidentally resuming paneBounds writes.
 *
 * Run: node js/test/test-viewer-pane-bounds.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const geo = require('../leaves/geometry');
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
  it('a real render leaves slice.paneBounds EMPTY (bounds are derived)', () => {
    const layout = renderIn('normal', 'pane-groups');
    eq(Object.keys(layout.paneBounds).length, 0,
      'render no longer writes paneBounds');
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
    const b = geo.visibleBoundsFor(layout, route.resolveViewerPaneId());
    assert(b, 'bounds resolved');
    assert(b.x > 0, `right half starts past mid-screen (saw x=${b.x})`);
    assert(b.y === 0, 'spans from top');
  });
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
