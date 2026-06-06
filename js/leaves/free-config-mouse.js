/**
 * Free-config mouse-gesture half — column-separator / panel-boundary
 * drag, in-grid pane drag (insert / swap / spawn-new-column), and
 * the pure hit-tests / validators that feed them.
 *
 * v0.6.3 E2 split this out of `leaves/free-config.js` so the mouse
 * half lives as a sibling of the keyboard half. Both halves share
 * `leaves/free-config-core.js` for constants, undo plumbing, focus
 * helpers, and the new-column width allocator.
 *
 * Drag state machine lives on `slice.freeConfig.drag`; the panel/
 * layout reducer routes `free_config_mouse_*` Msgs into these
 * transforms. Render-side preview reads `computeDragPreviewArrange`
 * via the layout free-config-view facade.
 *
 * State machine kinds (`drag.kind`):
 *   - 'resizing-col'             — column-separator drag
 *   - 'resizing-panel-boundary'  — within-column boundary drag
 *   - 'resizing-corner'          — both axes (col + panel-boundary)
 *   - 'dragging'                 — in-grid pane drag (insert/swap/spawn)
 *
 * Zero deps beyond `./pool` and `./free-config-core`.
 */
'use strict';

const mpool = require('./pool');
const core = require('./free-config-core');
const {
  MIN_PANEL_H, EDGE_W,
  detailMinPct, detailMaxPct,
  pushUndo, freezeColumnFlex, setPanelHeightPct,
  columnTotalH,
  reassignHotkeys,
  clampSelected,
  allocateNewColumnWidth, spliceAndReleaseWidth,
} = core;

// ---------------------------------------------------------------- column geometry

/** Find the column whose x-range contains `mx`, or null. */
function _columnAtX(arrange, mx, COLS) {
  for (const r of mpool.distributeColumnWidths(arrange, COLS)) {
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
  const ranges = mpool.distributeColumnWidths(arrange, COLS);
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
function newColumnZoneAt(arrange, mx, COLS) {
  // Out-of-bounds left (negative mx from terminal events that fired
  // after a resize / past the edge): the cursor is OFF the layout, not
  // in a left-edge spawn zone. Same symmetric defense as pool drag's
  // `if (mx < 0 || my < 0) return null;` at pointToPoolDropTarget.
  if (mx < 0) return null;
  if (mx < EDGE_W) return { position: 0 };
  const ranges = mpool.distributeColumnWidths(arrange, COLS);
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
  for (const p of mpool.allPanesInColumns(slice.arrange)) {
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
  const ncz = newColumnZoneAt(slice.arrange, mx, COLS);
  if (ncz) return validateNewColumn(slice, srcType, ncz.position);
  const ranges = mpool.distributeColumnWidths(slice.arrange, COLS);
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
    next = setPanelHeightPct(next, 'detail', upperPct);
    next = setPanelHeightPct(next, ds.lowerType, lowerPct);
  } else if (ds.detailIsLower) {
    next = setPanelHeightPct(next, 'detail', lowerPct);
    next = setPanelHeightPct(next, ds.upperType, upperPct);
  } else {
    next = setPanelHeightPct(next, ds.upperType, upperPct);
    next = setPanelHeightPct(next, ds.lowerType, lowerPct);
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
    workingColumns = spliceAndReleaseWidth(workingColumns, fromLoc.columnIndex);
    if (fromLoc.columnIndex < position) effectivePosition = position - 1;
  }

  const { columns: shrunk, newColWidth } =
    allocateNewColumnWidth(workingColumns, effectivePosition);
  // columnIndex re-stamped by _reassignHotkeys after the splice.
  const newCol = { width: newColWidth, panels: [{ ...src, columnIndex: -1 }] };
  shrunk.splice(effectivePosition, 0, newCol);

  return {
    ...slice,
    arrange: reassignHotkeys({ ...arrange, columns: shrunk }),
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
      const releasedColumns = spliceAndReleaseWidth(nextArrange.columns, fromCol);
      nextArrange = { ...nextArrange, columns: releasedColumns };
    }
  }

  return {
    ...slice,
    arrange: reassignHotkeys(nextArrange),
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
    arrange: reassignHotkeys(nextArrange),
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
    let next = pushUndo(slice);
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
  const drag = { kind: 'dragging', sourceType: hit, startX: mx, startY: my, curX: mx, curY: my, target: null };
  return { ...slice, focus: hit, freeConfig: { ...slice.freeConfig, drag } };
}

/** Motion: resize kinds redistribute heights; a panel drag recomputes
 *  the drop target. The 'armed' kind was retired (AR4): mousePress now
 *  sets `kind: 'dragging'` directly with target=null, and a movement-
 *  free motion is detected by the (mx, my) === (startX, startY) check
 *  rather than a separate state. Release/preview already short-circuit
 *  on `!target.valid`. */
function mouseMotion(slice, mx, my, COLS) {
  const d = slice.freeConfig;
  const ds = d && d.drag;
  if (!ds) return slice;
  if (ds.kind === 'resizing-col')            return applyColResize(slice, mx);
  if (ds.kind === 'resizing-panel-boundary') return applyBoundaryResize(slice, my);
  if (ds.kind === 'resizing-corner')         return applyBoundaryResize(applyColResize(slice, mx), my);
  if (ds.kind !== 'dragging') return slice;
  if (mx === ds.startX && my === ds.startY) {
    // No movement — keep the cursor record without recomputing target.
    return { ...slice, freeConfig: { ...d, drag: { ...ds, curX: mx, curY: my } } };
  }
  const target = pointToDropTarget(slice, ds.sourceType, mx, my, COLS);
  return { ...slice, freeConfig: { ...d, drag: { ...ds, curX: mx, curY: my, target } } };
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
      next = pushUndo(next);
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
  // column geometry
  newColumnZoneAt,
  // hit-tests
  pointToResizeTarget, pointToDropTarget, pointToCellZone,
  // validators
  validateNewColumn, validateTarget,
  // drop apply
  applyDrop, applyNewColumn, applyInsert, applySwap,
  // state machine
  mousePress, mouseMotion, mouseRelease,
  // preview
  computeDragPreviewArrange,
};
