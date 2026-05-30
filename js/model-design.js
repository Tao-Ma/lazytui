/**
 * Pure design-mode layout transforms — the reducer-owned half of design.js.
 *
 * Like model-groups / model-search / model-menu, this is a dependency-free
 * leaf so runtime.update can import it without a require cycle (design.js
 * requires runtime + term + ansi, so the reducer can't call into it). Every
 * function takes `model` and mutates model.layout / model.modal.design — no
 * I/O, no global, no terminal reads. The terminal-dependent geometry
 * (hit-tests reading cols(), the drag state machine) stays in design.js and
 * folds onto update in a later commit.
 *
 * State touched:
 *   - model.layout.{leftWidth, detailHeightPct, leftPanels, rightPanels}
 *   - model.layoutDirty
 *   - model.modal.design.{selectedIdx, undo, redo, titleEdit}
 *   - model.panelBounds (READ only — frame-derived, written by layout.js)
 */
'use strict';

const MIN_PANEL_H = 3;
const DETAIL_MIN_PCT = 20;
const DETAIL_MAX_PCT = 90;
const MAX_UNDO = 50;

function allDesignPanels(model) {
  return [...model.layout.leftPanels, ...model.layout.rightPanels];
}

// ---------------------------------------------------------------- undo / redo
//
// Snapshots are JSON round-trips of the layout — plain data (documented: no
// functions / Symbols / circular refs in panel config), so the stacks live
// happily on the model. Session-scoped: cleared on design_enter.

function snapshot(model) {
  return JSON.parse(JSON.stringify(model.layout));
}

/** Push the current layout to the undo stack (call BEFORE mutating) and clear
 *  the redo stack — any new mutation invalidates the redo timeline. */
function pushUndo(model) {
  const d = model.modal.design;
  d.undo.push(snapshot(model));
  if (d.undo.length > MAX_UNDO) d.undo.shift();
  d.redo.length = 0;
}

/** Restore layout fields from a snapshot in-place (preserves the outer
 *  model.layout reference other code holds). */
function applySnapshot(model, snap) {
  model.layout.leftWidth       = snap.leftWidth;
  model.layout.detailHeightPct = snap.detailHeightPct;
  model.layout.leftPanels      = snap.leftPanels;
  model.layout.rightPanels     = snap.rightPanels;
}

function undo(model) {
  const d = model.modal.design;
  if (d.undo.length === 0) return false;
  d.redo.push(snapshot(model));
  applySnapshot(model, d.undo.pop());
  model.layoutDirty = true;
  return true;
}

function redo(model) {
  const d = model.modal.design;
  if (d.redo.length === 0) return false;
  d.undo.push(snapshot(model));
  applySnapshot(model, d.redo.pop());
  model.layoutDirty = true;
  return true;
}

/** Wipe undo/redo (design_enter, and :restore-layout via the design.js shim).
 *  Tolerates model.modal.design not existing yet. */
function clearUndoStacks(model) {
  const d = model.modal && model.modal.design;
  if (!d) return;
  d.undo = [];
  d.redo = [];
}

// ---------------------------------------------------------------- geometry helpers

/** Total height of a column, summed from rendered bounds. */
function columnTotalH(model, column) {
  const panels = column === 'left' ? model.layout.leftPanels : model.layout.rightPanels;
  let total = 0;
  for (const p of panels) {
    const b = model.panelBounds[p.type];
    if (b) total += b.h;
  }
  return total;
}

/** Anchor any flex panels in `column` (no heightPct, not the active pair, not
 *  detail) at their current rendered height, so a boundary drag steals only
 *  from the neighbor instead of being absorbed proportionally. */
function freezeColumnFlex(model, column, upper, lower, availH) {
  const panels = column === 'left' ? model.layout.leftPanels : model.layout.rightPanels;
  for (const p of panels) {
    if (p === upper || p === lower) continue;
    if (p.type === 'detail') continue;
    if (typeof p.heightPct === 'number') continue;
    const b = model.panelBounds[p.type];
    if (!b) continue;
    p.heightPct = Math.round((b.h / availH) * 100);
  }
}

function panelHeightPct(model, p, availH) {
  if (p.type === 'detail') return model.layout.detailHeightPct;
  if (typeof p.heightPct === 'number') return p.heightPct;
  const b = model.panelBounds[p.type];
  return b ? Math.round(b.h / availH * 100) : 0;
}

