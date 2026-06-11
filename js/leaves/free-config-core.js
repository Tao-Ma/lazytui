/**
 * Free-config shared core — constants + pure transforms used by
 * BOTH the keyboard half (`leaves/free-config.js`) and the mouse
 * half (`leaves/free-config-mouse.js`).
 *
 * v0.6.3 E2 split this out of `leaves/free-config.js` so the two
 * halves can live as siblings without one importing the other
 * (pre-split the mouse functions were in the same file as the
 * shared helpers + the keyboard transforms).
 *
 * What lives here:
 *   - constants (MIN_PANEL_H, EDGE_W, NEW_COL_*, DETAIL_MIN_ROWS, MAX_UNDO)
 *   - detailMinPct / detailMaxPct (terminal-size-derived clamps)
 *   - snapshot / _applySnapshot (undo plumbing)
 *   - undo / redo / clearUndoStacks / _pushUndoSlice
 *   - selectedIdx / clampSelected (focus-derived index helpers)
 *   - columnTotalH / panelHeightPct / freezeColumnFlex / _setPanelHeightPct
 *   - _reassignHotkeys (positional hotkey re-stamp)
 *   - _allocateNewColumnWidth / _spliceAndReleaseWidth (column lifecycle)
 *
 * Zero deps beyond `./pool` and `./hotkeys`. Both halves import this
 * leaf; nothing in this file imports back from them.
 */
'use strict';

const mpool = require('./pool');
const mpane = require('./pane');
const { hotkeyPoolForColumn } = require('./hotkeys');

const MIN_PANEL_H = 3;
// Width allocation cells reserved for the edge/gap drop zones that
// spawn a new column. Cursor within EDGE_W of the terminal's left
// edge, the right edge, or any internal column boundary maps to
// `{kind: 'new_column', position}`. The existing 3-zone-per-cell hit
// runs only when none of these match — so the user can still drop
// inside the first cell of column 0 by aiming at its top/middle/bot
// strictly INSIDE the column (mx >= EDGE_W).
const EDGE_W = 2;
// Default width for a newly-spawned column. The renderer's
// _distributeColumnWidths squeezes everything to fit the terminal, so
// a too-large default just shrinks the other columns. 24 leaves a
// usable column on most terminals.
const NEW_COL_DEFAULT_W = 24;
// Minimum width a donor neighbor retains after a new-column spawn
// steals from it. Prevents the donor from being pared down to invisible.
const NEW_COL_DONOR_FLOOR = 10;
// Minimum cells we yank from a donor neighbor when its width allows
// (don't bother with a 1-cell donation). max(NEW_COL_DONOR_TAKE_MIN,
// floor(donor.width / 3)) — the `/3` heuristic leaves the donor at
// two-thirds; the floor keeps tiny donors honest.
const NEW_COL_DONOR_TAKE_MIN = 8;
// Detail height %, computed against available column rows. Big
// terminals (with enough rows) get more range — a 100-row column can
// shrink detail to 5% (5 rows still legible) and grow it to 97%
// (leaving MIN_PANEL_H rows for the upper panels). Small terminals
// clamp tighter — at 20 rows the min jumps to 25% (5 rows physical
// floor / 20 rows column), the max stays at ~85%.
const DETAIL_MIN_ROWS = 5;       // legible viewer: top border + ~3 content + bottom border
function detailMinPct(availH) {
  if (!Number.isFinite(availH) || availH <= 0) return 20;   // pre-layout fallback
  return Math.max(5, Math.ceil(DETAIL_MIN_ROWS / availH * 100));
}
function detailMaxPct(availH) {
  if (!Number.isFinite(availH) || availH <= 0) return 90;   // pre-layout fallback
  return Math.min(95, Math.floor((availH - MIN_PANEL_H) / availH * 100));
}
const MAX_UNDO = 50;

// Snapshots are JSON round-trips of the arrange struct — plain data
// (documented: no functions / Symbols / circular refs in panel config), so
// the stacks live happily on the slice. Session-scoped: cleared on
// free_config_enter.
function snapshot(arrange) {
  return JSON.parse(JSON.stringify(arrange));
}

function _applySnapshot(arrange, snap) {
  return {
    ...arrange,
    columns: snap.columns,
    detailHeightPct: snap.detailHeightPct,
  };
}

