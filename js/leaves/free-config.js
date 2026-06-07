/**
 * Pure free-config keyboard half — the keyboard-driven transforms,
 * title-edit buffer, and explicit column add/remove.
 *
 * Like leaves/search / leaves/pane-tabs / leaves/register, this is a
 * dependency-free leaf the layout Component imports without a require
 * cycle. Every function takes the layout Component slice, returns a
 * new slice (or the same ref when the operation is a no-op). No I/O,
 * no globals, no terminal reads.
 *
 * v0.6.3 E2 split the original ~1230-LOC `leaves/free-config.js` into
 * three siblings:
 *
 *   - `leaves/free-config-core.js`  — shared helpers + constants
 *     (constants, undo plumbing, focus helpers, geometry helpers,
 *     hotkey rekey, new-column width allocator).
 *   - `leaves/free-config.js` (this file) — keyboard half + title-
 *     edit + addColumn/removeColumn.
 *   - `leaves/free-config-mouse.js` — mouse-gesture half (hit-tests,
 *     validators, drop apply, state machine, drag preview).
 *
 * Importers reach into whichever leaf they need. Pre-split everything
 * routed through `./free-config`; post-split the importer's require
 * declarations show which subsystems it actually touches.
 *
 * Slice shape touched:
 *   - slice.arrange.{columns[], detailHeightPct} (and pool — read-only here)
 *   - slice.dirty (set true on any change that should round-trip to YAML)
 *   - slice.freeConfig.{undo, redo, titleEdit}
 *   - slice.focus — cursor truth in free-config; active-panel INDEX is
 *     derived via `core.selectedIdx(slice)`.
 *   - slice.panelBounds (READ only — frame-derived, written by layout.js)
 */
'use strict';

const mpool = require('./pool');
const core = require('./free-config-core');
const {
  MIN_PANEL_H, EDGE_W,
  detailMinPct, detailMaxPct,
  pushUndo, freezeColumnFlex, setPanelHeightPct,
  columnTotalH, panelHeightPct,
  reassignHotkeys,
  selectedIdx, clampSelected,
  allocateNewColumnWidth, spliceAndReleaseWidth,
} = core;

// ---------------------------------------------------------------- keyboard transforms

/** ↑/↓ — move the selection cursor, clamped to the panel list.
 *  v0.6: also syncs `slice.focus` to the newly selected panel's type
 *  so the runtime focus border tracks the free-config selection. v0.5
 *  surfaced the selection only in the footer text, leaving the green
 *  border on whatever was focused at mode entry — confusing in
 *  free-config where the user is actively navigating cells. The
 *  focused-panel content stays frozen (freeze gate drops the
 *  show_selected_info Cmd's downstream detail update); free_config_exit
 *  re-emits show_selected_info to refresh detail on the way out. */
function navSelect(slice, delta) {
  const all = mpool.allPanesInColumns(slice.arrange);
  const curIdx = selectedIdx(slice);
  let idx = curIdx;
  if (delta < 0) { if (idx > 0) idx--; }
  else           { if (idx < all.length - 1) idx++; }
  if (idx === curIdx) return slice;
  const nextFocus = all[idx] ? all[idx].type : slice.focus;
  return { ...slice, focus: nextFocus };
}

/** J/K — reorder the focused panel within its column (delta ±1). */
function reorderWithin(slice, delta) {
  const loc = mpool.findPaneLocation(slice.arrange, p => require('./pane').paneMatchesFocus(p, slice.focus));
  if (!loc) return slice;
  const panels = mpool.columnPanels(slice.arrange, loc.columnIndex);
  const targetIdx = loc.paneIndex + delta;
  if (targetIdx < 0 || targetIdx >= panels.length) return slice;

  // Last column keeps detail at the end. Refuse any swap that either
  // moves detail off its slot OR moves a non-detail panel past it.
  // Mirrors the validateTarget guard in applyDrop and the
  // insert-before-detail logic in pool_show — same invariant, three
  // entry points, one rule.
  const lastIdx = mpool.lastColumnIndex(slice.arrange);
  if (loc.columnIndex === lastIdx) {
    if (mpool.isDetailPane(panels[loc.paneIndex]) || mpool.isDetailPane(panels[targetIdx])) {
      return slice;
    }
  }

  const newCol = panels.slice();
  [newCol[loc.paneIndex], newCol[targetIdx]] = [newCol[targetIdx], newCol[loc.paneIndex]];

  let next = pushUndo(slice);
  next = {
    ...next,
    arrange: reassignHotkeys(mpool.updateColumn(slice.arrange, loc.columnIndex, () => newCol)),
    dirty: true,
  };
  return next;
}

/** ←/→ — move the focused panel between columns (dir = -1 or +1).
 *  Phase 1: refuses moves into/out of last column for reserved panes;
 *  clamps at the layout edges. Detail/actions stay in the last column. */
