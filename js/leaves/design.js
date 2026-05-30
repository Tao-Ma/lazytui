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
 *   - slice.design.{selectedIdx, undo, redo, titleEdit, drag}
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
  const d = slice.design;
  const all = allDesignPanels(slice);
  let idx = d.selectedIdx;
  if (delta < 0) { if (idx > 0) idx--; }
  else           { if (idx < all.length - 1) idx++; }
  if (idx === d.selectedIdx) return slice;
  const focus = all[idx] ? all[idx].type : slice.focus;
  return { ...slice, focus, design: { ...d, selectedIdx: idx } };
}

/** J/K — reorder the focused panel within its column (delta ±1). */
function reorderWithin(slice, delta) {
  const d = slice.design;
  const sel = d.selectedIdx;
  const isLeft = sel < slice.arrange.leftPanels.length;
  const localIdx = isLeft ? sel : sel - slice.arrange.leftPanels.length;
  const colKey = isLeft ? 'leftPanels' : 'rightPanels';
  const column = slice.arrange[colKey];
  const targetIdx = localIdx + delta;
  if (targetIdx < 0 || targetIdx >= column.length) return slice;

  const newCol = column.slice();
  [newCol[localIdx], newCol[targetIdx]] = [newCol[targetIdx], newCol[localIdx]];

  let next = _pushUndoSlice(slice);
  next = {
    ...next,
    arrange: _reassignHotkeys({ ...slice.arrange, [colKey]: newCol }),
    design: { ...next.design, selectedIdx: sel + delta },
    dirty: true,
  };
  return next;
}

/** ←/→ — move the focused panel between columns. */
function moveColumn(slice, col) {
  const d = slice.design;
  const sel = d.selectedIdx;
  const all = allDesignPanels(slice);
  const selPanel = all[sel];
  if (!selPanel) return slice;
  const isLeft = sel < slice.arrange.leftPanels.length;
  const localIdx = isLeft ? sel : sel - slice.arrange.leftPanels.length;

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
      design: { ...next.design, selectedIdx: newLeft.length - 1 },
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
    design: { ...next.design, selectedIdx: newLeft.length + insertAt },
    dirty: true,
  };
  return next;
}

/** +/- — detail selected: grow/shrink detailHeightPct by 5 (clamped [20,90]);
 *  else a left panel selected: grow/shrink leftWidth by 2 (clamped [20,60]). */