/** Rendered bounds for a pane, addressed by paneId with a type fallback
 *  (v0.6.4). renderNormal/Half/Full dual-write `paneBounds[paneId]` AND
 *  `paneBounds[type]`, so the paneId read always hits first in production
 *  — that's what lets two same-kind panes in one column read their OWN
 *  height instead of colliding on the shared type key. The `[type]`
 *  fallback only fires for legacy single-instance fixtures that still seed
 *  bounds by type; it degrades to the same `null` a missing pane gives
 *  once the type-keyed write is eventually retired. */
function boundsOf(slice, p) {
  return slice.paneBounds[p.paneId] || slice.paneBounds[p.type];
}

function columnTotalH(slice, columnIndex) {
  const panels = mpool.columnPanels(slice.arrange, columnIndex);
  let total = 0;
  for (const p of panels) {
    const b = boundsOf(slice, p);
    if (b) total += b.h;
  }
  return total;
}

function panelHeightPct(slice, p, availH) {
  // v0.6.4 — detail height is per-pane (heightPct) like every other pane;
  // the `arrange.detailHeightPct` scalar is only a fallback for a detail
  // pane that wasn't seeded (legacy / direct-built fixtures).
  if (typeof p.heightPct === 'number') return p.heightPct;
  if (mpool.isDetailPane(p)) return slice.arrange.detailHeightPct;
  const b = boundsOf(slice, p);
  return b ? Math.round(b.h / availH * 100) : 0;
}

/** Recompute positional hotkeys for every column. detail keeps 'o', actions
 *  keeps '0' as semantic anchors (last-column convention); everything else
 *  gets its column's pool key by slot position. When a column has more
 *  panes than its pool has slots (above the soft cap), the overflow slots
 *  get '' — matches panel/layout.js#rekeyColumn so the two rekey paths
 *  agree on the same answer, regardless of which one fired last (drag-
 *  reorder vs pool_hide / pool_show). */
function _reassignHotkeys(arrange) {
  const N = mpool.columnCount(arrange);
  const lastIdx = N - 1;
  return {
    ...arrange,
    columns: arrange.columns.map((col, ci) => {
      const pool = hotkeyPoolForColumn(ci, N);
      const isLast = ci === lastIdx;
      const panels = (col.panels || []).map((p, i) => {
        if (isLast && mpool.isActionsPane(p)) return { ...p, hotkey: '0', columnIndex: ci };
        if (isLast && mpool.isDetailPane(p))  return { ...p, hotkey: 'o', columnIndex: ci };
        return { ...p, hotkey: pool[i] || '', columnIndex: ci };
      });
      return { ...col, panels };
    }),
  };
}

// ---------------------------------------------------------------- undo / redo

function _pushUndoSlice(slice) {
  const d = slice.freeConfig;
  let undoStack = [...d.undo, snapshot(slice.arrange)];
  if (undoStack.length > MAX_UNDO) undoStack = undoStack.slice(undoStack.length - MAX_UNDO);
  return { ...slice, freeConfig: { ...d, undo: undoStack, redo: [] } };
}

function undo(slice) {
  const d = slice.freeConfig;
  if (d.undo.length === 0) return slice;
  const snap = d.undo[d.undo.length - 1];
  return {
    ...slice,
    arrange: _applySnapshot(slice.arrange, snap),
    freeConfig: {
      ...d,
      undo: d.undo.slice(0, -1),
      redo: [...d.redo, snapshot(slice.arrange)],
    },
    dirty: true,
  };
}

function redo(slice) {
  const d = slice.freeConfig;
  if (d.redo.length === 0) return slice;
  const snap = d.redo[d.redo.length - 1];
  return {
    ...slice,
    arrange: _applySnapshot(slice.arrange, snap),
    freeConfig: {
      ...d,
      redo: d.redo.slice(0, -1),
      undo: [...d.undo, snapshot(slice.arrange)],
    },
    dirty: true,
  };
}

/** Wipe undo/redo (free_config_enter, and :restore-layout via the
 *  panel/free-config-view shim). Tolerates the layout slice not existing yet. */
function clearUndoStacks(slice) {
  if (!slice || !slice.freeConfig) return slice;
  if (slice.freeConfig.undo.length === 0 && slice.freeConfig.redo.length === 0) return slice;
  return { ...slice, freeConfig: { ...slice.freeConfig, undo: [], redo: [] } };
}

// ---------------------------------------------------------------- geometry helpers

/** Anchor any flex panels in `columnIndex` (no heightPct, not the active
 *  pair, not detail) at their current rendered height, so a boundary drag
 *  steals only from the neighbor instead of being absorbed proportionally.
 *  Returns the same slice ref when nothing actually freezes. */
