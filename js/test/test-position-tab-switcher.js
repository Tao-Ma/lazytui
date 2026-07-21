/**
 * U2e stopgap — the UNIFIED tab strip for MULTI-tab slots (visible border strip +
 * matching `[≡]` menu). Run: node js/test/test-position-tab-switcher.js
 *
 * Regression for a U2c-shipped bug: a `tab:true` action mints its output as a
 * `text-view` position-tab into the viewer slot + activates it, which used to
 * swap the visible border strip from the viewer's inner tabs (`Info | Transcript`)
 * to the slot's position-tabs (`Detail | primary`) — Info/Transcript appeared to
 * vanish. The fix flattens both levels into ONE strip (`Info | Transcript |
 * primary`) shown whichever is active, so running an action ADDS a tab. The `[≡]`
 * menu shows the same flattened list. (The full unified strip lands in P1b/U2f.)
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = sm.route;
const api = sm.api;
const paneMenu = require('../overlay/pane-menu');
const dispatch = require('../dispatch/control/dispatch');
const { unifiedSlotStrip } = require('../panel/slot-strip');

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
  it('no unified slot rows until the slot is multi-tab', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    const rows = paneMenu.items(vpid) || [];
    assert(!rows.some(r => r && r.backing === 'slot'), 'no unified slot rows for a single-tab slot');
    assert(rows.some(r => r && r.section === 'tab'), 'viewer flat-strip tabs still present');
    assert(unifiedSlotStrip(paneOf(vpid)) === null, 'unifiedSlotStrip null for single-tab');
  });
});

describe('[stopgap] a multi-tab slot flattens into ONE unified strip', () => {
  it('the strip lists the viewer inner tabs + the action tab (Info/Transcript/primary), primary active', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    const strip = unifiedSlotStrip(paneOf(vpid));
    const labels = strip.entries.map(e => e.label);
    eq(labels.join(','), 'Info,Transcript,primary', 'flattened: viewer inner tabs + the action tab');
    eq(strip.entries[strip.activeIdx].label, 'primary', 'the just-run action tab is active');
    // No standalone "Detail" entry — it expanded into Info/Transcript.
    assert(!labels.includes('Detail'), 'the viewer tab is expanded, not shown as one "Detail" entry');
  });

  it('the [≡] menu shows the SAME flattened rows (menu ≡ strip)', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    const rows = paneMenu.items(vpid) || [];
    assert(rows.length >= 3 && rows.every(r => r && r.backing === 'slot'), 'unified slot rows');
    eq(rows.map(r => r.label).join(','), 'Info,Transcript,primary', 'menu matches the strip');
    assert(paneMenu.triggerVisible(vpid), '[≡] trigger shows on the multi-tab slot');
  });

  it('the visible border strip renders the flattened labels', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    const pane = paneOf(vpid);
    const tv = require('../panel/text-view/text-view');
    const out = tv.panelTypes['text-view'].render(pane, 60, 8, api.getInstanceSlice(vpid), { focused: true });
    const text = Array.isArray(out) ? out.join('\n') : String(out);
    assert(/Info/.test(text) && /Transcript/.test(text), 'viewer inner tabs VISIBLE in the strip');
    assert(/primary/.test(text), 'the action tab is visible');
  });
});

describe('[stopgap] picking a flattened row switches correctly', () => {
  it('picking Transcript (a viewer inner tab) activates the viewer + its Transcript tab', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    eq(route.instanceKind(vpid), 'text-view', 'text-view active before pick');
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: vpid }));
    const row = (paneMenu.items(vpid) || []).find(r => r && r.label === 'Transcript');
    assert(row && row.kind === 'flat', 'Transcript is a flat (viewer inner) row');
    dispatch._paneMenuPick(vpid, row);
    eq(paneOf(vpid).activeTabId, 'detail', 'viewer tab activated');
    eq(route.instanceKind(vpid), 'detail', 'slot reads as a viewer again');
    eq(api.getInstanceSlice(vpid).tab, 1, 'the viewer switched to its Transcript inner tab (idx 1)');
  });

  it('picking the action tab (a position row) activates the text-view', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    // Switch to the viewer first, then back to the action tab via the menu.
    api.dispatchMsg(api.wrap('layout', { type: 'set_active_tab', paneId: vpid, tabPoolId: 'detail' }));
    eq(route.instanceKind(vpid), 'detail', 'viewer active');
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: vpid }));
    const row = (paneMenu.items(vpid) || []).find(r => r && r.label === 'primary');
    assert(row && row.kind === 'position', 'primary is a position row');
    dispatch._paneMenuPick(vpid, row);
    eq(paneOf(vpid).activeTabId, 'tv-act-g-primary', 'action text-view activated');
    eq(paneOf(vpid).tabs.length, 2, 'both tabs still present (nothing destroyed)');
  });
});

report();
