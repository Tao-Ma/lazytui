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
const api = sm.api;
const { getModel } = require('../../app/runtime');
const actions = require('../../dispatch/actions');
const mb = require('../../dispatch/mouse-bindings');

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
  const layout = api.getInstanceSlice('layout');
  return layout.paneBounds['pane-groups'] || layout.paneBounds.groups;
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
    // as smoke/hit-zones.js) and find the row carrying the "Menu" title.
    const grid = decodeFrame(raw);
    let titleRow = null;
    for (const [row, cells] of grid) {
      let line = '';
      for (let c = 1; c <= COLS; c++) line += (cells.get(c) || ' ');
      if (line.includes('Menu')) { titleRow = row; break; }
    }
    assert(titleRow != null, 'found the painted Menu title on some row');
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

report();