function setPanelHeightPct(model, p, pct) {
  if (p.type === 'detail') model.layout.detailHeightPct = pct;
  else p.heightPct = pct;
}

function reassignHotkeys(model) {
  model.layout.leftPanels.forEach((p, i) => { p.hotkey = String(i + 1); });
  model.layout.rightPanels.forEach(p => {
    if (p.type === 'actions') p.hotkey = '0';
    else if (p.type === 'detail') p.hotkey = 'o';
    else p.hotkey = '';
  });
}

// ---------------------------------------------------------------- keyboard transforms

/** ↑/↓ — move the selection cursor, clamped to the panel list. */
function navSelect(model, delta) {
  const d = model.modal.design;
  const all = allDesignPanels(model);
  if (delta < 0) { if (d.selectedIdx > 0) d.selectedIdx--; }
  else           { if (d.selectedIdx < all.length - 1) d.selectedIdx++; }
}

/** J/K — reorder the focused panel within its column (delta ±1). */
function reorderWithin(model, delta) {
  const d = model.modal.design;
  const sel = d.selectedIdx;
  const isLeft = sel < model.layout.leftPanels.length;
  const localIdx = isLeft ? sel : sel - model.layout.leftPanels.length;
  const column = isLeft ? model.layout.leftPanels : model.layout.rightPanels;
  if (delta < 0) {
    if (localIdx > 0) {
      pushUndo(model);
      [column[localIdx], column[localIdx - 1]] = [column[localIdx - 1], column[localIdx]];
      d.selectedIdx--;
      reassignHotkeys(model);
      model.layoutDirty = true;
    }
  } else {
    if (localIdx < column.length - 1) {
      pushUndo(model);
      [column[localIdx], column[localIdx + 1]] = [column[localIdx + 1], column[localIdx]];
      d.selectedIdx++;
      reassignHotkeys(model);
      model.layoutDirty = true;
    }
  }
}

/** ←/→ — move the focused panel between columns. */
function moveColumn(model, col) {
  const d = model.modal.design;
  const sel = d.selectedIdx;
  const all = allDesignPanels(model);
  const selPanel = all[sel];
  if (!selPanel) return;
  const isLeft = sel < model.layout.leftPanels.length;
  const localIdx = isLeft ? sel : sel - model.layout.leftPanels.length;

  if (col === 'left') {
    if (!isLeft && selPanel.type !== 'detail' && selPanel.type !== 'actions'
        && model.layout.leftPanels.length < 6) {
      pushUndo(model);
      model.layout.rightPanels.splice(localIdx, 1);
      model.layout.leftPanels.push(selPanel);
      selPanel.column = 'left';
      d.selectedIdx = model.layout.leftPanels.length - 1;
      reassignHotkeys(model);
      model.layoutDirty = true;
    }
  } else {
    if (isLeft && model.layout.rightPanels.length < 3) {
      pushUndo(model);
      model.layout.leftPanels.splice(localIdx, 1);
      const detailIdx = model.layout.rightPanels.findIndex(p => p.type === 'detail');
      const insertAt = detailIdx >= 0 ? detailIdx : model.layout.rightPanels.length;
      model.layout.rightPanels.splice(insertAt, 0, selPanel);
      selPanel.column = 'right';
      selPanel.hotkey = '';
      d.selectedIdx = model.layout.leftPanels.length + insertAt;
      reassignHotkeys(model);
      model.layoutDirty = true;
    }
  }
}

/** +/- — detail selected: grow/shrink detailHeightPct by 5 (clamped [20,90]);
 *  else a left panel selected: grow/shrink leftWidth by 2 (clamped [20,60]). */
function resizeWidthOrDetail(model, sign) {
  const d = model.modal.design;
  const all = allDesignPanels(model);
  const selPanel = all[d.selectedIdx];
  if (!selPanel) return;
  const isLeft = d.selectedIdx < model.layout.leftPanels.length;
  if (sign > 0) {
    if (selPanel.type === 'detail' && model.layout.detailHeightPct < 90) {
      pushUndo(model);
      model.layout.detailHeightPct = Math.min(90, model.layout.detailHeightPct + 5);
      model.layoutDirty = true;
    } else if (isLeft && model.layout.leftWidth < 60) {
      pushUndo(model);
      model.layout.leftWidth = Math.min(60, model.layout.leftWidth + 2);
      model.layoutDirty = true;
    }
  } else {
    if (selPanel.type === 'detail' && model.layout.detailHeightPct > 20) {
      pushUndo(model);
      model.layout.detailHeightPct = Math.max(20, model.layout.detailHeightPct - 5);
      model.layoutDirty = true;
    } else if (isLeft && model.layout.leftWidth > 20) {
      pushUndo(model);
      model.layout.leftWidth = Math.max(20, model.layout.leftWidth - 2);
      model.layoutDirty = true;
    }
  }
}

