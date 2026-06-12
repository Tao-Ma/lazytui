/**
 * v0.6.4 — paneBounds is keyed by CONTAINER paneId only (the type-keyed
 * write retired), and viewer-geometry readers resolve their container pane
 * via route.resolveViewerPaneId() so they get half/full-correct VISIBLE
 * bounds.
 *
 * Why this matters: `resolveTarget('viewer')` returns a viewer *tab/instance*
 * id (singleton: 'detail') which, before this change, aliased the type key.
 * Readers (terminal overlay, viewer innerH, tab-drag/select bounds) keyed by
 * that tab-id worked in half/full ONLY because the per-view-mode type write
 * overrode the slice with the rebuilt single-pane bounds. `_currentLayout`
 * rects can't supply that — they always describe the normal column layout.
 * After retiring the type write, those readers MUST key by the container
 * paneId (whose write is rebuilt per view mode). This pins both halves:
 *   1. a real render leaves no bare type key in paneBounds, and
 *   2. boundsFor(resolveViewerPaneId()) tracks the visible bounds in every
 *      view mode.
 *
 * Regression guard for the full/half "small normal-layout rect leaks through"
 * bug that dropping the type write would otherwise reintroduce.
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

describe('v0.6.4 paneBounds — paneId-keyed only', () => {
  it('a real render leaves no bare type key (every key is a container paneId)', () => {
    const layout = renderIn('normal', 'pane-groups');
    const keys = Object.keys(layout.paneBounds);
    assert(keys.length > 0, 'paneBounds populated');
    assert(keys.every(k => k.startsWith('pane-')),
      `all keys are container paneIds (saw: ${keys.join(',')})`);
    // The type-aliased key is specifically gone.
    eq(layout.paneBounds.detail, undefined);
    eq(layout.paneBounds.groups, undefined);
  });

  it("resolveViewerPaneId() returns the viewer's CONTAINER paneId", () => {
    renderIn('normal', 'pane-groups');
    eq(route.resolveViewerPaneId(), 'pane-detail');
  });
});

describe('v0.6.4 viewer bounds track the VISIBLE pane per view mode', () => {
  it('normal: boundsFor(resolveViewerPaneId()) is the column-positioned detail rect', () => {
    const layout = renderIn('normal', 'pane-groups');
    const b = geo.boundsFor(layout, route.resolveViewerPaneId());
    assert(b, 'bounds resolved');
    // Detail sits in the right column, not at the origin.
    assert(b.x > 0, `right-column x (saw x=${b.x})`);
  });

  it('full (focus detail): bounds fill the screen — NOT the small normal rect', () => {
    const layout = renderIn('full', 'pane-detail');
    const b = geo.boundsFor(layout, route.resolveViewerPaneId());
    assert(b, 'bounds resolved');
    eq(b.x, 0);
    eq(b.y, 0);
    eq(b.w, layout.paneBounds['pane-detail'].w);
    // Full-screen width spans the whole terminal — wider than a column.
    assert(b.w >= 40, `full width (saw w=${b.w})`);
  });

  it('half (focus detail): bounds are the right half at full height', () => {
    const layout = renderIn('half', 'pane-detail');
    const b = geo.boundsFor(layout, route.resolveViewerPaneId());
    assert(b, 'bounds resolved');
    assert(b.x > 0, `right half starts past mid-screen (saw x=${b.x})`);
    assert(b.y === 0, 'spans from top');
  });
});

report();
