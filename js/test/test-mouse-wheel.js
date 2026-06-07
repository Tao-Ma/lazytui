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
const term = require('../io/term');
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

const { _handleWheel } = require('../dispatch/input');
const { describe, it, eq, report } = require('./test-runner');
const {getInstanceSlice, getFocus } = require('../panel/api');

// T10: _handleWheel no longer takes a `model` arg — the body uses
// getInstanceSlice/_detail/getSel/getFocus directly. Mirrors the T7
// arity sweep across the rest of the dispatch helpers.

function setupTwoPanel() {
  // Pretend layout: hosts on the left (0..30, 0..20), detail on the right (30..80, 0..20)
  getInstanceSlice("layout").arrange = {
    columns: [
      { width: 30, panels: [{ type: 'hosts' }] },
      { panels: [{ type: 'detail' }] },
    ],
    detailHeightPct: 60,
  };
  getInstanceSlice('layout').paneBounds = {
    hosts:  { x: 0,  y: 0, w: 30, h: 20 },
    detail: { x: 30, y: 0, w: 50, h: 20 },
  };
  // panelHeights left the slice — wheel paths read paneBounds[type].h
  // via getPanelViewportH for view-mode-aware inner viewport rows.
  getInstanceSlice("layout").focus = 'hosts';
  getInstanceSlice('detail').lines = Array.from({ length: 100 }, (_, i) => `line-${i}`);
  getInstanceSlice('detail').scroll = 0;
  // A1/B1 fix: viewer.update reads slice.innerH instead of layout's
  // panelHeights. Seed the detail slice's own viewport (panel h - 2 chrome).
  getInstanceSlice('detail').innerH = 18;
}

describe('[1] wheel over detail scrolls view, no focus change', () => {
  it('wheel-down increments detail.scroll while focus stays on hosts', () => {
    setupTwoPanel();
    eq(getFocus(), 'hosts', 'starts on hosts');
    const mutated = _handleWheel(40, 5, +1);  // (mx, my) inside detail
    eq(mutated, true);
    eq(getInstanceSlice('detail').scroll, 1, 'detail scrolled');
    eq(getFocus(), 'hosts', 'focus unchanged — that is the friendlier semantics');
  });
  it('wheel-up decrements', () => {
    setupTwoPanel();
    getInstanceSlice('detail').scroll = 5;
    _handleWheel(40, 5, -1);
    eq(getInstanceSlice('detail').scroll, 4);
  });
  it('clamps at 0 and at maxScroll', () => {
    setupTwoPanel();
    // detailLines = 100, innerH = h - 2 = 18, maxScroll = 82
    _handleWheel(40, 5, -1);
    eq(getInstanceSlice('detail').scroll, 0, 'cannot go negative');
    getInstanceSlice('detail').scroll = 82;
    const mutated = _handleWheel(40, 5, +1);
    eq(mutated, false, 'no mutation past max');
    eq(getInstanceSlice('detail').scroll, 82);
  });
});

describe('[2] wheel outside any panel is a no-op', () => {
  it('returns false; nothing changes', () => {
    setupTwoPanel();
    getInstanceSlice('detail').scroll = 5;
    const mutated = _handleWheel(200, 200, +1);
    eq(mutated, false);
    eq(getInstanceSlice('detail').scroll, 5, 'untouched');
  });
});

describe('[3] wheel target ≠ focused panel: focus stays put', () => {
  it('hosts focused, wheel lands in detail — detail scrolls, hosts focus retained', () => {
    setupTwoPanel();
    getInstanceSlice("layout").focus = 'hosts';
    _handleWheel(40, 10, +1);
    eq(getFocus(), 'hosts');
    eq(getInstanceSlice('detail').scroll, 1);
  });
});

// ---- [4] T13 regression: handleMouse gates on chain modes ----
//
// The keyboard modeChain claims keystrokes while any chain mode (filter
// / menu / prefix / cmdline / confirm / prompt / copy / register-popup
// / detail-search / design-title-edit) is active. handleMouse used to
// only special-case freeConfigMode, letting every other modal cascade into
// focus changes + selection + reset_group_context — the wheel-over-
// groups path during filter mode was the smoking gun (modal sub-model
// stayed bound to the OLD current-group). Pin the post-fix behavior.

const { handleMouse } = require('../dispatch/input');
const { getModel } = require('../app/runtime');
const modes = require('../dispatch/modes');

describe('[4] T13 regression: handleMouse modal gating', () => {
  it('wheel over a panel during filterMode does NOT change focus or scroll', () => {
    setupTwoPanel();
    getInstanceSlice('detail').scroll = 0;
    getInstanceSlice('layout').focus = 'hosts';
    modes.resetModes();
    getModel().modes.filterMode = true;
    // Wheel inside detail bounds — pre-T13 this would scroll detail.
    handleMouse('wheel-down', 40, 5);
    eq(getInstanceSlice('detail').scroll, 0, 'detail did not scroll under filter modal');
    eq(getFocus(), 'hosts', 'focus unchanged');
    eq(getModel().modes.filterMode, true, 'filterMode preserved');
    modes.resetModes();
  });
  it('press over a panel during menuOpen does NOT change focus', () => {
    setupTwoPanel();
    getInstanceSlice('layout').focus = 'hosts';
    modes.resetModes();
    getModel().modes.menuOpen = true;
    // A click on detail would normally focus + begin selection.
    handleMouse('press', 40, 5);
    eq(getFocus(), 'hosts', 'focus unchanged under menu modal');
    eq(getModel().modes.menuOpen, true, 'menuOpen preserved');
    modes.resetModes();
  });
  it('wheel during prefixMode does NOT trigger groups cascade', () => {
    // The most subtle path the audit flagged: prefix-chord state
    // (prefixMode + prefixNode + prefixSeq) has no clear-on-group-
    // switch, so a wheel-over-groups during a leader chord used to
    // leave the partial chord bound against the new group's tree.
    setupTwoPanel();
    modes.resetModes();
    getModel().modes.prefixMode = true;
    getModel().prefixSeq = ['g'];
    handleMouse('wheel-down', 5, 5);   // wheel over hosts panel
    eq(getModel().modes.prefixMode, true, 'prefixMode preserved');
    eq(getModel().prefixSeq.join(','), 'g', 'prefix chord preserved');
    modes.resetModes();
    getModel().prefixSeq = [];
  });
  // Note: "wheel still works in normal mode" is covered end-to-end by
  // [1] (_handleWheel direct call). handleMouse's full path also calls
  // render() at the bottom, which pulls in chrome paint + config reads
  // the bare test harness doesn't seed — out of scope for this gate
  // regression. The gate is proven by [4]'s three "during X mode" cases.
});

report();
