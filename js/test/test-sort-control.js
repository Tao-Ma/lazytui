/**
 * sort-control + nav.sort — the SORT SELECTOR border-control kind and the
 * per-pane sort state it drives. Pins the label/width/regions geometry (the
 * paint ↔ hit-test source), the spec's cycle/dispatch/render, and the nav
 * reducer arms (set_sort / sort_reverse).
 *
 * Run: node js/test/test-sort-control.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sc = require('../leaves/render/sort-control');
const mnav = require('../leaves/wm/nav');

describe('[nav] sort state', () => {
  const s0 = { nav: mnav.init() };
  it('init seeds native order (key null, dir asc)', () => {
    eq(mnav.init().sort, { key: null, dir: 1 });
  });
  it('set_sort sets the key; a new column starts ascending', () => {
    eq(mnav.apply(s0, { type: 'set_sort', key: 'cpu' }).nav.sort, { key: 'cpu', dir: 1 });
    const cpuDesc = mnav.apply(mnav.apply(s0, { type: 'set_sort', key: 'cpu' }), { type: 'sort_reverse' });
    eq(mnav.apply(cpuDesc, { type: 'set_sort', key: 'name' }).nav.sort, { key: 'name', dir: 1 });   // switch → asc
  });
  it('set_sort to the current key is a no-op (same slice ref — no churn)', () => {
    assert(mnav.apply(s0, { type: 'set_sort', key: null }) === s0);
  });
  it('sort_reverse flips dir once a key is set', () => {
    const sorted = mnav.apply(s0, { type: 'set_sort', key: 'cpu' });
    eq(mnav.apply(sorted, { type: 'sort_reverse' }).nav.sort, { key: 'cpu', dir: -1 });
  });
  it('sort_reverse is a no-op while unsorted (nothing to reverse — no churn)', () => {
    assert(mnav.apply(s0, { type: 'sort_reverse' }) === s0);
  });
});

describe('[sort-control] text + regions (paint ↔ hit-test source)', () => {
  it('unsorted → the neutral label; width = label + 4', () => {
    const { text, visibleW } = sc.sortControlText(sc.NONE_LABEL);
    eq(visibleW, 5);                    // '·' (1) + 4
    assert(text.includes(sc.NONE_LABEL));
  });
  it('a sorted label carries the direction glyph', () => {
    eq(sc.sortControlText('cpu' + sc.DESC).visibleW, 8);   // 'cpu↓' (4) + 4
  });
  it('three regions: ‹ prev (2) / label reverse (mid) / › next (2)', () => {
    const [prev, rev, next] = sc.sortControlHits(30, 0, 5);
    eq(prev, { x0: 30, x1: 31, y: 0, action: 'prev' });
    eq(rev,  { x0: 32, x1: 32, y: 0, action: 'reverse' });
    eq(next, { x0: 33, x1: 34, y: 0, action: 'next' });
    assert(prev.x1 < rev.x0 && rev.x1 < next.x0, 'non-overlapping, left→right');
  });
});

describe('[sort-control] spec render + cycle dispatch', () => {
  const keys = [{ key: 'name', label: 'name' }, { key: 'cpu', label: 'cpu' }];
  let cur = { key: null, dir: 1 };
  const spec = sc.sortControlSpec({ keys, getSort: () => cur });
  const pane = { paneId: 'p1', type: 'containers' };
  it('render hides in free-config, shows the current column otherwise', () => {
    eq(spec.render({ modes: { freeConfigMode: true } }, pane), null);
    cur = { key: 'cpu', dir: -1 };
    assert(spec.render({ modes: {} }, pane).text.includes('cpu' + sc.DESC));
    cur = { key: null, dir: 1 };
  });
  it('next/prev walk the ring [null, name, cpu]; both route to the clicked pane', () => {
    eq(spec.dispatch('next', pane), { owner: 'p1', msg: { type: 'set_sort', panel: 'containers', key: 'name' } });
    eq(spec.dispatch('prev', pane), { owner: 'p1', msg: { type: 'set_sort', panel: 'containers', key: 'cpu' } });   // null→prev wraps to last
  });
  it('reverse targets the pane regardless of current key', () => {
    eq(spec.dispatch('reverse', pane), { owner: 'p1', msg: { type: 'sort_reverse', panel: 'containers' } });
  });
});

report();
