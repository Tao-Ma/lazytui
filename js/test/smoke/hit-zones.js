/**
 * Smoke — mouse hit-zones over the rendered frame (U2e P1b model).
 *
 * The v0.6.3 "[x] click hit-zone offset" bug lived in the viewer's flat
 * content-tab strip: `buildTabStrip` computed each tab's `closeX` from the
 * title's start column, and a chrome change (the `[≡]` trigger) shifted the
 * title 3 cells without shifting the hit-rect. Post-U2e-P1b that flat
 * content-tab strip is gone: the content slot's tabs are POSITION-tabs
 * (Info / Transcript / minted `text-view`s), painted by the unified slot
 * strip (panel/slot-strip.js#unifiedSlotStrip). Those bounds carry
 * `{ kind:'position', poolId, x, w }` — a click switches the active tab
 * (`set_active_tab`); there is no border `[x]` close glyph anymore. Closing a
 * content tab is the keyboard `x` gesture on the focused active text-view tab
 * (dispatch.js#'x' → `remove_tab`); Info + Transcript are permanent.
 *
 * The regression class this still guards: any chrome insertion that shifts the
 * painted labels without shifting the strip's `x`/`w` bounds re-introduces the
 * off-by-one — clicking a tab would switch the wrong sibling. So this smoke
 * pins, from both directions:
 *   - For every position-tab, the column where its label is painted on screen
 *     matches the `x`/`w` bounds input.js hit-tests (paint-vs-hittest).
 *   - Clicking inside (x, x+w) switches the slot's active tab to it.
 *   - Clicking ONE column outside that range does NOT switch to it.
 *   - `x` on a focused content text-view tab closes it (remove_tab); Info +
 *     Transcript are permanent (no close).
 *
 * Run: node js/test/smoke/hit-zones.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('../test-runner');
const sm = require('./_helpers/smoke');
const geo = require('../../leaves/wm/geometry');  // A.2: bounds are derived, not on slice.paneBounds
const api = sm.api;
const { getModel } = require('../../app/runtime');
const mpool = require('../../leaves/wm/pool');
const slotStrip = require('../../panel/slot-strip');

// U2e P1b — the content slot is seeded (arrange.js#_seedContentSlots) with
// Info + Transcript position-tabs, minting `info` + `text-view` instances; and
// content tabs are minted `text-view` position-tabs by feature/content-tab.js.
// test-runner auto-registers only layout/detail/groups, so register the two
// content Components (or the seed's mint drops the info/transcript instances)
// and require the content-tab feature (wires the mint-a-position-tab seam).
if (!api.getComponent('info')) api.registerComponent(require('../../panel/info/info'));
if (!api.getComponent('text-view')) api.registerComponent(require('../../panel/text-view/text-view'));
const contentTab = require('../../panel/content-tab');

// The content SLOT pane (role-anchored, P1a) — its unified strip + geometry.
function contentPane() {
  const layout = api.getInstanceSlice('layout');
  return mpool.allPanesInColumns(layout.arrange).find(p => p.role === 'content');
}

// The position-tab strip's click bounds (what input.js hit-tests on the top
// border of a multi-tab slot: panel/slot-strip.unifiedSlotStrip → tabBounds
// with { kind:'position', poolId, x, w }; the hidden detail anchor is skipped).
function slotTabBounds() {
  const strip = slotStrip.unifiedSlotStrip(contentPane());
  return strip ? strip.tabBounds : [];
}

// --- Decode cursor positions from the raw ANSI bytes so we can locate
//     the painted tab label on the actual screen coordinate grid.
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

// --- Setup helper: open two content text-view tabs so the slot has a
//     multi-tab position strip (Info | Transcript | A | B) to hit-test.
//     Content tabs are minted position-tabs now (feature/content-tab),
//     NOT the retired viewer contentTabs map.

function setupTwoContentTabs() {
  sm.bootFresh();
  contentTab.addContentTab('g1', 'doc-A', 'A', ['A1', 'A2']);
  contentTab.addContentTab('g1', 'doc-B', 'B', ['B1', 'B2']);
  // Park focus on the content slot so its tab-strip paints prominently.
  api.getInstanceSlice('layout').focus = 'pane-detail';
}

// The poolId of the tab whose painted label (bracket-stripped) === `label`.
function poolIdForLabel(label) {
  const strip = slotStrip.unifiedSlotStrip(contentPane());
  const e = (strip.entries || []).find(x => x.label === label);
  return e ? e.poolId : null;
}

// --- [1] slot strip vs. painted frame: each tab's x/w aligns with its label -

describe('[1] paint-vs-hittest: position-tab bounds align with on-screen labels', () => {
  it('every strip tab bound sits exactly under its painted label', () => {
    setupTwoContentTabs();
    const { raw } = sm.capture(() => sm.render());
    const grid = decodeFrame(raw);
    const layout = api.getInstanceSlice('layout');
    const b = geo.visibleBoundsFor(layout, 'pane-detail');
    assert(b, 'derived viewer bounds present');
    const bounds = slotTabBounds();
    assert(bounds.length >= 3,
      `the multi-tab slot has a position strip (saw ${bounds.length} tabs)`);
    // The active tab is painted bracketed (`[label]`); the strip bound's `w`
    // already includes those two bracket cells, so the painted slice matches.
    const activePoolId = contentPane().activeTabId;

    for (const tb of bounds) {
      // input.js uses 0-indexed bounds + 0-indexed mx/my; the decoder emits
      // 1-based cursor coords. Convert at the comparison.
      const screenColStart = b.x + tb.x + 1;      // 1-based
      const screenRow = b.y + 1;                   // top border (1-based)
      const painted = rowText(grid, screenRow, screenColStart, screenColStart + tb.w - 1);
      const strip = slotStrip.unifiedSlotStrip(contentPane());
      const label = (strip.entries.find(e => e.poolId === tb.poolId) || {}).label || '';
      if (tb.poolId === activePoolId) {
        // Active tab paints `[label]`.
        assert(painted === `[${label}]`,
          `active tab '${tb.poolId}': expected '[${label}]' at row=${screenRow}, col=${screenColStart}..${screenColStart + tb.w - 1}; got ${JSON.stringify(painted)}`);
      } else {
        assert(painted === label,
          `tab '${tb.poolId}': expected '${label}' at row=${screenRow}, col=${screenColStart}..${screenColStart + tb.w - 1}; got ${JSON.stringify(painted)}`);
      }
    }
  });
});

// --- [2] Click inside a tab's x..x+w → set_active_tab (switch); x closes ---

// handleMouse takes 1-based SGR coords (it subtracts 1 internally to
// reach the 0-based grid input.js uses for hit-tests). paneBounds and
// tabBounds are 0-based — so a click at 0-based (b.x + x + k, b.y)
// maps to SGR (b.x + x + k + 1, b.y + 1).
function sgr0(col0, row0) { return [col0 + 1, row0 + 1]; }

describe('[2] click a position tab switches it; `x` closes a content tab', () => {
  it('clicking tab A\'s bounds makes it active, then `x` removes it', () => {
    setupTwoContentTabs();
    sm.capture(() => sm.render());   // populate geometry
    const layout = api.getInstanceSlice('layout');
    const b = geo.visibleBoundsFor(layout, 'pane-detail');
    const poolA = poolIdForLabel('A');
    assert(poolA, 'content tab A is in the strip');
    const tabA = slotTabBounds().find(t => t.poolId === poolA);
    assert(tabA, 'tab A has a click bound');

    // Click the middle column of tab A's bound, on the top border row.
    const [sx, sy] = sgr0(b.x + tabA.x + Math.floor(tabA.w / 2), b.y);
    sm.capture(() => sm.handleMouse('press', sx, sy));
    eq(contentPane().activeTabId, poolA, 'clicking tab A made it the slot\'s active tab');

    // `x` on the focused active content text-view tab closes it (remove_tab).
    sm.capture(() => sm.handleKey('x', 'x'));
    const tabsAfter = (contentPane().tabs || []).map(t => t.poolId);
    assert(!tabsAfter.includes(poolA),
      `content tab '${poolA}' MUST be closed by \`x\`; remaining: ${JSON.stringify(tabsAfter)}`);
    // The tab's minted instance is disposed too (no orphan slice).
    const mpane = require('../../leaves/wm/pane');
    assert(!api.getInstance(mpane.newPaneId(poolA)),
      'the closed tab\'s minted text-view instance is disposed');
  });
});

// --- [3] Click ONE column LEFT of a tab → does not switch to it ------------
//
// The off-by-one regression class. A click one column left of tab A's start
// lands on the separator / previous tab, NOT tab A — so activeTabId must not
// become tab A.

describe('[3] click one column LEFT of a tab does not switch to it', () => {
  it('mx=x-1 → active tab is NOT that tab (no left slop)', () => {
    setupTwoContentTabs();
    sm.capture(() => sm.render());
    const layout = api.getInstanceSlice('layout');
    const b = geo.visibleBoundsFor(layout, 'pane-detail');
    // Pick a tab that is NOT currently active, so a real switch would be a
    // visible change; the click one column left must NOT produce it.
    const activePoolId = contentPane().activeTabId;
    const target = slotTabBounds().find(t => t.poolId !== activePoolId);
    assert(target, 'a non-active tab exists');

    const [sx, sy] = sgr0(b.x + target.x - 1, b.y);
    sm.capture(() => sm.handleMouse('press', sx, sy));
    assert(contentPane().activeTabId !== target.poolId,
      `a click one column left of tab '${target.poolId}' must NOT switch to it (off-by-one guard)`);

    // Positive control: a click INSIDE the same tab's bounds DOES switch to it.
    // Without this, the "left click didn't switch" check would pass vacuously
    // even if clicks in the strip did nothing at all.
    const [ix, iy] = sgr0(b.x + target.x, b.y);
    sm.capture(() => sm.handleMouse('press', ix, iy));
    eq(contentPane().activeTabId, target.poolId,
      `a click at the tab's own start column MUST switch to '${target.poolId}' (switch zone is live)`);
  });
});

// --- [4] Info + Transcript are permanent: `x` does not close them ----------
//
// The other side of the close bracket: closing is scoped to content
// text-view tabs. Info (kind 'info') and Transcript (text-view, hint
// 'transcript') are seeded permanents and must survive an `x`.

describe('[4] `x` does not close the permanent Info / Transcript tabs', () => {
  it('Info + Transcript survive `x` when active', () => {
    setupTwoContentTabs();
    sm.capture(() => sm.render());
    const loop = require('../../dispatch/runtime/loop');
    const route = sm.route;

    for (const label of ['Info', 'Transcript']) {
      const poolId = poolIdForLabel(label);
      assert(poolId, `${label} tab is present`);
      loop.dispatchMsg(route.wrap('layout',
        { type: 'set_active_tab', paneId: 'pane-detail', tabPoolId: poolId }));
      api.getInstanceSlice('layout').focus = 'pane-detail';
      sm.capture(() => sm.handleKey('x', 'x'));
      const stillThere = (contentPane().tabs || []).some(t => t.poolId === poolId);
      assert(stillThere, `${label} MUST be permanent — \`x\` must not close it`);
    }
  });
});

report();
