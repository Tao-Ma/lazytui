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

describe('[U2f] the content slot is ALWAYS a multi-tab unified strip', () => {
  // U2e P1b — the content slot is seeded with Info + Transcript position-tabs
  // (over a hidden `detail` anchor), so it is NEVER a single-tab slot: the
  // unified strip and the `[≡]` slot rows are present from boot. (The old
  // "single-tab keeps its flat-strip" premise is retired — there is no
  // single-tab content slot to fall back to.)
  it('the seeded slot exposes unified position rows (Info | Transcript) at boot', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    const rows = paneMenu.items(vpid) || [];
    assert(rows.length && rows.every(r => r && r.backing === 'slot'), 'unified slot rows present at boot');
    eq(rows.map(r => r.label).join(','), 'Info,Transcript', 'the two seeded position-tabs (detail anchor hidden)');
    assert(rows.every(r => r.kind === 'position'), 'every row is a position-tab (no flat expansion)');
    const strip = unifiedSlotStrip(paneOf(vpid));
    assert(strip && Array.isArray(strip.entries), 'unifiedSlotStrip non-null for the seeded slot');
    eq(strip.entries.map(e => e.label).join(','), 'Info,Transcript', 'strip lists the two seeded tabs');
    assert(!strip.entries.some(e => e.label === 'Detail'), 'the detail anchor is hidden from the strip');
  });
});

describe('[U2f] running an action ADDS a position-tab to the unified strip', () => {
  // U2e P1b — Info/Transcript are now sibling POSITION-tabs (each its own
  // instance), seeded over the hidden `detail` anchor. Minting an action's
  // text-view appends one more position-tab, so the strip reads
  // `Info | Transcript | primary` and only the active bracket moves.
  it('the strip lists the seeded tabs + the action tab (Info/Transcript/primary), primary active', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    const strip = unifiedSlotStrip(paneOf(vpid));
    const labels = strip.entries.map(e => e.label);
    eq(labels.join(','), 'Info,Transcript,primary', 'seeded position-tabs + the action tab');
    eq(strip.entries[strip.activeIdx].label, 'primary', 'the just-run action tab is active');
    // No standalone "Detail" entry — the anchor is hidden from the strip.
    assert(!labels.includes('Detail'), 'the detail anchor is hidden, not shown as a "Detail" entry');
    assert(strip.entries.every(e => e.kind === 'position'), 'every entry is a position-tab');
  });

  it('the [≡] menu shows the SAME rows (menu ≡ strip)', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    const rows = paneMenu.items(vpid) || [];
    assert(rows.length >= 3 && rows.every(r => r && r.backing === 'slot'), 'unified slot rows');
    eq(rows.map(r => r.label).join(','), 'Info,Transcript,primary', 'menu matches the strip');
    assert(paneMenu.triggerVisible(vpid), '[≡] trigger shows on the multi-tab slot');
  });

  it('the visible border strip renders the position-tab labels', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    const pane = paneOf(vpid);
    const tv = require('../panel/text-view/text-view');
    const out = tv.panelTypes['text-view'].render(pane, 60, 8, api.getInstanceSlice(vpid), { focused: true });
    const text = Array.isArray(out) ? out.join('\n') : String(out);
    assert(/Info/.test(text) && /Transcript/.test(text), 'seeded position-tabs VISIBLE in the strip');
    assert(/primary/.test(text), 'the action tab is visible');
  });
});

describe('[stopgap] picking a position row switches correctly', () => {
  it('picking Transcript (a position row) activates the Transcript text-view tab', () => {
    // U2e P1b — Transcript is now a real POSITION-tab (its own text-view
    // instance), not the viewer's inner flat tab. Picking it activates that
    // tab directly via set_active_tab; the slot stays a text-view instance
    // (Transcript IS a text-view), so there's no inner `slice.tab` flip.
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    eq(route.instanceKind(vpid), 'text-view', 'text-view active before pick');
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: vpid }));
    const row = (paneMenu.items(vpid) || []).find(r => r && r.label === 'Transcript');
    assert(row && row.kind === 'position', 'Transcript is a position row');
    dispatch._paneMenuPick(vpid, row);
    eq(paneOf(vpid).activeTabId, 'transcript-pane-detail', 'Transcript position-tab activated');
    eq(route.instanceKind(vpid), 'text-view', 'the Transcript tab is a text-view instance');
    eq(paneOf(vpid).tabs.length, 4,
       'all tabs still present (detail anchor + Info + Transcript + primary)');
  });

  it('picking the action tab (a position row) activates the text-view', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    // Switch to the detail anchor first, then back to the action tab via the menu.
    api.dispatchMsg(api.wrap('layout', { type: 'set_active_tab', paneId: vpid, tabPoolId: 'detail' }));
    eq(route.instanceKind(vpid), 'detail', 'detail anchor active');
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: vpid }));
    const row = (paneMenu.items(vpid) || []).find(r => r && r.label === 'primary');
    assert(row && row.kind === 'position', 'primary is a position row');
    dispatch._paneMenuPick(vpid, row);
    eq(paneOf(vpid).activeTabId, 'tv-act-g-primary', 'action text-view activated');
    // Post-P1b the slot always carries the seeded detail/Info/Transcript tabs
    // plus the minted action tab — nothing is destroyed by switching.
    eq(paneOf(vpid).tabs.length, 4, 'all four tabs still present (nothing destroyed)');
  });
});

report();
