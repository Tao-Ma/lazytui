/**
 * Panel-list overlay — modal popup
 * showing every panel in the pool: placed panels (in grid order, greyed
 * since picking them means hide), the essential `detail` panel (no-op
 * pick), and hidden panels (highlighted; pick = show + place in grid).
 *
 * Two-pane layout when the terminal is wide enough (≥ MIN_SIDE_BY_SIDE
 * cols total): left = entry list, right = preview of the highlighted
 * entry. Preview renders on demand via the panel type's Component
 * renderer (mirrors render/layout.js#rendererFor with a lazy require to
 * avoid the render → overlay → render cycle). Placed entries show a
 * placement indicator instead of duplicating their on-screen content.
 *
 * State + behavior live in the layout Component's slice (slice.panelList
 * + the `panel_list_*` Msgs). This module is render-only: reads the
 * slice and paints, no writes.
 */
'use strict';

const { esc, visibleLen, stripMarkup } = require('../io/ansi');
const { cols, rows } = require('../io/term');
const { renderOverlay, truncate } = require('../render/panel');
const { getInstanceSlice } = require('../panel/api');
const mpool = require('../leaves/pool');

// Side-by-side overlay sizing — middle ground between the v0.6 Phase 4
// "preview is too tiny" cap (90×10) and the "fills the screen" pass
// (200×60). Leaves a margin so the underlying layout grid stays visible
// around the overlay (~4 rows top/bottom, ~4 cols left/right on common
// terminals).
const OVERLAY_MAX_WIDTH  = 120;
const OVERLAY_MAX_HEIGHT = 30;
const OVERLAY_W_MARGIN   = 8;     // total cols reserved (split L/R)
const OVERLAY_H_MARGIN   = 8;     // total rows reserved (split top/bottom)
const OVERLAY_LIST_ONLY_WIDTH = 60;
const MIN_SIDE_BY_SIDE = 75;      // need at least this many cols for two-pane
const LIST_W = 36;                // left-pane content width when side-by-side
const SEP = ' │ ';
const HEADER_ROWS_TOP = 1;

function _slice() { return getInstanceSlice('layout'); }

// ----------------------- list pane ----------------------------

/** Build the list-pane rows (header + items + separator + blank + hint).
 *  Items truncated to fit `w` columns of visible width. Returns rich-
 *  markup strings; renderOverlay handles ANSI conversion. */