function freezeColumnFlex(slice, columnIndex, upperId, lowerId, availH) {
  const panels = mpool.columnPanels(slice.arrange, columnIndex);
  let changed = false;
  const newCol = panels.map(p => {
    // v0.6.4 — identify the active resize pair + bounds by paneId, not
    // type, so two same-kind panes don't both get frozen / mis-read.
    const key = p.paneId || p.type;
    if (key === upperId || key === lowerId) return p;
    if (mpool.isDetailPane(p)) return p;
    if (typeof p.heightPct === 'number') return p;
    const b = boundsOf(slice, p);
    if (!b) return p;
    changed = true;
    return { ...p, heightPct: Math.round((b.h / availH) * 100) };
  });
  if (!changed) return slice;
  return { ...slice, arrange: mpool.updateColumn(slice.arrange, columnIndex, () => newCol) };
}

/** Set a pane's heightPct, addressed by paneId (v0.6.4). Detail is no
 *  longer special — its height lives on the pane's own `heightPct` like
 *  every other pane, so two detail panes resize independently. Accepts
 *  `p.type` as the key too (legacy / single-instance fixtures whose panes
 *  have no paneId). Identity-preserve when already at `pct`. */
function _setPanelHeightPct(slice, paneId, pct) {
  let changed = false;
  const nextColumns = slice.arrange.columns.map(col => {
    let colChanged = false;
    const panels = (col.panels || []).map(p => {
      if ((p.paneId || p.type) !== paneId) return p;
      if (p.heightPct === pct) return p;
      colChanged = true;
      return { ...p, heightPct: pct };
    });
    if (!colChanged) return col;
    changed = true;
    return { ...col, panels };
  });
  if (!changed) return slice;
  return { ...slice, arrange: { ...slice.arrange, columns: nextColumns } };
}

// ---------------------------------------------------------------- focus / selection

/** Derive the free-config cursor index from `slice.focus`. Returns
 *  -1 if the focused type isn't in the placed set (caller should
 *  clampSelected to recover). Replaces the pre-v0.6.x `selectedIdx`
 *  slice field — focus is the single source of truth for the active
 *  panel in free-config; the index is just an arithmetic convenience. */
function selectedIdx(slice) {
  // v0.6.3 Phase B3 — focus is a paneId; tolerant matcher catches
  // pre-migration callers (boot default, tests) seeding a panel-type.
  return mpool.allPanesInColumns(slice.arrange).findIndex(p => mpane.paneMatchesFocus(p, slice.focus));
}

/** Safety clamp after any mutation that can change the panel count.
 *  v0.6 invariant: `slice.focus` is the cursor truth — when a layout-
 *  shape change (undo/redo, applyDrop, pool_hide/show) leaves focus
 *  pointing at a panel that's no longer placed, snap it to whatever
 *  ends up at the same index, or to preferredType if supplied.
 *  v0.6.3 Phase B3 — preferredType matches by panel type (the caller
 *  knows the kind, not the paneId, and there's a 1:1 in singleton);
 *  result is written as paneId. */
function clampSelected(slice, preferredType) {
  const all = mpool.allPanesInColumns(slice.arrange);
  if (all.length === 0) return slice;
  if (preferredType) {
    const pIdx = all.findIndex(p => p.type === preferredType);
    if (pIdx >= 0) {
      const nextFocus = all[pIdx].paneId || all[pIdx].type;
      if (nextFocus === slice.focus) return slice;
      return { ...slice, focus: nextFocus };
    }
  }
  // v0.6.3 post-arch-arc T3.5 — null is a valid "no focus yet"
  // state (layout.init() seeds null pre-first-arrange). Don't
  // proactively snap it to a pane here; callers that want focus
  // assigned should dispatch focus_set (which routes through
  // _withFocus normalization).
  if (slice.focus == null) return slice;
  // focus already names a placed panel (by paneId or type) → no clamp needed
  if (all.some(p => mpane.paneMatchesFocus(p, slice.focus))) return slice;
  // focus is stale — snap to the first placed panel
  return { ...slice, focus: all[0].paneId || all[0].type };
}

// ---------------------------------------------------------------- new-column width allocation

