/**
 * U2f — the UNIFIED tab strip for the (always multi-tab) content slot (visible
 * border strip + matching `[≡]` menu). Run: node js/test/test-position-tab-switcher.js
 *
 * Post-U2f the content slot is a position-tab container seeded with Info +
 * Transcript position-tabs (each its own instance; there is NO hidden `detail`
 * anchor — the viewer Component is gone). Running a `tab:true` action mints its
 * output as a `text-view` position-tab into the slot + activates it, so the strip
 * reads `Info ─ Transcript ─ primary` and only the active bracket moves — running
 * an action ADDS a tab. The `[≡]` menu shows the SAME unified list as the strip.
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

describe('[U2f] picking a position row switches correctly', () => {
  it('picking Transcript (a position row) activates the Transcript text-view tab', () => {
    // U2f — Transcript is a real POSITION-tab (its own text-view instance),
    // seeded alongside Info directly on the content slot (there is NO hidden
    // `detail` anchor anymore). Picking it activates that tab via set_active_tab;
    // the slot stays a text-view instance (Transcript IS a text-view).
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
    eq(paneOf(vpid).tabs.length, 3,
       'all tabs still present (Info + Transcript + primary — no detail anchor)');
  });

  it('picking the action tab (a position row) activates the text-view', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-act-g-primary', 'primary');
    // U2f — switch to the seeded Info position-tab first (there is no `detail`
    // anchor anymore), then back to the action tab via the menu.
    api.dispatchMsg(api.wrap('layout', { type: 'set_active_tab', paneId: vpid, tabPoolId: 'info-pane-detail' }));
    eq(route.instanceKind(vpid), 'info', 'Info position-tab active');
    api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: vpid }));
    const row = (paneMenu.items(vpid) || []).find(r => r && r.label === 'primary');
    assert(row && row.kind === 'position', 'primary is a position row');
    dispatch._paneMenuPick(vpid, row);
    eq(paneOf(vpid).activeTabId, 'tv-act-g-primary', 'action text-view activated');
    // Post-U2f the slot always carries the seeded Info + Transcript tabs plus the
    // minted action tab — nothing is destroyed by switching.
    eq(paneOf(vpid).tabs.length, 3, 'all three tabs still present (nothing destroyed)');
  });
});

describe('[cascade-refactor] activate_tab == the focus_set→set_active_tab cascade (round-4)', () => {
  // The strip-click (input.js) and the pane-menu tab pick (dispatch.js) now
  // dispatch ONE `activate_tab`; the layout reducer emits the focus_set→
  // set_active_tab pair (moving the sequence out of the handler — rule-3). Pin
  // that the combined Msg produces byte-identical end state (focus + active tab).
  function endState(switchFn) {
    sm.bootFresh();                               // content slot starts UNFOCUSED (focus=groups)
    const vpid = route.resolveViewerPaneId();
    mintTextView(vpid, 'tv-x', 'X');              // active becomes tv-x
    const target = paneOf(vpid).tabs.find(t => t.id !== 'tv-x').id;  // a non-active seeded tab
    switchFn(vpid, target);
    const layout = api.getInstanceSlice('layout');
    return { focus: layout.focus, activeTabId: paneOf(vpid).activeTabId, target };
  }
  it('yields the same focus + active tab as the two-Msg cascade', () => {
    const viaCascade = endState((vpid, target) => {
      api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: vpid }));
      api.dispatchMsg(api.wrap('layout', { type: 'set_active_tab', paneId: vpid, tabPoolId: target }));
    });
    const viaCombined = endState((vpid, target) => {
      api.dispatchMsg(api.wrap('layout', { type: 'activate_tab', paneId: vpid, tabPoolId: target }));
    });
    eq(viaCombined.activeTabId, viaCombined.target, 'combined activates the picked tab');
    // The end state (incl. focus_set's downstream show_selected_info) is what
    // must match — the whole point is that ONE Msg == the two-Msg cascade.
    eq(JSON.stringify(viaCombined), JSON.stringify(viaCascade), 'combined == cascade (focus + active tab)');
  });
  it('no-ops on a missing paneId', () => {
    sm.bootFresh();
    const before = JSON.stringify(api.getInstanceSlice('layout').focus);
    api.dispatchMsg(api.wrap('layout', { type: 'activate_tab', tabPoolId: 'whatever' }));
    eq(JSON.stringify(api.getInstanceSlice('layout').focus), before, 'no paneId → slice untouched');
  });
});

report();
