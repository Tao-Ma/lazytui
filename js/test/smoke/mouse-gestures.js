/**
 * Smoke — v0.6.4 Theme F Phase 3 mouse gestures end-to-end.
 *
 * Drives the real `handleMouse` pipeline (the resolver half of Theme F)
 * for the three new gestures the parser now emits:
 *
 *   - double-click on a list row → `activate` (the GUI single-selects /
 *     double-opens convention; the preceding single press already
 *     focused + selected the row).
 *   - right-click → context menu, opened AT the cursor (the anchor is
 *     threaded through menu_open into model.modal.menu.anchor).
 *   - middle-click → reserved no-op (recognized + discarded).
 *
 * The parser's timing derivation (which press becomes a `double`) is
 * unit-tested in test-mouse-gestures.js; this scenario starts from the
 * already-classified gesture kind and pins the resolver's effect.
 *
 * Run: node js/test/smoke/mouse-gestures.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('../test-runner');
const sm = require('./_helpers/smoke');
const geo = require('../../leaves/wm/geometry');  // A.2: bounds are derived, not on slice.paneBounds
const api = sm.api;
const { getModel } = require('../../app/runtime');
const actions = require('../../dispatch/control/actions');
const dispatch = require('../../dispatch/control/dispatch');
const mb = require('../../dispatch/control/mouse-bindings');
const mreg = require('../../leaves/register');

// 0-based pane grid → 1-based SGR coords (handleMouse subtracts 1).
function sgr0(col0, row0) { return [col0 + 1, row0 + 1]; }

// Decode raw ANSI into Map<row, Map<col, char>> on the 1-based cursor
// grid (mirrors smoke/hit-zones.js's decoder).
function decodeFrame(raw) {
  const grid = new Map();
  let curRow = 1, curCol = 1, i = 0;
  while (i < raw.length) {
    const cur = raw.slice(i).match(/^\x1b\[(\d+);(\d+)H/);
    if (cur) { curRow = parseInt(cur[1], 10); curCol = parseInt(cur[2], 10); i += cur[0].length; continue; }
    const otherEsc = raw.slice(i).match(/^\x1b\[[\d;?]*[A-Za-z]/);
    if (otherEsc) { i += otherEsc[0].length; continue; }
    const ch = raw[i];
    if (ch === '\n' || ch === '\r') { i++; continue; }
    let row = grid.get(curRow);
    if (!row) { row = new Map(); grid.set(curRow, row); }
    row.set(curCol, ch);
    curCol++; i++;
  }
  return grid;
}

// Bounds of the groups navigator pane in the default layout.
function groupsBounds() {
  return geo.visibleBoundsFor(api.getInstanceSlice('layout'), 'pane-groups');
}

// Spy on handleAction WITHOUT calling through — focus + select route via
// dispatchMsg / navSelect (not handleAction), so swallowing it keeps the
// cursor write intact while isolating the `activate` (run_selected) call.
function withActionSpy(fn) {
  const calls = [];
  const real = actions.handleAction;
  actions.handleAction = (...a) => { calls.push(a); };
  try { fn(); } finally { actions.handleAction = real; }
  return calls;
}

describe('[1] double-click on a row activates it', () => {
  it('double-click fires run_selected; a single press does NOT', () => {
    sm.bootFresh();
    sm.capture(() => sm.render());
    const b = groupsBounds();
    assert(b, 'groups pane bounds present');
    const [sx, sy] = sgr0(b.x + 2, b.y + 1);   // first item row, inside body

    const single = withActionSpy(() => sm.capture(() => sm.handleMouse('press', sx, sy)));
    assert(!single.some(c => c[0] === 'run_selected'),
      `a single press must NOT activate (saw: ${JSON.stringify(single)})`);

    const dbl = withActionSpy(() => sm.capture(() => sm.handleMouse('double', sx, sy)));
    assert(dbl.some(c => c[0] === 'run_selected'),
      `a double-click MUST activate the row (saw: ${JSON.stringify(dbl)})`);
  });

  it('double-click OFF any row (top border) does NOT activate', () => {
    sm.bootFresh();
    sm.capture(() => sm.render());
    const b = groupsBounds();
    const [sx, sy] = sgr0(b.x + 2, b.y);       // top border row — no item here
    const calls = withActionSpy(() => sm.capture(() => sm.handleMouse('double', sx, sy)));
    assert(!calls.some(c => c[0] === 'run_selected'),
      `a double on the border must not activate (saw: ${JSON.stringify(calls)})`);
  });
});

describe('[2] right-click opens the context menu at the cursor', () => {
  it('right-click sets menuOpen and threads the {x,y} anchor', () => {
    sm.bootFresh();
    sm.capture(() => sm.render());
    eq(getModel().modes.menuOpen, false, 'menu starts closed');
    const b = groupsBounds();
    const [sx, sy] = sgr0(b.x + 3, b.y + 1);
    sm.capture(() => sm.handleMouse('right', sx, sy));
    eq(getModel().modes.menuOpen, true, 'right-click opened the menu');
    eq(getModel().modal.menu.anchor, { x: sx, y: sy }, 'menu anchored at the cursor cell');
    assert(getModel().modal.menu.items.length > 0, 'menu has items');
  });

  it('the menu paints near the anchor, not centered', () => {
    sm.bootFresh();
    const { rows, cols } = require('../../io/term');
    const COLS = cols(), ROWS = rows();
    // Anchor in the top-left quadrant so an anchored open is clearly
    // distinguishable from the centered placement.
    const ax = 3, ay = 2;
    sm.capture(() => sm.render());
    sm.capture(() => sm.handleMouse('right', ax, ay));
    const { raw } = sm.capture(() => sm.render());
    // Decode the painted frame onto a 1-based cursor grid (same technique
    // as smoke/hit-zones.js) and find the row carrying the context-menu
    // title ("Actions" — the right-click menu; the `x` command list is "Menu").
    const grid = decodeFrame(raw);
    let titleRow = null;
    for (const [row, cells] of grid) {
      let line = '';
      for (let c = 1; c <= COLS; c++) line += (cells.get(c) || ' ');
      if (line.includes('Actions')) { titleRow = row; break; }
    }
    assert(titleRow != null, 'found the painted Actions title on some row');
    assert(titleRow < Math.floor(ROWS / 2),
      `anchored menu should paint in the top half (row ${titleRow} < ${Math.floor(ROWS / 2)}); ROWS=${ROWS} COLS=${COLS}`);
  });
});

describe('[3] middle-click is a reserved no-op', () => {
  it('middle-click changes nothing — no menu, no focus change, no activate', () => {
    sm.bootFresh();
    sm.capture(() => sm.render());
    const focusBefore = api.getInstanceSlice('layout').focus;
    const b = groupsBounds();
    const [sx, sy] = sgr0(b.x + 2, b.y + 1);
    const calls = withActionSpy(() => sm.capture(() => sm.handleMouse('middle', sx, sy)));
    eq(getModel().modes.menuOpen, false, 'no menu opened');
    eq(api.getInstanceSlice('layout').focus, focusBefore, 'focus unchanged');
    assert(calls.length === 0, `middle-click fires nothing (saw: ${JSON.stringify(calls)})`);
  });
});

// --- [4] Phase 4 — a YAML `mouse:` remap reassigns gesture → intent ----
//
// Prove the gesture→intent edge is data: swap the defaults so that
// MIDDLE-click opens the context menu and RIGHT-click activates the row.
// Behavior must follow the config, not the gesture name.

describe('[4] mouse: remap — middle→context, right→activate', () => {
  it('after remap, middle opens the menu and right activates the row', () => {
    mb.configure({ 'middle-click': 'context', 'right-click': 'activate' });
    try {
      sm.bootFresh();
      sm.capture(() => sm.render());
      const b = groupsBounds();
      const [sx, sy] = sgr0(b.x + 2, b.y + 1);

      // Middle now opens the context menu (was a no-op under defaults).
      sm.capture(() => sm.handleMouse('middle', sx, sy));
      eq(getModel().modes.menuOpen, true, 'remapped middle-click opened the menu');
      eq(getModel().modal.menu.anchor, { x: sx, y: sy }, 'menu anchored at the cursor');

      // Right now activates the row (was context under defaults).
      sm.bootFresh();
      sm.capture(() => sm.render());
      const right = withActionSpy(() => sm.capture(() => sm.handleMouse('right', sx, sy)));
      assert(right.some(c => c[0] === 'run_selected'),
        `remapped right-click MUST activate the row (saw: ${JSON.stringify(right)})`);
      eq(getModel().modes.menuOpen, false, 'right-click no longer opens the menu');
    } finally {
      mb.reset();
    }
  });

  it('right→activate OFF a row is inert (no menu, no activate)', () => {
    mb.configure({ 'right-click': 'activate' });
    try {
      sm.bootFresh();
      sm.capture(() => sm.render());
      const b = groupsBounds();
      const [sx, sy] = sgr0(b.x + 2, b.y);   // top border — off-row
      const calls = withActionSpy(() => sm.capture(() => sm.handleMouse('right', sx, sy)));
      eq(getModel().modes.menuOpen, false, 'no menu');
      assert(!calls.some(c => c[0] === 'run_selected'), 'off-row activate is inert');
    } finally {
      mb.reset();
    }
  });
});

// --- [5] right-click opens a CONTEXT menu (copy) + dismiss-on-outside ----
//
// The right-click menu is contextual (leaves/context-menu), not the global
// command list: right-clicking a groups row offers "Copy item", clicking it
// yanks the row label onto the register (→ clipboard), and a click outside
// the box dismisses the menu without leaking into focus/selection.

// Capture register_push without swallowing — actions reads dispatch.applyMsg
// by property at call time, so the copy verb's push is observable while the
// menu_open / menu_activate flow still runs through the real reducer.
function withMsgSpy(fn) {
  const seen = [];
  const real = dispatch.applyMsg;
  dispatch.applyMsg = (m) => { seen.push(m); return real(m); };
  try { fn(); } finally { dispatch.applyMsg = real; }
  return seen;
}

describe('[5] right-click context menu — copy + dismiss', () => {
  it('right-click a row → "Copy item"; clicking it yanks the label', () => {
    sm.bootFresh();
    sm.capture(() => sm.render());
    const b = groupsBounds();
    const [sx, sy] = sgr0(b.x + 2, b.y + 1);     // first groups row (g1)

    sm.capture(() => sm.handleMouse('right', sx, sy));
    eq(getModel().modes.menuOpen, true, 'right-click opened the context menu');
    const labels = getModel().modal.menu.items.map(r => r && r[0]);   // null = separator
    assert(labels.includes('Copy item'), `context menu offers Copy item (saw: ${JSON.stringify(labels)})`);

    // The menu opened at the anchor → its first content row sits one cell
    // below/right of the cursor. Click it; the copy verb pushes to register.
    const seen = withMsgSpy(() => sm.capture(() => sm.handleMouse('press', sx + 1, sy + 1)));
    eq(getModel().modes.menuOpen, false, 'activating an item closed the menu');
    const push = seen.find(m => m.type === 'register_push');
    assert(push, 'a register_push fired from the Copy item row');
    eq(push.text, 'Group 1', 'copied the row label');
    eq(mreg.top(getModel().register), 'Group 1', 'register top is the copied label');
  });

  it('right-click then click OUTSIDE the box dismisses it', () => {
    sm.bootFresh();
    sm.capture(() => sm.render());
    const { rows } = require('../../io/term');
    const b = groupsBounds();
    const [sx, sy] = sgr0(b.x + 2, b.y + 1);
    sm.capture(() => sm.handleMouse('right', sx, sy));
    eq(getModel().modes.menuOpen, true, 'menu open');
    const focusBefore = api.getInstanceSlice('layout').focus;
    // Click the very bottom row — well outside the small top-anchored box.
    sm.capture(() => sm.handleMouse('press', sx, rows()));
    eq(getModel().modes.menuOpen, false, 'outside-click dismissed the menu');
    eq(api.getInstanceSlice('layout').focus, focusBefore, 'dismiss did not change focus');
  });

  it('right-click a VIEWER line → "Copy line" copies that line text', () => {
    sm.bootFresh();
    sm.capture(() => sm.render());
    // Seed viewer content directly; right-click → menu_open is a root Msg
    // (doesn't run the viewer finalizer), so the lines persist for the
    // context resolver to read the line under the cursor.
    const d = api.primarySliceOf('detail');
    d.infoLines = ['alpha line', 'bravo line', 'charlie line'];  // P3 — Info canonical home
    d.scroll = 0;
    sm.capture(() => sm.render());
    const lay = api.getInstanceSlice('layout');
    const b = geo.visibleBoundsFor(lay, 'pane-detail');
    assert(b, 'detail pane bounds present');
    const [sx, sy] = sgr0(b.x + 2, b.y + 1);   // first content row → 'alpha line'

    const seen = withMsgSpy(() => {
      sm.capture(() => sm.handleMouse('right', sx, sy));
      const labels = getModel().modal.menu.items.map(r => r && r[0]);   // null = separator
      assert(labels.includes('Copy line'), `viewer context offers Copy line (saw: ${JSON.stringify(labels)})`);
      sm.capture(() => sm.handleMouse('press', sx + 1, sy + 1));   // click the first row
    });
    const push = seen.find(m => m.type === 'register_push');
    assert(push, 'a register_push fired from Copy line');
    eq(push.text, 'alpha line', 'copied the clicked line');
  });

  it('a viewer drag-selection PERSISTS, and right-click → Copy selection copies it', () => {
    const sel = require('../../panel/viewer/select');
    const { overlayBox } = require('../../leaves/render/draw');
    sm.bootFresh();
    sm.capture(() => sm.render());
    const d = api.primarySliceOf('detail');
    d.lines = ['hello world foo bar', 'second line'];
    d.scroll = 0;
    sm.capture(() => sm.render());
    const lay = api.getInstanceSlice('layout');
    const b = geo.visibleBoundsFor(lay, 'pane-detail');
    // Drag across the first content line: press → motion → release.
    const [px, py] = sgr0(b.x + 2, b.y + 1);      // first content row, col 0-ish
    sm.capture(() => sm.handleMouse('press', px, py));
    sm.capture(() => sm.handleMouse('motion', px + 11, py));
    sm.capture(() => sm.handleMouse('release', px + 11, py));
    assert(sel.isActive(), 'selection persists after release (no auto-clear)');
    const selText = sel.selectedText();
    assert(selText && selText.length > 0, `something is selected (got ${JSON.stringify(selText)})`);

    // Right-click the selection → the menu offers Copy selection.
    const [rx, ry] = sgr0(b.x + 4, b.y + 1);
    sm.capture(() => sm.handleMouse('right', rx, ry));
    const items = getModel().modal.menu.items;
    const ci = items.findIndex(r => r && r[0] === 'Copy selection');
    assert(ci >= 0, `menu offers Copy selection (saw: ${JSON.stringify(items.map(r => r && r[0]))})`);

    // Click that row (compute its painted cell from the shared box geometry).
    const box = overlayBox({ linesLen: items.length, anchor: getModel().modal.menu.anchor, maxWidth: 44 });
    const seen = withMsgSpy(() => sm.capture(() => sm.handleMouse('press', box.offX + 3, box.offY + 1 + ci + 1)));
    const push = seen.find(m => m.type === 'register_push');
    assert(push, 'Copy selection pushed to the register');
    eq(push.text, selText, 'copied the persisted selection text');
  });

  it('a bare viewer click (press→release, no motion) does NOT yank or trap visual mode', () => {
    // Regression: settle() used to treat a zero-width click as a 1-char
    // selection — yanking a stray char to the register AND leaving the
    // viewer stuck in visual mode (j/k extend instead of scroll).
    const sel = require('../../panel/viewer/select');
    sm.bootFresh();
    sm.capture(() => sm.render());
    const d = api.primarySliceOf('detail');
    d.lines = ['hello world foo bar', 'second line'];
    d.scroll = 0;
    sm.capture(() => sm.render());
    const lay = api.getInstanceSlice('layout');
    const b = geo.visibleBoundsFor(lay, 'pane-detail');
    const [px, py] = sgr0(b.x + 4, b.y + 1);     // land ON a char
    const seen = withMsgSpy(() => {
      sm.capture(() => sm.handleMouse('press', px, py));
      sm.capture(() => sm.handleMouse('release', px, py));   // no motion
    });
    assert(!sel.isActive(), 'a bare click leaves NO active selection (not trapped in visual mode)');
    assert(!seen.some(m => m.type === 'register_push'),
      `a bare click must NOT push to the register (saw: ${JSON.stringify(seen.map(m => m.type))})`);
  });

  it('right-click on empty space opens the general menu (no copy entry)', () => {
    sm.bootFresh();
    sm.capture(() => sm.render());
    const { cols, rows } = require('../../io/term');
    sm.capture(() => sm.handleMouse('right', cols(), rows()));   // bottom-right corner
    eq(getModel().modes.menuOpen, true, 'right-click is live even on empty space');
    const labels = getModel().modal.menu.items.map(r => r && r[0]);
    assert(labels.includes('Refresh'), `general section present (saw: ${JSON.stringify(labels)})`);
    assert(!labels.includes('Copy line') && !labels.includes('Copy item'),
      'no copy entry where there is no target');
  });
});

// --- [6] YAML `context-menu:` entries — appear in the menu + route -----
//
// A config-declared entry is appended as a trailing section and, when
// clicked, routes its verb through menu_action → handleAction. The
// menu_action effect calls dispatch.handleAction (a captured re-export),
// so spy THAT layer to observe the routed (verb, arg). pane: gates an entry
// to its kind (shown there, hidden on empty space).

const cm = require('../../leaves/input/context-menu');
const { overlayBox } = require('../../leaves/render/draw');

// Spy dispatch.handleAction (the menu_action effect's call target) to capture
// the routed (verb, arg) without running the verb's downstream effect.
function withDispatchActionSpy(fn) {
  const calls = [];
  const real = dispatch.handleAction;
  dispatch.handleAction = (...a) => { calls.push(a); };
  try { fn(); } finally { dispatch.handleAction = real; }
  return calls;
}

// Click the painted cell of the menu row whose label === wantLabel, using the
// shared overlayBox geometry (same technique as [5]'s Copy selection click).
function clickMenuRow(wantLabel) {
  const items = getModel().modal.menu.items;
  const ci = items.findIndex(r => r && r[0] === wantLabel);
  assert(ci >= 0, `menu offers '${wantLabel}' (saw: ${JSON.stringify(items.map(r => r && r[0]))})`);
  const box = overlayBox({ linesLen: items.length, anchor: getModel().modal.menu.anchor, maxWidth: 44 });
  sm.capture(() => sm.handleMouse('press', box.offX + 3, box.offY + 1 + ci + 1));
}

describe('[6] context-menu: config entries', () => {
  it('a builtin entry appears after the built-ins and routes its verb on click', () => {
    cm.configure([{ label: 'My Refresh', builtin: 'refresh' }]);
    try {
      sm.bootFresh();
      sm.capture(() => sm.render());
      const { cols, rows } = require('../../io/term');
      sm.capture(() => sm.handleMouse('right', cols(), rows()));   // empty space → general + config
      const labels = getModel().modal.menu.items.map(r => r && r[0]);
      assert(labels.includes('My Refresh'), `config entry present (saw: ${JSON.stringify(labels)})`);
      assert(labels.indexOf('My Refresh') > labels.indexOf('Help'), 'config section trails the built-ins');

      const calls = withDispatchActionSpy(() => clickMenuRow('My Refresh'));
      eq(getModel().modes.menuOpen, false, 'clicking the config row closed the menu');
      assert(calls.some(c => c[0] === 'refresh'), `builtin verb routed (saw: ${JSON.stringify(calls)})`);
    } finally { cm.reset(); }
  });

  it('an action entry routes ctx_run_action(key); a pane: gate scopes it', () => {
    cm.configure([{ label: 'Grep', action: 'grep', pane: 'groups' }]);
    try {
      sm.bootFresh();
      sm.capture(() => sm.render());
      const { cols, rows } = require('../../io/term');

      // Hidden on empty space (pane-gated, no pane under the cursor there).
      sm.capture(() => sm.handleMouse('right', cols(), rows()));
      assert(!getModel().modal.menu.items.some(r => r && r[0] === 'Grep'),
        'pane-gated entry hidden on empty space');

      // Fresh boot so the next right-click opens a NEW menu (a right-click
      // while one is open just interacts with the existing modal).
      sm.bootFresh();
      sm.capture(() => sm.render());

      // Shown on the groups pane it is gated to; click routes ctx_run_action.
      const b = groupsBounds();
      const [sx, sy] = sgr0(b.x + 3, b.y + 1);
      sm.capture(() => sm.handleMouse('right', sx, sy));
      const calls = withDispatchActionSpy(() => clickMenuRow('Grep'));
      const ctxCall = calls.find(c => c[0] === 'ctx_run_action');
      assert(ctxCall, `action entry routes ctx_run_action (saw: ${JSON.stringify(calls)})`);
      eq(ctxCall[1], 'grep', 'with the configured action key as arg');
    } finally { cm.reset(); }
  });
});

report();
