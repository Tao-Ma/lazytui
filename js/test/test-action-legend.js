/**
 * action-legend — the item-action bar (bottom slot), btop-style in-word key
 * highlight + width-adaptive full/compact. Pins the form choice, the rendered
 * markup (key highlighted, `label[0] === key`), the per-form click regions, and
 * the spec (focus-gated render + dispatch → item_action).
 *
 * Run: node js/test/test-action-legend.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const al = require('../leaves/render/action-legend');
const { stripMarkup } = require('../leaves/text/ansi');

// Mirrors docker's real list: label[0] IS the key (case-sensitive).
const acts = [
  { id: 'inspect', label: 'inspect', key: 'i' },
  { id: 'logs',    label: 'Logs',    key: 'L' },
  { id: 'shell',   label: 'shell',   key: 's' },
  { id: 'stop',    label: 'Stop',    key: 'S' },
];

describe('[action-legend] label[0] === key (in-word highlight is the key)', () => {
  it('every action label starts with its trigger key', () => {
    for (const a of acts) eq(a.label[0], a.key, a.id);
  });
});

describe('[action-legend] width-adaptive form', () => {
  // fullW = 7+4+5+4 + 3 gaps = 23; compactW = 4 keys + 3 gaps = 7.
  it('picks full when it fits, compact when only keys fit, null when nothing fits', () => {
    eq(al._form(acts, 30), 'full');       // 23 <= 30-1
    eq(al._form(acts, 20), 'compact');    // 23 too wide; 7 fits
    eq(al._form(acts, 6),  null);         // 7 needs innerW>=9
  });
});

describe('[action-legend] render — key highlighted, rest plain', () => {
  it('full form shows whole labels with the first letter (the key) colored', () => {
    const { text, visibleW } = al.actionLegendRender(acts, 30);
    eq(stripMarkup(text), 'inspect Logs shell Stop');
    eq(visibleW, 23);
    assert(/\[[^\]]+\]i\[\/\]nspect/.test(text), 'i of inspect is wrapped in a color');
    assert(/\[[^\]]+\]L\[\/\]ogs/.test(text), 'L of Logs is wrapped in a color');
  });
  it('compact form shows only the colored key letters', () => {
    const { text, visibleW } = al.actionLegendRender(acts, 20);
    eq(stripMarkup(text), 'i L s S');
    eq(visibleW, 7);
  });
  it('null when it does not fit at all', () => {
    eq(al.actionLegendRender(acts, 6), null);
  });
});

describe('[action-legend] regions match the chosen form', () => {
  it('full → each region spans the whole word', () => {
    const r = al.actionLegendRegions(2, 9, acts, 30);
    eq(r[0], { x0: 2,  x1: 8,  y: 9, action: 'inspect' });   // 'inspect' (7): 2..8
    eq(r[1], { x0: 10, x1: 13, y: 9, action: 'logs' });      // gap at 9; 'Logs' (4): 10..13
    eq(r[3], { x0: 21, x1: 24, y: 9, action: 'stop' });
  });
  it('compact → each region is the single key cell', () => {
    const r = al.actionLegendRegions(2, 9, acts, 20);
    eq(r[0], { x0: 2, x1: 2, y: 9, action: 'inspect' });
    eq(r[1], { x0: 4, x1: 4, y: 9, action: 'logs' });        // gap at 3
    eq(r[3], { x0: 8, x1: 8, y: 9, action: 'stop' });
  });
});

describe('[action-legend] spec', () => {
  let item = 'web';
  const spec = al.actionLegendSpec({ actions: acts, itemAt: () => item });
  it('slot bottom; renders on a focused pane only, never in free-config', () => {
    eq(spec.slot, 'bottom');
    eq(spec.render({ modes: {} }, { paneId: 'p', focused: false, innerW: 40 }), null);
    eq(spec.render({ modes: { freeConfigMode: true } }, { paneId: 'p', focused: true, innerW: 40 }), null);
    assert(spec.render({ modes: {} }, { paneId: 'p', focused: true, innerW: 40 }).text);
  });
  it('dispatch → item_action against the selected item; null when nothing selected', () => {
    eq(spec.dispatch('kill', { paneId: 'p', type: 'containers' }),
       { owner: 'p', msg: { type: 'item_action', action: 'kill', item: 'web' } });
    item = undefined;
    eq(spec.dispatch('kill', { paneId: 'p', type: 'containers' }), null);
  });
});

describe('[action-legend] quick_keys placement gate', () => {
  const spec = al.actionLegendSpec({ actions: acts, itemAt: () => 'web' });
  const pane = { paneId: 'p', focused: true, innerW: 40 };
  it('renders in border mode + by default; suppressed in footer / off', () => {
    assert(spec.render({ modes: {}, config: { quick_keys: 'border' } }, pane));
    assert(spec.render({ modes: {}, config: {} }, pane), 'default = border');
    eq(spec.render({ modes: {}, config: { quick_keys: 'footer' } }, pane), null);
    eq(spec.render({ modes: {}, config: { quick_keys: 'off' } }, pane), null);
  });
});

report();
