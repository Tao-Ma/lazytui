/**
 * Pane-select overlay — per-cell pool picker.
 *
 * Click the [≡] glyph on any non-detail panel → a dropdown anchored
 * to that pane's top-left (mirrors detail's tab-list dropdown) lists
 * every pool entry tagged by status:
 *   [here]      current cell's occupant (pick = no-op)
 *   [hidden]    pool entry not currently placed (pick = replace)
 *   [in col N]  placed elsewhere (pick = SWAP — the two slots trade)
 *
 * Invariants enforced at pick time (D3):
 *   - detail can't be picked anywhere (must stay at end)
 *   - actions can't end up in the leftmost column (Code-1 rule)
 *   - detail / actions can't be replaced (existing rule)
 *   - multi-tab targets can't be REPLACEd (would lose tabs[] grouping)
 *
 * Geometry: same anchored-render pattern as overlay/tab-list — drops
 * down from the target pane's top row (y+1), with width clamped to the
 * pane's width (or MAX_W), and height clamped to remaining space below
 * (matches tab-list's bottom-edge handling).
 *
 * Co-exists with `w` (the panel-list overlay): `w` is "global pool
 * browser, toggle hide/show." Pane-select is "what should occupy THIS
 * slot specifically." Different intents, different glyphs (`w` opens
 * a centered overlay via key; pane-select opens via [≡] click).
 */
'use strict';

const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');
const { renderPanel } = require('../render/panel');
const { richToAnsi, RESET, esc, visibleLen } = require('../io/ansi');
const { stdout, rows } = require('../io/term');
const { isChainActive } = require('../dispatch/modes');
const mpool = require('../leaves/pool');

const MAX_W = 50;
const VIEWPORT = 12;

// [≡] glyph geometry — matches the tab-list trigger (same position,
// same width).
const TRIGGER_X_OFFSET = 5;  // after the pane's `╭─(o)`
const TRIGGER_VIS_W = 3;     // [≡] occupies 3 visible cells

// Residue tracking — the dropdown shrinks/closes by overwriting only
// the rows that were live last frame. Same pattern as overlay/tab-list
// (and overlay/cmdline.js#_lastPanelH).
let _lastPanelH = 0;
let _lastTop = 0;
let _lastLeft = 0;
let _lastWidth = 0;

/** Pane bounds via the layout-derived accessor. Null when layout
 *  hasn't rendered yet (boot edge), AND null for off-screen panes
 *  in half/full view — visibleBoundsFor reads slice-only so a click
 *  on the visible half can't accidentally fire pane-select on a
 *  non-visible pane whose normal-view rect overlaps the click.
 *  Lazy require to dodge the layout ↔ overlay cycle. */
function _paneBounds(paneId) {
  return require('../render/layout').visibleBoundsFor(paneId);
}

/** Mouse hit-test for any non-detail pane's [≡] trigger. Returns the
 *  paneId under (mx, my) or null. Suppression rules:
 *    - detail's [≡] is tab-list, not pane-select — skipped here.
 *    - drag in flight suppresses ALL pane chrome.
 *    - any chain mode OTHER than paneSelectMode itself disables every
 *      trigger (mirrors the painted 'disabled' state from chromeFor;
 *      the hit-test must agree with what the user sees).
 *    - while paneSelectMode is active, siblings return null; only the
 *      open target's own [≡] is clickable (toggles close).
 */
function hitTestTrigger(mx, my) {
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice || !layoutSlice.arrange) return null;
  const drag = layoutSlice.freeConfig && layoutSlice.freeConfig.drag;
  if (drag) return null;
  const modes = getModel().modes;
  if (!modes.paneSelectMode && isChainActive(modes)) return null;
  const openTargetId = (layoutSlice.paneSelect && layoutSlice.paneSelect.targetPaneId) || null;
  for (const p of mpool.allPanesInColumns(layoutSlice.arrange)) {
    if (p.type === 'detail') continue;
    const b = _paneBounds(p.paneId) || _paneBounds(p.type);
    if (!b) continue;
    if (b.w < TRIGGER_X_OFFSET + TRIGGER_VIS_W + 2) continue;
    if (my !== b.y) continue;
    if (mx < b.x + TRIGGER_X_OFFSET) continue;
    if (mx >= b.x + TRIGGER_X_OFFSET + TRIGGER_VIS_W) continue;
    if (modes.paneSelectMode && p.paneId !== openTargetId) return null;
    return p.paneId;
  }
  return null;
}

/** v0.6.3 D2 — pure item list for the overlay. Shape:
 *    [{ id, type, title, status: 'here'|'placed'|'hidden',
 *       columnIndex: number | null }, …]
 *  Returns []  when no layout yet. Exposed for tests + the handler
 *  side (handlePaneSelectKey needs item count for clamp math). */
function items() {
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice || !layoutSlice.paneSelect) return [];
  const arrange = layoutSlice.arrange;
  if (!arrange) return [];
  return mpool.paneSelectItems(arrange, layoutSlice.paneSelect.targetPaneId);
}

function _statusLabel(it) {
  if (it.status === 'here')   return '[dim][here][/]';
  if (it.status === 'hidden') return '[yellow][hidden][/]';
  return `[cyan][in col ${it.columnIndex + 1}][/]`;
}

