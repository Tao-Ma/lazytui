/**
 * U2b P1 — full per-tab instance model (K3). See docs/one-tab-system.md.
 * Run: node js/test/test-per-tab-instance.js
 *
 * Pins: the paneId → active-tab-instance resolution (a slot resolves to its
 * ACTIVE tab's instance; a non-active tab stays addressable by its own id), and
 * that a booted single-tab layout is byte-identical (every pane keyed at
 * pane-<poolId> = its paneId, so the map is identity).
 */
'use strict';

const route = require('../panel/route');
const { describe, it, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');

function reset() { route._resetRegistryForTest(); }

describe('[per-tab-instance] active-instance map resolution (K3)', () => {
  it('single-tab identity: a paneId whose active tab is itself resolves directly', () => {
    reset();
    route.setInstance('pane-groups', 'groups', { nav: { cursor: 3 } });
    route.setActiveInstanceMap({ 'pane-groups': 'pane-groups' });
    eq(route.getInstanceSlice('pane-groups').nav.cursor, 3);
    assert(route.hasInstance('pane-groups'));
  });

  it('multi-tab divert: a slot paneId resolves to its ACTIVE tab instance', () => {
    reset();
    route.setInstance('pane-a', 'x', { v: 'A' });   // tab a
    route.setInstance('pane-b', 'y', { v: 'B' });   // tab b (same slot, active)
    route.setActiveInstanceMap({ 'pane-a': 'pane-b' });   // slot 'pane-a', active = b
    eq(route.getInstanceSlice('pane-a').v, 'B', 'paneId resolves to the active tab (b)');
    assert(route.hasInstance('pane-a'), 'hasInstance follows the map');
    // getInstance stays LITERAL — the inactive tab is addressable by its own id.
    eq(route.getInstance('pane-a').slice.v, 'A', 'getInstance is literal → tab a');
    eq(route.getInstance('pane-b').slice.v, 'B');
  });

  it('setInstanceSlice writes to the ACTIVE tab via the map', () => {
    reset();
    route.setInstance('pane-a', 'x', { v: 'A' });
    route.setInstance('pane-b', 'y', { v: 'B' });
    route.setActiveInstanceMap({ 'pane-a': 'pane-b' });
    route.setInstanceSlice('pane-a', { v: 'B2' });
    eq(route.getInstance('pane-b').slice.v, 'B2', 'wrote to active tab b');
    eq(route.getInstance('pane-a').slice.v, 'A', 'inactive tab a untouched');
  });

  it('restoreInstanceSlice is LITERAL — restores a non-active tab by its own id', () => {
    reset();
    route.setInstance('pane-a', 'x', { v: 'A0' });   // tab a (non-active)
    route.setInstance('pane-b', 'y', { v: 'B0' });   // tab b (active)
    route.setActiveInstanceMap({ 'pane-a': 'pane-b' });
    // The routed write (setInstanceSlice) diverts a paneId to the ACTIVE tab —
    // which is why replay restore must NOT use it (it would lose tab a's slice).
    route.setInstanceSlice('pane-a', { v: 'DIVERTED' });
    eq(route.getInstance('pane-b').slice.v, 'DIVERTED', 'setInstanceSlice(paneId) hit the active tab');
    eq(route.getInstance('pane-a').slice.v, 'A0', 'non-active tab untouched by the routed write');
    // restoreInstanceSlice bypasses the divert — writes the non-active tab itself.
    route.restoreInstanceSlice('pane-a', { v: 'A_RESTORED' });
    eq(route.getInstance('pane-a').slice.v, 'A_RESTORED', 'literal write hit the non-active tab');
    eq(route.getInstance('pane-b').slice.v, 'DIVERTED', 'active tab untouched by the literal write');
  });

  it('activeInstanceOf resolves a mapped paneId; passes non-paneIds through', () => {
    reset();
    route.setActiveInstanceMap({ 'pane-a': 'pane-b' });
    eq(route.activeInstanceOf('pane-a'), 'pane-b');
    eq(route.activeInstanceOf('layout'), 'layout', 'a service kind passes through');
    eq(route.activeInstanceOf('pane-z'), 'pane-z', 'an unmapped paneId passes through');
  });
});

describe('[per-tab-instance] booted single-tab layout is byte-identical', () => {
  it('every placed pane resolves its slice + type; instance keyed at pane-<poolId>', () => {
    sm.bootFresh();
    const layout = route.getInstanceSlice('layout');
    let checked = 0;
    for (const col of layout.arrange.columns) {
      for (const p of col.panels) {
        // A single-tab pane's active-instance id is pane-<activeTab poolId>,
        // which equals its paneId — the identity that makes the map a no-op.
        const tabInstId = route.activeInstanceOf(p.paneId);
        // Skip panes whose Component isn't registered in the test harness (no
        // instance minted) — they use the kind-primary/default path, identical
        // pre/post U2b.
        if (!route.getInstance(tabInstId)) continue;
        eq(tabInstId, 'pane-' + (p.activeTabId || p.id), `${p.paneId} active instance keyed at pane-<poolId>`);
        assert(route.getInstanceSlice(p.paneId) !== undefined, `slice resolves via ${p.paneId}→active`);
        eq(route.paneTypeOf(p.paneId), p.type, `paneTypeOf(${p.paneId})`);
        checked++;
      }
    }
    assert(checked >= 2, 'verified the registered single-tab panes (groups + detail)');
  });
});

report();
