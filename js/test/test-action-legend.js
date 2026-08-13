/**
 * action-legend — the item-action bar border-control kind (bottom slot). Pins
 * the label row / width, the per-action click regions (the paint ↔ hit-test
 * source), and the spec (focus-gated render + dispatch → item_action).
 *
 * Run: node js/test/test-action-legend.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const al = require('../leaves/render/action-legend');

const acts = [{ id: 'inspect', label: 'inspect' }, { id: 'stop', label: 'stop' }, { id: 'kill', label: 'kill' }];

describe('[action-legend] text + regions', () => {
  it('text = labels joined by a space; width = its length', () => {
    const { text, visibleW } = al.actionLegendText(acts);
    eq(text, 'inspect stop kill');
    eq(visibleW, 17);
  });
  it('one region per label; the separators between them are gaps (misses)', () => {
    const r = al.actionLegendRegions(2, 5, acts);
    eq(r[0], { x0: 2,  x1: 8,  y: 5, action: 'inspect' });   // 'inspect' (7): 2..8
    eq(r[1], { x0: 10, x1: 13, y: 5, action: 'stop' });      // gap at 9;  'stop' (4): 10..13
    eq(r[2], { x0: 15, x1: 18, y: 5, action: 'kill' });      // gap at 14; 'kill' (4): 15..18
  });
});

describe('[action-legend] spec', () => {
  let item = 'web';
  const spec = al.actionLegendSpec({ actions: acts, itemAt: () => item });
  it('slot is bottom; renders on a FOCUSED pane only, never in free-config', () => {
    eq(spec.slot, 'bottom');
    eq(spec.render({ modes: {} }, { paneId: 'p', focused: false }), null);
    eq(spec.render({ modes: { freeConfigMode: true } }, { paneId: 'p', focused: true }), null);
    eq(spec.render({ modes: {} }, { paneId: 'p', focused: true }).text, 'inspect stop kill');
  });
  it('dispatch → item_action against the selected item, routed to the clicked pane', () => {
    eq(spec.dispatch('kill', { paneId: 'p', type: 'containers' }),
       { owner: 'p', msg: { type: 'item_action', action: 'kill', item: 'web' } });
  });
  it('dispatch is a no-op (null) when the pane has no selection', () => {
    item = undefined;
    eq(spec.dispatch('kill', { paneId: 'p', type: 'containers' }), null);
  });
});

report();