function resizeWidthOrDetail(slice, sign) {
  const d = slice.design;
  const all = allDesignPanels(slice);
  const selPanel = all[d.selectedIdx];
  if (!selPanel) return slice;
  const isLeft = d.selectedIdx < slice.arrange.leftPanels.length;

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
  const d = slice.design;
  const all = allDesignPanels(slice);
  const sel = all[d.selectedIdx];
  if (!sel || sel.type === 'detail') return slice;  // detail uses +/-

  const isLeft = d.selectedIdx < slice.arrange.leftPanels.length;
  const column = isLeft ? slice.arrange.leftPanels : slice.arrange.rightPanels;
  const colName = isLeft ? 'left' : 'right';
  const idx = column.indexOf(sel);
  if (idx < 0 || idx === column.length - 1) return slice;  // no neighbor below
  const nextPanel = column[idx + 1];

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

/** Safety clamp after any mutation that can change the panel count.
 *  v0.6 invariant: in free-config the active panel is one well-defined
 *  thing — selectedIdx is the cursor truth, slice.focus follows. This
 *  helper re-establishes the invariant after a layout-shape change
 *  (undo/redo, applyDrop, pool_hide/show).
 *
 *  Resolution order for "which panel index is active now":
 *    1. preferredType (when supplied — e.g. the panel just dropped)
 *    2. the current selectedIdx, clamped into [0, all.length-1]
 *  Then `slice.focus = all[idx].type` always, so focus reflects
 *  whatever panel ended up at the chosen index. */
function clampSelected(slice, preferredType) {
  const d = slice.design;
  const all = allDesignPanels(slice);
  if (all.length === 0) return slice;
  let idx = -1;
  if (preferredType) idx = all.findIndex(p => p.type === preferredType);
  if (idx < 0) {
    idx = d.selectedIdx;
    if (idx >= all.length) idx = all.length - 1;
    if (idx < 0) idx = 0;
  }
  const focus = all[idx].type;
  if (idx === d.selectedIdx && focus === slice.focus) return slice;
  return { ...slice, focus, design: { ...d, selectedIdx: idx } };
}

// ---------------------------------------------------------------- title edit

/** Seed the title-edit buffer from the focused panel's current title. */
function titleEnter(slice) {
  const d = slice.design;
  if (!d) return slice;
  const all = allDesignPanels(slice);
  const p = all[d.selectedIdx];
  if (!p) return slice;
  return { ...slice, design: { ...d, titleEdit: { active: true, text: p.title || '' } } };
}

/** Commit a non-empty, changed title to the focused panel (pushes one undo). */
function setSelectedTitle(slice, text) {
  const d = slice.design;
  if (!d) return slice;
  const all = allDesignPanels(slice);
  const p = all[d.selectedIdx];
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
 * Resolve a screen point to a drop target — `{ column, index, valid, reason? }`
 * or null. Top half → before, bottom half → after, below last → append, empty
 * column → index 0, detail/actions in left column → invalid.
 */
function pointToDropTarget(slice, srcType, mx, my, COLS) {
  const leftPanels = slice.arrange.leftPanels;
  const rightPanels = slice.arrange.rightPanels;
  const leftW = slice.arrange.leftWidth;
  const inLeft = matchColumn(slice, leftPanels, mx, my);
  if (inLeft !== null) return validateTarget(srcType, 'left', inLeft);
  const inRight = matchColumn(slice, rightPanels, mx, my);
  if (inRight !== null) return validateTarget(srcType, 'right', inRight);
  if (mx >= 0 && mx < leftW && leftPanels.length === 0) return validateTarget(srcType, 'left', 0);
  if (mx >= leftW && mx < COLS && rightPanels.length === 0) return validateTarget(srcType, 'right', 0);
  return null;
}

function matchColumn(slice, panels, mx, my) {
  let anyXMatch = false;
  for (let i = 0; i < panels.length; i++) {
    const b = slice.panelBounds[panels[i].type];
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w) continue;
    anyXMatch = true;
    if (my < b.y) return i;
    if (my < b.y + b.h) return (my < b.y + b.h / 2) ? i : i + 1;
  }
  if (anyXMatch) return panels.length;
  return null;
}

function validateTarget(srcType, column, index) {
  if (column === 'left' && (srcType === 'detail' || srcType === 'actions')) {
    return { column, index, valid: false, reason: `${srcType} can't live in left column` };
  }
  return { column, index, valid: true };
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

/** Splice the source panel out of its column and insert at the target slot;
 *  re-derive hotkeys positionally; mark dirty. */
function applyDrop(slice, srcType, target) {
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

/** Press: resize hit-test FIRST (a seam sits on a panel border), else arm a
 *  panel drag + move the keyboard selection to the clicked panel. */
function mousePress(slice, model, mx, my, COLS) {
  if (!model.modes.freeConfigMode) return slice;
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
  const all = allDesignPanels(slice);
  const idx = all.findIndex(p => p.type === hit);
  const drag = { kind: 'armed', sourceType: hit, startX: mx, startY: my, curX: mx, curY: my, target: null };
  // Sync runtime focus alongside the design selection (same v0.6
  // invariant navSelect maintains for keyboard nav). A click on a
  // cell should move the green border there, even if the user
  // doesn't go on to drag.
  const focus = idx >= 0 ? all[idx].type : slice.focus;
  const designNext = idx >= 0
    ? { ...slice.design, drag, selectedIdx: idx }
    : { ...slice.design, drag };
  return { ...slice, focus, design: designNext };
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
 *  Drop normalizes focus + selectedIdx onto the panel that just landed
 *  (its type stayed the same; its position is new). Without this the
 *  green border would stay on whatever was focused before the drag. */
function mouseRelease(slice) {
  const d = slice.design;
  const ds = d && d.drag;
  if (!ds) return slice;
  let next = slice;
  let droppedType = null;
  if (ds.kind === 'dragging' && ds.target && ds.target.valid) {
    next = _pushUndoSlice(next);
    next = applyDrop(next, ds.sourceType, ds.target);
    droppedType = ds.sourceType;
  }
  next = { ...next, design: { ...next.design, drag: null } };
  if (droppedType) next = clampSelected(next, droppedType);
  return next;
}

// ---------------------------------------------------- v0.6 Phase 5: pool drag
//
// A separate gesture from the existing panel-reorder drag. Source: an item in
// the panel-list overlay (identified by sourceId, not sourceType, since the
// pool can hold multiple panels of the same type). Drop:
//
//   - on an existing cell → REPLACE: occupant returns to pool, source lands
//     in occupant's column at the same position
//   - in a column area but not on any cell → APPEND to that column's tail
//   - outside the layout → cancel
//
// `pool-armed` → `pool-dragging` promotion on any motion (matches the design
// drag pattern). Release returns [next slice, cmds] — cmds are dispatch_msg
// wrappers that re-emit pool_hide/pool_show Msgs back into layout.update so
// the existing handlers (Phase 2) do the actual mutation.

/** Compute the drop target for a pool drag at (mx, my). Returns
 *  `{ kind, column, occupantId?, valid }` or `null` when outside the
 *  layout area. Uses slice.panelBounds (view-derived, written by the
 *  render pass) for cell hit-tests, mirroring the design-drag approach. */
function pointToPoolDropTarget(slice, mx, my) {
  const arrange = slice.arrange;
  for (const p of arrange.leftPanels  || []) {
    const b = slice.panelBounds[p.type];
    if (b && mx >= b.x && mx < b.x + b.w && my >= b.y && my < b.y + b.h) {
      // Refuse replace on detail — layout invariant. The release path
      // converts an invalid replace into a same-column append above
      // the cell, so the gesture isn't a dead-end.
      const valid = p.type !== 'detail';
      return { kind: 'replace', column: 'left', occupantId: p.id, valid };
    }
  }
  for (const p of arrange.rightPanels || []) {
    const b = slice.panelBounds[p.type];
    if (b && mx >= b.x && mx < b.x + b.w && my >= b.y && my < b.y + b.h) {
      const valid = p.type !== 'detail';
      return { kind: 'replace', column: 'right', occupantId: p.id, valid };
    }
  }
  // Not on any cell — pick column by x, append at tail.
  if (mx < 0 || my < 0) return null;
  const leftWidth = arrange.leftWidth || 30;
  const column = mx < leftWidth ? 'left' : 'right';
  return { kind: 'append', column, valid: true };
}

function poolDragStart(slice, sourceId, mx, my) {
  // Close the overlay while dragging so the layout drop targets are
  // visible. The user can still see what they're dragging via the
  // free-config footer ("dragging <title> → <target>"). If the drag
  // is cancelled (drop outside layout), poolDragRelease reopens the
  // overlay so they can try again without pressing `w`.
  const drag = { kind: 'pool-armed', sourceId, startX: mx, startY: my, curX: mx, curY: my, target: null };
  const wasOpen = !!(slice.panelList && slice.panelList.open);
  return {
    ...slice,
    panelList: { ...slice.panelList, open: false, _resumeOnCancel: wasOpen },
    design: { ...slice.design, drag },
  };
}

function poolDragMotion(slice, mx, my) {
  const d = slice.design;
  const ds = d && d.drag;
  if (!ds || (ds.kind !== 'pool-armed' && ds.kind !== 'pool-dragging')) return slice;
  let nextKind = ds.kind;
  if (ds.kind === 'pool-armed') {
    if (mx === ds.startX && my === ds.startY) {
      return { ...slice, design: { ...d, drag: { ...ds, curX: mx, curY: my } } };
    }
    nextKind = 'pool-dragging';
  }
  const target = pointToPoolDropTarget(slice, mx, my);
  return { ...slice, design: { ...d, drag: { ...ds, kind: nextKind, curX: mx, curY: my, target } } };
}

/** Release: returns [next slice, cmds]. Cmds re-emit pool_hide/show Msgs
 *  back into layout.update so the existing Phase 2 handlers do the work
 *  (single source of truth for the mutation). On a valid drop the overlay
 *  stays closed; on cancel (no valid target) the overlay reopens if it
 *  was open at drag-start, so the user can try again without re-pressing
 *  `w`. Clears the `_resumeOnCancel` bookkeeping flag in both cases. */
function poolDragRelease(slice) {
  const d = slice.design;
  const ds = d && d.drag;
  if (!ds || (ds.kind !== 'pool-armed' && ds.kind !== 'pool-dragging')) return [slice, []];
  const resumeOnCancel = !!(slice.panelList && slice.panelList._resumeOnCancel);
  const repaint = { type: 'force_full_repaint' };
  const isValid = ds.kind === 'pool-dragging' && ds.target && ds.target.valid;
  if (!isValid) {
    // Cancel — reopen overlay (if it was open at drag-start) so the user
    // can retry. The repaint covers the drag-state pixel churn.
    const cleared = {
      ...slice,
      panelList: { ...slice.panelList, open: resumeOnCancel, _resumeOnCancel: false },
      design: { ...d, drag: null },
    };
    return [cleared, [repaint]];
  }
  const sourceId = ds.sourceId;
  const t = ds.target;
  const closeOverlay = {
    ...slice,
    panelList: { ...slice.panelList, open: false, _resumeOnCancel: false },
    design: { ...d, drag: null },
  };
  const showCmd = { kind: 'layout', msg: { type: 'pool_show', id: sourceId, column: t.column } };
  if (t.kind === 'replace') {
    const cmds = [
      { type: 'dispatch_msg', msg: { kind: 'layout', msg: { type: 'pool_hide', id: t.occupantId } } },
      { type: 'dispatch_msg', msg: showCmd },
      repaint,
    ];
    return [closeOverlay, cmds];
  }
  // append
  return [closeOverlay, [{ type: 'dispatch_msg', msg: showCmd }, repaint]];
}

module.exports = {
  MIN_PANEL_H, DETAIL_MIN_PCT, DETAIL_MAX_PCT,
  allDesignPanels,
  snapshot, undo, redo, clearUndoStacks,
  columnTotalH, freezeColumnFlex, panelHeightPct,
  navSelect, reorderWithin, moveColumn, resizeWidthOrDetail, resizeFocusedPanelHeight,
  clampSelected, titleEnter, setSelectedTitle,
  pointToResizeTarget, pointToDropTarget, panelAt,
  mousePress, mouseMotion, mouseRelease,
  poolDragStart, poolDragMotion, poolDragRelease, pointToPoolDropTarget,
};
