/**
 * U2e stopgap — the `[≡]` position-tab switcher for MULTI-tab slots.
 * Run: node js/test/test-position-tab-switcher.js
 *
 * Regression for a U2c-shipped bug: a `tab:true` action mints its output as a
 * `text-view` position-tab into the viewer slot + activates it, so the slot's
 * active kind is `text-view` — at which point the slot stops reading as a viewer
 * (`_isViewer` false) and its flat-strip `[≡]` switcher vanished, stranding the
 * backgrounded `detail` tab (Info/Transcript) with no way back. The stopgap wires
 * tab-container's `instance` backing into the pane-menu so any multi-tab slot
 * offers a position-tab switcher. (The proper unified strip lands in P1b/U2f.)
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = sm.route;
const api = sm.api;
const paneMenu = require('../overlay/pane-menu');
const dispatch = require('../dispatch/control/dispatch');

if (!api.getComponent('text-view')) api.registerComponent(require('../panel/text-view/text-view'));

function mintTextView(vpid, poolId, title) {
  api.dispatchMsg(api.wrap('layout', {
    type: 'mint_tab', paneId: vpid, paneType: 'text-view', poolId, title,
    hint: { origin: 'action', group: 'g', key: title },
  }));
}
function paneOf(vpid) {
  const layout = api.getInstanceSlice('layout');
  for (const col of layout.arrange.columns) for (const p of (col.panels || [])) if (p.paneId === vpid) return p;
  return null;
}

describe('[stopgap] single-tab viewer slot keeps its flat-strip [≡]', () => {
  it('no position-tab switcher until the slot is multi-tab', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    const rows = paneMenu.items(vpid) || [];
    // Single-tab viewer → the viewer flat strip (Info/Transcript), NOT instance rows.
    assert(!rows.some(r => r && r.backing === 'instance'), 'no instance-backing rows for a single-tab slot');
    assert(rows.some(r => r && r.section === 'tab'), 'viewer flat-strip tabs still present');
  });
});

describe('[stopgap] a multi-tab slot offers a position-tab switcher', () => {
  it('items() lists the slot position-tabs (Detail + the minted text-view)', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    const pane = paneOf(vpid);
    eq(pane.tabs.length, 2, 'slot now has 2 position-tabs');
    assert(route.instanceKind(vpid) === 'text-view', 'the minted text-view is active');
    const rows = paneMenu.items(vpid) || [];
    assert(rows.length >= 2 && rows.every(r => r && r.backing === 'instance'),
      'items() are instance-backing position-tab rows');
    const labels = rows.map(r => r.label);
    assert(labels.includes('primary'), 'the action text-view tab is listed');
    assert(rows.some(r => r.poolId === 'detail'), 'the backgrounded Detail tab is listed (reachable)');
  });

  it('triggerVisible is true so the [≡] glyph is clickable', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    assert(paneMenu.triggerVisible(vpid), '[≡] trigger shows on the multi-tab slot');
  });

  it('picking the Detail row switches the slot back (Info/Transcript reachable)', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    eq(route.instanceKind(vpid), 'text-view', 'text-view active before pick');
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: vpid }));
    const detailRow = (paneMenu.items(vpid) || []).find(r => r && r.poolId === 'detail');
    assert(detailRow, 'Detail row present');
    dispatch._paneMenuPick(vpid, detailRow);
    eq(paneOf(vpid).activeTabId, 'detail', 'slot active tab flipped back to detail');
    eq(route.instanceKind(vpid), 'detail', 'slot reads as a viewer again (flat strip renders)');
    eq(api.getInstanceSlice('layout').arrange && paneOf(vpid).tabs.length, 2, 'both tabs still present (nothing destroyed)');
  });
});

report();