/** ] / [ — grow/shrink the focused panel's heightPct by Δ, stealing from the
 *  panel below in the same column (D1 semantics). No-op on detail / last row. */
function resizeFocusedPanelHeight(model, deltaPct) {
  const d = model.modal.design;
  const all = allDesignPanels(model);
  const sel = all[d.selectedIdx];
  if (!sel || sel.type === 'detail') return;  // detail uses +/-

  const isLeft = d.selectedIdx < model.layout.leftPanels.length;
  const column = isLeft ? model.layout.leftPanels : model.layout.rightPanels;
  const colName = isLeft ? 'left' : 'right';
  const idx = column.indexOf(sel);
  if (idx < 0 || idx === column.length - 1) return;  // no neighbor below
  const next = column[idx + 1];

  const availH = columnTotalH(model, colName);
  if (availH < 6) return;

  freezeColumnFlex(model, colName, sel, next, availH);

  const selCur  = panelHeightPct(model, sel,  availH);
  const nextCur = panelHeightPct(model, next, availH);
  const combined = selCur + nextCur;

  const rowsToPct = (rows) => Math.max(1, Math.ceil(rows / availH * 100));
  const minPct = (p) => p.type === 'detail' ? DETAIL_MIN_PCT : rowsToPct(MIN_PANEL_H);
  const maxPct = (p) => p.type === 'detail' ? DETAIL_MAX_PCT : 100;

  let newSel  = selCur  + deltaPct;
  let newNext = nextCur - deltaPct;
  if (newSel < minPct(sel))   { newSel = minPct(sel);   newNext = combined - newSel; }
  if (newSel > maxPct(sel))   { newSel = maxPct(sel);   newNext = combined - newSel; }
  if (newNext < minPct(next)) { newNext = minPct(next); newSel = combined - newNext; }
  if (newNext > maxPct(next)) { newNext = maxPct(next); newSel = combined - newNext; }

  if (newSel === selCur && newNext === nextCur) return;
  pushUndo(model);
  setPanelHeightPct(model, sel, newSel);
  setPanelHeightPct(model, next, newNext);
  model.layoutDirty = true;
}

/** Safety clamp after any mutation that can change the panel count. */
function clampSelected(model) {
  const d = model.modal.design;
  const all = allDesignPanels(model);
  if (d.selectedIdx >= all.length) d.selectedIdx = all.length - 1;
  if (d.selectedIdx < 0) d.selectedIdx = 0;
}

// ---------------------------------------------------------------- title edit

/** Seed the title-edit buffer from the focused panel's current title. */
function titleEnter(model) {
  const all = allDesignPanels(model);
  const p = all[model.modal.design.selectedIdx];
  if (!p) return;
  model.modal.design.titleEdit = { active: true, text: p.title || '' };
}

/** Commit a non-empty, changed title to the focused panel (pushes one undo). */
function setSelectedTitle(model, text) {
  const all = allDesignPanels(model);
  const p = all[model.modal.design.selectedIdx];
  if (p && text.length > 0 && text !== p.title) {
    pushUndo(model);
    p.title = text;
    model.layoutDirty = true;
  }
}

// ---------------------------------------------------------------- mouse
//
// The drag/resize state machine. `model.modal.design.drag` holds the in-flight
// gesture across press→motion→release (it can't be a single Msg). `COLS` (the
// terminal width) is caller-resolved — the one terminal read the reducer can't
// do — and threaded into the hit-tests. panelBounds is read off the model
// (frame-derived, written by layout.js).

/**
 * Hit-test a point against draggable separators. Returns `{ edge, boundary?,
 * column? }` or null. Edges: 'corner' (col-sep × a column boundary, both axes),
 * 'col' (col-sep only), 'right-boundary' / 'left-boundary' (a horizontal seam
 * between two stacked panels). ±1 tolerance on both axes; right-col wins ties.
 */
