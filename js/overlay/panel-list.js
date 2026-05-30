/**
 * Panel-list overlay (v0.6 Phase 4) — modal popup showing every panel in
 * the pool: placed panels (in grid order, greyed since picking them
 * means hide), the essential `detail` panel (no-op pick), and hidden
 * panels (highlighted; pick = show + place in grid).
 *
 * State + behavior live in the layout Component's slice (slice.panelList
 * + the `panel_list_*` Msgs). This module is render-only: reads the
 * slice and paints, no writes.
 *
 * Opens automatically on free-config entry when there are hidden entries
 * (the discoverability hint that more panels are available than the
 * current grid shows). Manual open: `w` key while inside free-config.
 */
'use strict';

const { esc } = require('../io/ansi');
const { cols, rows } = require('../io/term');
const { renderOverlay } = require('../render/panel');
const { getComponentSlice } = require('../panel/api');
const mpool = require('../leaves/pool');

const OVERLAY_MAX_WIDTH = 60;
// Layout of the overlay's content rows (must match _buildLines below):
//   row 0: header "  status     id ..."
//   rows 1..N: one row per item (separator inserted between placed/hidden
//              groups; the separator advances visual position by 2 rows
//              without being a "clickable" item)
//   row N+1: blank
//   row N+2: footer hint
const HEADER_ROWS_TOP = 1;

function _slice() { return getComponentSlice('layout'); }

function renderPanelListOverlay() {
  const slice = _slice();
  if (!slice || !slice.panelList || !slice.panelList.open) return;
  const items = mpool.panelListItems(slice.arrange);
  const cursor = slice.panelList.cursor || 0;

  // Two visual sections separated by a blank line: placed (incl
  // essential), then hidden. Cursor lands on a single contiguous index
  // over the combined item list; we render the separator between the
  // last placed/essential and the first hidden.
  const lines = [];
  const placedCount = items.filter(it => it.status !== 'hidden').length;

  // Header row.
  lines.push('[dim]  status     id         type          title[/]');

  for (let i = 0; i < items.length; i++) {
    if (i === placedCount && placedCount > 0 && placedCount < items.length) {
      lines.push('');
      lines.push('[dim]  ── hidden (pool only) ──────────────────────[/]');
    }
    const it = items[i];
    const marker = it.status === 'essential'
      ? '[dim]●[/]'
      : it.status === 'placed'
        ? '[green]●[/]'
        : '[yellow]○[/]';
    const idCol    = esc(it.id).padEnd(10);
    const typeCol  = esc(it.type).padEnd(13);
    const titleCol = esc(it.title);
    const label = `${marker}  ${idCol} ${typeCol} ${titleCol}`;
    if (i === cursor) lines.push(`[reverse]> ${label}`);
    else              lines.push(`  ${label}`);
  }

  if (items.length === 0) {
    lines.push('  [dim]\\(pool is empty — should never happen)[/]');
  }

  // Footer hint
  lines.push('');
  const item = items[cursor];
  let hint = '[dim]\\[↑/↓] nav   \\[Enter] ';
  if (!item)                          hint += 'pick';
  else if (item.status === 'placed')  hint += 'hide';
  else if (item.status === 'hidden')  hint += 'show';
  else                                hint += '(essential — no-op)';
  hint += '   \\[Esc / w] close[/]';
  lines.push(hint);

  renderOverlay({
    lines,
    title: 'Panels',
    maxWidth: 60,
    count: items.length ? [cursor + 1, items.length] : undefined,
  });
}

/**
 * Compute the overlay's screen rectangle + the index of the item under
 * (mx, my), or null if (mx, my) is outside the overlay. Pure derivation
 * — mirrors renderOverlay's geometry so the renderer doesn't need to
 * stash bounds anywhere. Used by input.js to start a pool drag when
 * the user presses inside the overlay.
 */
function hitTest(mx, my) {
  const slice = _slice();
  if (!slice || !slice.panelList || !slice.panelList.open) return null;
  const items = mpool.panelListItems(slice.arrange);
  // Visual line count is rebuilt by _visualLineCount to account for the
  // separator + header + footer (matches renderPanelListOverlay).
  const lineCount = _visualLineCount(items);
  const W = Math.min(OVERLAY_MAX_WIDTH, cols() - 2);
  const H = Math.min(lineCount + 2, rows() - 2); // +2 for top/bottom border
  const offY = Math.max(0, Math.floor((rows() - H) / 2));
  const offX = Math.max(0, Math.floor((cols() - W) / 2));
  if (mx < offX || mx >= offX + W || my < offY || my >= offY + H) return null;
  // Translate (mx, my) → item index. Content starts at offY+1 (border).
  // Skip HEADER_ROWS_TOP for the column header.
  const placedCount = items.filter(it => it.status !== 'hidden').length;
  const localY = my - offY - 1 /* top border */ - HEADER_ROWS_TOP;
  if (localY < 0) {
    return { bounds: { x: offX, y: offY, w: W, h: H }, itemIdx: null };
  }
  // Items 0..placedCount-1 are on rows localY 0..placedCount-1, then
  // 2 separator rows (blank + "── hidden ──"), then hidden items.
  let itemIdx = null;
  if (localY < placedCount) {
    itemIdx = localY;
  } else if (placedCount > 0 && placedCount < items.length) {
    const hiddenLocalY = localY - placedCount - 2;
    if (hiddenLocalY >= 0 && hiddenLocalY < items.length - placedCount) {
      itemIdx = placedCount + hiddenLocalY;
    }
  } else if (placedCount === 0) {
    // No placed: hidden start right after header (no separator).
    if (localY < items.length) itemIdx = localY;
  }
  return { bounds: { x: offX, y: offY, w: W, h: H }, itemIdx };
}

function _visualLineCount(items) {
  const placedCount = items.filter(it => it.status !== 'hidden').length;
  const separatorRows = (placedCount > 0 && placedCount < items.length) ? 2 : 0;
  // header + items + separator + blank + footer-hint
  return 1 + items.length + separatorRows + 1 + 1;
}

module.exports = { renderPanelListOverlay, hitTest };