function moveColumn(slice, dir) {
  const loc = mpool.findPaneLocation(slice.arrange, p => require('./pane').paneMatchesFocus(p, slice.focus));
  if (!loc) return slice;
  const selPanel = loc.pane;
  const N = mpool.columnCount(slice.arrange);
  const lastIdx = N - 1;
  const fromIdx = loc.columnIndex;
  const toIdx = fromIdx + (dir < 0 ? -1 : +1);
  if (toIdx < 0 || toIdx >= N) return slice;
  if (mpool.isReservedPane(selPanel) && toIdx !== lastIdx) return slice;

  // Source column with the pane removed.
  const fromPanels = mpool.columnPanels(slice.arrange, fromIdx).slice();
  fromPanels.splice(loc.paneIndex, 1);

  // Destination column: append; if moving into last column with detail,
  // insert before detail so detail stays last.
  const toPanels = mpool.columnPanels(slice.arrange, toIdx).slice();
  let insertAt = toPanels.length;
  if (toIdx === lastIdx) {
    const detailIdx = toPanels.findIndex(mpool.isDetailPane);
    if (detailIdx >= 0) insertAt = detailIdx;
  }
  toPanels.splice(insertAt, 0, { ...selPanel, columnIndex: toIdx, hotkey: '' });

  let nextArrange = mpool.updateColumn(slice.arrange, fromIdx, () => fromPanels);
  nextArrange = mpool.updateColumn(nextArrange, toIdx, () => toPanels);

  let next = pushUndo(slice);
  next = { ...next, arrange: reassignHotkeys(nextArrange), dirty: true };
  return next;
}

/** +/- — detail selected: grow/shrink detailHeightPct by 5 (clamped [20,90]);
 *  else a non-last-column panel selected: grow/shrink its column's width by
 *  2 (clamped [20,60]). Last-column non-detail panels: no-op (the last
 *  column's width is implicit; can't grow without shrinking a neighbor). */
function resizeWidthOrDetail(slice, sign) {
  const loc = mpool.findPaneLocation(slice.arrange, p => require('./pane').paneMatchesFocus(p, slice.focus));
  if (!loc) return slice;
  const selPanel = loc.pane;
  const lastIdx = mpool.lastColumnIndex(slice.arrange);

  let newDetail = slice.arrange.detailHeightPct;
  let newColumns = slice.arrange.columns;
  let changed = false;

  if (sign > 0) {
    if (mpool.isDetailPane(selPanel) && slice.arrange.detailHeightPct < 90) {
      newDetail = Math.min(90, slice.arrange.detailHeightPct + 5);
      changed = true;
    } else if (loc.columnIndex < lastIdx) {
      const col = slice.arrange.columns[loc.columnIndex];
      const curW = col.width != null ? col.width : 30;
      if (curW < 60) {
        const w = Math.min(60, curW + 2);
        newColumns = slice.arrange.columns.slice();
        newColumns[loc.columnIndex] = { ...col, width: w };
        changed = true;
      } else return slice;
    } else return slice;
  } else {
    if (mpool.isDetailPane(selPanel) && slice.arrange.detailHeightPct > 20) {
      newDetail = Math.max(20, slice.arrange.detailHeightPct - 5);
      changed = true;
    } else if (loc.columnIndex < lastIdx) {
      const col = slice.arrange.columns[loc.columnIndex];
      const curW = col.width != null ? col.width : 30;
      if (curW > 20) {
        const w = Math.max(20, curW - 2);
        newColumns = slice.arrange.columns.slice();
        newColumns[loc.columnIndex] = { ...col, width: w };
        changed = true;
      } else return slice;
    } else return slice;
  }
  if (!changed) return slice;

  let next = pushUndo(slice);
  next = {
    ...next,
    arrange: { ...slice.arrange, columns: newColumns, detailHeightPct: newDetail },
    dirty: true,
  };
  return next;
}

/** ] / [ — grow/shrink the focused panel's heightPct by Δ, stealing from the
 *  panel below in the same column (D1 semantics). No-op on detail / last row. */
function resizeFocusedPanelHeight(slice, deltaPct) {
  const loc = mpool.findPaneLocation(slice.arrange, p => require('./pane').paneMatchesFocus(p, slice.focus));
  if (!loc) return slice;
  const sel = loc.pane;
  if (mpool.isDetailPane(sel)) return slice;  // detail uses +/-

  const panels = mpool.columnPanels(slice.arrange, loc.columnIndex);
  if (loc.paneIndex === panels.length - 1) return slice;  // no neighbor below
  const nextPanel = panels[loc.paneIndex + 1];

  const availH = columnTotalH(slice, loc.columnIndex);
  if (availH < 6) return slice;

  const frozen = freezeColumnFlex(slice, loc.columnIndex, sel.type, nextPanel.type, availH);

  const selCur  = panelHeightPct(frozen, sel, availH);
  const nextCur = panelHeightPct(frozen, nextPanel, availH);
  const combined = selCur + nextCur;

  const rowsToPct = (rows) => Math.max(1, Math.ceil(rows / availH * 100));
  const minPct = (p) => mpool.isDetailPane(p) ? detailMinPct(availH) : rowsToPct(MIN_PANEL_H);
  const maxPct = (p) => mpool.isDetailPane(p) ? detailMaxPct(availH) : 100;

  let newSel  = selCur  + deltaPct;
  let newNext = nextCur - deltaPct;
  if (newSel < minPct(sel))         { newSel = minPct(sel);         newNext = combined - newSel; }
  if (newSel > maxPct(sel))         { newSel = maxPct(sel);         newNext = combined - newSel; }
  if (newNext < minPct(nextPanel))  { newNext = minPct(nextPanel);  newSel  = combined - newNext; }
  if (newNext > maxPct(nextPanel))  { newNext = maxPct(nextPanel);  newSel  = combined - newNext; }

  if (newSel === selCur && newNext === nextCur) return slice;

  let result = pushUndo(frozen);
  result = setPanelHeightPct(result, sel.type, newSel);
  result = setPanelHeightPct(result, nextPanel.type, newNext);
  return { ...result, dirty: true };
}