function _buildListLines(items, cursor, w) {
  const lines = [];
  const placedCount = items.filter(it => it.status !== 'hidden').length;

  // Column widths chosen to fit the LIST_W (36) target. Item label
  // is `[marker]  <id:9> <type:8> <title:rest>` = 22 + titleLen
  // visible cols; cursor prefix adds 2. Title gets the slack.
  lines.push('[dim] s  id        type     title[/]');

  for (let i = 0; i < items.length; i++) {
    if (i === placedCount && placedCount > 0 && placedCount < items.length) {
      lines.push('');
      lines.push('[dim] ── hidden ─────────[/]');
    }
    const it = items[i];
    const idCol    = esc(it.id).padEnd(9);
    const typeCol  = esc(it.type).padEnd(8);
    const titleCol = esc(it.title);
    // The marker's COLOR comes from a `[/]` that — for the cursor row
    // — would also close the outer `[reverse]` early (richToAnsi's
    // `[/]` is a single hard reset, not stack-aware). Non-cursor rows
    // still get the colored marker; cursor row drops the color and
    // uses the bare glyph so the whole label highlights uniformly.
    // Status is also surfaced in the footer hint (pick/hide/show/no-op).
    const markerChar = it.status === 'hidden' ? '○' : '●';
    const coloredMarker = it.status === 'essential'
      ? '[dim]●[/]'
      : it.status === 'placed'
        ? '[green]●[/]'
        : '[yellow]○[/]';
    if (i === cursor) {
      // Single [reverse]…[/] wrapping the whole label — no inner [/].
      lines.push(`[reverse]> ${markerChar}  ${idCol} ${typeCol} ${titleCol}[/]`);
    } else {
      lines.push(`  ${coloredMarker}  ${idCol} ${typeCol} ${titleCol}`);
    }
  }

  if (items.length === 0) {
    lines.push('  [dim]\\(pool is empty)[/]');
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

  return lines;
}

// ----------------------- preview pane -------------------------

/** Lazy-require the Component renderer for a panel type. Mirrors
 *  render/layout.js#rendererFor; duplicated here to break the
 *  render → overlay → render require cycle. Returns null when
 *  the type has no registered Component. */
function _rendererFor(type) {
  const api = require('../panel/api');
  const compName = api.getComponentOwningPanel(type);
  if (!compName) return null;
  const comp = api.getComponent(compName);
  const def = comp && comp.panelTypes && comp.panelTypes[type];
  if (!def || typeof def.render !== 'function') return null;
  return (panel, w, h) => def.render(panel, w, h, api.getInstanceSlice(compName));
}

/** Build the preview-pane rows for the highlighted entry. Returns an
 *  array of rich-markup rows clipped to (w, h). Three cases:
 *    - no entry        → "(no entry)"
 *    - placed/essential → "(currently placed: <id>)" + a few lines of
 *                          metadata; we don't re-render their content
 *                          since it's already visible under the overlay
 *    - hidden          → call the panel's Component renderer on demand
 *                          (panel object synthesized from the pool entry).
 *                          Render errors caught + surfaced as a fallback. */
function _buildPreviewLines(entry, w, h, arrange) {
  if (!entry) return ['[dim](no entry)[/]'];
  if (entry.status !== 'hidden') {
    const lines = [`[dim]── ${esc(entry.title || entry.id)} ──[/]`, ''];
    // Find where it sits in the grid.
    const cols2 = ['left', 'right'];
    for (const c of cols2) {
      const arr = c === 'left' ? arrange.leftPanels : arrange.rightPanels;
      const idx = arr.findIndex(p => p.id === entry.id);
      if (idx >= 0) {
        lines.push(`  column: [bold]${c}[/]`);
        lines.push(`  slot:   ${idx + 1} of ${arr.length}`);
        lines.push(`  hotkey: ${arr[idx].hotkey || '(none)'}`);
        break;
      }
    }
    if (entry.status === 'essential') {
      lines.push('');
      lines.push('  [dim](essential — cannot be hidden)[/]');
    } else {
      lines.push('');
      lines.push('  [dim](currently placed — content visible on the grid)[/]');
    }
    return lines;
  }
  // Hidden entry — render on demand.
  const renderer = _rendererFor(entry.type);
  if (!renderer) return [`[red](no renderer for type '${esc(entry.type)}')[/]`];
  const panel = {
    ...(entry.config || {}),
    id: entry.id,
    type: entry.type,
    title: entry.title,
    hotkey: '',
    column: 'right',
  };
  // Reserve 1 trailing column so the rendered panel's right border
  // doesn't kiss the overlay's right border (which produced a visual
  // double-`│` or a half-painted border at the right edge depending
  // on how the renderer handled the requested width). _padRight then
  // pads the composed row to `w`, leaving 1 visible space between the
  // preview content and the overlay frame.
  const renderW = Math.max(4, w - 1);
  let out;
  try {
    out = renderer(panel, renderW, h);
  } catch (e) {
    return [`[red](preview error)[/]`, `[red]${esc((e && e.message) || String(e))}[/]`];
  }
  if (typeof out !== 'string') return ['[dim](empty preview)[/]'];
  return out.split('\n').slice(0, h);
}

// ----------------------- compose + render ---------------------

/** Fit a markup row to EXACTLY `w` visible columns — truncate if too
 *  long, pad with trailing spaces if too short. Crucial for the
 *  side-by-side layout: any over-width row pushes the `│` separator
 *  past its column and the whole panel cascades misaligned. Panel
 *  renderers don't always respect the requested width, and the list
 *  header was already wider than the list pane in 75-col terminals. */
function _padRight(row, w) {
  const vl = visibleLen(row);
  // Always close any open style after the row. truncate() preserves
  // the row's leading style prefix (e.g. `[reverse]`) but DROPS the
  // trailing `[/]` — v0.5's convention was "renderPanel adds the
  // closing `[/]` before the right border". That convention falls
  // apart in the side-by-side composition: SEP + preview now sit
  // between the row's content and renderPanel's border, so an open
  // [reverse] from a truncated cursor row paints the entire preview
  // half in reverse video. Append `[/]` after both the truncate and
  // the pad branches — richToAnsi handles a redundant reset cheaply.
  if (vl === w) return row + '[/]';
  if (vl > w)   return truncate(row, w) + '[/]';
  return row + ' '.repeat(w - vl) + '[/]';
}

function renderPanelListOverlay() {
  const slice = _slice();
  if (!slice || !slice.panelList || !slice.panelList.open) return;
  const items = mpool.panelListItems(slice.arrange);
  const cursor = slice.panelList.cursor || 0;

  const termW = cols();
  const termH = rows();
  const sideBySide = termW >= MIN_SIDE_BY_SIDE && items.length > 0;
  // Side-by-side: use most of the terminal so the preview is actually
  // useful, but leave a margin so the layout grid still peeks through.
  // List-only: stick with the v0.6 Phase 4 compact width.
  const wantW = sideBySide
    ? Math.min(OVERLAY_MAX_WIDTH, termW - OVERLAY_W_MARGIN)
    : Math.min(OVERLAY_LIST_ONLY_WIDTH, termW - 2);
  const innerW = Math.max(10, wantW - 2);  // -2 for borders

  if (!sideBySide) {
    const listLines = _buildListLines(items, cursor, innerW);
    renderOverlay({
      lines: listLines, title: 'Panels',
      maxWidth: wantW,
      count: items.length ? [cursor + 1, items.length] : undefined,
    });
    return;
  }

  // Side-by-side: list on the left, preview on the right.
  const listW = Math.min(LIST_W, Math.floor(innerW / 2));
  const sepVisLen = visibleLen(SEP);
  const previewW = Math.max(10, innerW - listW - sepVisLen);

  const listLines = _buildListLines(items, cursor, listW);
  // Preview pane area ≈ terminal_area / 5. Compute previewH from the
  // target area and current previewW, then clamp so:
  //   - the list isn't truncated (>= listLines.length)
  //   - the overlay still fits the terminal (<= termH - OVERLAY_H_MARGIN)
  //   - we don't shrink below a usable minimum (8 rows)
  // previewLines is then padded to EXACTLY previewH so hitTest's bounds
  // math (which also uses previewH) matches the actual painted height.
  const targetPreviewArea = Math.floor(termW * termH / 5);
  const idealPreviewH = Math.ceil(targetPreviewArea / previewW);
  const previewH = Math.max(
    Math.max(listLines.length, 8),
    Math.min(idealPreviewH, termH - OVERLAY_H_MARGIN, OVERLAY_MAX_HEIGHT),
  );
  const previewLines = _buildPreviewLines(items[cursor], previewW, previewH, slice.arrange);
  while (previewLines.length < previewH) previewLines.push('');

  const totalRows = Math.max(listLines.length, previewLines.length);
  const composed = [];
  for (let i = 0; i < totalRows; i++) {
    const left  = _padRight(listLines[i]    || '', listW);
    const right = _padRight(previewLines[i] || '', previewW);
    composed.push(`${left}${SEP}${right}`);
  }

  renderOverlay({
    lines: composed, title: 'Panels',
    maxWidth: wantW,
    count: items.length ? [cursor + 1, items.length] : undefined,
  });
}

/**
 * Compute the overlay's screen rectangle + the index of the LIST-side
 * item under (mx, my). Preview-pane clicks return `itemIdx: null` (no
 * item to drag), but `bounds` reflects the whole overlay box so
 * input.js can still detect "click inside vs outside". Pure derivation;
 * mirrors renderPanelListOverlay's geometry.
 */
function hitTest(mx, my) {
  const slice = _slice();
  if (!slice || !slice.panelList || !slice.panelList.open) return null;
  const items = mpool.panelListItems(slice.arrange);

  const termW = cols();
  const termH = rows();
  const sideBySide = termW >= MIN_SIDE_BY_SIDE && items.length > 0;
  const wantW = sideBySide
    ? Math.min(OVERLAY_MAX_WIDTH, termW - OVERLAY_W_MARGIN)
    : Math.min(OVERLAY_LIST_ONLY_WIDTH, termW - 2);
  const innerW = Math.max(10, wantW - 2);
  const listW = sideBySide ? Math.min(LIST_W, Math.floor(innerW / 2)) : innerW;

  const listLines = _buildListLines(items, slice.panelList.cursor || 0, listW);
  let previewH = 0;
  if (sideBySide) {
    const sepVisLen = visibleLen(SEP);
    const previewW = Math.max(10, innerW - listW - sepVisLen);
    const targetPreviewArea = Math.floor(termW * termH / 5);
    const idealPreviewH = Math.ceil(targetPreviewArea / previewW);
    previewH = Math.max(
      Math.max(listLines.length, 8),
      Math.min(idealPreviewH, termH - OVERLAY_H_MARGIN, OVERLAY_MAX_HEIGHT),
    );
  }
  const visualRows = Math.max(listLines.length, previewH);
  const H = Math.min(visualRows + 2, termH - 2);
  const offY = Math.max(0, Math.floor((termH - H) / 2));
  const offX = Math.max(0, Math.floor((termW - wantW) / 2));
  if (mx < offX || mx >= offX + wantW || my < offY || my >= offY + H) return null;

  const bounds = { x: offX, y: offY, w: wantW, h: H };

  // Preview-pane click → no item, just bounds (drag start refused).
  const listRightCol = offX + 1 + listW;  // +1 for left border
  if (mx >= listRightCol) return { bounds, itemIdx: null };

  // List-side hit-test (unchanged from list-only layout).
  const placedCount = items.filter(it => it.status !== 'hidden').length;
  const localY = my - offY - 1 /* top border */ - HEADER_ROWS_TOP;
  if (localY < 0) return { bounds, itemIdx: null };
  let itemIdx = null;
  if (localY < placedCount) {
    itemIdx = localY;
  } else if (placedCount > 0 && placedCount < items.length) {
    const hiddenLocalY = localY - placedCount - 2;
    if (hiddenLocalY >= 0 && hiddenLocalY < items.length - placedCount) {
      itemIdx = placedCount + hiddenLocalY;
    }
  } else if (placedCount === 0) {
    if (localY < items.length) itemIdx = localY;
  }
  return { bounds, itemIdx };
}

module.exports = { renderPanelListOverlay, hitTest };
