/**
 * item-ops leaf — the per-pane item-operation contract (surfaces + context rows).
 *
 * Run: node js/test/test-item-ops.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { BOTTOM, MENU, surfacesOf, hasSurface, bottomOps, menuOps, contextOpRows } = require('../leaves/render/item-ops');

const OPS = [
  { id: 'kill', label: 'Kill', key: 'K' },                       // unset → both
  { id: 'pin', label: 'Pin', surfaces: ['menu'] },               // right-click only
  { id: 'go', label: 'Go', surfaces: ['bottom'] },               // bar only
  { id: 'none', label: 'None', surfaces: [] },                   // explicit [] → NOWHERE
];

describe('[item-ops] surfaces — default both, explicit subset', () => {
  it('surfacesOf: UNSET → both; an explicit array is taken as-is', () => {
    eq(surfacesOf({ id: 'x' }), [BOTTOM, MENU], 'unset → both');
    eq(surfacesOf({ id: 'x', surfaces: [] }), [], 'explicit [] → nowhere (empty subset), NOT both');
    eq(surfacesOf({ id: 'x', surfaces: ['menu'] }), ['menu']);
  });
  it('hasSurface reflects the declaration', () => {
    assert(hasSurface({ surfaces: ['bottom'] }, BOTTOM));
    assert(!hasSurface({ surfaces: ['bottom'] }, MENU));
    assert(hasSurface({}, MENU), 'default op is on every surface');
    assert(!hasSurface({ surfaces: [] }, BOTTOM), 'explicit [] is on no surface');
  });
});

describe('[item-ops] bottomOps / menuOps — per-surface projection', () => {
  it('bottomOps keeps unset + bottom-declared; drops an explicit-[] op', () => {
    eq(bottomOps(OPS).map(o => o.id), ['kill', 'go']);
  });
  it('menuOps keeps unset + menu-declared; drops an explicit-[] op', () => {
    eq(menuOps(OPS).map(o => o.id), ['kill', 'pin']);
  });
  it('empty / nullish → []', () => { eq(bottomOps([]), []); eq(menuOps(null), []); });
});

describe('[item-ops] contextOpRows — right-click menu rows', () => {
  it('one [label, pane_item_action, {paneId,id,item}] row per menu-surface op', () => {
    eq(contextOpRows('procs', '4242', OPS), [
      ['Kill', 'pane_item_action', { paneId: 'procs', id: 'kill', item: '4242' }],
      ['Pin', 'pane_item_action', { paneId: 'procs', id: 'pin', item: '4242' }],
    ]);
  });
  it('bottom-only and nowhere ops are excluded from the menu', () => {
    assert(!contextOpRows('p', 'x', OPS).some(r => r[2].id === 'go'), 'the bar-only "go" op is not offered on right-click');
    assert(!contextOpRows('p', 'x', OPS).some(r => r[2].id === 'none'), 'the nowhere "none" op is not offered on right-click');
  });
  it('no item under the pointer → [] (nothing to act on)', () => {
    eq(contextOpRows('procs', null, OPS), []);
    eq(contextOpRows('procs', undefined, OPS), []);
  });
});

report();
