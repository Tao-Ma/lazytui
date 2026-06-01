/**
 * Pure design-mode layout transforms — the reducer-owned half of design.js.
 *
 * Like leaves/search / leaves/tabs / leaves/register, this is a dependency-free
 * leaf the layout Component imports without a require cycle (design.js
 * requires runtime + term + ansi, so the reducer can't call into it). Every
 * function takes the layout Component slice, returns a new slice (or the
 * same ref when the operation is a no-op). No I/O, no globals, no terminal
 * reads. The one bit of terminal state the reducer can't synthesize — the
 * current terminal width — is threaded in as `COLS` by the caller for the
 * hit-tests; `model.modes.freeConfigMode` is the one read of the chrome flag,
 * threaded in as `model` for mousePress's defensive guard.
 *
 * Slice shape touched:
 *   - slice.arrange.{leftWidth, detailHeightPct, leftPanels, rightPanels}
 *   - slice.dirty (set true on any change that should round-trip to YAML)
 *   - slice.design.{undo, redo, titleEdit, drag}
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

const MIN_PANEL_H = 3;
const DETAIL_MIN_PCT = 20;
const DETAIL_MAX_PCT = 90;
const MAX_UNDO = 50;

// ---------------------------------------------------------------- pure reads

function allDesignPanels(slice) {
  return [...slice.arrange.leftPanels, ...slice.arrange.rightPanels];
}

// Snapshots are JSON round-trips of the arrange struct — plain data
// (documented: no functions / Symbols / circular refs in panel config), so
// the stacks live happily on the slice. Session-scoped: cleared on
// design_enter.
function snapshot(arrange) {
  return JSON.parse(JSON.stringify(arrange));
}

function _applySnapshot(arrange, snap) {
  return {
    ...arrange,
    leftWidth: snap.leftWidth,
    detailHeightPct: snap.detailHeightPct,
    leftPanels: snap.leftPanels,
    rightPanels: snap.rightPanels,
  };
}

function columnTotalH(slice, column) {
  const panels = column === 'left' ? slice.arrange.leftPanels : slice.arrange.rightPanels;
  let total = 0;
  for (const p of panels) {
    const b = slice.panelBounds[p.type];
    if (b) total += b.h;
  }
  return total;
}

function panelHeightPct(slice, p, availH) {
  if (p.type === 'detail') return slice.arrange.detailHeightPct;
  if (typeof p.heightPct === 'number') return p.heightPct;
  const b = slice.panelBounds[p.type];
  return b ? Math.round(b.h / availH * 100) : 0;
}

function _reassignHotkeys(arrange) {
  return {
    ...arrange,
    leftPanels: arrange.leftPanels.map((p, i) => ({ ...p, hotkey: String(i + 1) })),
    rightPanels: arrange.rightPanels.map(p =>
      p.type === 'actions' ? { ...p, hotkey: '0' }
      : p.type === 'detail' ? { ...p, hotkey: 'o' }
      : { ...p, hotkey: '' }
    ),
  };
}

// ---------------------------------------------------------------- undo / redo

function _pushUndoSlice(slice) {
  const d = slice.design;
  let undo = [...d.undo, snapshot(slice.arrange)];
  if (undo.length > MAX_UNDO) undo = undo.slice(undo.length - MAX_UNDO);
  return { ...slice, design: { ...d, undo, redo: [] } };
}

function undo(slice) {
  const d = slice.design;
  if (d.undo.length === 0) return slice;
  const snap = d.undo[d.undo.length - 1];
  return {
    ...slice,
    arrange: _applySnapshot(slice.arrange, snap),
    design: {
      ...d,
      undo: d.undo.slice(0, -1),
      redo: [...d.redo, snapshot(slice.arrange)],
    },
    dirty: true,
  };
}

function redo(slice) {
  const d = slice.design;
  if (d.redo.length === 0) return slice;
  const snap = d.redo[d.redo.length - 1];
  return {
    ...slice,
    arrange: _applySnapshot(slice.arrange, snap),
    design: {
      ...d,
      redo: d.redo.slice(0, -1),
      undo: [...d.undo, snapshot(slice.arrange)],
    },
    dirty: true,
  };
}

/** Wipe undo/redo (design_enter, and :restore-layout via the design.js shim).
 *  Tolerates the layout slice not existing yet. */
