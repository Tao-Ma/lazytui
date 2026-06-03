/**
 * Pure free-config layout transforms — the reducer-owned half of the
 * free-config flow (the read-side overlay lives in `overlay/free-config.js`).
 *
 * Like leaves/search / leaves/pane-tabs / leaves/register, this is a
 * dependency-free leaf the layout Component imports without a require
 * cycle (overlay/free-config requires runtime + term + ansi, so the
 * reducer can't call into it). Every
 * function takes the layout Component slice, returns a new slice (or the
 * same ref when the operation is a no-op). No I/O, no globals, no terminal
 * reads. The one bit of terminal state the reducer can't synthesize — the
 * current terminal width — is threaded in as `COLS` by the caller for the
 * hit-tests; `model.modes.freeConfigMode` is the one read of the chrome flag,
 * threaded in as `model` for mousePress's defensive guard.
 *
 * Slice shape touched:
 *   - slice.arrange.{columns[], detailHeightPct}
 *     where columns[i] = { width?, panels: [...] }; last column's width
 *     is implicit (takes the remainder).
 *   - slice.dirty (set true on any change that should round-trip to YAML)
 *   - slice.freeConfig.{undo, redo, titleEdit, drag}
 *   - slice.focus is the cursor truth in free-config; the active-panel
 *     INDEX is derived via `selectedIdx(slice)` rather than stored.
 *   - slice.panelBounds (READ only — frame-derived, written by layout.js)
 *
 * Drag state machine note: `drag` captures the gesture's anchor panels by
 * **type string**, not by panel ref, because the panel objects themselves
 * are reallocated as the slice updates and any captured refs would go stale
 * across motion events.
 */
'use strict';

const mpool = require('./pool');
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

// ---------------------------------------------------------------- pure reads

function allFreeConfigPanels(slice) {
  return mpool.allPanesInColumns(slice.arrange);
}

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

function columnTotalH(slice, columnIndex) {
  const panels = mpool.columnPanels(slice.arrange, columnIndex);
  let total = 0;
  for (const p of panels) {
    const b = slice.panelBounds[p.type];
    if (b) total += b.h;
  }
  return total;
}

function panelHeightPct(slice, p, availH) {
  if (mpool.isDetailPane(p)) return slice.arrange.detailHeightPct;
  if (typeof p.heightPct === 'number') return p.heightPct;
  const b = slice.panelBounds[p.type];
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
  let undo = [...d.undo, snapshot(slice.arrange)];
  if (undo.length > MAX_UNDO) undo = undo.slice(undo.length - MAX_UNDO);
  return { ...slice, freeConfig: { ...d, undo, redo: [] } };
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
 *  overlay/free-config shim). Tolerates the layout slice not existing yet. */
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
function freezeColumnFlex(slice, columnIndex, upperType, lowerType, availH) {
  const panels = mpool.columnPanels(slice.arrange, columnIndex);
  let changed = false;
  const newCol = panels.map(p => {
    if (p.type === upperType || p.type === lowerType) return p;
    if (mpool.isDetailPane(p)) return p;
    if (typeof p.heightPct === 'number') return p;
    const b = slice.panelBounds[p.type];
    if (!b) return p;
    changed = true;
    return { ...p, heightPct: Math.round((b.h / availH) * 100) };
  });
  if (!changed) return slice;
  return { ...slice, arrange: mpool.updateColumn(slice.arrange, columnIndex, () => newCol) };
}

/** Set a panel's heightPct by type. detail → arrange.detailHeightPct; other
 *  panels → the matching panel's heightPct in whichever column owns it.
 *  Identity-preserve when already at `pct`. */
