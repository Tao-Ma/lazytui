/**
 * Mouse-wheel smoke test — verifies wheel-over-panel scrolling without
 * focus changes. Exercises _handleWheel directly against a REAL seeded
 * layout; the real SGR parsing path is exercised implicitly by the
 * existing input pipeline.
 *
 * U2f — the content slot is no longer a single `detail` viewer whose slice
 * carried `infoLines`. It is a position-tab container pane (`pane-detail`,
 * role:'content') whose ACTIVE tab is an `info` instance storing its buffer on
 * `slice.lines`. So instead of hand-building layout.arrange + a paneBounds slice
 * field (both retired — bounds are DERIVED now, #D7), we boot a real seeded
 * layout via `sm.bootFresh()` and let render/geometry derive the bounds. The
 * wheel resolves the content slot via `route.isViewerKind` and scrolls the
 * active instance's `slice.lines` through the `viewer_scroll` dispatch.
 *
 * Run: node js/test/test-mouse-wheel.js
 */
'use strict';

// test-runner wires the dispatch host + registers layout/detail/groups; loading
// it first makes bootFresh's initState (which recomputes groups via the host) work.
require('./test-runner');

// Mute OSC52 — register imports get pulled transitively.
const term = require('../io/term');
const _origWrite = term.stdout.write.bind(term.stdout);
term.stdout.write = (chunk, ...rest) => {
  const s = typeof chunk === 'string' ? chunk : '';
  if (s.startsWith('\x1b]52;')) return true;
  return _origWrite(chunk, ...rest);
};

const { _handleWheel } = require('../dispatch/control/input');
const { describe, it, eq, report } = require('./test-runner');
const { getInstanceSlice, getFocus } = require('../panel/api');
const sm = require('./smoke/_helpers/smoke');
const route = require('../panel/route');
const geo = require('../leaves/wm/geometry');

// T10: _handleWheel no longer takes a `model` arg — the body uses
// getInstanceSlice/_detail/getSel/getFocus directly. Mirrors the T7
// arity sweep across the rest of the dispatch helpers.

// The default bootFresh layout is groups (left column) + actions/detail (right
// column, detail = the content slot). The active content instance is `info`; its
// buffer lives on slice.lines. Boot fresh, render once so the derived geometry
// memo is populated, seed the content instance's lines, and return a point inside
// the content slot's bounds for the wheel to land on.
function setupContentSlot(lineCount = 100) {
  sm.bootFresh();
  // Keyboard focus on the left (groups) pane — the wheel-over-content must NOT
  // move it (the "friendlier than click" semantics the original test pinned).
  getInstanceSlice('layout').focus = 'pane-groups';
  // Populate + reset the active content instance (Info): its displayed buffer is
  // slice.lines (the retired `detail.infoLines` is gone).
  const contentSlice = getInstanceSlice('pane-detail');   // resolves to the active info instance
  contentSlice.lines = Array.from({ length: lineCount }, (_, i) => `line-${i}`);
  contentSlice.scroll = 0;
  // Populate the derived-geometry memo by painting one frame.
  sm.capture(() => sm.render());
}

// The content slot's derived visible bounds + a center point inside it.
function contentBounds() {
  const layout = getInstanceSlice('layout');
  return geo.visibleBoundsFor(layout, 'pane-detail', route.resolveViewerPaneId());
}
function contentPoint() {
  const b = contentBounds();
  return { mx: b.x + Math.floor(b.w / 2), my: b.y + 1 };
}
// The real view-mode-aware viewport height the wheel clamps against — so the
// maxScroll expectation tracks whatever the seeded layout produces.
function contentViewportH() {
  const layout = getInstanceSlice('layout');
  return geo.getPanelViewportH(layout, 'pane-detail', layout.dims, null, route.resolveViewerPaneId());
}
function contentScroll() { return getInstanceSlice('pane-detail').scroll; }