function clearUndoStacks(slice) {
  if (!slice || !slice.design) return slice;
  if (slice.design.undo.length === 0 && slice.design.redo.length === 0) return slice;
  return { ...slice, design: { ...slice.design, undo: [], redo: [] } };
}

// ---------------------------------------------------------------- geometry helpers

/** Anchor any flex panels in `column` (no heightPct, not the active pair, not
 *  detail) at their current rendered height, so a boundary drag steals only
 *  from the neighbor instead of being absorbed proportionally. Returns the
 *  same slice ref when nothing actually freezes. */
function freezeColumnFlex(slice, column, upperType, lowerType, availH) {
  const colKey = column === 'left' ? 'leftPanels' : 'rightPanels';
  let changed = false;
  const newCol = slice.arrange[colKey].map(p => {
    if (p.type === upperType || p.type === lowerType) return p;
    if (p.type === 'detail') return p;
    if (typeof p.heightPct === 'number') return p;
    const b = slice.panelBounds[p.type];
    if (!b) return p;
    changed = true;
    return { ...p, heightPct: Math.round((b.h / availH) * 100) };
  });
  if (!changed) return slice;
  return { ...slice, arrange: { ...slice.arrange, [colKey]: newCol } };
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
  const patch = (col) => col.map(p => {
    if (p.type !== panelType) return p;
    if (p.heightPct === pct) return p;
    changed = true;
    return { ...p, heightPct: pct };
  });
  const leftPanels  = patch(slice.arrange.leftPanels);
  const rightPanels = patch(slice.arrange.rightPanels);
  if (!changed) return slice;
  return { ...slice, arrange: { ...slice.arrange, leftPanels, rightPanels } };
}

// ---------------------------------------------------------------- keyboard transforms

/** ↑/↓ — move the selection cursor, clamped to the panel list.
 *  v0.6: also syncs `slice.focus` to the newly selected panel's type
 *  so the runtime focus border tracks the design selection. v0.5
 *  surfaced the selection only in the footer text, leaving the green
 *  border on whatever was focused at mode entry — confusing in
 *  free-config where the user is actively navigating cells. The
 *  focused-panel content stays frozen (freeze gate drops the
 *  show_selected_info Cmd's downstream detail update); design_exit
 *  re-emits show_selected_info to refresh detail on the way out. */
function navSelect(slice, delta) {
  const all = allDesignPanels(slice);
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
  const sel = selectedIdx(slice);
  if (sel < 0) return slice;
  const isLeft = sel < slice.arrange.leftPanels.length;
  const localIdx = isLeft ? sel : sel - slice.arrange.leftPanels.length;
  const colKey = isLeft ? 'leftPanels' : 'rightPanels';
  const column = slice.arrange[colKey];
  const targetIdx = localIdx + delta;
  if (targetIdx < 0 || targetIdx >= column.length) return slice;

  // Right column: detail stays at the end. Refuse any swap that
  // either moves detail off its slot OR moves a non-detail panel
  // past it. Mirrors the validateTarget guard in applyDrop and the
  // insert-before-detail logic in pool_show — same invariant, three
  // entry points, one rule.
  if (!isLeft) {
    if (column[localIdx].type === 'detail' || column[targetIdx].type === 'detail') {
      return slice;
    }
  }

  const newCol = column.slice();
  [newCol[localIdx], newCol[targetIdx]] = [newCol[targetIdx], newCol[localIdx]];

  let next = _pushUndoSlice(slice);
  // focus stays — same TYPE, new position. selectedIdx() will derive
  // the new index from focus + the new arrangement on next read.
  next = {
    ...next,
    arrange: _reassignHotkeys({ ...slice.arrange, [colKey]: newCol }),
    dirty: true,
  };
  return next;
}

