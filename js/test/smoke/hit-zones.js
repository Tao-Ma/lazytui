/**
 * Smoke — mouse hit-zones over the rendered frame.
 *
 * The v0.6.3 "[x] click hit-zone offset" bug: `buildTabStrip` computed
 * each tab's `closeX` based on the column where the title's text
 * begins, but a recent chrome change added a `[≡]` tab-list trigger
 * (3 cells) BETWEEN the hotkey and the title — without that 3-cell
 * shift the hit-rect was off by 3 columns left of the visible glyph.
 * Clicking the actual `[x]` did nothing; clicking 3 cells to its
 * left fired close on the wrong target.
 *
 * The structural fix was a one-line offset correction in
 * tab-strip.js:84. The regression risk is that any future chrome
 * insertion that shifts the title (a new glyph, a renamed slot, a
 * width change) will re-introduce the same bug class without a hit-
 * zone gate to catch it.
 *
 * This smoke pins the invariant from BOTH directions:
 *   - For every content tab, the column where `[x]` is painted on
 *     screen matches the closeX/closeW that input.js uses for hit-
 *     test (paint-vs-hittest cross-check).
 *   - Clicking inside (closeX, closeX+closeW) closes the tab.
 *   - Clicking ONE column outside that range does NOT close (no
 *     off-by-one slop in either direction).
 *
 * Run: node js/test/smoke/hit-zones.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('../test-runner');
const sm = require('./_helpers/smoke');
const api = sm.api;
const tabs = sm.tabs;
const { getModel } = require('../../app/runtime');

// --- Decode cursor positions from the raw ANSI bytes so we can locate
//     the painted `[x]` glyph on the actual screen coordinate grid.
//     Same technique as test-live-render.js [collapse-shift].
//
// Returns Map<row, Map<col, char>> using 1-based cursor coords (the
// terminal's native form; `\x1b[N;MH` puts the cursor at row N, col M,
// both 1-based).

function decodeFrame(raw) {
  const grid = new Map();
  let curRow = 1, curCol = 1;
  let i = 0;
  while (i < raw.length) {
    const cur = raw.slice(i).match(/^\x1b\[(\d+);(\d+)H/);
    if (cur) {
      curRow = parseInt(cur[1], 10);
      curCol = parseInt(cur[2], 10);
      i += cur[0].length;
      continue;
    }
    const otherEsc = raw.slice(i).match(/^\x1b\[[\d;?]*[A-Za-z]/);
    if (otherEsc) { i += otherEsc[0].length; continue; }
    const ch = raw[i];
    if (ch === '\n' || ch === '\r') { i++; continue; }
    let row = grid.get(curRow);
    if (!row) { row = new Map(); grid.set(curRow, row); }
    row.set(curCol, ch);
    curCol++;
    i++;
  }
  return grid;
}

/** Extract the visible text of a single row from the decoded grid. */
function rowText(grid, row, fromCol, toCol) {
  const r = grid.get(row);
  if (!r) return '';
  let s = '';
  for (let c = fromCol; c <= toCol; c++) s += (r.get(c) || ' ');
  return s;
}

// --- Setup helper: open two content tabs so we have at least one
//     [x] close glyph to hit-test.

function setupTwoContentTabs() {
  sm.bootFresh();
  tabs.addContentTab('g1', 'doc-A', 'A', ['A1', 'A2']);
  tabs.addContentTab('g1', 'doc-B', 'B', ['B1', 'B2']);
  // Park focus on detail so the tab-strip paints prominently.
  api.getInstanceSlice('layout').focus = 'pane-detail';
}

// --- [1] tabBounds vs. painted frame: closeX points at the [x] glyph -

describe('[1] paint-vs-hittest: closeX in tabBounds aligns with on-screen [x]', () => {
  it('the column under closeX is the literal `[` of the close glyph', () => {
    setupTwoContentTabs();
    const { raw } = sm.capture(() => sm.render());
    const grid = decodeFrame(raw);
    const layout = api.getInstanceSlice('layout');
    const detail = api.primarySliceOf('detail');
    const b = layout.paneBounds && (layout.paneBounds['pane-detail'] || layout.paneBounds.detail);
    assert(b, `paneBounds for detail present (saw keys: ${Object.keys(layout.paneBounds || {}).join(',')})`);
    const bounds = (detail.tabBounds || []).filter(t => t.closeKey != null);
    assert(bounds.length >= 1, `at least one tab carries a close glyph (saw ${bounds.length})`);

    for (const tb of bounds) {
      // input.js uses 0-indexed bounds + 0-indexed mx/my; the decoder
      // emits 1-based cursor coords. Convert at the comparison.
      const screenColStart = b.x + tb.closeX + 1;    // 1-based
      const screenRow = b.y + 1;                     // top border (1-based)
      const painted = rowText(grid, screenRow, screenColStart, screenColStart + tb.closeW - 1);
      assert(painted.includes('[') && painted.includes('x') && painted.includes(']'),
        `closeKey='${tb.closeKey}': expected '[x]' painted at row=${screenRow}, col=${screenColStart}..${screenColStart + tb.closeW - 1}; got: ${JSON.stringify(painted)}`);
    }
  });
});

