/**
 * item-ops leaf — the per-pane item-operation contract (surfaces + context rows).
 *
 * Run: node js/test/test-item-ops.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { BOTTOM, MENU, surfacesOf, hasSurface, bottomOps, menuOps, contextOpRows } = require('../leaves/render/item-ops');

const OPS = [
  { id: 'kill', label: 'Kill', key: 'K' },                       // default → both
  { id: 'pin', label: 'Pin', surfaces: ['menu'] },               // right-click only
  { id: 'go', label: 'Go', surfaces: ['bottom'] },               // bar only
  { id: 'none', label: 'None', surfaces: [] },                   // empty → treated as default (both)
];

describe('[item-ops] surfaces — default both, explicit filters', () => {
  it('surfacesOf defaults to both when unset/empty', () => {
    eq(surfacesOf({ id: 'x' }), [BOTTOM, MENU]);
    eq(surfacesOf({ id: 'x', surfaces: [] }), [BOTTOM, MENU]);
    eq(surfacesOf({ id: 'x', surfaces: ['menu'] }), ['menu']);
  });
  it('hasSurface reflects the declaration', () => {
    assert(hasSurface({ surfaces: ['bottom'] }, BOTTOM));
    assert(!hasSurface({ surfaces: ['bottom'] }, MENU));
    assert(hasSurface({}, MENU), 'default op is on every surface');
  });
});

describe('[item-ops] bottomOps / menuOps — per-surface projection', () => {
  it('bottomOps keeps default + bottom-declared', () => {
    eq(bottomOps(OPS).map(o => o.id), ['kill', 'go', 'none']);
  });
  it('menuOps keeps default + menu-declared', () => {
    eq(menuOps(OPS).map(o => o.id), ['kill', 'pin', 'none']);
  });
  it('empty / nullish → []', () => { eq(bottomOps([]), []); eq(menuOps(null), []); });
});

describe('[item-ops] contextOpRows — right-click menu rows', () => {
  it('one [label, pane_item_action, {paneId,id,item}] row per menu-surface op', () => {
    eq(contextOpRows('procs', '4242', OPS), [
      ['Kill', 'pane_item_action', { paneId: 'procs', id: 'kill', item: '4242' }],
      ['Pin', 'pane_item_action', { paneId: 'procs', id: 'pin', item: '4242' }],
      ['None', 'pane_item_action', { paneId: 'procs', id: 'none', item: '4242' }],
    ]);
  });
  it('bottom-only ops are excluded from the menu', () => {
    assert(!contextOpRows('p', 'x', OPS).some(r => r[2].id === 'go'), 'the bar-only "go" op is not offered on right-click');
  });
  it('no item under the pointer → [] (nothing to act on)', () => {
    eq(contextOpRows('procs', null, OPS), []);
    eq(contextOpRows('procs', undefined, OPS), []);
  });
});

report();
