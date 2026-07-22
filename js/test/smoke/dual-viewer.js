/**
 * Smoke — dual-viewer: two content SLOTS are independent viewers.
 *
 * Acceptance scenario for the v0.6.4 multi-viewer arc, carried onto the
 * U2e P1b model. Drives the SHIPPED demo config `demo/dual-viewer/tui.yml`
 * (a files browser feeding two side-by-side preview panes) through the
 * REAL pipeline — parser → `initState` → per-tab mint — then pins the
 * property the arc delivers: two content slots coexist as fully
 * independent viewer instances, and content routes to the FOCUSED (major)
 * slot.
 *
 * U2e P1b — the single `detail` Component per slot is dissolved into
 * sibling POSITION-TAB instances: each `role:'content'` slot is seeded
 * with [ detail(hidden anchor) · info(ACTIVE default) · transcript ].
 * So the two slots are selected by `role === 'content'` (there is no
 * `detail`-TYPED placed pane anymore), and every "which pane shows what"
 * assertion targets the slot's ACTIVE instance — the `info` tab by
 * default (`resolveTarget('viewer'|'viewer_info')`), each slot with its
 * OWN info+transcript (poolIds `info-<paneId>` differ per slot).
 *
 * Coverage:
 *   [1] mint     — two distinct content slots, each with its own instances
 *   [2] identity — each slot's active instance self-identifies (slice.paneId)
 *   [3] routing  — resolveTarget('viewer') follows focus (the major slot)
 *   [4] content  — info_show_content routed via focus lands ONLY on the
 *                  focused slot's info instance; the other is untouched
 *   [5] tab      — set_active_tab is per-slot (independent position-tab strips)
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
const { parse } = require('../../parser/index');
const { getModel } = require('../../app/runtime');
const { initState } = require('../../app/state');

const DEMO = path.join(__dirname, '..', '..', '..', 'demo', 'dual-viewer', 'tui.yml');

// files is the navigator this config uses; layout/detail/groups were
// auto-registered when test-runner loaded. U2e P1b — the seeded content
// slots mint `info` + `text-view` (Transcript) tab-instances, so those
// Components MUST be registered before initState or the mint loop skips
// them (state.reconcilePaneInstances#`if (!comp) continue`) and the slot's
// active instance never comes into being.
if (!api.getComponent('files')) {
  api.registerComponent(require('../../panel/navigator/files'));
}
if (!api.getComponent('info')) api.registerComponent(require('../../panel/info/info'));
if (!api.getComponent('text-view')) api.registerComponent(require('../../panel/text-view/text-view'));

const cfg = parse(DEMO);
getModel().config = cfg;
getModel().projectDir = cfg.project_dir;
initState();

// U2e P1b — the two viewer SLOTS are identified by their stable
// `role === 'content'` marker (there is no `detail`-typed placed pane
// post-P1b; the active tab is `info`). Returns the CONTAINER paneIds.
function placedContentSlots() {
  const out = [];
  const layout = api.getInstanceSlice('layout');
  for (const col of (layout.arrange.columns || [])) {
    for (const p of (col.panels || [])) {
      if (p && p.role === 'content' && p.paneId) out.push(p.paneId);
    }
  }
  return out;
}

// The navigator slot (single-tab, non-content) — its `[≡]` still surfaces the
// half-view projection picker (see [9]).
function placedNav() {
  const layout = api.getInstanceSlice('layout');
  for (const col of (layout.arrange.columns || [])) {
    for (const p of (col.panels || [])) {
      if (p && p.role !== 'content' && p.type !== 'detail' && p.paneId) return p.paneId;
    }
  }
  return null;
}

const SLOTS = placedContentSlots();
const A = SLOTS[0];   // pane-left
const B = SLOTS[1];   // pane-right

// The slot's ACTIVE instance (info by default) — the id `resolveTarget`
// returns for the focused slot, and what every content assertion targets.
function activeInst(paneId) { return route.activeInstanceOf(paneId); }
// The slot's INFO instance specifically (independent of what's active).
function infoInst(paneId) { return route.resolveTarget('viewer_info', { focusedTabId: paneId }); }

function focus(paneId) { api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: paneId })); }

describe('[1] the demo mints two independent content slots (viewers)', () => {
  it('two `content`-role slots were placed', () => {
    eq(SLOTS.length, 2, 'exactly two content slots placed');
    assert(A !== B, `distinct paneIds (${A} vs ${B})`);
  });
  it('each slot`s active instance has its OWN slice object', () => {
    // getInstanceSlice(paneId) diverts to the slot's ACTIVE tab instance
    // (info by default) via _resolveActive.
    const sa = api.getInstanceSlice(A);
    const sb = api.getInstanceSlice(B);
    assert(sa && sb, 'both active-instance slices resolve');
    assert(sa !== sb, 'slices are distinct objects');
  });
  it('each slot seeds its OWN info + transcript (distinct instances)', () => {
    assert(infoInst(A) !== infoInst(B), `distinct info instances (${infoInst(A)} vs ${infoInst(B)})`);
    const tA = route.resolveTarget('viewer_transcript', { focusedTabId: A });
    const tB = route.resolveTarget('viewer_transcript', { focusedTabId: B });
    assert(tA !== tB, `distinct transcript instances (${tA} vs ${tB})`);
  });
});

describe('[2] each viewer self-identifies by (column) paneId', () => {
  it('slice.paneId matches the placed slot paneId', () => {
    // The active `info` instance's slice.paneId is the COLUMN paneId
    // (threaded by the mint loop as init(paneId)).
    eq(api.getInstanceSlice(A).paneId, A, 'A self-identifies');
    eq(api.getInstanceSlice(B).paneId, B, 'B self-identifies');
  });
});

describe('[3] resolveTarget follows focus (the major viewer)', () => {
  it('focusing A makes A`s active instance the viewer target; focusing B makes B`s', () => {
    focus(A);
    eq(route.resolveTarget('viewer'), activeInst(A), 'A focused → A`s active instance is the target');
    focus(B);
    eq(route.resolveTarget('viewer'), activeInst(B), 'B focused → B`s active instance is the target');
  });
});

describe('[4] content routes to the focused viewer only', () => {
  it('info_show_content via resolveTarget(viewer_info) lands on the focused slot`s info', () => {
    // U2e P1b — nav-selection body now lands on the slot's `info` instance
    // via the `info_show_content` arm (slice.lines), NOT the retired detail
    // viewer's viewer_set_content/viewerOverride.
    focus(A);
    api.dispatchMsg(api.wrap(route.resolveTarget('viewer_info'), {
      type: 'info_show_content', lines: ['hello from A'],
    }));
    const oa = api.getInstanceSlice(infoInst(A)).lines;
    const ob = api.getInstanceSlice(infoInst(B)).lines;
    assert(oa && oa[0] === 'hello from A', 'A`s info received the content');
    assert(!ob || ob.length === 0, 'B`s info was NOT touched');

    // Now focus B and route again — lands on B, A unchanged.
    focus(B);
    api.dispatchMsg(api.wrap(route.resolveTarget('viewer_info'), {
      type: 'info_show_content', lines: ['hello from B'],
    }));
    const ob2 = api.getInstanceSlice(infoInst(B)).lines;
    assert(ob2 && ob2[0] === 'hello from B', 'B`s info received the content');
    eq(api.getInstanceSlice(infoInst(A)).lines[0], 'hello from A', 'A still shows its own content');
  });
});

describe('[5] tab switching is per-slot (independent position-tab strips)', () => {
  it('set_active_tab on A does not move B`s active tab', () => {
    // Position-tabs replace the retired flat slice.tab index. Each slot's
    // activeTabId is independent; switching A's must not touch B's.
    const layout = () => api.getInstanceSlice('layout');
    const mpool = require('../../leaves/wm/pool');
    const paneOf = (pid) => mpool.findPaneLocation(layout().arrange, p => p.paneId === pid).pane;
    const bActiveBefore = paneOf(B).activeTabId;
    // Switch A to its Transcript tab, then back to Info.
    api.dispatchMsg(api.wrap('layout', { type: 'set_active_tab', paneId: A, tabPoolId: `transcript-${A}` }));
    api.dispatchMsg(api.wrap('layout', { type: 'set_active_tab', paneId: A, tabPoolId: `info-${A}` }));
    eq(paneOf(B).activeTabId, bActiveBefore, 'B`s active tab unchanged');
  });
});

describe('[7] half / full view thread opts.focused to the rendered pane', () => {
  // Regression: renderHalf/renderFull passed only { chrome } to _safeRender,
  // not { focused } — so the panel renderers got opts.focused === undefined
  // and drew no focus border ("no pane focus"), most visible when the
  // focused pane is the viewer on the right. U2e P1b — the slot's ACTIVE
  // tab is now the `info` instance, so spy the info panel-def render
  // (mutating the registered spec object, which the registry holds by
  // reference) and read the opts.focused it receives.
  const infoSpec = require('../../panel/info/info');
  function focusedSeenFor(paneId, mode) {
    const def = infoSpec.panelTypes.info;
    const orig = def.render;
    let seen = null;
    def.render = (panel, w, h, slice, opts) => {
      // The active info instance's slice carries the column paneId.
      if (slice && slice.paneId === paneId) seen = !!(opts && opts.focused);
      return orig(panel, w, h, slice, opts);
    };
    try {
      api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'normal' }));
      focus(paneId);
      api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode }));
      const realWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = () => true;
      // Phase F — redraw (dispatch-then-paint) moved to the dispatch layer.
      try { require('../../dispatch/control/dispatch').redraw(); } finally { process.stdout.write = realWrite; }
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
  // "Loading…" forever (the update resolved the wrong pane). U2e P1b —
  // opening content is now a minted `text-view` POSITION-tab
  // (feature/content-tab.js → poolId `content-<key>`), which mints into the
  // slot resolveViewerPaneId picks (the focused slot). The mint must land on
  // the focused slot's OWN id.
  const feature = require('../../panel/content-tab');
  const mpool = require('../../leaves/wm/pool');
  function slotPane(pid) {
    return mpool.findPaneLocation(api.getInstanceSlice('layout').arrange, p => p.paneId === pid).pane;
  }
  it('add-content-tab on the focused (second) viewer does NOT steal focus to the primary', () => {
    focus(B);
    getModel().currentGroup = getModel().currentGroup || 'browse';
    feature.addContentTab(getModel().currentGroup, 'file:/x', 'x', ['hi']);
    eq(route.getFocus(), B, 'focus stayed on B (was stolen to the primary pre-fix)');
    // The content tab landed as a position-tab in B's slot, not the primary A.
    const poolId = feature._poolId('file:/x');
    const bTabs = (slotPane(B).tabs || []).map(t => t.poolId);
    assert(bTabs.includes(poolId), `B received the content tab (${JSON.stringify(bTabs)})`);
    const aTabs = (slotPane(A).tabs || []).map(t => t.poolId);
    assert(!aTabs.includes(poolId), 'A did NOT receive it');
    // The mint activated + focused B's new text-view tab; its content loaded
    // via tv_set_lines.
    const mpane = require('../../leaves/wm/pane');
    eq(api.getInstanceSlice(mpane.newPaneId(poolId)).lines.join('\n'), 'hi', 'content loaded on B`s new tab');
  });
});

describe('[8] half view is an API-driven projection — two viewers side-by-side', () => {
  // v0.6.4 #1 Step 1. Half view used to hardcode "one navigator + the major
  // viewer" and HIDE every other viewer. It's now a projection of two slots
  // resolved by geo.halfProjection: an ephemeral, API-settable selection
  // (view_place_pane) over a default that reproduces the old behavior.
  const geo = require('../../leaves/wm/geometry');
  const layoutSlice = () => api.getInstanceSlice('layout');

  const mpool = require('../../leaves/wm/pool');
  function renderNow() {
    const realWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = () => true;
    try { require('../../dispatch/control/dispatch').redraw(); } finally { process.stdout.write = realWrite; }
    // A.2 — paneBounds is no longer a render-written field; build the visible
    // map from the derived accessor (only on-screen panes resolve, exactly
    // what the old half-view paneBounds held).
    const ls = layoutSlice();
    const map = {};
    // Thread viewerPaneId so the default half-view right slot resolves — the
    // leaf can't reach route (§3); mirrors paint.js / input.js callers.
    const vpid = route.resolveViewerPaneId();
    for (const p of mpool.allPanesInColumns(ls.arrange)) {
      const b = geo.visibleBoundsFor(ls, p.paneId, vpid);
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

describe('[9] Step 2 — half-view slot placement + swap (pane_menu_place)', () => {
  // The user-facing path: in half view the pane-menu's Panes section lists
  // every placed pane (incl. viewers); picking one places it in the clicked
  // pane's slot via view_place_pane (pane_menu_place), swapping when it
  // already occupies the other slot.
  //
  // U2e P1b — a content SLOT is now a MULTI-tab pane (detail anchor · Info ·
  // Transcript), so its `[≡]` menu shows the UNIFIED position-tab SWITCHER
  // (Info/Transcript), NOT the projection Panes picker (pane-menu.js#items —
  // `_instanceTabRows` takes precedence for a >1-tab slot). The projection
  // picker is still surfaced through a SINGLE-tab pane's `[≡]` (the navigator),
  // and the swap Msg (pane_menu_place) is unchanged — so this section pins the
  // new menu shape and drives the swap through the still-supported path.
  const overlay = require('../../overlay/pane-menu');
  const layoutSlice = () => api.getInstanceSlice('layout');
  const NAV = SLOTS.length ? placedNav() : null;

  it('a multi-tab viewer`s `[≡]` shows its position-tab switcher (U2e stopgap), not the projection picker', () => {
    layoutSlice().halfView = { left: A, right: B };
    api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' }));
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: A }));
    const items = overlay.items(A);
    // Every row is a Tabs row (the slot's Info/Transcript position-tabs) — a
    // multi-tab slot no longer surfaces the pane-projection picker.
    assert(items.length > 0 && items.every(it => it && it.section === 'tab'),
      `only Tabs rows for a multi-tab slot (${JSON.stringify(items.map(i => i && i.label))})`);
    assert(!items.some(it => it && it.section === 'pane'),
      'no Panes (projection) rows on a multi-tab viewer`s menu');
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_close' }));
  });

  it('the projection picker is still reachable via the navigator`s `[≡]` and lists the viewers', () => {
    layoutSlice().halfView = { left: A, right: B };
    api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' }));
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: NAV }));
    const items = overlay.items(NAV);
    const rowA = items.find(it => it && it.section === 'pane' && it.paneId === A);
    const rowB = items.find(it => it && it.section === 'pane' && it.paneId === B);
    assert(rowA && rowB, `both viewers appear as placeable pane rows (${JSON.stringify(items.map(i => i && i.paneId))})`);
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_close' }));
  });

  it('placing the pane already in the OTHER slot swaps the two slots (no collapse)', () => {
    // pane_menu_place is the Msg `_paneMenuPick` emits for a half-view pane
    // row; drive it directly. Place B into the LEFT slot while B occupies the
    // RIGHT slot → the arm swaps (right gets what left held), keeping both
    // viewers on screen rather than collapsing to one.
    layoutSlice().halfView = { left: A, right: B };
    api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' }));
    const viewerPaneId = route.resolveViewerPaneId();
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_place', slot: 'left', paneId: B, viewerPaneId }));
    const hv = layoutSlice().halfView;
    eq(hv.left, B, 'left slot now B (the pick)');
    eq(hv.right, A, 'right slot got A (swap, not collapse)');
    api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'normal' }));
  });
});

report();
