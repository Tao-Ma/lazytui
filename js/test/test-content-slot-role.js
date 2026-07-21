/**
 * U2e P1a — the content-slot `role` marker + role-based viewer-slot resolution.
 * See /root/.claude/plans/u2e-viewer-dissolution.md. Run: node js/test/test-content-slot-role.js
 *
 * "The viewer slot" (where Info / output / opened files / terminals land, and the
 * half/full-view geometry reference) is identified by a STABLE `pane.role` marker
 * instead of by the instance kind occupying it. P1a stamps the role (derived from
 * the `detail` pane today — behaviour-preserving) and re-points `resolveViewerPaneId`
 * at it. The load-bearing invariant these tests pin: the role SURVIVES the active
 * tab's kind changing — which is exactly what P1b relies on when the default tab
 * becomes `info` and no `detail` instance exists.
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const mpane = require('../leaves/wm/pane');
const sm = require('./smoke/_helpers/smoke');
const route = sm.route;
const api = sm.api;

describe('[P1a] wrapAsPane stamps role only on the content (detail) slot', () => {
  it('a detail pane gets role=content', () => {
    const p = mpane.wrapAsPane({ id: 'd', type: 'detail', title: 'D' }, 'pane-d');
    eq(p.role, 'content', 'detail → role content');
  });
  it('a non-content pane gets no role', () => {
    const p = mpane.wrapAsPane({ id: 'f', type: 'files', title: 'F' }, 'pane-f');
    eq(p.role, undefined, 'files → no role');
  });
});

describe('[P1a] the role survives the active tab changing kind (the P1b invariant)', () => {
  it('minting + activating a non-detail tab keeps role=content while pane.type flips', () => {
    const pane = mpane.wrapAsPane({ id: 'd', type: 'detail', title: 'D' }, 'pane-d');
    eq(pane.role, 'content');
    eq(pane.type, 'detail');
    // Mint a text-view tab and activate it (the U2b mint-into-slot primitive).
    const tvEntry = { id: 'tv-1', type: 'text-view', title: 'TV', config: {} };
    const next = mpane.addTab(pane, { id: 'tv-1', poolId: 'tv-1' }, tvEntry, { activate: true });
    eq(next.type, 'text-view', 'active tab kind flipped to text-view');
    eq(next.role, 'content', 'role PRESERVED across the activation (slot identity is stable)');
  });
  it('setActiveTab back to the detail tab keeps role', () => {
    let pane = mpane.wrapAsPane({ id: 'd', type: 'detail', title: 'D' }, 'pane-d');
    const tvEntry = { id: 'tv-1', type: 'text-view', title: 'TV', config: {} };
    pane = mpane.addTab(pane, { id: 'tv-1', poolId: 'tv-1' }, tvEntry, { activate: true });
    const back = mpane.setActiveTab(pane, 'd', { id: 'd', type: 'detail', title: 'D', config: {} });
    eq(back.type, 'detail', 'active back to detail');
    eq(back.role, 'content', 'role still content');
  });
  it('removeTab keeps role on the surviving pane', () => {
    let pane = mpane.wrapAsPane({ id: 'd', type: 'detail', title: 'D' }, 'pane-d');
    const tvEntry = { id: 'tv-1', type: 'text-view', title: 'TV', config: {} };
    pane = mpane.addTab(pane, { id: 'tv-1', poolId: 'tv-1' }, tvEntry, { activate: true });
    const pool = { 'd': { id: 'd', type: 'detail', title: 'D', config: {} },
                   'tv-1': tvEntry };
    const r = mpane.removeTab(pane, 'tv-1', pool);
    assert(r && r.pane, 'removeTab returned a pane');
    eq(r.pane.role, 'content', 'role preserved after removing the extra tab');
  });
});

describe('[P1a] resolveViewerPaneId resolves the slot by role', () => {
  it('the booted content slot resolves + carries role=content', () => {
    sm.bootFresh();
    const vpid = route.resolveViewerPaneId();
    assert(vpid, 'a content slot resolves');
    const layout = api.getInstanceSlice('layout');
    let found = null;
    for (const col of (layout.arrange.columns || [])) {
      for (const p of (col.panels || [])) if (p.paneId === vpid) found = p;
    }
    assert(found, 'resolved paneId is a placed pane');
    eq(found.role, 'content', 'the resolved slot carries role=content');
  });
});

report();
