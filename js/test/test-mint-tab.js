/**
 * U2b P2 — mint-into-slot: the mint_tab primitive + the text-view pane type.
 * See docs/one-tab-system.md. Run: node js/test/test-mint-tab.js
 *
 * End-to-end through the real dispatch → finalizer → reconcile path: minting a
 * text-view into a focused slot appends+activates a tab, mints its OWN per-tab
 * instance (cross-kind: text-view beside whatever the slot held), routes keys to
 * it, and preserves both slices across a tab switch.
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const { dispatchMsg } = require('../dispatch/runtime/loop');

// The test-runner auto-registers only layout/detail/groups; register the
// text-view pane type so reconcile can mint its instance (as the fabric smoke
// registers the components its demo places).
const api = sm.api;
if (!api.getComponent('text-view')) api.registerComponent(require('../panel/text-view/text-view'));

function paneAt(focus) {
  const arr = route.getInstanceSlice('layout').arrange;
  for (const col of arr.columns) for (const p of col.panels) if (p.paneId === focus) return p;
  return null;
}

describe('[mint-tab] mint a text-view into the focused slot', () => {
  it('appends + activates a text-view tab and mints its instance', () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    assert(focus, 'a pane is focused on boot');
    const before = paneAt(focus);
    const nTabs = (before.tabs || []).length;

    dispatchMsg(route.wrap('layout', {
      type: 'mint_tab', paneId: focus, paneType: 'text-view', title: 'demo',
      config: { lines: ['line 1', 'line 2', 'line 3', 'line 4'] },
    }));

    const after = paneAt(focus);
    eq(after.tabs.length, nTabs + 1, 'a tab was appended');
    eq(after.activeTabId, 'tv-1', 'the minted tab is active');
    eq(after.type, 'text-view', 'legacy type mirrors the active (text-view) tab');
    // Its OWN per-tab instance (tabInstId = pane-<poolId>) is minted.
    assert(route.getInstance('pane-tv-1'), 'text-view instance minted at pane-tv-1');
    eq(route.getInstance('pane-tv-1').kind, 'text-view');
    // The slot resolves (via the active map) to the text-view slice.
    eq(route.paneTypeOf(focus), 'text-view', 'active tab type');
    eq(route.getInstanceSlice(focus).lines[0], 'line 1', 'text-view content seeded');
  });

  it('minting a tab does NOT mark the layout dirty (session-only tab, not a structural edit)', () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    assert(!route.getInstanceSlice('layout').dirty, 'precondition: clean layout on boot');
    dispatchMsg(route.wrap('layout', {
      type: 'mint_tab', paneId: focus, paneType: 'text-view', title: 'demo', config: { lines: ['x'] },
    }));
    // A minted tab isn't serialized (see the session-transient test below), so
    // opening one must never nag `• unsaved (:save-layout)`.
    assert(!route.getInstanceSlice('layout').dirty, 'mint_tab is transient — must not dirty the layout');
  });

  it('an id collision / reserved type / unknown pane is a no-op', () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    const arrBefore = route.getInstanceSlice('layout').arrange;
    // reserved type
    dispatchMsg(route.wrap('layout', { type: 'mint_tab', paneId: focus, paneType: 'detail', title: 'x' }));
    // unknown pane
    dispatchMsg(route.wrap('layout', { type: 'mint_tab', paneId: 'pane-ghost', paneType: 'text-view', title: 'x' }));
    eq(route.getInstanceSlice('layout').arrange, arrBefore, 'no-ops left arrange ref unchanged');
  });

  it('keys route to the active text-view tab and scroll its own slice', () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    // U2c P0 — the text-view now scrolls VIEWPORT-based through the shared
    // reducer (maxScroll = lines - innerH), like the viewer, not the old U2b
    // line-based clamp. Seed more lines than the pane is tall so `j` can move
    // (a buffer shorter than the viewport has nothing to scroll to).
    dispatchMsg(route.wrap('layout', {
      type: 'mint_tab', paneId: focus, paneType: 'text-view', title: 'demo',
      config: { lines: Array.from({ length: 60 }, (_, i) => `L${i}`) },
    }));
    eq(route.getInstanceSlice(focus).scroll, 0, 'starts at top');
    sm.handleKey('j', 'j');
    eq(route.getInstanceSlice(focus).scroll, 1, 'j scrolled the text-view');
    sm.handleKey('j', 'j');
    sm.handleKey('k', 'k');
    eq(route.getInstanceSlice(focus).scroll, 1, 'j j k nets +1');
  });

  it('search + visual-select route through the shared reducer end-to-end', () => {
    sm.bootFresh();
    const { getModel } = require('../model/store');
    const focus = route.getInstanceSlice('layout').focus;
    dispatchMsg(route.wrap('layout', {
      type: 'mint_tab', paneId: focus, paneType: 'text-view', title: 'demo',
      config: { lines: Array.from({ length: 60 }, (_, i) => `line ${i}`) },
    }));
    // `/` enters search-typing → the mode_set effect arms detailSearchMode on the
    // focused text-view (proves the shared reducer's effects plumb through the real
    // Component key path); escape cancels back out.
    sm.handleKey('/', '/');
    assert(getModel().modes.detailSearchMode, '/ arms detailSearchMode on the text-view');
    sm.handleKey('escape', 'escape');
    assert(!getModel().modes.detailSearchMode, 'escape cancels search-typing');
    // v enters visual mode on the text-view's OWN slice (per-instance selection —
    // the partial D4 collapse); escape exits.
    sm.handleKey('v', 'v');
    assert(route.getInstanceSlice(focus).select.active, 'v enters visual mode on the text-view');
    sm.handleKey('escape', 'escape');
    assert(!route.getInstanceSlice(focus).select.active, 'escape exits visual mode');
  });

  it('switching away and back preserves BOTH tabs’ instances', () => {
    sm.bootFresh();
    const focus = route.getInstanceSlice('layout').focus;
    const origTab = paneAt(focus).activeTabId;   // the slot's original single tab
    dispatchMsg(route.wrap('layout', {
      type: 'mint_tab', paneId: focus, paneType: 'text-view', title: 'demo', config: { lines: ['a', 'b'] },
    }));
    // both instances exist
    assert(route.getInstance('pane-tv-1'), 'text-view instance');
    assert(route.getInstance('pane-' + origTab), 'original tab instance');
    // switch back to the original tab
    dispatchMsg(route.wrap('layout', { type: 'set_active_tab', paneId: focus, tabPoolId: origTab }));
    eq(route.paneTypeOf(focus), paneAt(focus).type, 'active resolves to original tab');
    assert(route.getInstance('pane-tv-1'), 'text-view instance survives the switch (still placed)');
  });
});

describe('[mint-tab] a minted tab is session-transient (not serialized)', () => {
  it(':save-layout output omits the minted pool entry + its tab', () => {
    sm.bootFresh();
    const { serializeLayout, serializePanelsBlock } = require('../feature/yaml-layout');
    const focus = route.getInstanceSlice('layout').focus;
    dispatchMsg(route.wrap('layout', {
      type: 'mint_tab', paneId: focus, paneType: 'text-view', title: 'demo', config: { lines: ['a'] },
    }));
    const arrange = route.getInstanceSlice('layout').arrange;
    const poolYaml = serializePanelsBlock(arrange);
    const layoutYaml = serializeLayout(arrange);
    assert(!poolYaml.includes('tv-1'), 'transient pool entry omitted from panels:');
    assert(!layoutYaml.includes('tv-1'), 'minted tab omitted from layout cells');
    assert(layoutYaml.includes('columns'), 'the rest of the layout still serializes');
  });
});

report();
