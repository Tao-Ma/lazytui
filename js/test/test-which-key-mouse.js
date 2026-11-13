/**
 * which-key (leader chord hint) — mouse (docs/mouse-hit-map.md Release 1).
 *
 *   [1] each row covers its painted continuation (paint↔hit agreement)
 *   [2] click a subtree row → descends (same as typing its token)
 *   [3] click a leaf row → runs the binding, exits prefix mode
 *   [4] box swallows clicks/wheel; outside click = Esc (cancels the chord) via a
 *       backdrop BELOW the chrome band (pane chrome stays clickable)
 *
 * Run: node js/test/test-which-key-mouse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const kb = require('../leaves/input/keybindings');
const { getModel } = require('../app/runtime');

const O = 'which-key';
// A pane-chrome [_] the popup does not cover. The popup's backdrop sits BELOW
// the chrome band (z 35 < 40), so chrome stays clickable while it is open.
function uncoveredCollapse() {
  const hm = require('../panel/hit-map');
  return hm.all().find(r => {
    if (r.z !== hm.BANDS.CHROME || r.id !== 'collapse') return false;
    const hit = hm.resolve(r.rect.x, r.rect.y, 'press');
    return !!hit && hit.region.id === 'collapse' && hit.region.owner === r.owner;
  }) || null;
}
const collapsedOf = (paneId) => {
  const mpool = require('../leaves/wm/pool');
  const p = mpool.allPanesInColumns(sm.api.getInstanceSlice('layout').arrange).find(x => x.paneId === paneId);
  return !!(p && p.collapsed);
};

let ran = [];

function openChord() {
  sm.bootFresh();
  sm.resize(120, 30);
  kb.clearBindings();
  ran = [];
  kb.registerKeyBinding('g g', { label: 'top',    run: () => ran.push('top') });
  kb.registerKeyBinding('g G', { label: 'bottom', run: () => ran.push('bottom') });
  kb.registerKeyBinding('?',   { label: 'help',   run: () => ran.push('help') });
  sm.capture(() => sm.applyMsg({ type: 'enter_prefix' }));
  hc.paint();
}
// continuations sort with localeCompare: '?' then 'g'.
const ROW_HELP = 'row:0', ROW_G = 'row:1';

describe('[1] agreement', () => {
  it('rows cover their continuations', () => {
    openChord();
    assert(hc.paintedText(O, ROW_HELP).includes('help'), 'row 0 = ? help');
    assert(hc.paintedText(O, ROW_G).includes('g'), 'row 1 = g subtree');
  });
});

describe('[2] subtree row', () => {
  it('descends like typing `g`', () => {
    openChord();
    sm.capture(() => sm.handleKey('g', 'g'));
    const viaKey = hc.snapshot();
    openChord();
    hc.clickRegion(O, ROW_G);
    eq(hc.snapshot(), viaKey);
    eq(getModel().prefixSeq, ['g']);
    eq(getModel().modes.prefixMode, true, 'still armed');
  });
});

describe('[3] leaf row', () => {
  it('runs the binding and exits prefix mode', () => {
    openChord();
    hc.clickRegion(O, ROW_HELP);
    eq(ran, ['help']);
    eq(getModel().modes.prefixMode, false);
  });
  it('a leaf one level down: click g, then click G', () => {
    openChord();
    hc.clickRegion(O, ROW_G);
    hc.paint();
    // Find the row by its painted text rather than assuming a sort order.
    const rows = hc.regions(O).filter(r => r.id.startsWith('row:'));
    const bottom = rows.find(r => hc.paintedText(O, r.id).includes('bottom'));
    assert(bottom, 'a row shows "bottom"');
    hc.clickRegion(O, bottom.id);
    eq(ran, ['bottom']);
  });
});

describe('[4] box / outside', () => {
  it('a click on the box border is swallowed; chord stays armed', () => {
    openChord();
    const box = hc.region(O, 'box');
    hc.click(box.rect.x, box.rect.y);       // top-left corner (border)
    hc.wheel(box.rect.x + 1, box.rect.y + 1, 'down');
    eq(getModel().modes.prefixMode, true);
    eq(ran, []);
  });
  it('outside click cancels the chord and runs nothing', () => {
    openChord();
    const bd = hc.region(O, 'backdrop');
    eq(bd && bd.z, require('../panel/hit-map').BANDS.BELOW_CHROME);
    hc.click(0, 25);
    eq(getModel().modes.prefixMode, false, 'chord cancelled');
    eq(ran, []);
  });
  it('pane chrome stays clickable while the chord is pending', () => {
    openChord();
    const r = uncoveredCollapse();
    assert(r, 'a [_] outside the which-key box');
    hc.click(r.rect.x + 1, r.rect.y);
    eq(collapsedOf(r.owner), true);
  });
});

report();
