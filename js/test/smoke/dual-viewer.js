/**
 * Smoke — dual-viewer: two `detail` panes are independent viewers.
 *
 * Acceptance scenario for the v0.6.4 multi-viewer arc. Drives the SHIPPED
 * demo config `demo/dual-viewer/tui.yml` (a files browser feeding two
 * side-by-side preview panes) through the REAL pipeline — parser →
 * `initState` → per-pane mint — then pins the property the arc delivers:
 * two `detail` panes coexist as fully independent viewer instances, and
 * content routes to the FOCUSED (major) viewer.
 *
 * Before this arc the parser refused a second detail tab outright, and
 * every viewer path hardcoded the single `'detail'` instance. Each
 * assertion below pins one axis of independence.
 *
 * Coverage:
 *   [1] mint     — two distinct `detail` instances (the parser allows it)
 *   [2] identity — each instance self-identifies (slice.paneId)
 *   [3] routing  — resolveTarget('viewer') follows focus (the major viewer)
 *   [4] content  — viewer_set_content routed via focus lands ONLY on the
 *                  focused pane; the other is untouched
 *   [5] tab      — viewer_set_tab is per-pane (independent tab strips)
 *
 * Run: node js/test/smoke/dual-viewer.js
 *      (or via the suite: node js/scripts/run-smoke.js dual-viewer)
 */
'use strict';

const path = require('path');
const { describe, it, eq, assert, report } = require('../test-runner');
const sm = require('./_helpers/smoke');
const route = sm.route;
const api = sm.api;
const state = require('../../app/state');
const { parse } = require('../../parser/index');
const { getModel } = require('../../app/runtime');
const { initState } = require('../../app/state');

const DEMO = path.join(__dirname, '..', '..', '..', 'demo', 'dual-viewer', 'tui.yml');

// files is the navigator this config uses; layout/detail/groups were
// auto-registered when test-runner loaded.
if (!api.getInstanceSlice('files')) {
  api.registerComponent(require('../../panel/navigator/files'));
}

const cfg = parse(DEMO);
getModel().config = cfg;
getModel().projectDir = cfg.project_dir;
initState();

function placedViewerPanes() {
  const out = [];
  const layout = api.getInstanceSlice('layout');
  for (const col of (layout.arrange.columns || [])) {
    for (const p of (col.panels || [])) {
      if (p && p.type === 'detail' && p.paneId) out.push(p.paneId);
    }
  }
  return out;
}

const VIEWERS = placedViewerPanes();
const A = VIEWERS[0];   // pane-left
const B = VIEWERS[1];   // pane-right

function focus(paneId) { api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: paneId })); }

describe('[1] the demo mints two independent detail (viewer) instances', () => {
  it('two `detail` panes were placed', () => {
    eq(VIEWERS.length, 2, 'exactly two detail panes placed');
    assert(A !== B, `distinct paneIds (${A} vs ${B})`);
  });
  it('each pane has its OWN slice object', () => {
    const sa = api.getInstanceSlice(A);
    const sb = api.getInstanceSlice(B);
    assert(sa && sb, 'both slices resolve');
    assert(sa !== sb, 'slices are distinct objects');
  });
});

describe('[2] each viewer self-identifies by paneId', () => {
  it('slice.paneId matches the placed paneId', () => {
    eq(api.getInstanceSlice(A).paneId, A, 'A self-identifies');
    eq(api.getInstanceSlice(B).paneId, B, 'B self-identifies');
  });
});

describe('[3] resolveTarget follows focus (the major viewer)', () => {
  it('focusing A makes A the viewer target; focusing B makes B', () => {
    focus(A);
    eq(route.resolveTarget('viewer'), A, 'A focused → A is the target');
    focus(B);
    eq(route.resolveTarget('viewer'), B, 'B focused → B is the target');
  });
});

describe('[4] content routes to the focused viewer only', () => {
  it('viewer_set_content via resolveTarget lands on the focused pane', () => {
    focus(A);
    api.dispatchMsg(api.wrap(route.resolveTarget('viewer'), {
      type: 'viewer_set_content', lines: ['hello from A'],
    }));
    const oa = api.getInstanceSlice(A).viewerOverride;
    const ob = api.getInstanceSlice(B).viewerOverride;
    assert(oa && oa.lines && oa.lines[0] === 'hello from A', 'A received the content');
    assert(!ob, 'B was NOT touched');

    // Now focus B and route again — lands on B, A unchanged.
    focus(B);
    api.dispatchMsg(api.wrap(route.resolveTarget('viewer'), {
      type: 'viewer_set_content', lines: ['hello from B'],
    }));
    const ob2 = api.getInstanceSlice(B).viewerOverride;
    assert(ob2 && ob2.lines && ob2.lines[0] === 'hello from B', 'B received the content');
    eq(api.getInstanceSlice(A).viewerOverride.lines[0], 'hello from A', 'A still shows its own content');
  });
});