/** Steal width from the columns adjacent to `position` and return
 *  `{ columns: <new array with neighbors shrunk>, newColWidth: int }`.
 *  Position must satisfy `0 <= position <= columns.length - 1` — the
 *  validators (validateNewColumn, validatePoolNewColumn, addColumn)
 *  refuse `position === columns.length` because spawning a new-last-
 *  column would push the detail-bearing previous-last off "last."
 *
 *  Each explicit-width neighbor donates
 *  `max(NEW_COL_DONOR_TAKE_MIN, floor(w / 3))`, shrinking to
 *  `max(NEW_COL_DONOR_FLOOR, w - take)`. The new column's width =
 *  sum of donations (or NEW_COL_DEFAULT_W if no explicit-width
 *  neighbor donates — e.g. spawning to the LEFT of an implicit-width
 *  last column in a 1-column layout, which is a corner case the
 *  validators don't yet refuse).
 *
 *  Shared by `addColumn` (empty new column), `applyNewColumn`
 *  (in-grid drag spawn), and `spawnNewColumnArrange` (pool drag
 *  spawn) — every spawn site routes through this one helper so the
 *  width math agrees across paths. */
function _allocateNewColumnWidth(columns, position) {
  const out = columns.slice();
  let donated = 0;
  if (position > 0) {
    const left = out[position - 1];
    if (left.width != null) {
      const take = Math.max(NEW_COL_DONOR_TAKE_MIN, Math.floor(left.width / 3));
      const newW = Math.max(NEW_COL_DONOR_FLOOR, left.width - take);
      out[position - 1] = { ...left, width: newW };
      donated += (left.width - newW);
    }
  }
  if (position < out.length) {
    const right = out[position];
    if (right.width != null) {
      const take = Math.max(NEW_COL_DONOR_TAKE_MIN, Math.floor(right.width / 3));
      const newW = Math.max(NEW_COL_DONOR_FLOOR, right.width - take);
      out[position] = { ...right, width: newW };
      donated += (right.width - newW);
    }
  }
  // When donations land tiny (e.g. a 11-cell donor floors at 10, donates
  // 1), the new column would be 1 cell wide. The new column compensates
  // by stealing from the implicit-width last column at render time
  // (_distributeColumnWidths absorbs the difference) — at the cost of
  // shrinking detail's home. NEW_COL_DONOR_TAKE_MIN as a floor on the
  // new column's width keeps it usable; the last column gives up the
  // shortfall.
  const newColWidth = donated > 0
    ? Math.max(NEW_COL_DONOR_TAKE_MIN, donated)
    : NEW_COL_DEFAULT_W;
  return { columns: out, newColWidth };
}

/** Splice the column at `removedIndex` out of `columns` AND release
 *  its explicit width back to the left neighbor (the most likely
 *  donor when the column was originally spawned). Pairs with
 *  `_allocateNewColumnWidth` so a spawn/remove round-trip restores
 *  the donor's width — without this, dragging a pane out to a new
 *  column then back leaves the donor permanently narrower.
 *
 *  Caller must ensure the column is genuinely removable (not last,
 *  and either empty after a drag move or explicitly :remove-column'd
 *  empty). When the left neighbor has implicit width or doesn't
 *  exist (removedIndex === 0), no transfer — the implicit last
 *  column absorbs the released cells naturally via the renderer's
 *  remainder math. */
function _spliceAndReleaseWidth(columns, removedIndex) {
  const removed = columns[removedIndex];
  const out = columns.slice();
  out.splice(removedIndex, 1);
  if (removed && removed.width != null && removedIndex > 0) {
    const leftIdx = removedIndex - 1;
    const left = out[leftIdx];
    if (left && left.width != null) {
      out[leftIdx] = { ...left, width: left.width + removed.width };
    }
  }
  return out;
}

module.exports = {
  // constants. NEW_COL_*, DETAIL_MIN_ROWS used only internally (the
  // width-alloc + clamp math below) — not exported.
  MIN_PANEL_H, EDGE_W, MAX_UNDO,
  // detail clamps
  detailMinPct, detailMaxPct,
  // undo (snapshot / _applySnapshot are internal undo plumbing — not exported)
  pushUndo: _pushUndoSlice,
  undo, redo, clearUndoStacks,
  // hotkey rekey
  reassignHotkeys: _reassignHotkeys,
  // geometry
  boundsOf,
  columnTotalH, panelHeightPct,
  freezeColumnFlex, setPanelHeightPct: _setPanelHeightPct,
  // focus
  selectedIdx, clampSelected,
  // new-column width
  allocateNewColumnWidth: _allocateNewColumnWidth,
  spliceAndReleaseWidth: _spliceAndReleaseWidth,
};