function pointToResizeTarget(model, mx, my, COLS) {
  const leftW = model.layout.leftWidth;
  const colMatch = Math.abs(mx - leftW) <= 1;
  const rightB = boundaryNear(model, model.layout.rightPanels, my);
  const leftB  = boundaryNear(model, model.layout.leftPanels,  my);
  if (colMatch && rightB) return { edge: 'corner', boundary: rightB, column: 'right' };
  if (colMatch && leftB)  return { edge: 'corner', boundary: leftB,  column: 'left'  };
  if (colMatch)            return { edge: 'col' };
  if (rightB && mx > leftW + 1 && mx < COLS) return { edge: 'right-boundary', boundary: rightB };
  if (leftB && mx >= 0 && mx < leftW)        return { edge: 'left-boundary', boundary: leftB };
  return null;
}

/** Horizontal boundary between two adjacent panels within ±1 of `my`, or null.
 *  Boundary y = `upper.y + upper.h` (where the next panel's top border sits). */
function boundaryNear(model, panels, my) {
  for (let i = 0; i < panels.length - 1; i++) {
    const b = model.panelBounds[panels[i].type];
    if (!b) continue;
    const y = b.y + b.h;
    if (Math.abs(my - y) <= 1) return { upper: panels[i], lower: panels[i + 1], y };
  }
  return null;
}

/** Column-separator drag: leftWidth follows cursor, clamped [20, 60]. */
function applyColResize(model, mx) {
  const newW = Math.max(20, Math.min(60, mx + 1));
  if (newW !== model.layout.leftWidth) {
    model.layout.leftWidth = newW;
    model.layoutDirty = true;
  }
}

/** Within-column boundary drag: redistributes height between the two panels
 *  captured at press (D1 — steal from neighbor only). A detail side writes
 *  detailHeightPct clamped [20, 90]; the neighbor takes the complement. */
function applyBoundaryResize(model, my) {
  const ds = model.modal.design.drag;
  if (!ds) return;
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
  const setPct = (panel, pct) => {
    if (panel.heightPct !== pct) { panel.heightPct = pct; model.layoutDirty = true; }
  };
  const setDetailPct = (pct) => {
    if (model.layout.detailHeightPct !== pct) { model.layout.detailHeightPct = pct; model.layoutDirty = true; }
  };
  if (ds.detailIsUpper)      { setDetailPct(upperPct); setPct(ds.lower, lowerPct); }
  else if (ds.detailIsLower) { setDetailPct(lowerPct); setPct(ds.upper, upperPct); }
  else                       { setPct(ds.upper, upperPct); setPct(ds.lower, lowerPct); }
}

