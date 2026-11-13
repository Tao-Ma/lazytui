/**
 * menu (x command list / right-click context menu) — mouse, on the hit map
 * (docs/mouse-hit-map.md Release 1).
 *
 *   [1] double-click an item → ONE activation; the pane beneath never fires
 *       (pre-existing leak: the second click fell through to the pane's
 *       double-click `activate` → run_selected once the menu had closed)
 *   [2] rows: press / right / middle activate the item under the pointer;
 *       separators and borders are inert; rows follow the scroll window
 *   [3] wheel steps the highlight; outside click (any button) closes
 *
 * Run: node js/test/test-menu-mouse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const actions = require('../dispatch/control/actions');
const geo = require('../leaves/wm/geometry');
const { getModel } = require('../app/runtime');

const O = 'menu';

function manyGroups(n) {
  const out = {};
  for (let i = 0; i < n; i++) {
    out[`g${i}`] = { name: `g${i}`, label: `Group ${i}`, containers: [], children: [], parent: null, depth: 0, quick: false,
                     actions: { a: { key: 'a', label: 'A', type: 'run', script: 'true', tab: false } } };
  }
  return out;
}
// Items run harmless verbs; handleAction is spied (call-through) to observe.
const ITEMS = [['Down', 'nav_down'], ['Up', 'nav_up'], null, ['Down again', 'nav_down']];

function openMenu(items, anchor) {
  sm.bootFresh({ groups: manyGroups(40) });
  sm.resize(120, 30);
  sm.capture(() => sm.applyMsg({ type: 'menu_open', items: items || ITEMS, anchor: anchor || { x: 3, y: 8 }, title: 'Actions' }));
  hc.paint();
}
// Verbs reach handleAction two ways: a menu item via the menu_action effect
// (dispatch.handleAction), the pane's double-click intent via actions.handleAction.
const dispatch = require('../dispatch/control/dispatch');
function spyActions(fn) {
  const calls = [];
  const realA = actions.handleAction, realD = dispatch.handleAction;
  actions.handleAction = (...a) => { calls.push(a[0]); return realA(...a); };
  dispatch.handleAction = (...a) => { calls.push(a[0]); return realD(...a); };
  try { fn(); } finally { actions.handleAction = realA; dispatch.handleAction = realD; }
  return calls;
}
// Menu box geometry (shared overlayBox) → the screen cell of item i.
function itemCell(i) {
  const { overlayBox } = require('../leaves/render/draw');
  const m = getModel().modal.menu;
  const { offX, offY } = overlayBox({ linesLen: m.items.length, anchor: m.anchor, maxWidth: 44 });
  return { mx: offX + 3, my: offY + 1 + i };
}

describe('[1] double-click an item', () => {
  it('activates once; the groups row beneath is NOT activated', () => {
    openMenu();
    const { mx, my } = itemCell(0);
    const g = geo.visibleBoundsFor(sm.api.getInstanceSlice('layout'), 'pane-groups');
    assert(g && mx >= g.x && mx < g.x + g.w && my > g.y && my < g.y + g.h - 1,
           'precondition: the item cell sits over a groups-pane body row');
    // Two raw presses at the same cell, nothing before them (the helper's
    // off-screen reset press would itself dismiss a legacy menu).
    const input = require('../dispatch/control/input');
    const press = `\x1b[<0;${mx + 1};${my + 1}M`;
    const calls = spyActions(() => sm.capture(() => { input._dispatchToken(press); input._dispatchToken(press); }));
    eq(calls.filter(c => c === 'run_selected'), [], 'no pane activate leaked through');
    eq(calls.filter(c => c === 'nav_down').length, 1, 'the item ran exactly once');
  });
});

describe('[2] rows', () => {
  for (const [label, button] of [['press', 0], ['right-click', 2], ['middle-click', 1]]) {
    it(`${label} on item 1 activates THAT item (not the highlighted one)`, () => {
      openMenu();
      eq(getModel().modal.menu.idx, 0);
      const calls = spyActions(() => hc.clickRegion(O, 'row:1', button));
      eq(calls, ['nav_up']);
      eq(getModel().modes.menuOpen, false);
    });
  }
  it('the separator row and the border are inert (consumed, menu stays open)', () => {
    openMenu();
    eq(hc.region(O, 'row:2'), null, 'separator publishes no row');
    const box = hc.region(O, 'box');
    const calls = spyActions(() => { hc.click(box.rect.x + 3, box.rect.y + 3); hc.click(box.rect.x, box.rect.y); });
    eq(calls, []);
    eq(getModel().modes.menuOpen, true);
  });
  it('rows follow the scroll window: the first visible row maps to the scrolled item', () => {
    const items = Array.from({ length: 60 }, (_, i) => [`ITEM_${i}`, 'nav_down']);
    sm.bootFresh();
    sm.resize(120, 30);
    sm.capture(() => sm.applyMsg({ type: 'menu_open', items, anchor: null }));
    for (let i = 0; i < 59; i++) sm.capture(() => sm.applyMsg({ type: 'menu_nav', dir: +1 }));
    hc.paint();
    const rows = hc.regions(O).filter(r => r.id.startsWith('row:'));
    const first = rows.reduce((a, b) => (a.rect.y < b.rect.y ? a : b));
    const box = hc.region(O, 'box');
    eq(first.rect.y, box.rect.y + 1, 'topmost row sits right under the top border');
    assert(hc.paintedText(O, first.id).includes(`ITEM_${first.id.slice(4)}`), 'row id matches the painted item');
    assert(Number(first.id.slice(4)) > 0, 'scrolled: the first visible row is not item 0');
  });
});

describe('[2b] double-click a row that opens a submenu in place', () => {
  it('the submenu stays open (the 2nd click is swallowed, not turned into Esc)', () => {
    sm.bootFresh();
    sm.resize(120, 30);
    require('../dispatch/runtime/host-wiring').wireFabricHost();
    const ports = require('../fabric/ports');
    const realList = ports.listPorts;
    ports.listPorts = () => [{ dir: 'in', component: 'svc', port: 'note', type: 'text' }];
    try {
      // The submenu row sits LOW (row 5) so the shorter port picker that replaces
      // the menu no longer covers that cell — the second click lands on the
      // backdrop, which must swallow it rather than press Esc.
      const items = [['Copy line', 'copy_text', 'a'], ['Copy word', 'copy_text', 'b'], ['Copy path', 'copy_text', 'c'],
                     ['Down', 'nav_down'], ['Up', 'nav_up'], ['Send selection to port…', 'send_to_port', 'hello']];
      sm.capture(() => sm.applyMsg({ type: 'menu_open', items, title: 'Actions', anchor: { x: 20, y: 5 } }));
      hc.paint();
      const cell = hc.at(hc.region(O, 'row:5'));
      hc.dblclickRegion(O, 'row:5');
      eq(getModel().modes.menuOpen, true, 'the port picker is still open');
      hc.paint();
      const at = require('../panel/hit-map').resolve(cell.mx, cell.my, 'press');
      eq(at && at.region.id, 'backdrop', 'precondition: after the swap the cell is on the backdrop');
      const labels = getModel().modal.menu.items.map(r => r && r[0]);
      assert(labels.some(l => l && l.includes('svc.note')), `picker shown: ${JSON.stringify(labels)}`);
    } finally { ports.listPorts = realList; }
  });
});

describe('[3] wheel / outside', () => {
  it('wheel moves the highlight (skipping the separator)', () => {
    openMenu();
    hc.wheelRegion(O, 'box', 'down');
    eq(getModel().modal.menu.idx, 1);
    hc.wheelRegion(O, 'box', 'down');
    eq(getModel().modal.menu.idx, 3, 'separator skipped');
  });
  for (const [label, button] of [['click', 0], ['right-click', 2]]) {
    it(`an outside ${label} closes without running anything`, () => {
      openMenu();
      const calls = spyActions(() => hc.click(100, 25, button));
      eq(calls, []);
      eq(getModel().modes.menuOpen, false);
    });
  }
});

report();