/** ←/→ — move the focused panel between columns. */
function moveColumn(slice, col) {
  const sel = selectedIdx(slice);
  const all = allDesignPanels(slice);
  const selPanel = all[sel];
  if (!selPanel) return slice;
  const isLeft = sel < slice.arrange.leftPanels.length;
  const localIdx = isLeft ? sel : sel - slice.arrange.leftPanels.length;

  // focus stays at the same type across the move — selectedIdx()
  // derives the new index from the rearranged columns automatically.
  if (col === 'left') {
    if (isLeft) return slice;
    if (selPanel.type === 'detail' || selPanel.type === 'actions') return slice;
    if (slice.arrange.leftPanels.length >= 6) return slice;

    const newRight = slice.arrange.rightPanels.slice();
    newRight.splice(localIdx, 1);
    const newLeft = [...slice.arrange.leftPanels, { ...selPanel, column: 'left' }];

    let next = _pushUndoSlice(slice);
    next = {
      ...next,
      arrange: _reassignHotkeys({ ...slice.arrange, leftPanels: newLeft, rightPanels: newRight }),
      dirty: true,
    };
    return next;
  }

  // col === 'right'
  if (!isLeft) return slice;
  if (slice.arrange.rightPanels.length >= 3) return slice;

  const newLeft = slice.arrange.leftPanels.slice();
  newLeft.splice(localIdx, 1);
  const detailIdx = slice.arrange.rightPanels.findIndex(p => p.type === 'detail');
  const insertAt = detailIdx >= 0 ? detailIdx : slice.arrange.rightPanels.length;
  const newRight = slice.arrange.rightPanels.slice();
  newRight.splice(insertAt, 0, { ...selPanel, column: 'right', hotkey: '' });

  let next = _pushUndoSlice(slice);
  next = {
    ...next,
    arrange: _reassignHotkeys({ ...slice.arrange, leftPanels: newLeft, rightPanels: newRight }),
    dirty: true,
  };
  return next;
}

/** +/- — detail selected: grow/shrink detailHeightPct by 5 (clamped [20,90]);
 *  else a left panel selected: grow/shrink leftWidth by 2 (clamped [20,60]). */
function resizeWidthOrDetail(slice, sign) {
  const sel = selectedIdx(slice);
  const all = allDesignPanels(slice);
  const selPanel = all[sel];
  if (!selPanel) return slice;
  const isLeft = sel < slice.arrange.leftPanels.length;

  let newDetail = slice.arrange.detailHeightPct;
  let newLeftW  = slice.arrange.leftWidth;

  if (sign > 0) {
    if (selPanel.type === 'detail' && slice.arrange.detailHeightPct < 90) {
      newDetail = Math.min(90, slice.arrange.detailHeightPct + 5);
    } else if (isLeft && slice.arrange.leftWidth < 60) {
      newLeftW = Math.min(60, slice.arrange.leftWidth + 2);
    } else return slice;
  } else {
    if (selPanel.type === 'detail' && slice.arrange.detailHeightPct > 20) {
      newDetail = Math.max(20, slice.arrange.detailHeightPct - 5);
    } else if (isLeft && slice.arrange.leftWidth > 20) {
      newLeftW = Math.max(20, slice.arrange.leftWidth - 2);
    } else return slice;
  }

  let next = _pushUndoSlice(slice);
  next = {
    ...next,
    arrange: { ...slice.arrange, detailHeightPct: newDetail, leftWidth: newLeftW },
    dirty: true,
  };
  return next;
}

/** ] / [ — grow/shrink the focused panel's heightPct by Δ, stealing from the
 *  panel below in the same column (D1 semantics). No-op on detail / last row. */