/** Panel type at (mx, my) per rendered bounds, or null (frame-synchronous). */
function panelAt(model, mx, my) {
  for (const p of allDesignPanels(model)) {
    const b = model.panelBounds[p.type];
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
function pointToDropTarget(model, srcType, mx, my, COLS) {
  const leftPanels = model.layout.leftPanels;
  const rightPanels = model.layout.rightPanels;
  const leftW = model.layout.leftWidth;
  const inLeft = matchColumn(model, leftPanels, mx, my);
  if (inLeft !== null) return validateTarget(srcType, 'left', inLeft);
  const inRight = matchColumn(model, rightPanels, mx, my);
  if (inRight !== null) return validateTarget(srcType, 'right', inRight);
  if (mx >= 0 && mx < leftW && leftPanels.length === 0) return validateTarget(srcType, 'left', 0);
  if (mx >= leftW && mx < COLS && rightPanels.length === 0) return validateTarget(srcType, 'right', 0);
  return null;
}

function matchColumn(model, panels, mx, my) {
  let anyXMatch = false;
  for (let i = 0; i < panels.length; i++) {
    const b = model.panelBounds[panels[i].type];
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

/** Splice the source panel out of its column and insert at the target slot;
 *  re-derive hotkeys positionally; set layoutDirty. */
function applyDrop(model, srcType, target) {
  const leftPanels = model.layout.leftPanels;
  const rightPanels = model.layout.rightPanels;

  let src = null, fromCol = null, fromIdx = -1;
  for (let i = 0; i < leftPanels.length; i++) {
    if (leftPanels[i].type === srcType) { src = leftPanels[i]; fromCol = 'left'; fromIdx = i; break; }
  }
  if (!src) {
    for (let i = 0; i < rightPanels.length; i++) {
      if (rightPanels[i].type === srcType) { src = rightPanels[i]; fromCol = 'right'; fromIdx = i; break; }
    }
  }
  if (!src) return;

  if (fromCol === 'left') leftPanels.splice(fromIdx, 1);
  else rightPanels.splice(fromIdx, 1);

  let insertAt = target.index;
  if (fromCol === target.column && fromIdx < insertAt) insertAt--;

  const dest = target.column === 'left' ? leftPanels : rightPanels;
  dest.splice(insertAt, 0, src);
  src.column = target.column;

  reassignHotkeys(model);
  model.layoutDirty = true;
}

/** Press: resize hit-test FIRST (a seam sits on a panel border), else arm a
 *  panel drag + move the keyboard selection to the clicked panel. */
function mousePress(model, mx, my, COLS) {
  if (!model.modes.designMode) return;
  const d = model.modal.design;
  const resize = pointToResizeTarget(model, mx, my, COLS);
  if (resize) {
    pushUndo(model);
    const ds = { kind: `resizing-${resize.edge}` };
    if (resize.edge === 'left-boundary' || resize.edge === 'right-boundary' || resize.edge === 'corner') {
      const column = resize.column || (resize.edge === 'left-boundary' ? 'left' : 'right');
      const b = resize.boundary;
      ds.column = column;
      ds.upper = b.upper;
      ds.lower = b.lower;
      ds.upperStartY = model.panelBounds[b.upper.type].y;
      ds.combinedH = model.panelBounds[b.upper.type].h + model.panelBounds[b.lower.type].h;
      ds.availH = columnTotalH(model, column);
      if (ds.availH < 1) ds.availH = 1;
      ds.detailIsUpper = b.upper.type === 'detail';
      ds.detailIsLower = b.lower.type === 'detail';
      freezeColumnFlex(model, column, b.upper, b.lower, ds.availH);
    }
    d.drag = ds;
    return;
  }
  const hit = panelAt(model, mx, my);
  if (!hit) { d.drag = null; return; }
  d.drag = { kind: 'armed', sourceType: hit, startX: mx, startY: my, curX: mx, curY: my, target: null };
  const all = allDesignPanels(model);
  const idx = all.findIndex(p => p.type === hit);
  if (idx >= 0) d.selectedIdx = idx;
}

/** Motion: resize kinds mutate directly; a panel drag promotes armed→dragging
 *  after ≥1 cell and recomputes the drop target. */
function mouseMotion(model, mx, my, COLS) {
  const ds = model.modal.design.drag;
  if (!ds) return;
  if (ds.kind === 'resizing-col') { applyColResize(model, mx); return; }
  if (ds.kind === 'resizing-left-boundary' || ds.kind === 'resizing-right-boundary') { applyBoundaryResize(model, my); return; }
  if (ds.kind === 'resizing-corner') { applyColResize(model, mx); applyBoundaryResize(model, my); return; }
  ds.curX = mx;
  ds.curY = my;
  if (ds.kind === 'armed') {
    if (mx !== ds.startX || my !== ds.startY) ds.kind = 'dragging';
    else return;
  }
  ds.target = pointToDropTarget(model, ds.sourceType, mx, my, COLS);
}

/** Release: commit a valid drop (pushUndo + applyDrop), then clear the drag. */
function mouseRelease(model) {
  const d = model.modal.design;
  const ds = d.drag;
  if (!ds) return;
  if (ds.kind === 'dragging' && ds.target && ds.target.valid) {
    pushUndo(model);
    applyDrop(model, ds.sourceType, ds.target);
  }
  d.drag = null;
}

module.exports = {
  MIN_PANEL_H, DETAIL_MIN_PCT, DETAIL_MAX_PCT,
  allDesignPanels,
  snapshot, pushUndo, applySnapshot, undo, redo, clearUndoStacks,
  columnTotalH, freezeColumnFlex, panelHeightPct, setPanelHeightPct, reassignHotkeys,
  navSelect, reorderWithin, moveColumn, resizeWidthOrDetail, resizeFocusedPanelHeight,
  clampSelected, titleEnter, setSelectedTitle,
  pointToResizeTarget, pointToDropTarget, panelAt,
  mousePress, mouseMotion, mouseRelease,
};
