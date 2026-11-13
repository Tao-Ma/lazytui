/**
 * `:` cmdline dropdown — mouse (docs/mouse-hit-map.md Release 1).
 *
 *   [1] cmdline_nav { to } — absolute, clamped; empty list is a no-op
 *   [2] rows are reversed: each row covers ITS match; a click selects it
 *   [3] wheel ≡ ↑/↓ keys; outside click (incl. the prompt row) swallowed
 *
 * Run: node js/test/test-cmdline-mouse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const runtime = require('../app/runtime');
const { getModel } = runtime;

const O = 'cmdline';
const MATCHES = ['focus', 'filter', 'fold'].map(n => ({ display: n, desc: `${n} things`, kind: 'cmd' }));

function openCmd() {
  sm.bootFresh();
  sm.resize(120, 30);
  sm.capture(() => sm.applyMsg({ type: 'cmdline_enter' }));
  sm.capture(() => { sm.handleKey('f', 'f'); });
  sm.capture(() => sm.applyMsg({ type: 'cmdline_set_matches', matches: MATCHES }));
  hc.paint();
}
const c = () => getModel().modal.cmdline;

describe('[1] cmdline_nav { to }', () => {
  it('absolute + clamped; no matches → no-op', () => {
    let m = runtime.init();
    [m] = runtime.update(m, { type: 'cmdline_enter' });
    const before = m;
    [m] = runtime.update(m, { type: 'cmdline_nav', to: 2 });
    assert(m === before, 'empty match list → unchanged');
    [m] = runtime.update(m, { type: 'cmdline_set_matches', matches: MATCHES });
    [m] = runtime.update(m, { type: 'cmdline_nav', to: 2 });
    eq(m.modal.cmdline.sel, 2);
    [m] = runtime.update(m, { type: 'cmdline_nav', to: 9 });
    eq(m.modal.cmdline.sel, 2, 'clamped');
  });
});

describe('[2] rows', () => {
  it('reversed order: the TOP row is the worst match; clicking selects it', () => {
    openCmd();
    eq(c().matches.length, 3, 'matches seeded');
    const rows = hc.regions(O).filter(r => r.id.startsWith('row:'));
    eq(rows.length, 3);
    const top = rows.reduce((a, b) => (a.rect.y < b.rect.y ? a : b));
    assert(hc.paintedText(O, top.id).includes('fold'), 'top row paints the LAST match (fold)');
    hc.clickRegion(O, top.id);
    eq(c().sel, 2, 'selected match 2');
    eq(getModel().modes.cmdMode, true, 'still typing');
  });
});

describe('[3] wheel / outside', () => {
  it('wheel-up ≡ the up key (toward worse matches)', () => {
    openCmd();
    sm.capture(() => sm.handleKey('up', '\x1b[A'));
    const viaKey = c().sel;
    openCmd();
    hc.wheelRegion(O, 'box', 'up');
    eq(c().sel, viaKey);
  });
  it('outside click and a click on the prompt row are swallowed', () => {
    openCmd();
    const text = c().text;
    const vp = require('../leaves/render/draw').viewportDims();
    hc.click(2, 2);
    hc.click(3, vp.rows - 1);
    eq(getModel().modes.cmdMode, true);
    eq(c().text, text, 'typed text intact');
  });
});

report();