// --- [2] Click inside closeX..closeX+closeW → close fires -------------

// handleMouse takes 1-based SGR coords (it subtracts 1 internally to
// reach the 0-based grid input.js uses for hit-tests). paneBounds and
// tabBounds are 0-based — so a click at 0-based (b.x + closeX + k,
// b.y) maps to SGR (b.x + closeX + k + 1, b.y + 1).
function sgr0(col0, row0) { return [col0 + 1, row0 + 1]; }

describe('[2] click inside the [x] hit-rect closes the tab', () => {
  it('click at the center of closeX → tab removed from contentTabs map', () => {
    setupTwoContentTabs();
    sm.capture(() => sm.render());   // populate tabBounds + paneBounds
    const layout = api.getInstanceSlice('layout');
    const detail = api.primarySliceOf('detail');
    const b = layout.paneBounds['pane-detail'] || layout.paneBounds.detail;
    const closeTab = (detail.tabBounds || []).find(t => t.closeKey != null);
    assert(closeTab, 'a closeable tab exists');

    // Click at the middle column of the close rect, on the top border row.
    const [sx, sy] = sgr0(b.x + closeTab.closeX + Math.floor(closeTab.closeW / 2), b.y);
    sm.capture(() => sm.handleMouse('press', sx, sy));

    const after = api.primarySliceOf('detail');
    const stillThere = (after.contentTabs && after.contentTabs.g1 && after.contentTabs.g1[closeTab.closeKey]);
    assert(!stillThere,
      `tab '${closeTab.closeKey}' MUST be closed; remaining keys: ${JSON.stringify(Object.keys((after.contentTabs && after.contentTabs.g1) || {}))}`);
  });
});

// --- [3] Click ONE column LEFT of closeX → tab-switch, NOT close ------
//
// The off-by-one regression class. Clicking just inside the tab body
// (one column left of where `[` is) MUST do a tab-switch, not a close.

describe('[3] click one column LEFT of closeX → switches, does not close', () => {
  it('mx=closeX-1 → tab still in map; the click moves activeTab instead', () => {
    setupTwoContentTabs();
    sm.capture(() => sm.render());
    const layout = api.getInstanceSlice('layout');
    const detail = api.primarySliceOf('detail');
    const b = layout.paneBounds['pane-detail'] || layout.paneBounds.detail;
    // Pick a tab that is NOT currently active so a tab-switch click
    // actually changes activeTab — easier signal than "no change".
    const activeIdx = detail.tab;
    const closeTab = (detail.tabBounds || []).find(t => t.closeKey != null && t.tabIdx !== activeIdx);
    assert(closeTab, 'a non-active closeable tab exists');

    // ONE column LEFT of closeX. Use the same local-x math input.js does.
    const [sx, sy] = sgr0(b.x + closeTab.closeX - 1, b.y);
    sm.capture(() => sm.handleMouse('press', sx, sy));

    const after = api.primarySliceOf('detail');
    const stillThere = after.contentTabs && after.contentTabs.g1 && after.contentTabs.g1[closeTab.closeKey];
    assert(stillThere,
      `tab '${closeTab.closeKey}' MUST survive a click one column left of [x] — that's a switch zone, not a close zone`);
    // Stronger invariant: the click must have moved activeTab to closeTab.
    // The bare "tab still exists" check passes even if the click hit dead
    // space (neither close nor switch fires); this assertion catches that
    // class of off-by-one in the switch hit-rect compute.
    eq(after.tab, closeTab.tabIdx,
      `click in the switch zone MUST land activeTab on tabIdx=${closeTab.tabIdx} (was ${activeIdx})`);
  });
});

// --- [4] Click ONE column RIGHT of closeX + closeW → no close --------
//
// The other side of the off-by-one bracket. Clicking past the [x]
// rect must not bleed into close behavior.

describe('[4] click ONE column RIGHT of closeX+closeW → does not close', () => {
  it('mx=closeX+closeW → close does NOT fire', () => {
    setupTwoContentTabs();
    sm.capture(() => sm.render());
    const layout = api.getInstanceSlice('layout');
    const detail = api.primarySliceOf('detail');
    const b = layout.paneBounds['pane-detail'] || layout.paneBounds.detail;
    const closeTab = (detail.tabBounds || []).find(t => t.closeKey != null);
    assert(closeTab, 'a closeable tab exists');

    const [sx, sy] = sgr0(b.x + closeTab.closeX + closeTab.closeW, b.y);
    sm.capture(() => sm.handleMouse('press', sx, sy));

    const after = api.primarySliceOf('detail');
    const stillThere = after.contentTabs && after.contentTabs.g1 && after.contentTabs.g1[closeTab.closeKey];
    assert(stillThere,
      `tab '${closeTab.closeKey}' MUST survive a click one column right of [x]+closeW`);
  });
});

report();