/** Compute the dropdown geometry from the target pane's bounds. Drops
 *  down from `paneB.y + 1` (the row below the `[≡]` trigger). Width
 *  clamps to the pane's width (or MAX_W). Height clamps to remaining
 *  space below — same bottom-edge handling as overlay/tab-list. */
function _geom() {
  if (!getModel().modes.paneSelectMode) return null;
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice || !layoutSlice.paneSelect) return null;
  const paneId = layoutSlice.paneSelect.targetPaneId;
  const paneB = _paneBounds(paneId);
  if (!paneB) return null;
  const ROWS = rows();
  const all = items();
  // innerCap reserves: 2 border rows + 1 footer-row safety net (same
  // shape tab-list uses). Bottom-clamp height — if room runs out
  // below the trigger, drop fewer rows rather than overflow.
  const innerCap = Math.max(1, ROWS - paneB.y - 3);
  const lineCount = all.length === 0 ? 1 : Math.min(VIEWPORT, all.length);
  const innerH = Math.min(lineCount, innerCap);
  const h = innerH + 2;
  const w = Math.min(MAX_W, Math.max(24, paneB.w));
  const scroll = Math.max(0, layoutSlice.paneSelect.scroll || 0);
  return {
    x: paneB.x,
    y: paneB.y + 1,
    w,
    innerH,
    h,
    items: all,
    scroll,
  };
}

/** Effective viewport row count — used by the nav handler to compute
 *  clamp math (the reducer stays free of the terminal-size read). */
function viewportRows() {
  const g = _geom();
  return g ? g.innerH : 1;
}

/** Row hit-test for the open overlay. Returns { idx, item } when the
 *  click lands on a list row, null for borders / outside / empty
 *  state. Caller (dispatch/input.js paneSelectMode block) routes a
 *  row hit to `pool_swap_by_id` and a null hit to `pane_select_close`. */
function hitTest(mx, my) {
  const g = _geom();
  if (!g) return null;
  if (mx < g.x || mx >= g.x + g.w) return null;
  if (my < g.y || my >= g.y + g.h) return null;
  if (my === g.y || my === g.y + g.h - 1) return null;
  if (g.items.length === 0) return null;
  const rowIdx = (my - g.y - 1) + g.scroll;
  if (rowIdx < 0 || rowIdx >= g.items.length) return null;
  return { idx: rowIdx, item: g.items[rowIdx] };
}

/** Paint the dropdown. Mirrors overlay/tab-list#renderTabList — stamps
 *  panel content at absolute coords, residue-blanks rows from the
 *  previous frame that this frame doesn't cover. */
function render() {
  if (!getModel().modes.paneSelectMode) { _maybeBlank(); return; }
  const g = _geom();
  if (!g) { _maybeBlank(); return; }
  const cursor = Math.max(0, Math.min(g.items.length - 1, (getInstanceSlice('layout').paneSelect.cursor || 0)));
  const scroll = Math.max(0, Math.min(Math.max(0, g.items.length - g.innerH), g.scroll));

  const lines = [];
  if (g.items.length === 0) {
    lines.push('[dim](no panes — pool is empty)[/]');
  } else {
    const end = Math.min(g.items.length, scroll + g.innerH);
    for (let i = scroll; i < end; i++) {
      const it = g.items[i];
      const marker = (i === cursor) ? '▸' : ' ';
      const left = `${marker} ${esc(it.type)}`;
      const right = _statusLabel(it);
      const leftVis = visibleLen(left);
      const rightVis = visibleLen(right);
      // Available width inside the panel is (g.w - 4) — 2 border
      // cells + 2 padding cells the renderPanel module reserves.
      const inner = Math.max(8, g.w - 4);
      const padLen = Math.max(1, inner - leftVis - rightVis);
      const row = `${left}${' '.repeat(padLen)}${right}`;
      lines.push((i === cursor) ? `[reverse]${row}[/]` : row);
    }
  }

  const content = renderPanel({
    width: g.w, height: g.h, lines,
    title: 'Pane select', focused: true,
    count: g.items.length > 0 ? [cursor + 1, g.items.length] : null,
  });
  const panelLines = content.split('\n');
  let buf = '';
  for (let i = 0; i < panelLines.length; i++) {
    buf += `\x1b[${g.y + i + 1};${g.x + 1}H` + richToAnsi(panelLines[i]) + RESET;
  }
  // Residue-blank rows the prior frame painted but this one doesn't.
  if (_lastPanelH > g.h && _lastTop === g.y && _lastLeft === g.x) {
    const { invalidateRows } = require('../render/layout');
    invalidateRows(g.y + g.h, _lastTop + _lastPanelH);
    for (let y = g.y + g.h; y < _lastTop + _lastPanelH; y++) {
      buf += `\x1b[${y + 1};${g.x + 1}H${' '.repeat(_lastWidth)}`;
    }
  }
  _lastPanelH = g.h;
  _lastTop = g.y;
  _lastLeft = g.x;
  _lastWidth = g.w;
  stdout.write(buf);
}

function _maybeBlank() {
  if (_lastPanelH === 0) return;
  const { invalidateRows } = require('../render/layout');
  invalidateRows(_lastTop, _lastTop + _lastPanelH);
  _lastPanelH = 0;
}

module.exports = { hitTestTrigger, hitTest, render, items, viewportRows };
