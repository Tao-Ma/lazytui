/**
 * diag-log window — mouse (docs/mouse-hit-map.md Release 1).
 *
 *   [1] diag_log_nav { to } — absolute, clamped, scroll follows
 *   [2] a row click moves the cursor to THAT entry (paint↔hit agreement)
 *   [3] chips: [y] [c] [Esc] ≡ their keys; [↑/↓] / [g/G] are not clickable
 *   [4] wheel steps the cursor; outside click closes
 *
 * Run: node js/test/test-diag-log-mouse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const runtime = require('../app/runtime');
const { getModel } = runtime;

const O = 'diag-log';
const LIST = ['alpha', 'bravo', 'charlie', 'delta'].map((w, i) => ({ level: 'warn', code: `C${i}`, message: `${w} happened`, t: 0 }));

function openDiag() {
  sm.bootFresh();
  sm.resize(120, 30);
  getModel().diagLog = LIST.slice();
  getModel().register = { history: [], cap: 100 };
  sm.capture(() => sm.applyMsg({ type: 'diag_log_open', now: 0 }));
  hc.paint();
}
const cursor = () => getModel().modal.diagLog.cursor;

describe('[1] diag_log_nav { to }', () => {
  it('absolute + clamped; scroll keeps the cursor in view', () => {
    let m = runtime.init();
    [m] = runtime.update(m, { type: 'diag_log_open', now: 0 });
    [m] = runtime.update(m, { type: 'diag_log_nav', to: 7, count: 10, vh: 3 });
    eq(m.modal.diagLog, { cursor: 7, scroll: 5 });
    [m] = runtime.update(m, { type: 'diag_log_nav', to: 99, count: 10, vh: 3 });
    eq(m.modal.diagLog.cursor, 9, 'clamped');
    [m] = runtime.update(m, { type: 'diag_log_nav', to: 'top', count: 10, vh: 3 });
    eq(m.modal.diagLog.cursor, 0, "symbolic 'top' unchanged");
  });
});

describe('[2] row click', () => {
  it('moves the cursor to the clicked entry', () => {
    openDiag();
    assert(hc.paintedText(O, 'row:2').includes('charlie happened'), 'row 2 covers the "charlie" line');
    hc.clickRegion(O, 'row:2');
    eq(cursor(), 2);
    eq(getModel().modes.diagLogMode, true, 'window stays open');
  });
});

describe('[3] chips', () => {
  it('[↑/↓] nav and [g/G] publish no chip; y/c/Esc do', () => {
    openDiag();
    const ids = hc.regions(O).filter(r => r.id.startsWith('chip:')).map(r => r.id).sort();
    eq(ids, ['chip:c', 'chip:escape', 'chip:s', 'chip:y']);
    eq(hc.paintedText(O, 'chip:y'), '[y] copy');
    eq(hc.paintedText(O, 'chip:escape'), '[Esc] close');
  });
  for (const [id, key] of [['chip:y', 'y'], ['chip:c', 'c'], ['chip:escape', 'escape']]) {
    it(`${id} ≡ the ${key} key`, () => {
      openDiag();
      sm.capture(() => sm.handleKey('down', 'j'));
      sm.capture(() => sm.handleKey(key, key));
      const viaKey = hc.snapshot();
      openDiag();
      sm.capture(() => sm.handleKey('down', 'j'));
      hc.paint();
      hc.clickRegion(O, id);
      eq(hc.snapshot(), viaKey);
    });
  }
});

describe('[4] wheel / outside', () => {
  it('wheel steps the cursor', () => {
    openDiag();
    hc.wheelRegion(O, 'box', 'down');
    hc.wheelRegion(O, 'box', 'down');
    eq(cursor(), 2);
    hc.wheelRegion(O, 'box', 'up');
    eq(cursor(), 1);
  });
  it('an outside click closes the window', () => {
    openDiag();
    hc.click(0, 0);
    eq(getModel().modes.diagLogMode, false);
  });
});

report();