describe('[5] tab switching is per-pane', () => {
  it('viewer_set_tab on A does not move B`s tab', () => {
    const bTabBefore = api.getInstanceSlice(B).tab;
    api.dispatchMsg(api.wrap(A, { type: 'viewer_set_tab', tab: 0 }));
    api.dispatchMsg(api.wrap(A, { type: 'viewer_set_tab', tab: 1 }));
    eq(api.getInstanceSlice(B).tab, bTabBefore, 'B`s tab unchanged');
  });
});

describe('[7] half / full view thread opts.focused to the rendered pane', () => {
  // Regression: renderHalf/renderFull passed only { chrome } to _safeRender,
  // not { focused } — so the panel renderers got opts.focused === undefined
  // and drew no focus border ("no pane focus"), most visible when the
  // focused pane is the viewer on the right. Spy the viewer's panel-def
  // render (mutating the registered spec object, which the registry holds
  // by reference — robust to the load-time renderPanel capture) and read
  // the opts.focused it receives.
  const viewerSpec = require('../../panel/viewer/viewer');
  function focusedSeenFor(paneId, mode) {
    const def = viewerSpec.panelTypes.detail;
    const orig = def.render;
    let seen = null;
    def.render = (panel, w, h, slice, opts) => {
      if (panel && panel.paneId === paneId) seen = !!(opts && opts.focused);
      return orig(panel, w, h, slice, opts);
    };
    try {
      api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'normal' }));
      focus(paneId);
      api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode }));
      const realWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      try { require('../../render/paint').redraw(getModel()); } finally { process.stdout.write = realWrite; }
    } finally { def.render = orig; }
    return seen;
  }
  it('half view: the focused viewer (right pane) renders with opts.focused', () => {
    eq(focusedSeenFor(A, 'half'), true, 'focused viewer got opts.focused=true in half view');
  });
  it('full view: the focused viewer renders with opts.focused', () => {
    eq(focusedSeenFor(A, 'full'), true, 'focused viewer got opts.focused=true in full view');
  });
});

describe('[6] opening content into the focused viewer keeps focus there', () => {
  // Regression: viewer.js handed reduceTabMsg a hardcoded paneId 'detail',
  // so add-content-tab focused the PRIMARY viewer — stealing focus from a
  // focused second viewer, which stranded the async file load on
  // "Loading…" forever (the update resolved the wrong pane). The focus
  // side-effect must target the pane's OWN id.
  it('add-content-tab on the focused (second) viewer does NOT steal focus to the primary', () => {
    focus(B);
    const tabs = require('../../panel/viewer/tabs');
    getModel().currentGroup = getModel().currentGroup || 'browse';
    tabs.addContentTab(getModel().currentGroup, 'file:/x', 'x', ['hi']);
    eq(route.getFocus(), B, 'focus stayed on B (was stolen to the primary pre-fix)');
    eq(route.resolveTarget('viewer_tab_add'), B, 'the async update will resolve B, not the primary');
    // The content tab landed on B, not the primary A.
    const bTabs = api.getInstanceSlice(B).contentTabs[getModel().currentGroup] || {};
    assert(bTabs['file:/x'], 'B received the content tab');
    const aTabs = api.getInstanceSlice(A).contentTabs[getModel().currentGroup] || {};
    assert(!aTabs['file:/x'], 'A did NOT receive it');
  });
});