// ---------------------------------------------------------------- title edit

/** Seed the title-edit buffer from the focused panel's current title. */
function titleEnter(slice) {
  const d = slice.freeConfig;
  if (!d) return slice;
  const p = mpool.allPanesInColumns(slice.arrange)[selectedIdx(slice)];
  if (!p) return slice;
  return { ...slice, freeConfig: { ...d, titleEdit: { text: p.title || '' } } };
}

/** Commit a non-empty, changed title to the focused panel (pushes one undo). */
function setSelectedTitle(slice, text) {
  const d = slice.freeConfig;
  if (!d) return slice;
  const p = mpool.allPanesInColumns(slice.arrange)[selectedIdx(slice)];
  if (!p || text.length === 0 || text === p.title) return slice;

  let next = pushUndo(slice);
  const nextColumns = next.arrange.columns.map(col => ({
    ...col,
    panels: (col.panels || []).map(x => x.type === p.type ? { ...x, title: text } : x),
  }));
  next = { ...next, arrange: { ...next.arrange, columns: nextColumns }, dirty: true };
  return next;
}

// ---------------------------------------------------------------- column add/remove (Phase 3)

/**
 * Pure transform: insert an empty column at `position` (0..N-1) and
 * return a new slice. Phase 3 rules mirror the drag-edge spawn:
 *   - position must be 0 <= P <= N-1 (P === N is refused — would
 *     demote the detail-bearing last column off "last")
 *   - new column has explicit width (stolen from neighbors) so it
 *     doesn't collide with the last column's implicit width
 *   - hotkeys re-stamped via _reassignHotkeys after the splice
 *
 * Returns `{ slice, error }` where `error` is null on success or a
 * user-facing message string on refusal. Pure: no side effects.
 */
function addColumn(slice, position) {
  const arrange = slice.arrange;
  const N = mpool.columnCount(arrange);
  if (typeof position !== 'number' || !Number.isInteger(position)) {
    return { slice, error: 'position must be an integer' };
  }
  if (position < 0 || position > N) {
    return { slice, error: `position out of range (0..${N - 1})` };
  }
  if (position === N) {
    return { slice, error: `can't add a column at position ${N} — would push detail off the last column` };
  }
  const { columns: shrunk, newColWidth } =
    allocateNewColumnWidth(arrange.columns, position);
  shrunk.splice(position, 0, { width: newColWidth, panels: [] });
  const nextArrange = reassignHotkeys({ ...arrange, columns: shrunk });
  return { slice: { ...slice, arrange: nextArrange, dirty: true }, error: null };
}

/**
 * Pure transform: remove the column at index `n` and return a new
 * slice. Phase 3 rules:
 *   - n must be 0 <= n < N
 *   - n must NOT be the last column (it holds detail by invariant)
 *   - column must be empty (caller must `:hide` or drag panes out first)
 *
 * Returns `{ slice, error }`. Removing the column splices out the
 * array slot AND re-stamps columnIndex on every pane in shifted
 * columns via _reassignHotkeys. The terminal-side width redistributes
 * automatically since the last column's implicit width grows.
 */
function removeColumn(slice, n) {
  const arrange = slice.arrange;
  const N = mpool.columnCount(arrange);
  if (typeof n !== 'number' || !Number.isInteger(n)) {
    return { slice, error: 'column index must be an integer' };
  }
  if (n < 0 || n >= N) {
    return { slice, error: `column index out of range (0..${N - 1})` };
  }
  if (n === N - 1) {
    return { slice, error: `can't remove the last column — it holds detail` };
  }
  const col = arrange.columns[n];
  if ((col.panels || []).length > 0) {
    return { slice, error: `column ${n + 1} is not empty — hide its panes first` };
  }
  const columns = spliceAndReleaseWidth(arrange.columns, n);
  const nextArrange = reassignHotkeys({ ...arrange, columns });
  return { slice: { ...slice, arrange: nextArrange, dirty: true }, error: null };
}

module.exports = {
  // keyboard transforms
  navSelect, reorderWithin, moveColumn,
  resizeWidthOrDetail, resizeFocusedPanelHeight,
  // title edit
  titleEnter, setSelectedTitle,
  // column lifecycle
  addColumn, removeColumn,
};