function _setPanelHeightPct(slice, panelType, pct) {
  if (panelType === 'detail') {
    if (slice.arrange.detailHeightPct === pct) return slice;
    return { ...slice, arrange: { ...slice.arrange, detailHeightPct: pct } };
  }
  let changed = false;
  const nextColumns = slice.arrange.columns.map(col => {
    let colChanged = false;
    const panels = (col.panels || []).map(p => {
      if (p.type !== panelType) return p;
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
  const all = allFreeConfigPanels(slice);
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
  const loc = mpool.findPaneLocation(slice.arrange, p => p.type === slice.focus);
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

  let next = _pushUndoSlice(slice);
  next = {
    ...next,
    arrange: _reassignHotkeys(mpool.updateColumn(slice.arrange, loc.columnIndex, () => newCol)),
    dirty: true,
  };
  return next;
}

/** ←/→ — move the focused panel between columns (dir = -1 or +1).
 *  Phase 1: refuses moves into/out of last column for reserved panes;
 *  clamps at the layout edges. Detail/actions stay in the last column. */
function moveColumn(slice, dir) {
  const loc = mpool.findPaneLocation(slice.arrange, p => p.type === slice.focus);
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

  let next = _pushUndoSlice(slice);
  next = { ...next, arrange: _reassignHotkeys(nextArrange), dirty: true };
  return next;
}

/** +/- — detail selected: grow/shrink detailHeightPct by 5 (clamped [20,90]);
 *  else a non-last-column panel selected: grow/shrink its column's width by
 *  2 (clamped [20,60]). Last-column non-detail panels: no-op (the last
 *  column's width is implicit; can't grow without shrinking a neighbor). */
function resizeWidthOrDetail(slice, sign) {
  const loc = mpool.findPaneLocation(slice.arrange, p => p.type === slice.focus);
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

  let next = _pushUndoSlice(slice);
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
  const loc = mpool.findPaneLocation(slice.arrange, p => p.type === slice.focus);
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

  let result = _pushUndoSlice(frozen);
  result = _setPanelHeightPct(result, sel.type, newSel);
  result = _setPanelHeightPct(result, nextPanel.type, newNext);
  return { ...result, dirty: true };
}

/** Derive the free-config cursor index from `slice.focus`. Returns
 *  -1 if the focused type isn't in the placed set (caller should
 *  clampSelected to recover). Replaces the pre-v0.6.x `selectedIdx`
 *  slice field — focus is the single source of truth for the active
 *  panel in free-config; the index is just an arithmetic convenience. */
function selectedIdx(slice) {
  return allFreeConfigPanels(slice).findIndex(p => p.type === slice.focus);
}

/** Safety clamp after any mutation that can change the panel count.
 *  v0.6 invariant: `slice.focus` is the cursor truth — when a layout-
 *  shape change (undo/redo, applyDrop, pool_hide/show) leaves focus
 *  pointing at a panel that's no longer placed, snap it to whatever
 *  ends up at the same index, or to preferredType if supplied. */
function clampSelected(slice, preferredType) {
  const all = allFreeConfigPanels(slice);
  if (all.length === 0) return slice;
  if (preferredType) {
    const pIdx = all.findIndex(p => p.type === preferredType);
    if (pIdx >= 0) {
      const nextFocus = all[pIdx].type;
      if (nextFocus === slice.focus) return slice;
      return { ...slice, focus: nextFocus };
    }
  }
  // focus already names a placed panel → no clamp needed
  if (all.some(p => p.type === slice.focus)) return slice;
  // focus is stale — snap to the first placed panel
  return { ...slice, focus: all[0].type };
}

// ---------------------------------------------------------------- title edit

/** Seed the title-edit buffer from the focused panel's current title. */
function titleEnter(slice) {
  const d = slice.freeConfig;
  if (!d) return slice;
  const p = allFreeConfigPanels(slice)[selectedIdx(slice)];
  if (!p) return slice;
  return { ...slice, freeConfig: { ...d, titleEdit: { active: true, text: p.title || '' } } };
}

/** Commit a non-empty, changed title to the focused panel (pushes one undo). */
function setSelectedTitle(slice, text) {
  const d = slice.freeConfig;
  if (!d) return slice;
  const p = allFreeConfigPanels(slice)[selectedIdx(slice)];
  if (!p || text.length === 0 || text === p.title) return slice;

  let next = _pushUndoSlice(slice);
  const nextColumns = next.arrange.columns.map(col => ({
    ...col,
    panels: (col.panels || []).map(x => x.type === p.type ? { ...x, title: text } : x),
  }));
  next = { ...next, arrange: { ...next.arrange, columns: nextColumns }, dirty: true };
  return next;
}

// ---------------------------------------------------------------- column geometry

/** Compute the x-range of each column. Thin re-export of the shared
 *  distributor in `leaves/pool` so the mouse hit-tester and the
 *  renderer (which also calls `mpool.distributeColumnWidths`) never
 *  disagree — on narrow terminals where the squeeze kicks in, the
 *  renderer's painted column boundary IS where clicks land. */
function _columnRanges(arrange, COLS) {
  return mpool.distributeColumnWidths(arrange, COLS);
}

/** Find the column whose x-range contains `mx`, or null. */
function _columnAtX(arrange, mx, COLS) {
  for (const r of _columnRanges(arrange, COLS)) {
    if (mx >= r.x && mx < r.x + r.w) return r;
  }
  return null;
}

/** Find the column-boundary that `mx` sits on (±1), or null. Boundary i
 *  sits between columns i and i+1 (i.e. at x = sum(0..i).width). Only
 *  N-1 boundaries exist (the last column's right edge IS the terminal
 *  edge, not a draggable boundary). Returns
 *  { boundaryIndex, x, leftColumn, rightColumn } when a hit. */
function _boundaryAtX(arrange, mx, COLS) {
  const ranges = _columnRanges(arrange, COLS);
  for (let i = 0; i < ranges.length - 1; i++) {
    const bx = ranges[i].x + ranges[i].w;
    if (Math.abs(mx - bx) <= 1) {
      return { boundaryIndex: i, x: bx, leftColumn: i, rightColumn: i + 1 };
    }
  }
  return null;
}

/** Detect the new-column drop zone the cursor falls in, or null. Two
 *  classes:
 *    - left edge: `mx < EDGE_W` → position 0
 *    - column gap: `|mx - boundary| < EDGE_W` → position i+1 (between
 *      columns i and i+1)
 *  No right-edge zone: position == N is always refused (would push
 *  detail off the last column), so capturing the last 2 cells of the
 *  terminal as a "spawn here" zone just dead-shadows the rightmost
 *  cells of the last column without giving the user a usable target.
 *  Cursor near the right edge falls through to the in-column 3-zone
 *  hit on the last column's cells instead. */
function _newColumnZoneAt(arrange, mx, COLS) {
  // Out-of-bounds left (negative mx from terminal events that fired
  // after a resize / past the edge): the cursor is OFF the layout, not
  // in a left-edge spawn zone. Same symmetric defense as pool drag's
  // `if (mx < 0 || my < 0) return null;` at pointToPoolDropTarget.
  if (mx < 0) return null;
  if (mx < EDGE_W) return { position: 0 };
  const ranges = _columnRanges(arrange, COLS);
  for (let i = 0; i < ranges.length - 1; i++) {
    const bx = ranges[i].x + ranges[i].w;
    if (Math.abs(mx - bx) < EDGE_W) {
      return { position: i + 1 };
    }
  }
  return null;
}

// ---------------------------------------------------------------- mouse hit-tests

/**
 * Hit-test a point against draggable separators. Returns `{ edge, boundary?,
 * columnIndex?, boundaryIndex? }` or null. Edges: 'corner' (col-sep × a
 * panel boundary, both axes), 'col' (col-sep only), 'panel-boundary' (a
 * horizontal seam between two stacked panels within a column). ±1
 * tolerance on both axes; the column the cursor sits IN wins ties on
 * the corner. The legacy 'left-boundary'/'right-boundary' edge names
 * are folded into 'panel-boundary' with an explicit `columnIndex`.
 */
function pointToResizeTarget(slice, mx, my, COLS) {
  const boundaryHit = _boundaryAtX(slice.arrange, mx, COLS);
  const colHit = _columnAtX(slice.arrange, mx, COLS);

  // Corner detection: when the cursor sits on a column boundary, look
  // for a panel boundary at `my` in BOTH flanking columns. Prefer the
  // cursor's column (left or right of the boundary by floor-half-cell);
  // fall back to the other column so a 1-cell-wide column-boundary
  // misalignment still surfaces the corner gesture.
  if (boundaryHit) {
    const cursorCol = colHit ? colHit.columnIndex : boundaryHit.rightColumn;
    const otherCol = (cursorCol === boundaryHit.leftColumn)
      ? boundaryHit.rightColumn
      : boundaryHit.leftColumn;
    const inCursor = boundaryNear(slice, mpool.columnPanels(slice.arrange, cursorCol), my);
    if (inCursor) {
      return { edge: 'corner', boundary: inCursor, columnIndex: cursorCol, boundaryIndex: boundaryHit.boundaryIndex };
    }
    const inOther = boundaryNear(slice, mpool.columnPanels(slice.arrange, otherCol), my);
    if (inOther) {
      return { edge: 'corner', boundary: inOther, columnIndex: otherCol, boundaryIndex: boundaryHit.boundaryIndex };
    }
    return { edge: 'col', boundaryIndex: boundaryHit.boundaryIndex };
  }
  // Panel boundary not on a column boundary.
  if (colHit) {
    const panelB = boundaryNear(slice, mpool.columnPanels(slice.arrange, colHit.columnIndex), my);
    if (panelB) return { edge: 'panel-boundary', boundary: panelB, columnIndex: colHit.columnIndex };
  }
  return null;
}

/** Horizontal boundary between two adjacent panels within ±1 of `my`, or null.
 *  Boundary y = `upper.y + upper.h` (where the next panel's top border sits). */
function boundaryNear(slice, panels, my) {
  for (let i = 0; i < panels.length - 1; i++) {
    const b = slice.panelBounds[panels[i].type];
    if (!b) continue;
    const y = b.y + b.h;
    if (Math.abs(my - y) <= 1) return { upper: panels[i], lower: panels[i + 1], y };
  }
  return null;
}

/** Panel type at (mx, my) per rendered bounds, or null (frame-synchronous). */
function panelAt(slice, mx, my) {
  for (const p of allFreeConfigPanels(slice)) {
    const b = slice.panelBounds[p.type];
    if (!b) continue;
    if (mx >= b.x && mx < b.x + b.w && my >= b.y && my < b.y + b.h) return p.type;
  }
  return null;
}

/**
 * Cell vertical-third the point falls in, or null when outside the cell's
 * y-range. h<3 collapses the middle (insert-only top/bottom halves) so very
 * short cells don't sprout a 1-row-tall swap zone that's impossible to land in.
 */
function pointToCellZone(b, my) {
  if (my < b.y || my >= b.y + b.h) return null;
  if (b.h < 3) return (my < b.y + b.h / 2) ? 'top' : 'bottom';
  const third = Math.floor(b.h / 3);
  if (my < b.y + third)        return 'top';
  if (my < b.y + b.h - third)  return 'middle';
  return 'bottom';
}

/**
 * Resolve a screen point to a drop target. Three zones per cell:
 *   top third    → insert before this cell
 *   middle third → swap with this cell's occupant
 *   bottom third → insert after this cell
 *
 * Returns a tagged target — `{ kind:'insert', columnIndex, index, valid, reason? }`
 * or `{ kind:'swap', columnIndex, index, occupantType, valid, reason? }` —
 * or null when the point isn't in any column.
 */
function pointToDropTarget(slice, srcType, mx, my, COLS) {
  // Edge/gap zones first — spawn-new-column takes precedence over the
  // in-column 3-zone hit. Users still reach in-column inserts at the
  // top/middle/bot of any pane that lives strictly INSIDE the column
  // (i.e., mx >= EDGE_W and away from internal boundaries).
  const ncz = _newColumnZoneAt(slice.arrange, mx, COLS);
  if (ncz) return validateNewColumn(slice, srcType, ncz.position);
  const ranges = _columnRanges(slice.arrange, COLS);
  for (const r of ranges) {
    const panels = mpool.columnPanels(slice.arrange, r.columnIndex);
    const hit = matchColumn(slice, panels, mx, my);
    if (hit !== null) return validateTarget(slice, srcType, r.columnIndex, hit);
    // Empty column: cursor in its x-range with no panes → insert@0.
    if (mx >= r.x && mx < r.x + r.w && panels.length === 0) {
      return validateTarget(slice, srcType, r.columnIndex, { kind: 'insert', index: 0 });
    }
  }
  return null;
}

/** Validate a new_column drop. Phase 2 rules:
 *    - Detail and actions sources refuse (they live in the last column
 *      by invariant; moving them to a fresh column would split the
 *      reserved-pane group).
 *    - Spawning at position == N (right edge) refuses: would promote
 *      a non-reserved pane to the new last column, demoting the old
 *      last (where detail lives) off "last" and breaking the invariant.
 *      Phase 3's `:add-column` verb may relax this with explicit UX.
 *  Future arc can relax both. */
function validateNewColumn(slice, srcType, position) {
  if (srcType === 'detail' || srcType === 'actions') {
    return { kind: 'new_column', position, valid: false, reason: `${srcType} must stay in the last column` };
  }
  const N = mpool.columnCount(slice.arrange);
  if (position === N) {
    return { kind: 'new_column', position, valid: false, reason: `can't push detail off the last column` };
  }
  return { kind: 'new_column', position, valid: true };
}

function matchColumn(slice, panels, mx, my) {
  let anyXMatch = false;
  for (let i = 0; i < panels.length; i++) {
    const b = slice.panelBounds[panels[i].type];
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w) continue;
    anyXMatch = true;
    if (my < b.y) return { kind: 'insert', index: i };
    if (my < b.y + b.h) {
      const zone = pointToCellZone(b, my);
      if (zone === 'top')    return { kind: 'insert', index: i };
      if (zone === 'middle') return { kind: 'swap',   index: i, occupantType: panels[i].type };
      return { kind: 'insert', index: i + 1 };
    }
  }
  if (anyXMatch) return { kind: 'insert', index: panels.length };
  return null;
}

function validateTarget(slice, srcType, columnIndex, target) {
  const lastIdx = mpool.lastColumnIndex(slice.arrange);
  if (target.kind === 'swap') {
    const occType = target.occupantType;
    const base = { kind: 'swap', columnIndex, index: target.index, occupantType: occType };
    // Self-swap (source == occupant) is always a valid no-op — mouseRelease
    // detects it and skips applyDrop, so nothing moves. Marking it invalid
    // would show a misleading "✗ blocked" footer when the user releases a
    // drag onto its own middle third (release does nothing in either case).
    if (occType === srcType) return { ...base, valid: true };
    const fromLoc = mpool.findPaneLocation(slice.arrange, p => p.type === srcType);
    const fromCol = fromLoc ? fromLoc.columnIndex : -1;
    // Dragged panel ends up in `columnIndex` — detail/actions can't live
    // outside the last column.
    if (columnIndex !== lastIdx && (srcType === 'detail' || srcType === 'actions')) {
      return { ...base, valid: false, reason: `${srcType} must stay in the last column` };
    }
    // Occupant ends up in source's column — same rule going the other way.
    if (fromCol !== lastIdx && (occType === 'detail' || occType === 'actions')) {
      return { ...base, valid: false, reason: `${occType} must stay in the last column` };
    }
    // Last column keeps detail at the end. Any swap involving detail in
    // the last column would move it off the tail.
    if (columnIndex === lastIdx && occType === 'detail') {
      return { ...base, valid: false, reason: `detail must stay at end` };
    }
    if (fromCol === lastIdx && srcType === 'detail') {
      return { ...base, valid: false, reason: `detail must stay at end` };
    }
    return { ...base, valid: true };
  }
  // insert
  const index = target.index;
  if (columnIndex !== lastIdx && (srcType === 'detail' || srcType === 'actions')) {
    return { kind: 'insert', columnIndex, index, valid: false, reason: `${srcType} must stay in the last column` };
  }
  // Last column: detail stays at the end (same convention pool_show
  // follows). Clamp any drop AFTER detail to detail's slot — applyInsert
  // handles the splice-shift for same-column moves, so the clamp uses
  // the pre-removal detailIdx. The `clamp` field marks that the target
  // index was rewritten so the footer can surface "(clamped — <reason>)".
  if (columnIndex === lastIdx && srcType !== 'detail') {
    const detailIdx = mpool.detailPaneIndex(slice.arrange);
    if (detailIdx >= 0 && index > detailIdx) {
      return { kind: 'insert', columnIndex, index: detailIdx, valid: true, clamp: 'detail stays at end' };
    }
  }
  return { kind: 'insert', columnIndex, index, valid: true };
}

// ---------------------------------------------------------------- mouse state machine

/** Column-separator drag: set the dragged boundary's left column to the
 *  cursor's x (relative to the column's left edge). Clamped [20, 60]. */
function applyColResize(slice, mx) {
  const ds = slice.freeConfig && slice.freeConfig.drag;
  if (!ds || ds.boundaryIndex == null) return slice;
  const bi = ds.boundaryIndex;
  // The boundary's left column is columns[bi]; that column's width is
  // (mx - leftEdge). Compute leftEdge from preceding columns' widths.
  let leftEdge = 0;
  for (let i = 0; i < bi; i++) {
    const w = slice.arrange.columns[i].width != null ? slice.arrange.columns[i].width : 30;
    leftEdge += w;
  }
  const newW = Math.max(20, Math.min(60, mx - leftEdge + 1));
  const col = slice.arrange.columns[bi];
  if (col.width === newW) return slice;
  const nextColumns = slice.arrange.columns.slice();
  nextColumns[bi] = { ...col, width: newW };
  return { ...slice, arrange: { ...slice.arrange, columns: nextColumns }, dirty: true };
}

/** Within-column boundary drag: redistributes height between the two panels
 *  captured at press (D1 — steal from neighbor only). A detail side writes
 *  detailHeightPct clamped [20, 90]; the neighbor takes the complement. */
function applyBoundaryResize(slice, my) {
  const d = slice.freeConfig;
  const ds = d && d.drag;
  if (!ds) return slice;
  let upperH = Math.max(MIN_PANEL_H, Math.min(ds.combinedH - MIN_PANEL_H, my - ds.upperStartY));
  let lowerH = ds.combinedH - upperH;

  if (ds.detailIsUpper) {
    const minH = Math.max(MIN_PANEL_H, Math.floor(ds.availH * detailMinPct(ds.availH) / 100));
    const maxH = Math.min(ds.combinedH - MIN_PANEL_H, Math.floor(ds.availH * detailMaxPct(ds.availH) / 100));
    upperH = Math.max(minH, Math.min(maxH, upperH));
    lowerH = ds.combinedH - upperH;
  } else if (ds.detailIsLower) {
    const minH = Math.max(MIN_PANEL_H, Math.floor(ds.availH * detailMinPct(ds.availH) / 100));
    const maxH = Math.min(ds.combinedH - MIN_PANEL_H, Math.floor(ds.availH * detailMaxPct(ds.availH) / 100));
    lowerH = Math.max(minH, Math.min(maxH, lowerH));
    upperH = ds.combinedH - lowerH;
  }

  const upperPct = Math.round(upperH / ds.availH * 100);
  const lowerPct = Math.round(lowerH / ds.availH * 100);

  let next = slice;
  if (ds.detailIsUpper) {
    next = _setPanelHeightPct(next, 'detail', upperPct);
    next = _setPanelHeightPct(next, ds.lowerType, lowerPct);
  } else if (ds.detailIsLower) {
    next = _setPanelHeightPct(next, 'detail', lowerPct);
    next = _setPanelHeightPct(next, ds.upperType, upperPct);
  } else {
    next = _setPanelHeightPct(next, ds.upperType, upperPct);
    next = _setPanelHeightPct(next, ds.lowerType, lowerPct);
  }
  if (next === slice) return slice;
  return { ...next, dirty: true };
}

/** Apply a drop target — insert (splice + insert at slot), swap (trade
 *  slots with occupant), or new_column (splice a fresh column in at
 *  `position` containing the dragged pane). Re-derives hotkeys
 *  positionally; marks dirty. */
function applyDrop(slice, srcType, target) {
  if (target.kind === 'swap') return applySwap(slice, srcType, target);
  if (target.kind === 'new_column') return applyNewColumn(slice, srcType, target);
  return applyInsert(slice, srcType, target);
}

/** Spawn a new column at `target.position` containing the dragged
 *  pane (moved from its source column). Width allocation routes
 *  through `_allocateNewColumnWidth`; both target.position and the
 *  shifted effective position remain strictly inside [0, len-1] (the
 *  validators refuse position == N so a "becomes the new last" outcome
 *  is unreachable here). Source column that ends up empty (the dragged
 *  pane was its only occupant) gets removed — keeps the UX clean. */
function applyNewColumn(slice, srcType, target) {
  const arrange = slice.arrange;
  const fromLoc = mpool.findPaneLocation(arrange, p => p.type === srcType);
  if (!fromLoc) return slice;
  const src = fromLoc.pane;
  const position = target.position;
  const N = mpool.columnCount(arrange);
  const lastIdx = N - 1;

  // Build the source column minus the dragged pane.
  const fromCol = arrange.columns[fromLoc.columnIndex];
  const fromPanels = (fromCol.panels || []).filter((_, i) => i !== fromLoc.paneIndex);
  const sourceWillBeEmpty = fromPanels.length === 0;
  // Can't remove the last column (detail invariant).
  const removeSource = sourceWillBeEmpty && fromLoc.columnIndex !== lastIdx;

  // Work against a transient copy of arrange.columns with the source
  // column either updated (with the dragged pane removed) or removed
  // entirely. Indexes shift if removeSource fires before `position`.
  let workingColumns = arrange.columns.slice();
  workingColumns[fromLoc.columnIndex] = { ...fromCol, panels: fromPanels };
  let effectivePosition = position;
  if (removeSource) {
    // _spliceAndReleaseWidth releases the source's width back to its
    // left neighbor so the spawn → drag-back round-trip restores the
    // donor's original width.
    workingColumns = _spliceAndReleaseWidth(workingColumns, fromLoc.columnIndex);
    if (fromLoc.columnIndex < position) effectivePosition = position - 1;
  }

  const { columns: shrunk, newColWidth } =
    _allocateNewColumnWidth(workingColumns, effectivePosition);
  // columnIndex re-stamped by _reassignHotkeys after the splice.
  const newCol = { width: newColWidth, panels: [{ ...src, columnIndex: -1 }] };
  shrunk.splice(effectivePosition, 0, newCol);

  return {
    ...slice,
    arrange: _reassignHotkeys({ ...arrange, columns: shrunk }),
    dirty: true,
  };
}

function applyInsert(slice, srcType, target) {
  const fromLoc = mpool.findPaneLocation(slice.arrange, p => p.type === srcType);
  if (!fromLoc) return slice;
  const src = fromLoc.pane;
  const fromCol = fromLoc.columnIndex;
  const fromIdx = fromLoc.paneIndex;
  let toCol = target.columnIndex;
  let insertAt = target.index;
  if (fromCol === toCol && fromIdx < insertAt) insertAt--;
  const lastIdx = mpool.lastColumnIndex(slice.arrange);

  // Build the target column's new panels array. If the source is moving
  // within the same column, mutate one column; otherwise mutate two.
  let nextArrange;
  if (fromCol === toCol) {
    const panels = mpool.columnPanels(slice.arrange, fromCol).slice();
    panels.splice(fromIdx, 1);
    panels.splice(insertAt, 0, { ...src, columnIndex: toCol });
    nextArrange = mpool.updateColumn(slice.arrange, fromCol, () => panels);
  } else {
    const fromPanels = mpool.columnPanels(slice.arrange, fromCol).slice();
    fromPanels.splice(fromIdx, 1);
    const toPanels = mpool.columnPanels(slice.arrange, toCol).slice();
    toPanels.splice(insertAt, 0, { ...src, columnIndex: toCol });
    nextArrange = mpool.updateColumn(slice.arrange, fromCol, () => fromPanels);
    nextArrange = mpool.updateColumn(nextArrange, toCol, () => toPanels);
    // Source column became empty and isn't the last column → auto-
    // remove it and release its width back to the left neighbor.
    // Mirrors applyNewColumn's removeSource branch: an emptied source
    // column would otherwise render as a blank gap (still occupying
    // its `width` cells) instead of yielding the cells back to the
    // donor neighbor. The drag-out + drag-back round-trip now
    // restores the original layout.
    if (fromPanels.length === 0 && fromCol !== lastIdx) {
      const releasedColumns = _spliceAndReleaseWidth(nextArrange.columns, fromCol);
      nextArrange = { ...nextArrange, columns: releasedColumns };
    }
  }

  return {
    ...slice,
    arrange: _reassignHotkeys(nextArrange),
    dirty: true,
  };
}

/** Swap source ↔ occupant by slot. Same-column = two writes to the same
 *  array; cross-column = one write to each. Self-swap (source = occupant)
 *  is a no-op (returns slice unchanged). Hotkeys re-derive positionally,
 *  so a panel's letter follows its slot, not its identity — same convention
 *  as applyInsert. */
function applySwap(slice, srcType, target) {
  const fromLoc = mpool.findPaneLocation(slice.arrange, p => p.type === srcType);
  if (!fromLoc) return slice;
  const src = fromLoc.pane;
  const fromCol = fromLoc.columnIndex;
  const fromIdx = fromLoc.paneIndex;

  const toCol = target.columnIndex;
  const toIdx = target.index;
  const toPanels = mpool.columnPanels(slice.arrange, toCol);
  const occ = toPanels[toIdx];
  if (!occ) return slice;
  if (fromCol === toCol && fromIdx === toIdx) return slice;

  const newSrc = { ...src, columnIndex: toCol };
  const newOcc = { ...occ, columnIndex: fromCol };

  let nextArrange;
  if (fromCol === toCol) {
    const panels = mpool.columnPanels(slice.arrange, fromCol).slice();
    panels[fromIdx] = newOcc;
    panels[toIdx] = newSrc;
    nextArrange = mpool.updateColumn(slice.arrange, fromCol, () => panels);
  } else {
    const fromPanels = mpool.columnPanels(slice.arrange, fromCol).slice();
    fromPanels[fromIdx] = newOcc;
    const toPanelsNew = toPanels.slice();
    toPanelsNew[toIdx] = newSrc;
    nextArrange = mpool.updateColumn(slice.arrange, fromCol, () => fromPanels);
    nextArrange = mpool.updateColumn(nextArrange, toCol, () => toPanelsNew);
  }

  return {
    ...slice,
    arrange: _reassignHotkeys(nextArrange),
    dirty: true,
  };
}

/** Press: resize hit-test FIRST (a seam sits on a panel border), else arm a
 *  panel drag + move the keyboard selection to the clicked panel. Callers
 *  already gate on `freeConfigMode` (input.js handleMouse only dispatches
 *  `free_config_mouse_press` when the mode is active), so the leaf no longer
 *  needs the model to re-check — drops the `model` arg. */
function mousePress(slice, mx, my, COLS) {
  const resize = pointToResizeTarget(slice, mx, my, COLS);
  if (resize) {
    let next = _pushUndoSlice(slice);
    const ds = { kind: `resizing-${resize.edge}` };
    if (resize.boundaryIndex != null) ds.boundaryIndex = resize.boundaryIndex;
    if (resize.edge === 'panel-boundary' || resize.edge === 'corner') {
      const columnIndex = resize.columnIndex;
      const b = resize.boundary;
      ds.columnIndex = columnIndex;
      ds.upperType = b.upper.type;
      ds.lowerType = b.lower.type;
      ds.upperStartY = slice.panelBounds[b.upper.type].y;
      ds.combinedH = slice.panelBounds[b.upper.type].h + slice.panelBounds[b.lower.type].h;
      ds.availH = columnTotalH(slice, columnIndex);
      if (ds.availH < 1) ds.availH = 1;
      ds.detailIsUpper = mpool.isDetailPane(b.upper);
      ds.detailIsLower = mpool.isDetailPane(b.lower);
      next = freezeColumnFlex(next, columnIndex, b.upper.type, b.lower.type, ds.availH);
    }
    return { ...next, freeConfig: { ...next.freeConfig, drag: ds } };
  }
  const hit = panelAt(slice, mx, my);
  if (!hit) return { ...slice, freeConfig: { ...slice.freeConfig, drag: null } };
  // Click sets focus to the panel under the cursor — green border
  // tracks the click even if the user doesn't go on to drag.
  // selectedIdx() derives from focus.
  const drag = { kind: 'armed', sourceType: hit, startX: mx, startY: my, curX: mx, curY: my, target: null };
  return { ...slice, focus: hit, freeConfig: { ...slice.freeConfig, drag } };
}

/** Motion: resize kinds redistribute heights; a panel drag promotes
 *  armed→dragging after ≥1 cell and recomputes the drop target. */
function mouseMotion(slice, mx, my, COLS) {
  const d = slice.freeConfig;
  const ds = d && d.drag;
  if (!ds) return slice;
  if (ds.kind === 'resizing-col')           return applyColResize(slice, mx);
  if (ds.kind === 'resizing-panel-boundary') return applyBoundaryResize(slice, my);
  if (ds.kind === 'resizing-corner')        return applyBoundaryResize(applyColResize(slice, mx), my);
  // panel drag (armed → dragging)
  let nextKind = ds.kind;
  if (ds.kind === 'armed') {
    if (mx === ds.startX && my === ds.startY) {
      // movement-free motion still updates the cursor record so a later release
      // can read it; old code mutated curX/curY before the early return.
      return { ...slice, freeConfig: { ...d, drag: { ...ds, curX: mx, curY: my } } };
    }
    nextKind = 'dragging';
  }
  const target = pointToDropTarget(slice, ds.sourceType, mx, my, COLS);
  return { ...slice, freeConfig: { ...d, drag: { ...ds, kind: nextKind, curX: mx, curY: my, target } } };
}

/** Release: commit a valid drop (push undo + applyDrop), then clear the drag.
 *  Drop calls clampSelected with the dropped panel's type so focus
 *  lands there — its type stayed the same; its position is new, and
 *  selectedIdx() derives the new index from the rearranged columns. */
function mouseRelease(slice) {
  const d = slice.freeConfig;
  const ds = d && d.drag;
  if (!ds) return slice;
  let next = slice;
  let droppedType = null;
  if (ds.kind === 'dragging' && ds.target && ds.target.valid) {
    // Self-swap (middle-zone drop on own cell) is a no-op — skip undo
    // push so it doesn't bloat the stack with empty entries.
    const t = ds.target;
    const isSelfSwap = t.kind === 'swap' && t.occupantType === ds.sourceType;
    if (!isSelfSwap) {
      next = _pushUndoSlice(next);
      next = applyDrop(next, ds.sourceType, ds.target);
      droppedType = ds.sourceType;
    }
  }
  next = { ...next, freeConfig: { ...next.freeConfig, drag: null } };
  if (droppedType) next = clampSelected(next, droppedType);
  return next;
}

// v0.6 Phase 5 pool drag (poolDragStart / poolDragMotion / poolDragRelease /
// pointToPoolDropTarget) lives in leaves/free-config-pool-drag — separate gesture
// with its own state-machine kind (pool-armed/pool-dragging). Shares
// pointToCellZone with this leaf for the 3-zone hit-test rule.

/** Compute the preview arrange for an in-grid drag at the current target —
 *  what the layout would look like on release. Returns null when there's no
 *  preview to paint (no drag, no target, invalid target, or self-swap). The
 *  render path swaps slice.arrange for this value during the drag-render
 *  pass, restoring after so subsequent hit-tests use the stable original
 *  layout (prevents the recursive flicker where painting the preview would
 *  change which cell the cursor "is in" on the next motion event). */
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
    _allocateNewColumnWidth(arrange.columns, position);
  shrunk.splice(position, 0, { width: newColWidth, panels: [] });
  const nextArrange = _reassignHotkeys({ ...arrange, columns: shrunk });
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
  const columns = _spliceAndReleaseWidth(arrange.columns, n);
  const nextArrange = _reassignHotkeys({ ...arrange, columns });
  return { slice: { ...slice, arrange: nextArrange, dirty: true }, error: null };
}

function computeDragPreviewArrange(slice) {
  const drag = slice.freeConfig && slice.freeConfig.drag;
  if (!drag || drag.kind !== 'dragging') return null;
  if (!drag.target || !drag.target.valid) return null;
  const t = drag.target;
  if (t.kind === 'swap' && t.occupantType === drag.sourceType) return null;
  // Same-position insert short-circuit: drop on top-third (target.index ==
  // fromIdx) or bottom-third (target.index == fromIdx + 1) of source's own
  // cell, same column. applyInsert's splice math produces an arrange that
  // matches the original layout, but with a fresh object identity and
  // dirty:true. Render would swap+paint identical pixels — wasted work.
  if (t.kind === 'insert') {
    const panels = mpool.columnPanels(slice.arrange, t.columnIndex);
    const fromIdx = panels.findIndex(p => p.type === drag.sourceType);
    if (fromIdx >= 0 && (t.index === fromIdx || t.index === fromIdx + 1)) return null;
  }
  const next = applyDrop(slice, drag.sourceType, t);
  return next === slice ? null : next.arrange;
}

module.exports = {
  MIN_PANEL_H, EDGE_W, DETAIL_MIN_ROWS, detailMinPct, detailMaxPct,
  allFreeConfigPanels, selectedIdx,
  snapshot, undo, redo, clearUndoStacks, pushUndo: _pushUndoSlice,
  columnTotalH, freezeColumnFlex, panelHeightPct,
  navSelect, reorderWithin, moveColumn, resizeWidthOrDetail, resizeFocusedPanelHeight,
  clampSelected, titleEnter, setSelectedTitle,
  pointToResizeTarget, pointToDropTarget, pointToCellZone, panelAt,
  mousePress, mouseMotion, mouseRelease,
  computeDragPreviewArrange,
  validateNewColumn, applyNewColumn,
  addColumn, removeColumn,
  allocateNewColumnWidth: _allocateNewColumnWidth,
  reassignHotkeys: _reassignHotkeys,
  _columnRanges, _newColumnZoneAt,
};
