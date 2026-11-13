/**
 * pane-menu ([≡] dropdown) — mouse on the hit map (docs/mouse-hit-map.md R1).
 *
 *   [1] row ≡ keys: clicking row k == navigating to k + Enter (_paneMenuPick)
 *   [2] wheel over the dropdown steps the cursor
 *   [3] border inert; outside press = Esc (close) via a backdrop BELOW the
 *       chrome band; the dropdown stays on screen at a narrow right edge
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

describe('[1b] double-click a row', () => {
  it('picks once; the second click does not activate the pane row beneath', () => {
    const groups = {};
    for (let i = 0; i < 40; i++) groups[`g${i}`] = { name: `g${i}`, label: `Group ${i}`, containers: [], children: [], parent: null, depth: 0, quick: false,
      actions: { a: { key: 'a', label: 'A', type: 'run', script: 'true', tab: false } } };
    sm.bootFresh({ groups });
    sm.resize(120, 30);
    sm.capture(() => api.dispatchMsg(api.wrap('layout', { type: 'pane_menu_open', paneId: 'pane-groups', cursor: 0, scroll: 0 })));
    hc.paint();
    const r = hc.region(O, 'row:1');
    const g = require('../leaves/wm/geometry').visibleBoundsFor(api.getInstanceSlice('layout'), 'pane-groups');
    const { mx, my } = hc.at(r);
    assert(mx >= g.x && mx < g.x + g.w && my > g.y && my < g.y + g.h - 1, 'precondition: row sits over a groups body row');
    const actions = require('../dispatch/control/actions');
    const calls = [];
    const real = actions.handleAction;
    actions.handleAction = (...a) => { calls.push(a[0]); return real(...a); };
    try { hc.dblclick(mx, my); } finally { actions.handleAction = real; }
    eq(getModel().modes.paneMenuMode, false, 'picked → closed');
    eq(calls.filter(c => c === 'run_selected'), [], 'no pane activate leaked through');
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
  it('an outside press closes it (Esc on a below-chrome backdrop)', () => {
    openMenu();
    const bd = hc.region(O, 'backdrop');
    eq(bd && bd.z, require('../panel/hit-map').BANDS.BELOW_CHROME);
    hc.click(100, 25);
    eq(getModel().modes.paneMenuMode, false);
  });
  it('a narrow right-edge pane: the dropdown shifts left to stay whole (adjacent finding 4)', () => {
    sm.bootFresh();
    sm.capture(() => require('../dispatch/runtime/loop').dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'half' })));
    sm.resize(34, 20);                 // half view: the content slot is 17 wide at x=17
    sm.capture(() => require('../dispatch/runtime/loop').dispatchMsg(api.wrap('layout',
      { type: 'pane_menu_open', paneId: 'pane-detail', cursor: 0, scroll: 0 })));
    const rows = hc.screenRows();
    const box = hc.region(O, 'box');
    assert(box.rect.x + box.rect.w <= 34, 'box inside the screen');
    eq((rows[box.rect.y] || [])[box.rect.x + box.rect.w - 1], '╮', 'top-right corner painted');
    eq((rows[box.rect.y + box.rect.h - 1] || [])[box.rect.x + box.rect.w - 1], '╯', 'bottom-right corner painted');
    sm.capture(() => require('../dispatch/runtime/loop').dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'normal' })));
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