describe('[1] wheel over the content slot scrolls its view, no focus change', () => {
  it('wheel-down increments the content scroll while focus stays on groups', () => {
    setupContentSlot();
    eq(getFocus(), 'pane-groups', 'starts on groups');
    const { mx, my } = contentPoint();
    const mutated = _handleWheel(mx, my, +1);  // inside the content slot
    eq(mutated, true);
    eq(contentScroll(), 1, 'content scrolled');
    eq(getFocus(), 'pane-groups', 'focus unchanged — that is the friendlier semantics');
  });
  it('wheel-up decrements', () => {
    setupContentSlot();
    getInstanceSlice('pane-detail').scroll = 5;
    const { mx, my } = contentPoint();
    _handleWheel(mx, my, -1);
    eq(contentScroll(), 4);
  });
  it('clamps at 0 and at maxScroll', () => {
    setupContentSlot();  // 100 lines
    const { mx, my } = contentPoint();
    _handleWheel(mx, my, -1);
    eq(contentScroll(), 0, 'cannot go negative');
    const maxScroll = Math.max(0, 100 - contentViewportH());
    getInstanceSlice('pane-detail').scroll = maxScroll;
    const mutated = _handleWheel(mx, my, +1);
    eq(mutated, false, 'no mutation past max');
    eq(contentScroll(), maxScroll);
  });
});

describe('[2] wheel outside any panel is a no-op', () => {
  it('returns false; nothing changes', () => {
    setupContentSlot();
    getInstanceSlice('pane-detail').scroll = 5;
    const mutated = _handleWheel(200, 200, +1);
    eq(mutated, false);
    eq(contentScroll(), 5, 'untouched');
  });
});

describe('[3] wheel target ≠ focused panel: focus stays put', () => {
  it('groups focused, wheel lands in the content slot — it scrolls, groups focus retained', () => {
    setupContentSlot();
    getInstanceSlice('layout').focus = 'pane-groups';
    const { mx, my } = contentPoint();
    _handleWheel(mx, my, +1);
    eq(getFocus(), 'pane-groups');
    eq(contentScroll(), 1);
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

const { handleMouse } = require('../dispatch/control/input');
const { getModel } = require('../app/runtime');
const modes = require('../leaves/input/modes');

describe('[4] T13 regression: handleMouse modal gating', () => {
  it('wheel over a panel during filterMode does NOT change focus or scroll', () => {
    setupContentSlot();
    getInstanceSlice('pane-detail').scroll = 0;
    getInstanceSlice('layout').focus = 'pane-groups';
    modes.resetModes(getModel().modes);
    getModel().modes.filterMode = true;
    // Wheel inside the content slot — pre-T13 this would scroll it.
    const { mx, my } = contentPoint();
    handleMouse('wheel-down', mx + 1, my + 1);  // 1-based SGR
    eq(contentScroll(), 0, 'content did not scroll under filter modal');
    eq(getFocus(), 'pane-groups', 'focus unchanged');
    eq(getModel().modes.filterMode, true, 'filterMode preserved');
    modes.resetModes(getModel().modes);
  });
  it('press OUTSIDE the menu during menuOpen dismisses it, never changes focus', () => {
    setupContentSlot();
    getInstanceSlice('layout').focus = 'pane-groups';
    modes.resetModes(getModel().modes);
    getModel().modes.menuOpen = true;
    // Empty menu (no items/anchor) → a small centered box; a press at (40,5)
    // lands outside it. v0.6.4 context-menu feature: an outside-click now
    // DISMISSES the menu (pre-feature it was swallowed and stayed open). The
    // invariant this regression pins still holds — the click must NOT leak
    // into the focus+select cascade (focus stays put; the menu's mouse
    // handler consumes the event rather than falling through).
    handleMouse('press', 40, 5);
    eq(getFocus(), 'pane-groups', 'focus unchanged — click did not leak into the focus cascade');
    eq(getModel().modes.menuOpen, false, 'outside-click dismissed the menu');
    modes.resetModes(getModel().modes);
  });
  it('wheel during prefixMode does NOT trigger groups cascade', () => {
    // The most subtle path the audit flagged: prefix-chord state
    // (prefixMode + prefixNode + prefixSeq) has no clear-on-group-
    // switch, so a wheel-over-groups during a leader chord used to
    // leave the partial chord bound against the new group's tree.
    setupContentSlot();
    modes.resetModes(getModel().modes);
    getModel().modes.prefixMode = true;
    getModel().prefixSeq = ['g'];
    handleMouse('wheel-down', 5, 5);   // wheel over the groups (left) panel
    eq(getModel().modes.prefixMode, true, 'prefixMode preserved');
    eq(getModel().prefixSeq.join(','), 'g', 'prefix chord preserved');
    modes.resetModes(getModel().modes);
    getModel().prefixSeq = [];
  });
  // Note: "wheel still works in normal mode" is covered end-to-end by
  // [1] (_handleWheel direct call). handleMouse's full path also calls
  // render() at the bottom, which pulls in chrome paint + config reads
  // the bare test harness doesn't seed — out of scope for this gate
  // regression. The gate is proven by [4]'s three "during X mode" cases.
});

report();
