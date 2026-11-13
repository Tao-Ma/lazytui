/**
 * copy popup — mouse (docs/mouse-hit-map.md Release 1).
 *
 *   [1] copy_nav { to } — absolute, clamped (the row-click reducer surface)
 *   [2] row click picks THAT option (copySelect gets its idx + label)
 *   [3] row ≡ keys: clicking row i == navigating to i + Enter
 *   [4] wheel steps the cursor like j/k; outside click cancels
 *
 * Run: node js/test/test-copy-mouse.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const runtime = require('../app/runtime');
const copy = require('../overlay/copy');
const { getModel } = runtime;

const O = 'copy';
const OPTS = [{ label: 'Name' }, { label: 'Path' }, { label: 'Image' }, { label: '— Cancel —', cancel: true }];

function openCopy() {
  sm.bootFresh();
  sm.resize(120, 30);
  copy._setOptions(OPTS.map(o => ({ ...o, content: o.label.toLowerCase() })));
  sm.capture(() => sm.applyMsg({ type: 'copy_enter', options: OPTS }));
  hc.paint();
}
function spySelect(fn) {
  const calls = [];
  const real = copy.copySelect;
  copy.copySelect = (idx, label) => calls.push([idx, label]);
  try { fn(); } finally { copy.copySelect = real; }
  return calls;
}

describe('[1] copy_nav { to }', () => {
  it('jumps to the index, clamped to the option range', () => {
    let m = runtime.init();
    [m] = runtime.update(m, { type: 'copy_enter', options: OPTS });
    [m] = runtime.update(m, { type: 'copy_nav', to: 2 });
    eq(m.modal.copy.idx, 2);
    [m] = runtime.update(m, { type: 'copy_nav', to: 99 });
    eq(m.modal.copy.idx, 3, 'clamped high');
    [m] = runtime.update(m, { type: 'copy_nav', to: -5 });
    eq(m.modal.copy.idx, 0, 'clamped low');
    [m] = runtime.update(m, { type: 'copy_nav', dir: -1 });
    eq(m.modal.copy.idx, 3, 'relative dir still wraps');
  });
});

describe('[2] row click', () => {
  it('picks the clicked option and closes', () => {
    openCopy();
    eq(hc.paintedText(O, 'row:2').trim(), 'Image', 'row 2 covers the painted "Image" line');
    const calls = spySelect(() => hc.clickRegion(O, 'row:2'));
    eq(calls, [[2, 'Image']]);
    eq(getModel().modes.copyMode, false);
  });
});

describe('[3] row ≡ keys', () => {
  it('clicking row 1 leaves the same model as down + Enter', () => {
    openCopy();
    spySelect(() => { sm.capture(() => { sm.handleKey('down', 'j'); sm.handleKey('return', '\r'); }); });
    const viaKeys = hc.snapshot();
    openCopy();
    spySelect(() => hc.clickRegion(O, 'row:1'));
    eq(hc.snapshot(), viaKeys);
  });
});

describe('[4] wheel / outside', () => {
  it('wheel down/up over the box moves the cursor', () => {
    openCopy();
    hc.wheelRegion(O, 'box', 'down');
    eq(getModel().modal.copy.idx, 1);
    hc.wheelRegion(O, 'box', 'up');
    eq(getModel().modal.copy.idx, 0);
  });
  it('an outside click cancels without copying', () => {
    openCopy();
    const calls = spySelect(() => hc.click(0, 0));
    eq(calls, []);
    eq(getModel().modes.copyMode, false);
  });
});

report();
