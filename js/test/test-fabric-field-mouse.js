/**
 * fabric-field popup — mouse (docs/mouse-hit-map.md Release 1).
 *
 *   [1] paint↔hit agreement for the [enter]/[esc] chips
 *   [2] chip ≡ key: [enter] submits, [esc] cancels — same model as the keys
 *   [3] outside click is SWALLOWED: typed text survives (no discard)
 *   [4] inside the box / wheel: consumed, nothing changes
 *
 * Run: node js/test/test-fabric-field-mouse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const { getModel } = require('../app/runtime');

const O = 'fabric-field';

function openField(text) {
  sm.bootFresh();
  sm.resize(120, 30);
  // pendingAction null → submit is a sticky inject (no spawn), so the [enter]
  // parity test has no side effects.
  sm.capture(() => sm.applyMsg({ type: 'fabric_field_enter', paneId: null, addr: 'g1.host', text: '', pendingAction: null }));
  for (const ch of text || '') sm.capture(() => sm.handleKey(ch, ch));
  hc.paint();
}
const isOpen = () => getModel().modes.fabricFieldMode === true;
const typed = () => getModel().modal.fabricField && getModel().modal.fabricField.text;

describe('[1] paint↔hit agreement', () => {
  it('chips cover their painted hint text', () => {
    openField('');
    eq(hc.paintedText(O, 'chip:return'), '[enter] run');
    eq(hc.paintedText(O, 'chip:escape'), '[esc] cancel');
  });
});

describe('[2] chip ≡ key', () => {
  for (const [id, key] of [['chip:return', 'return'], ['chip:escape', 'escape']]) {
    it(`${id} leaves the same model as the ${key} key`, () => {
      openField('abc');
      sm.capture(() => sm.handleKey(key, key));
      const viaKey = hc.snapshot();
      openField('abc');
      hc.clickRegion(O, id);
      eq(hc.snapshot(), viaKey);
      eq(isOpen(), false, 'popup closed');
    });
  }
});

describe('[3] outside click', () => {
  it('is swallowed: still open, typed text intact', () => {
    openField('abc');
    hc.click(0, 0);
    hc.click(0, 0, 2);
    eq(isOpen(), true);
    eq(typed(), 'abc');
  });
});

describe('[4] inside the box / wheel', () => {
  it('consumed: still open, text intact', () => {
    openField('abc');
    const box = hc.region(O, 'box');
    hc.click(box.rect.x + 2, box.rect.y + 1);
    hc.wheel(box.rect.x + 2, box.rect.y + 1, 'up');
    hc.wheel(0, 0, 'down');
    eq(isOpen(), true);
    eq(typed(), 'abc');
  });
});

report();
