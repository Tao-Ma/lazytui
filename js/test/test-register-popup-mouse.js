/**
 * register popup — mouse (docs/mouse-hit-map.md Release 1).
 *
 *   [1] register_popup_nav { to } — absolute, clamped
 *   [2] click an entry → cursor there (stays open); double → promote it
 *   [3] declared hints: [d]/[Enter]/[Esc] chips ≡ keys; [j/k] [g/G] inert
 *   [4] wheel steps; outside click cancels (register unchanged)
 *
 * Run: node js/test/test-register-popup-mouse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const runtime = require('../app/runtime');
const { getModel } = runtime;

const O = 'register-popup';

function openPopup() {
  sm.bootFresh();
  sm.resize(120, 30);
  getModel().register = { history: ['newest', 'middle', 'oldest'], cap: 100 };
  sm.capture(() => sm.applyMsg({ type: 'register_popup_enter' }));
  hc.paint();
}
const idx = () => getModel().modal.registerPopup.idx;
const hist = () => getModel().register.history.slice();

describe('[1] register_popup_nav { to }', () => {
  it('absolute + clamped', () => {
    let m = runtime.init();
    m.register = { history: ['a', 'b', 'c', 'd'], cap: 10 };
    [m] = runtime.update(m, { type: 'register_popup_enter' });
    [m] = runtime.update(m, { type: 'register_popup_nav', to: 2, vh: 3 });
    eq(m.modal.registerPopup.idx, 2);
    [m] = runtime.update(m, { type: 'register_popup_nav', to: 50, vh: 3 });
    eq(m.modal.registerPopup.idx, 3, 'clamped');
  });
});

describe('[2] rows', () => {
  it('click selects the entry; the popup stays open', () => {
    openPopup();
    assert(hc.paintedText(O, 'row:2').includes('oldest'), 'row 2 covers "oldest"');
    hc.clickRegion(O, 'row:2');
    eq(idx(), 2);
    eq(getModel().modes.registerPopupMode, true);
  });
  it('double-click promotes the entry (same model as nav + Enter)', () => {
    openPopup();
    sm.capture(() => { sm.handleKey('down', 'j'); sm.handleKey('down', 'j'); sm.handleKey('return', '\r'); });
    const viaKeys = hc.snapshot();
    openPopup();
    hc.dblclickRegion(O, 'row:2');
    eq(hc.snapshot(), viaKeys);
    eq(hist()[0], 'oldest', 'promoted to the top');
  });
});

describe('[3] chips', () => {
  it('only single-key hints publish chips', () => {
    openPopup();
    eq(hc.regions(O).filter(r => r.id.startsWith('chip:')).map(r => r.id).sort(), ['chip:d', 'chip:escape', 'chip:return']);
    eq(hc.paintedText(O, 'chip:d'), '[d] drop');
  });
  for (const [id, key] of [['chip:d', 'd'], ['chip:return', 'return'], ['chip:escape', 'escape']]) {
    it(`${id} ≡ the ${key} key`, () => {
      openPopup();
      sm.capture(() => sm.handleKey(key, key));
      const viaKey = hc.snapshot();
      openPopup();
      hc.clickRegion(O, id);
      eq(hc.snapshot(), viaKey);
    });
  }
});

describe('[4] wheel / outside', () => {
  it('wheel steps the cursor', () => {
    openPopup();
    hc.wheelRegion(O, 'box', 'down');
    eq(idx(), 1);
  });
  it('an outside click cancels; the register is untouched', () => {
    openPopup();
    hc.click(0, 0);
    eq(getModel().modes.registerPopupMode, false);
    eq(hist(), ['newest', 'middle', 'oldest']);
  });
});

report();
