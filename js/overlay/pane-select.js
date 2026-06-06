/**
 * Pane-select overlay — per-cell pool picker.
 *
 * Click the [≡] glyph on any non-detail panel → centered overlay opens
 * listing every pool entry tagged by status:
 *   [here]      current cell's occupant (pick = no-op)
 *   [hidden]    pool entry not currently placed (pick = replace)
 *   [in col N]  placed elsewhere (pick = SWAP — the two slots trade)
 *
 * Invariants enforced at pick time (D3):
 *   - detail can't be picked anywhere (must stay at end)
 *   - actions can't end up in the leftmost column (Code-1 rule)
 *   - detail / actions can't be replaced (existing rule)
 *
 * D1 — this file: glyph hit-test + render skeleton (no body yet).
 *      The overlay paints a placeholder until D2 wires the list +
 *      cursor.
 * D2 — list rendering + cursor navigation + close-on-pick.
 * D3 — pick logic: replace / swap / validity guard + pool_swap_by_id
 *      reducer Msg.
 *
 * Co-exists with `w` (the panel-list overlay): `w` is "global pool
 * browser, toggle hide/show." Pane-select is "what should occupy THIS
 * slot specifically." Different intents, different glyphs (`w` opens
 * a centered overlay via key; pane-select opens via [≡] click).
 */
'use strict';

const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');
const { renderOverlay } = require('../render/panel');
const { esc, visibleLen } = require('../io/ansi');
const { isChainActive } = require('../dispatch/modes');
const mpool = require('../leaves/pool');

const MAX_W = 50;
const VIEWPORT = 12;

// [≡] glyph geometry — matches the tab-list trigger (same position,
// same width). Kept duplicated rather than imported because the two
// triggers are semantically distinct (tab-list = detail; pane-select
// = non-detail) and may diverge in v0.7 (multi-tab non-detail panes
// could grow a separate paneSelect glyph at a different column).
const TRIGGER_X_OFFSET = 5;  // after the pane's `╭─(o)`
const TRIGGER_VIS_W = 3;     // [≡] occupies 3 visible cells

/** Pane bounds via the layout-derived accessor. Null when layout
 *  hasn't rendered yet (boot edge). Lazy require to dodge the
 *  layout ↔ overlay cycle. */
function _paneBounds(paneId) {
  return require('../render/layout').boundsFor(paneId);
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
  // Any chain mode other than paneSelectMode means the trigger is
  // painted disabled — refuse the click. Routes through
  // dispatch/modes.isChainActive so adding a new chain mode lands
  // here automatically.
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
    // Hit. While paneSelectMode is on, sibling triggers are inert —
    // only the open target's own [≡] toggles close.
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

/** Effective viewport row count — capped by terminal height. Exported
 *  so the dispatch nav handler can fold it into pane_select_nav Msgs
 *  (the reducer stays free of the terminal-size read). */
function viewportRows() {
  const { rows } = require('../io/term');
  // Reserve room for the centered overlay border + footer line.
  return Math.max(3, Math.min(VIEWPORT, rows() - 6));
}

function _statusLabel(it) {
  if (it.status === 'here')   return '[dim][here][/]';
  if (it.status === 'hidden') return '[yellow][hidden][/]';
  return `[cyan][in col ${it.columnIndex + 1}][/]`;
}

/** Overlay rect geometry — mirrors `renderOverlay`'s centering math so
 *  the row hit-test and the painter agree on cell coordinates. Returns
 *  { x, y, w, h, items, scroll } or null when the overlay isn't open. */
function _geom() {
  if (!getModel().modes.paneSelectMode) return null;
  const layoutSlice = getInstanceSlice('layout');
  if (!layoutSlice || !layoutSlice.paneSelect) return null;
  const { cols, rows } = require('../io/term');
  const all = items();
  const vh = viewportRows();
  const lineCount = all.length === 0 ? 1 : Math.min(vh, all.length);
  const COLS = cols(), ROWS = rows();
  const menuW = Math.min(MAX_W, COLS - 2);
  const menuH = Math.min(lineCount + 2, ROWS - 2);
  const offY = Math.max(0, Math.floor((ROWS - menuH) / 2));
  const offX = Math.max(0, Math.floor((COLS - menuW) / 2));
  const scroll = Math.max(0, layoutSlice.paneSelect.scroll || 0);
  return { x: offX, y: offY, w: menuW, h: menuH, items: all, scroll };
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

/** v0.6.3 D2 — list-body render. Item rows show:
 *    `▸ <type>  <status>`   (active row reverse-decorated)
 *  Empty state when the layout's pool has no non-detail entries. */
function render() {
  if (!getModel().modes.paneSelectMode) return;
  const layoutSlice = getInstanceSlice('layout');
  const ps = layoutSlice && layoutSlice.paneSelect;
  if (!ps) return;
  const all = items();
  const vh = viewportRows();
  const cursor = Math.max(0, Math.min(all.length - 1, ps.cursor || 0));
  const scroll = Math.max(0, Math.min(Math.max(0, all.length - vh), ps.scroll || 0));
  const lines = [];
  if (all.length === 0) {
    lines.push('[dim](no panes — pool is empty)[/]');
  } else {
    const end = Math.min(all.length, scroll + vh);
    for (let i = scroll; i < end; i++) {
      const it = all[i];
      const marker = (i === cursor) ? '▸' : ' ';
      const left = `${marker} ${esc(it.type)}`;
      const right = _statusLabel(it);
      const leftVis = visibleLen(left);
      const rightVis = visibleLen(right);
      // Budget = MAX_W - borders(2) - padding(2) = MAX_W - 4
      const inner = MAX_W - 4;
      const padLen = Math.max(1, inner - leftVis - rightVis);
      const row = `${left}${' '.repeat(padLen)}${right}`;
      lines.push((i === cursor) ? `[reverse]${row}[/]` : row);
    }
  }
  renderOverlay({
    lines,
    title: 'Pane select',
    count: all.length > 0 ? [cursor + 1, all.length] : null,
    maxWidth: MAX_W,
  });
}

module.exports = { hitTestTrigger, hitTest, render, items, viewportRows };
