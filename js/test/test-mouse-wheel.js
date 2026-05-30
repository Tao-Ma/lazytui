/**
 * Mouse-wheel smoke test — verifies wheel-over-panel scrolling without
 * focus changes. Exercises _handleWheel directly with synthetic panel
 * bounds; the real SGR parsing path is exercised implicitly by the
 * existing input pipeline.
 *
 * Run: node js/test/test-mouse-wheel.js
 */
'use strict';

// Mute OSC52 — register imports get pulled transitively.
const term = require('../term');
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

const { _handleWheel } = require('../input');
const { describe, it, eq, report } = require('./test-runner');
const { getModel } = require('../runtime');
const { getComponentSlice } = require('../plugins/api');


// _handleWheel now takes the owned model first (threaded from the pump).
const model = getModel();

function setupTwoPanel() {
  // Pretend layout: hosts on the left (0..30, 0..20), detail on the right (30..80, 0..20)
  getComponentSlice("layout").arrange = {
    leftPanels: [{ type: 'hosts' }],
    rightPanels: [{ type: 'detail' }],
    leftWidth: 30, detailHeightPct: 60,
  };
  getComponentSlice('layout').panelBounds = {
    hosts:  { x: 0,  y: 0, w: 30, h: 20 },
    detail: { x: 30, y: 0, w: 50, h: 20 },
  };
  getComponentSlice('layout').panelHeights = { hosts: 20, detail: 20 };
  getComponentSlice("layout").focus = 'hosts';
  getComponentSlice('detail').lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
  getComponentSlice('detail').scroll = 0;
}

describe('[1] wheel over detail scrolls view, no focus change', () => {
  it('wheel-down increments detail.scroll while focus stays on hosts', () => {
    setupTwoPanel();
    eq(getComponentSlice("layout").focus, 'hosts', 'starts on hosts');
    const mutated = _handleWheel(model, 40, 5, +1);  // (mx, my) inside detail
    eq(mutated, true);
    eq(getComponentSlice('detail').scroll, 1, 'detail scrolled');
    eq(getComponentSlice("layout").focus, 'hosts', 'focus unchanged — that is the friendlier semantics');
  });
  it('wheel-up decrements', () => {
    setupTwoPanel();
    getComponentSlice('detail').scroll = 5;
    _handleWheel(model, 40, 5, -1);
    eq(getComponentSlice('detail').scroll, 4);
  });
  it('clamps at 0 and at maxScroll', () => {
    setupTwoPanel();
    // detailLines = 100, innerH = h - 2 = 18, maxScroll = 82
    _handleWheel(model, 40, 5, -1);
    eq(getComponentSlice('detail').scroll, 0, 'cannot go negative');
    getComponentSlice('detail').scroll = 82;
    const mutated = _handleWheel(model, 40, 5, +1);
    eq(mutated, false, 'no mutation past max');
    eq(getComponentSlice('detail').scroll, 82);
  });
});

describe('[2] wheel outside any panel is a no-op', () => {
  it('returns false; nothing changes', () => {
    setupTwoPanel();
    getComponentSlice('detail').scroll = 5;
    const mutated = _handleWheel(model, 200, 200, +1);
    eq(mutated, false);
    eq(getComponentSlice('detail').scroll, 5, 'untouched');
  });
});

describe('[3] wheel target ≠ focused panel: focus stays put', () => {
  it('hosts focused, wheel lands in detail — detail scrolls, hosts focus retained', () => {
    setupTwoPanel();
    getComponentSlice("layout").focus = 'hosts';
    _handleWheel(model, 40, 10, +1);
    eq(getComponentSlice("layout").focus, 'hosts');
    eq(getComponentSlice('detail').scroll, 1);
  });
});

report();
