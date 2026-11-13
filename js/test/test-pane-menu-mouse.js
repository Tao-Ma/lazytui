/**
 * pane-menu ([≡] dropdown) — mouse on the hit map (docs/mouse-hit-map.md R1).
 *
 *   [1] row ≡ keys: clicking row k == navigating to k + Enter (_paneMenuPick)
 *   [2] wheel over the dropdown steps the cursor
 *   [3] border inert; outside press still closes (legacy arm, until R2)
 *   [4] pane_menu_nav { to } — absolute, clamped, skips nothing it shouldn't
 *
 * Run: node js/test/test-pane-menu-mouse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const api = sm.api;
const { getModel } = require('../app/runtime');

const O = 'pane-menu';
const pm = () => api.getInstanceSlice('layout').paneMenu || {};

function openMenu() {
  sm.bootFresh();
  sm.resize(120, 30);
  sm.capture(() => api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups', cursor: 0, scroll: 0 })));
  hc.paint();
}
const rows = () => hc.regions(O).filter(r => r.id.startsWith('row:'));

describe('[1] row ≡ keys', () => {
  it('the dropdown publishes at least two rows', () => {
    openMenu();
    eq(getModel().modes.paneMenuMode, true);
    assert(rows().length >= 2, `rows: ${rows().map(r => r.id)}`);
  });
  it('clicking row 1 leaves the same layout as down + Enter', () => {
    openMenu();
    sm.capture(() => { sm.handleKey('down', 'j'); sm.handleKey('return', '\r'); });
    const viaKeys = JSON.stringify({ modes: getModel().modes, layout: api.getInstanceSlice('layout') });
    openMenu();
    hc.clickRegion(O, 'row:1');
    eq(JSON.stringify({ modes: getModel().modes, layout: api.getInstanceSlice('layout') }), viaKeys);
    eq(getModel().modes.paneMenuMode, false, 'picked → closed');
  });
});

describe('[2] wheel', () => {
  it('steps the cursor', () => {
    openMenu();
    hc.wheelRegion(O, 'box', 'down');
    eq(pm().cursor, 1);
    hc.wheelRegion(O, 'box', 'up');
    eq(pm().cursor, 0);
  });
});

describe('[3] border / outside', () => {
  it('a border click is consumed; the menu stays open', () => {
    openMenu();
    const box = hc.region(O, 'box');
    hc.click(box.rect.x + 2, box.rect.y);
    eq(getModel().modes.paneMenuMode, true);
  });
  it('an outside press closes it (legacy arm until R2)', () => {
    openMenu();
    eq(hc.region(O, 'backdrop'), null, 'no backdrop in R1');
    hc.click(100, 25);
    eq(getModel().modes.paneMenuMode, false);
  });
});

describe('[4] pane_menu_nav { to }', () => {
  it('absolute + clamped', () => {
    openMenu();
    sm.capture(() => api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_nav', to: 1, n: 3, vh: 3, sepIdx: -1 })));
    eq(pm().cursor, 1);
    sm.capture(() => api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_nav', to: 9, n: 3, vh: 3, sepIdx: -1 })));
    eq(pm().cursor, 2, 'clamped');
  });
});

report();