describe('[8] half view is an API-driven projection — two viewers side-by-side', () => {
  // v0.6.4 #1 Step 1. Half view used to hardcode "one navigator + the major
  // viewer" and HIDE every other viewer. It's now a projection of two slots
  // resolved by geo.halfProjection: an ephemeral, API-settable selection
  // (view_place_pane) over a default that reproduces the old behavior.
  const geo = require('../../leaves/geometry');
  const paint = require('../../render/paint');
  const layoutSlice = () => api.getInstanceSlice('layout');

  const mpool = require('../../leaves/pool');
  function renderNow() {
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try { paint.redraw(getModel()); } finally { process.stdout.write = realWrite; }
    // A.2 — paneBounds is no longer a render-written field; build the visible
    // map from the derived accessor (only on-screen panes resolve, exactly
    // what the old half-view paneBounds held).
    const ls = layoutSlice();
    const map = {};
    for (const p of mpool.allPanesInColumns(ls.arrange)) {
      const b = geo.visibleBoundsFor(ls, p.paneId);
      if (b) map[p.paneId] = b;
    }
    return map;
  }

  it('DEFAULT half (nothing placed): one non-viewer + the focused viewer; the OTHER viewer is hidden', () => {
    layoutSlice().halfView = { left: null, right: null };
    focus(A);  // focus a viewer → default-left falls to the sticky nav
    api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' }));
    const pb = renderNow();
    const keys = Object.keys(pb);
    eq(keys.length, 2, 'exactly two panes projected');
    assert(keys.includes(A), 'the focused viewer (A) is on screen');
    assert(!keys.includes(B), 'the OTHER viewer (B) is hidden — the historical default');
  });

  it('PLACING both slots projects two viewers side-by-side (no navigator)', () => {
    api.dispatchMsg(api.wrap('layout', { type: 'view_place_pane', slot: 'left',  paneId: A }));
    api.dispatchMsg(api.wrap('layout', { type: 'view_place_pane', slot: 'right', paneId: B }));
    const pb = renderNow();
    const keys = Object.keys(pb);
    eq(keys.length, 2, 'exactly two panes projected');
    assert(pb[A] && pb[B], 'BOTH viewers are on screen');
    eq(pb[A].x, 0, 'A occupies the left slot (x=0)');
    eq(pb[B].x, pb[A].x + pb[A].w, 'B begins where A ends (right slot)');
    eq(pb[A].y, 0); eq(pb[B].y, 0);
    eq(pb[A].h, pb[B].h, 'both full height');
  });

  it('getPanelViewportH agrees: the RIGHT-slot viewer reports full content height', () => {
    const pb = renderNow();   // both slots still placed from the prior test
    const { dims } = require('../../io/term');
    eq(geo.getPanelViewportH(layoutSlice(), B, dims()), pb[B].h - 2,
       'right-slot viewer gets full availH-2 (geometry matches what was painted)');
  });

  it('clearing back to default (place the nav left) drops B again', () => {
    // Restore the single-viewer-era shape by placing the nav on the left and
    // re-defaulting the right via focus; proves the projection is reversible.
    layoutSlice().halfView = { left: null, right: null };
    focus(A);
    api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' }));
    const keys = Object.keys(renderNow());
    assert(!keys.includes(B), 'B hidden again once the override is cleared');
    api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'normal' }));
  });
});

describe('[9] Step 2 — the `[≡]` pane-menu DRIVES the projection in half view', () => {
  // The user-facing path: in half view, the pane-menu's Panes section
  // lists every placed pane (incl. viewers); picking one places it in the
  // clicked pane's slot via view_place_pane (pane_menu_place), swapping
  // when it already occupies the other slot.
  const overlay = require('../../overlay/pane-menu');
  const dispatch = require('../../dispatch/dispatch');
  const layoutSlice = () => api.getInstanceSlice('layout');

  it('a viewer pane-menu in half view lists the OTHER viewer as a placeable pane row', () => {
    layoutSlice().halfView = { left: A, right: B };
    api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' }));
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: A }));
    const items = overlay.items(A);
    assert(items.some(it => it && it.section === "tab"), 'Tabs section present (A is a viewer)');
    const rowB = items.find(it => it && it.section === "pane" && it.paneId === B);
    assert(rowB, 'the OTHER viewer (B) appears as a placeable pane row with its paneId');
  });

  it('picking the other viewer for THIS slot swaps the two slots', () => {
    layoutSlice().halfView = { left: A, right: B };
    api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' }));
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: A }));  // A = left slot
    const rowB = overlay.items(A).find(it => it && it.section === "pane" && it.paneId === B);
    dispatch._paneMenuPick(A, rowB);   // pick B (in the right slot) for A's (left) slot
    const hv = layoutSlice().halfView;
    eq(hv.left, B, 'left slot now B (the pick)');
    eq(hv.right, A, 'right slot got A (swap, not collapse)');
    eq(getModel().modes.paneMenuMode, false, 'menu closed after the pick');
    api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'normal' }));
  });
});

report();
