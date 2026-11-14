/**
 * Panel-list overlay — modal popup
 * showing every panel in the pool: placed panels (in grid order, greyed
 * since picking them means hide), the essential `detail` panel (no-op
 * pick), and hidden panels (highlighted; pick = show + place in grid).
 *
 * Two-pane layout when the terminal is wide enough (≥ MIN_SIDE_BY_SIDE
 * cols total): left = entry list, right = preview of the highlighted
 * entry. Preview renders on demand via the panel type's Component
 * renderer (mirrors render/geometry.js#rendererFor with a lazy require to
 * avoid the render → overlay → render cycle). Placed entries show a
 * placement indicator instead of duplicating their on-screen content.
 *
 * State + behavior live in the layout Component's slice (slice.panelList
 * + the `panel_list_*` Msgs). This module is render-only: reads the
 * slice and paints, no writes.
 */
'use strict';

const { esc, visibleLen } = require('../leaves/text/ansi');
const { renderOverlay, truncate, fitCell, viewportDims } = require('../leaves/render/draw');
const { getInstanceSlice, theme } = require('../panel/api');
const mpool = require('../leaves/wm/pool');

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

function _slice() { return getInstanceSlice('layout'); }

// ----------------------- list pane ----------------------------

/** Build the list-pane rows (header + items + separator + blank + hint).
 *  Items truncated to fit `w` columns of visible width. Returns rich-
 *  markup strings; renderOverlay handles ANSI conversion. */
function _buildListLines(items, cursor, w) {
  const t = theme();
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
    const idCol    = fitCell(esc(it.id), 9);
    const typeCol  = fitCell(esc(it.type), 8);
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
        ? `[${t.success}]●[/]`
        : `[${t.warning}]○[/]`;
    if (i === cursor) {
      // Single selected-tag wrap (§8: theme slot, no inner [/]) — closed
      // here rather than run-to-EOL because SEP + preview follow on the
      // same composed row.
      lines.push(`[${t.selected}]> ${markerChar}  ${idCol} ${typeCol} ${titleCol}[/]`);
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
 *  render/geometry.js#rendererFor; duplicated here to break the
 *  render → overlay → render require cycle. Returns null when
 *  the type has no registered Component. */
function _rendererFor(type) {
  const api = require('../panel/api');
  const compName = api.getComponentOwningPanel(type);
  if (!compName) return null;
  const comp = api.getComponent(compName);
  const def = comp && comp.panelTypes && comp.panelTypes[type];
  if (!def || typeof def.render !== 'function') return null;
  // compName is a Component NAME — explicit kind-level read (the
  // preview renders the kind's canonical instance, whichever pane is
  // primary; hidden pool entries have no pane instance of their own).
  return (panel, w, h) => def.render(panel, w, h, api.primarySliceOf(compName));
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
    const loc = mpool.findPaneLocation(arrange, p => p.id === entry.id);
    if (loc) {
      const colPanels = mpool.columnPanels(arrange, loc.columnIndex);
      const N = mpool.columnCount(arrange);
      const colLabel = loc.columnIndex === 0
        ? `1 (first)`
        : loc.columnIndex === N - 1
          ? `${loc.columnIndex + 1} (last)`
          : `${loc.columnIndex + 1}`;
      lines.push(`  column: [bold]${colLabel}[/]`);
      lines.push(`  slot:   ${loc.paneIndex + 1} of ${colPanels.length}`);
      lines.push(`  hotkey: ${loc.pane.hotkey || '(none)'}`);
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
  const t = theme();
  const renderer = _rendererFor(entry.type);
  if (!renderer) return [`[${t.error}](no renderer for type '${esc(entry.type)}')[/]`];
  const panel = {
    ...(entry.config || {}),
    id: entry.id,
    type: entry.type,
    title: entry.title,
    hotkey: '',
    columnIndex: mpool.lastColumnIndex(arrange),
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
    return [`[${t.error}](preview error)[/]`, `[${t.error}]${esc((e && e.message) || String(e))}[/]`];
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

// Overlay-compositor migration (Release 2 Phase 2.a #6). When `newRows` +
// `cols` are threaded in by paint.js, both `renderOverlay` call sites
// (list-only + side-by-side) composite into the main-frame row buffer
// through `renderOverlay`'s `targetRows` path. The cell-diff then handles
// both the leading paint AND the clean-up on close/resize from the natural
// row delta — which is why this commit ALSO drops the explicit
// `force_full_repaint` Cmds from `panel_list_open`, `panel_list_close`,
// and `free_config_enter`'s auto-open conditional in `js/panel/layout.js`
// (those were Class A workarounds for the overlay bypassing newRows).
// Hit map (docs/mouse-hit-map.md): the box OWNS its cells (opaque, consumes
// every gesture) — without it, pane chrome drawn under the box ([X] / [_] in
// free-config) took clicks aimed at the list or the preview (hiding /
// collapsing a pane the user could not see). Each NON-essential item row is a
// pool-drag source: a press starts the `pool-drag` pointer capture
// (dispatch/control/free-config-capture) for that item. The header, the
// `── hidden ──` separator, essential rows and the preview publish no target —
// the box swallows a press there (Release 3; before it, such a press dragged
// whichever item was highlighted).
function _hit(items, rowW) {
  const placedCount = items.filter(it => it.status !== 'hidden').length;
  const targets = [null];                                    // the header row
  for (let i = 0; i < items.length; i++) {
    if (i === placedCount && placedCount > 0 && placedCount < items.length) targets.push(null, null);   // blank + separator
    targets.push(items[i].status === 'essential' ? null : { press: { capture: 'pool-drag', idx: i, id: items[i].id } });
  }
  return { lineTargets: targets, box: {}, rowW };
}

function renderPanelListOverlay(newRows, cols) {
  const slice = _slice();
  if (!slice || !slice.panelList || !slice.panelList.open) return;
  const items = mpool.panelListItems(slice.arrange);
  const cursor = slice.panelList.cursor || 0;

  const { cols: termW, rows: termH } = viewportDims();
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
      targetRows: newRows || null, targetCols: cols || 0,
      hit: _hit(items, null),
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
  // previewLines is then padded to EXACTLY previewH, so the box height is
  // fixed by the preview (the hit map publishes the box renderOverlay drew).
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
    targetRows: newRows || null, targetCols: cols || 0,
    hit: _hit(items, listW),   // a row's drag source is its list column, not the preview beside it
  });
}

// Overlay-compositor R3 descriptor. zIndex=60 preserves panel-list's
// historical position (sixth in the retired paint.js if-chain —
// `md.freeConfigMode` gated the paint; the overlay's own open flag
// gates whether anything is drawn inside, same as before).
function registerSelf(compositor) {
  compositor.register({
    id: 'panel-list',
    isActive: (m) => !!(m && m.modes && m.modes.freeConfigMode),
    render: (m, newRows, cols) => renderPanelListOverlay(newRows, cols),
    modal: true,
    zIndex: 60,
    // Free-config owns the mouse outside the list (Release 3): a press anywhere
    // the chrome band doesn't claim closes the list if it is open, then starts
    // the layout drag (resize / move — the `free-config` pointer capture). The
    // backdrop sits BELOW the chrome band (free-config leaves chrome live) and
    // runs on press only: other gestures were swallowed before and still are.
    mouse: { backdrop: 'below-chrome', outside: { act: 'free-config-press' }, outsideGestures: ['press'] },
  });
}

module.exports = { renderPanelListOverlay, registerSelf };