function resizeFocusedPanelHeight(slice, deltaPct) {
  const selIdx = selectedIdx(slice);
  const all = allDesignPanels(slice);
  const sel = all[selIdx];
  if (!sel || sel.type === 'detail') return slice;  // detail uses +/-

  const isLeft = selIdx < slice.arrange.leftPanels.length;
  const column = isLeft ? slice.arrange.leftPanels : slice.arrange.rightPanels;
  const colName = isLeft ? 'left' : 'right';
  const idxInCol = column.indexOf(sel);
  if (idxInCol < 0 || idxInCol === column.length - 1) return slice;  // no neighbor below
  const nextPanel = column[idxInCol + 1];

  const availH = columnTotalH(slice, colName);
  if (availH < 6) return slice;

  const frozen = freezeColumnFlex(slice, colName, sel.type, nextPanel.type, availH);

  const selCur  = panelHeightPct(frozen, sel, availH);
  const nextCur = panelHeightPct(frozen, nextPanel, availH);
  const combined = selCur + nextCur;

  const rowsToPct = (rows) => Math.max(1, Math.ceil(rows / availH * 100));
  const minPct = (p) => p.type === 'detail' ? DETAIL_MIN_PCT : rowsToPct(MIN_PANEL_H);
  const maxPct = (p) => p.type === 'detail' ? DETAIL_MAX_PCT : 100;

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

/** Derive the design-mode cursor index from `slice.focus`. Returns
 *  -1 if the focused type isn't in the placed set (caller should
 *  clampSelected to recover). Replaces the pre-v0.6.x `selectedIdx`
 *  slice field — focus is the single source of truth for the active
 *  panel in free-config; the index is just an arithmetic convenience. */
function selectedIdx(slice) {
  return allDesignPanels(slice).findIndex(p => p.type === slice.focus);
}

/** Safety clamp after any mutation that can change the panel count.
 *  v0.6 invariant: `slice.focus` is the cursor truth — when a layout-
 *  shape change (undo/redo, applyDrop, pool_hide/show) leaves focus
 *  pointing at a panel that's no longer placed, snap it to whatever
 *  ends up at the same index, or to preferredType if supplied. */
function clampSelected(slice, preferredType) {
  const all = allDesignPanels(slice);
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
  const d = slice.design;
  if (!d) return slice;
  const all = allDesignPanels(slice);
  const p = all[selectedIdx(slice)];
  if (!p) return slice;
  return { ...slice, design: { ...d, titleEdit: { active: true, text: p.title || '' } } };
}

/** Commit a non-empty, changed title to the focused panel (pushes one undo). */
function setSelectedTitle(slice, text) {
  const d = slice.design;
  if (!d) return slice;
  const all = allDesignPanels(slice);
  const p = all[selectedIdx(slice)];
  if (!p || text.length === 0 || text === p.title) return slice;

  let next = _pushUndoSlice(slice);
  const patch = (col) => col.map(x => x.type === p.type ? { ...x, title: text } : x);
  next = {
    ...next,
    arrange: {
      ...next.arrange,
      leftPanels:  patch(next.arrange.leftPanels),
      rightPanels: patch(next.arrange.rightPanels),
    },
    dirty: true,
  };
  return next;
}

// ---------------------------------------------------------------- mouse hit-tests

/**
 * Hit-test a point against draggable separators. Returns `{ edge, boundary?,
 * column? }` or null. Edges: 'corner' (col-sep × a column boundary, both axes),
 * 'col' (col-sep only), 'right-boundary' / 'left-boundary' (a horizontal seam
 * between two stacked panels). ±1 tolerance on both axes; right-col wins ties.
 */
function pointToResizeTarget(slice, mx, my, COLS) {
  const leftW = slice.arrange.leftWidth;
  const colMatch = Math.abs(mx - leftW) <= 1;
  const rightB = boundaryNear(slice, slice.arrange.rightPanels, my);
  const leftB  = boundaryNear(slice, slice.arrange.leftPanels,  my);
  if (colMatch && rightB) return { edge: 'corner', boundary: rightB, column: 'right' };
  if (colMatch && leftB)  return { edge: 'corner', boundary: leftB,  column: 'left'  };
  if (colMatch)            return { edge: 'col' };
  if (rightB && mx > leftW + 1 && mx < COLS) return { edge: 'right-boundary', boundary: rightB };
  if (leftB && mx >= 0 && mx < leftW)        return { edge: 'left-boundary', boundary: leftB };
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
  for (const p of allDesignPanels(slice)) {
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
 * Returns a tagged target — `{ kind:'insert', column, index, valid, reason? }`
 * or `{ kind:'swap', column, index, occupantType, valid, reason? }` — or null
 * when the point isn't in any column.
 */
function pointToDropTarget(slice, srcType, mx, my, COLS) {
  const leftPanels = slice.arrange.leftPanels;
  const rightPanels = slice.arrange.rightPanels;
  const leftW = slice.arrange.leftWidth;
  const inLeft = matchColumn(slice, leftPanels, mx, my);
  if (inLeft !== null) return validateTarget(slice, srcType, 'left', inLeft);
  const inRight = matchColumn(slice, rightPanels, mx, my);
  if (inRight !== null) return validateTarget(slice, srcType, 'right', inRight);
  if (mx >= 0 && mx < leftW && leftPanels.length === 0) {
    return validateTarget(slice, srcType, 'left', { kind: 'insert', index: 0 });
  }
  if (mx >= leftW && mx < COLS && rightPanels.length === 0) {
    return validateTarget(slice, srcType, 'right', { kind: 'insert', index: 0 });
  }
  return null;
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

function validateTarget(slice, srcType, column, target) {
  if (target.kind === 'swap') {
    const occType = target.occupantType;
    const base = { kind: 'swap', column, index: target.index, occupantType: occType };
    // Self-swap (source == occupant) is always a valid no-op — mouseRelease
    // detects it and skips applyDrop, so nothing moves. Marking it invalid
    // would show a misleading "✗ blocked" footer when the user releases a
    // drag onto its own middle third (release does nothing in either case).
    if (occType === srcType) return { ...base, valid: true };
    const fromCol = slice.arrange.leftPanels.some(p => p.type === srcType) ? 'left' : 'right';
    // Dragged panel ends up in `column` — detail/actions can't live in left.
    if (column === 'left' && (srcType === 'detail' || srcType === 'actions')) {
      return { ...base, valid: false, reason: `${srcType} can't live in left column` };
    }
    // Occupant ends up in source's column — same rule going the other way.
    if (fromCol === 'left' && (occType === 'detail' || occType === 'actions')) {
      return { ...base, valid: false, reason: `${occType} can't live in left column` };
    }
    // Right column keeps detail at the end. Any swap involving detail in the
    // right column would move it off the tail.
    if (column === 'right' && occType === 'detail') {
      return { ...base, valid: false, reason: `detail must stay at end` };
    }
    if (fromCol === 'right' && srcType === 'detail') {
      return { ...base, valid: false, reason: `detail must stay at end` };
    }
    return { ...base, valid: true };
  }
  // insert
  const index = target.index;
  if (column === 'left' && (srcType === 'detail' || srcType === 'actions')) {
    return { kind: 'insert', column, index, valid: false, reason: `${srcType} can't live in left column` };
  }
  // Right column: detail stays at the end (same convention pool_show
  // follows). Clamp any drop AFTER detail to detail's slot — applyInsert
  // handles the splice-shift for same-column moves, so the clamp uses
  // the pre-removal detailIdx; an earlier version pre-decremented for
  // same-column source and applyInsert decremented again, leaving
  // same-column right-to-past-detail drags as silent no-ops.
  if (column === 'right' && srcType !== 'detail') {
    const rightPanels = slice.arrange.rightPanels;
    const detailIdx = rightPanels.findIndex(p => p.type === 'detail');
    if (detailIdx >= 0 && index > detailIdx) {
      return { kind: 'insert', column, index: detailIdx, valid: true };
    }
  }
  return { kind: 'insert', column, index, valid: true };
}

// ---------------------------------------------------------------- mouse state machine

/** Column-separator drag: leftWidth follows cursor, clamped [20, 60]. */
function applyColResize(slice, mx) {
  const newW = Math.max(20, Math.min(60, mx + 1));
  if (newW === slice.arrange.leftWidth) return slice;
  return { ...slice, arrange: { ...slice.arrange, leftWidth: newW }, dirty: true };
}

/** Within-column boundary drag: redistributes height between the two panels
 *  captured at press (D1 — steal from neighbor only). A detail side writes
 *  detailHeightPct clamped [20, 90]; the neighbor takes the complement. */
function applyBoundaryResize(slice, my) {
  const d = slice.design;
  const ds = d && d.drag;
  if (!ds) return slice;
  let upperH = Math.max(MIN_PANEL_H, Math.min(ds.combinedH - MIN_PANEL_H, my - ds.upperStartY));
  let lowerH = ds.combinedH - upperH;

  if (ds.detailIsUpper) {
    const minH = Math.max(MIN_PANEL_H, Math.floor(ds.availH * DETAIL_MIN_PCT / 100));
    const maxH = Math.min(ds.combinedH - MIN_PANEL_H, Math.floor(ds.availH * DETAIL_MAX_PCT / 100));
    upperH = Math.max(minH, Math.min(maxH, upperH));
    lowerH = ds.combinedH - upperH;
  } else if (ds.detailIsLower) {
    const minH = Math.max(MIN_PANEL_H, Math.floor(ds.availH * DETAIL_MIN_PCT / 100));
    const maxH = Math.min(ds.combinedH - MIN_PANEL_H, Math.floor(ds.availH * DETAIL_MAX_PCT / 100));
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

/** Apply a drop target — insert (splice + insert at slot) or swap (trade
 *  slots with occupant). Re-derives hotkeys positionally; marks dirty. */
function applyDrop(slice, srcType, target) {
  if (target.kind === 'swap') return applySwap(slice, srcType, target);
  return applyInsert(slice, srcType, target);
}

function applyInsert(slice, srcType, target) {
  const leftPanels = slice.arrange.leftPanels;
  const rightPanels = slice.arrange.rightPanels;

  let src = null, fromCol = null, fromIdx = -1;
  for (let i = 0; i < leftPanels.length; i++) {
    if (leftPanels[i].type === srcType) { src = leftPanels[i]; fromCol = 'left'; fromIdx = i; break; }
  }
  if (!src) {
    for (let i = 0; i < rightPanels.length; i++) {
      if (rightPanels[i].type === srcType) { src = rightPanels[i]; fromCol = 'right'; fromIdx = i; break; }
    }
  }
  if (!src) return slice;

  const newLeft = leftPanels.slice();
  const newRight = rightPanels.slice();
  if (fromCol === 'left') newLeft.splice(fromIdx, 1);
  else newRight.splice(fromIdx, 1);

  let insertAt = target.index;
  if (fromCol === target.column && fromIdx < insertAt) insertAt--;

  const newSrc = { ...src, column: target.column };
  if (target.column === 'left') newLeft.splice(insertAt, 0, newSrc);
  else newRight.splice(insertAt, 0, newSrc);

  return {
    ...slice,
    arrange: _reassignHotkeys({ ...slice.arrange, leftPanels: newLeft, rightPanels: newRight }),
    dirty: true,
  };
}

/** Swap source ↔ occupant by slot. Same-column = two writes to the same
 *  array; cross-column = one write to each. Self-swap (source = occupant)
 *  is a no-op (returns slice unchanged). Hotkeys re-derive positionally,
 *  so a panel's letter follows its slot, not its identity — same convention
 *  as applyInsert. */
function applySwap(slice, srcType, target) {
  const leftPanels = slice.arrange.leftPanels;
  const rightPanels = slice.arrange.rightPanels;

  let src = null, fromCol = null, fromIdx = -1;
  for (let i = 0; i < leftPanels.length; i++) {
    if (leftPanels[i].type === srcType) { src = leftPanels[i]; fromCol = 'left'; fromIdx = i; break; }
  }
  if (!src) {
    for (let i = 0; i < rightPanels.length; i++) {
      if (rightPanels[i].type === srcType) { src = rightPanels[i]; fromCol = 'right'; fromIdx = i; break; }
    }
  }
  if (!src) return slice;

  const toCol = target.column;
  const toIdx = target.index;
  const toPanels = toCol === 'left' ? leftPanels : rightPanels;
  const occ = toPanels[toIdx];
  if (!occ) return slice;
  if (fromCol === toCol && fromIdx === toIdx) return slice;

  const newLeft = leftPanels.slice();
  const newRight = rightPanels.slice();
  const newSrc = { ...src, column: toCol };
  const newOcc = { ...occ, column: fromCol };

  if (toCol   === 'left') newLeft[toIdx]   = newSrc; else newRight[toIdx]   = newSrc;
  if (fromCol === 'left') newLeft[fromIdx] = newOcc; else newRight[fromIdx] = newOcc;

  return {
    ...slice,
    arrange: _reassignHotkeys({ ...slice.arrange, leftPanels: newLeft, rightPanels: newRight }),
    dirty: true,
  };
}

/** Press: resize hit-test FIRST (a seam sits on a panel border), else arm a
 *  panel drag + move the keyboard selection to the clicked panel. Callers
 *  already gate on `freeConfigMode` (input.js handleMouse only dispatches
 *  `design_mouse_press` when the mode is active), so the leaf no longer
 *  needs the model to re-check — drops the `model` arg. */
function mousePress(slice, mx, my, COLS) {
  const resize = pointToResizeTarget(slice, mx, my, COLS);
  if (resize) {
    let next = _pushUndoSlice(slice);
    const ds = { kind: `resizing-${resize.edge}` };
    if (resize.edge === 'left-boundary' || resize.edge === 'right-boundary' || resize.edge === 'corner') {
      const column = resize.column || (resize.edge === 'left-boundary' ? 'left' : 'right');
      const b = resize.boundary;
      ds.column = column;
      ds.upperType = b.upper.type;
      ds.lowerType = b.lower.type;
      ds.upperStartY = slice.panelBounds[b.upper.type].y;
      ds.combinedH = slice.panelBounds[b.upper.type].h + slice.panelBounds[b.lower.type].h;
      ds.availH = columnTotalH(slice, column);
      if (ds.availH < 1) ds.availH = 1;
      ds.detailIsUpper = b.upper.type === 'detail';
      ds.detailIsLower = b.lower.type === 'detail';
      next = freezeColumnFlex(next, column, b.upper.type, b.lower.type, ds.availH);
    }
    return { ...next, design: { ...next.design, drag: ds } };
  }
  const hit = panelAt(slice, mx, my);
  if (!hit) return { ...slice, design: { ...slice.design, drag: null } };
  // Click sets focus to the panel under the cursor — green border
  // tracks the click even if the user doesn't go on to drag.
  // selectedIdx() derives from focus.
  const drag = { kind: 'armed', sourceType: hit, startX: mx, startY: my, curX: mx, curY: my, target: null };
  return { ...slice, focus: hit, design: { ...slice.design, drag } };
}

/** Motion: resize kinds redistribute heights; a panel drag promotes
 *  armed→dragging after ≥1 cell and recomputes the drop target. */
function mouseMotion(slice, mx, my, COLS) {
  const d = slice.design;
  const ds = d && d.drag;
  if (!ds) return slice;
  if (ds.kind === 'resizing-col')        return applyColResize(slice, mx);
  if (ds.kind === 'resizing-left-boundary' || ds.kind === 'resizing-right-boundary') {
    return applyBoundaryResize(slice, my);
  }
  if (ds.kind === 'resizing-corner') {
    return applyBoundaryResize(applyColResize(slice, mx), my);
  }
  // panel drag (armed → dragging)
  let nextKind = ds.kind;
  if (ds.kind === 'armed') {
    if (mx === ds.startX && my === ds.startY) {
      // movement-free motion still updates the cursor record so a later release
      // can read it; old code mutated curX/curY before the early return.
      return { ...slice, design: { ...d, drag: { ...ds, curX: mx, curY: my } } };
    }
    nextKind = 'dragging';
  }
  const target = pointToDropTarget(slice, ds.sourceType, mx, my, COLS);
  return { ...slice, design: { ...d, drag: { ...ds, kind: nextKind, curX: mx, curY: my, target } } };
}

/** Release: commit a valid drop (push undo + applyDrop), then clear the drag.
 *  Drop calls clampSelected with the dropped panel's type so focus
 *  lands there — its type stayed the same; its position is new, and
 *  selectedIdx() derives the new index from the rearranged columns. */
function mouseRelease(slice) {
  const d = slice.design;
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
  next = { ...next, design: { ...next.design, drag: null } };
  if (droppedType) next = clampSelected(next, droppedType);
  return next;
}

// v0.6 Phase 5 pool drag (poolDragStart / poolDragMotion / poolDragRelease /
// pointToPoolDropTarget) lives in leaves/design-pool-drag — separate gesture
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
  const drag = slice.design && slice.design.drag;
  if (!drag || drag.kind !== 'dragging') return null;
  if (!drag.target || !drag.target.valid) return null;
  const t = drag.target;
  if (t.kind === 'swap' && t.occupantType === drag.sourceType) return null;
  const next = applyDrop(slice, drag.sourceType, t);
  return next === slice ? null : next.arrange;
}

module.exports = {
  MIN_PANEL_H, DETAIL_MIN_PCT, DETAIL_MAX_PCT,
  allDesignPanels, selectedIdx,
  snapshot, undo, redo, clearUndoStacks,
  columnTotalH, freezeColumnFlex, panelHeightPct,
  navSelect, reorderWithin, moveColumn, resizeWidthOrDetail, resizeFocusedPanelHeight,
  clampSelected, titleEnter, setSelectedTitle,
  pointToResizeTarget, pointToDropTarget, pointToCellZone, panelAt,
  mousePress, mouseMotion, mouseRelease,
  computeDragPreviewArrange,
};
