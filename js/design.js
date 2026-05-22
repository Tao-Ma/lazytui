/**
 * Design mode — interactive panel layout editor.
 *
 * Pure overlay + runtime-state mutation. enterDesign/handleDesignKey
 * /onMouseEvent only mutate `S.layout` and a module-private state.
 * Rendering is owned by layout.render(), which calls
 * renderDesignOverlay() when S.designMode is set. This keeps design
 * on the same render pipeline as every other mode (copy/menu/filter)
 * — no parallel renderMain() loop, no drift from the themed footer
 * / overlay precedence.
 *
 * **Save is decoupled.** Design mode mutates S.layout in place and
 * sets `S.layoutDirty = true`. Persisting to YAML is a separate verb:
 * the `:save-layout` cmdline command writes the current layout to
 * the config file via `js/yaml-layout.js`. Companion `:restore-layout`
 * reverts the runtime layout to the YAML state and clears the dirty
 * flag and undo history.
 *
 * **Drag-and-drop (Phase 2).** Mouse press on a panel arms the drag.
 * Motion ≥1 cell from the press point enters dragging state and
 * paints an insertion line at the drop target. Release commits the
 * drop (or snaps back on invalid target). Mode 1002 mouse reporting
 * (button-with-motion) carries the events.
 *
 * **Drag-to-resize (Phase 3).** Mouse press on a separator zone
 * arms a resize gesture. Column separator (`mx ≈ leftWidth`, ±1
 * tolerance) → leftWidth tracks the cursor. Detail-panel top edge
 * (`my === panelBounds.detail.y`) → detailHeightPct tracks. Hit-test
 * is checked BEFORE panel-drag arming so the user can grab a
 * separator even though it visually sits on a panel border.
 *
 * **Title edit (Phase 3).** `t` enters a sub-mode where keystrokes
 * edit the focused panel's title. The mode flag `S.designTitleEditMode`
 * sits ABOVE `S.designMode` in the dispatch chain so design-mode's
 * key handler is skipped while editing. Enter commits, Esc cancels.
 *
 * **Undo / redo (Phase 3).** Every layout mutation pushes a snapshot
 * to an in-memory stack (max 50). `u` pops to undo, `Ctrl+R` redoes.
 * Stack is session-scoped: cleared on `enterDesign` and on
 * `:restore-layout` (the new layout invalidates the prior history).
 *
 * Keys (mouse is additive):
 *   ↑/↓       Select panel
 *   J/K       Reorder panel within column (shift+j/k)
 *   ←/→       Move panel between columns
 *   +/-       Resize (left width or detail height %)
 *   t         Edit focused panel's title
 *   u         Undo last layout mutation
 *   Ctrl+R    Redo
 *   Enter     Exit design mode (does NOT save — use :save-layout)
 *   q/Esc     Exit design mode (does NOT save — use :save-layout)
 */
'use strict';

const { esc, RESET, richToAnsi } = require('./ansi');
const { cols, rows, stdout } = require('./term');
const { S } = require('./state');

let designState = null; // null when not in design mode

// Drag lifecycle:
//   null
//     → armed(press, no motion yet)                  [panel drag]
//     → dragging(motion seen, target tracked)        [panel drag]
//     → resizing-col              (immediate, on press)  [drag-resize]
//     → resizing-left-boundary    (immediate, on press)  [drag-resize]
//     → resizing-right-boundary   (immediate, on press)  [drag-resize]
//     → resizing-corner           (immediate, on press)  [drag-resize]
//     → null (on release)
// `target` is recomputed on every motion event so renderDesignOverlay
// can paint the current drop indicator. Resize kinds capture the
// reference-frame measurements at press time (upper.y, combinedH,
// availH) so the dragged seam doesn't drift the math across motions,
// and freeze any other flex panels in the column so D1 semantics
// hold (steal from neighbor only — not redistributed across the
// column).
let dragState = null;

// Undo / redo stacks. Module-private, session-scoped — cleared on
// enterDesign and on :restore-layout. Snapshot via JSON round-trip
// because panel objects can carry plugin-specific keys (no functions /
// Symbols / circular refs in any documented panel config). Cap is a
// soft safety belt against runaway memory.
const MAX_UNDO = 50;
let undoStack = [];
let redoStack = [];

// Title-edit sub-mode buffer. titleEditPanel is a direct reference to
// the panel object being edited (not a copy) so commit is a single
// assignment. Cleared on enter/leave.
let titleEditBuf = '';
let titleEditPanel = null;

/**
 * Enter design mode. While active, S.layout IS the working draft —
 * mutations flow directly through the normal render path so live
 * preview is automatic. Save is NOT auto-attached to exit; mutations
 * persist at runtime, and the `:save-layout` cmdline command writes
 * them to YAML. The caller is responsible for triggering the next
 * render once `onDone` fires.
 */
function enterDesign(layout, configPath, onDone) {
  designState = {
    selectedIdx: 0,
    configPath,
    onDone,
  };
  dragState = null;
  // Undo history is session-scoped — clear it for the new session
  // so the user can't undo back into a previous session's state.
  undoStack = [];
  redoStack = [];
  S.designMode = true;
}

// ---------------------------------------------------------------- undo / redo

function snapshot() {
  return JSON.parse(JSON.stringify(S.layout));
}

/**
 * Push the current layout to the undo stack. Caller MUST call BEFORE
 * mutating (the snapshot captures the pre-mutation state). Also clears
 * the redo stack: any new mutation invalidates the redo history that
 * was built from a different timeline.
 */
function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  redoStack.length = 0;
}

/**
 * Restore the layout fields from a snapshot in-place (preserves the
 * outer S.layout reference, which other code may hold by reference).
 */
function applySnapshot(snap) {
  S.layout.leftWidth        = snap.leftWidth;
  S.layout.detailHeightPct  = snap.detailHeightPct;
  S.layout.leftPanels       = snap.leftPanels;
  S.layout.rightPanels      = snap.rightPanels;
}

function undo() {
  if (undoStack.length === 0) return false;
  redoStack.push(snapshot());
  applySnapshot(undoStack.pop());
  S.layoutDirty = true;
  return true;
}

function redo() {
  if (redoStack.length === 0) return false;
  undoStack.push(snapshot());
  applySnapshot(redoStack.pop());
  S.layoutDirty = true;
  return true;
}

/**
 * Exported escape hatch for `:restore-layout` to wipe the session's
 * undo history when the user explicitly resets from disk. The new
 * S.layout is unrelated to anything in the stacks; keeping them
 * would leak prior runtime state back in via `u`.
 */
function _clearUndoStacks() {
  undoStack = [];
  redoStack = [];
}

function allDesignPanels() {
  return [...S.layout.leftPanels, ...S.layout.rightPanels];
}

/**
 * Footer text contribution for renderFooter (read when S.designMode).
 * Idle: ` | <title> (<column>)`. Dragging: includes the live drop
 * target so the user sees where a release lands.
 */
function getDesignFooter() {
  if (!designState) return '';
  if (dragState && dragState.kind === 'dragging') {
    const t = dragState.target;
    const srcTitle = panelTitle(dragState.sourceType);
    if (!t) return ` | dragging ${esc(srcTitle)} → [yellow](drop outside)[/]`;
    if (!t.valid) return ` | dragging ${esc(srcTitle)} → [red]✗ ${esc(t.reason || 'blocked')}[/]`;
    return ` | dragging ${esc(srcTitle)} → ${t.column} @ ${t.index}`;
  }
  const all = allDesignPanels();
  const sel = all[designState.selectedIdx];
  return sel ? ` | ${esc(sel.title)} (${sel.column})` : '';
}

function panelTitle(type) {
  const p = allDesignPanels().find(x => x.type === type);
  return p ? p.title : type;
}

// ---------------------------------------------------------------- mouse

/**
 * Mouse event entry — called by input.js#handleMouse when designMode
 * is true. `kind` is 'press' | 'motion' | 'release'. Mutates dragState
 * + S.layout as the user drives the gesture.
 */
function onMouseEvent(kind, mx, my) {
  if (!designState) return;

  if (kind === 'press') {
    // Resize hit-test runs FIRST — the separator visually sits on a
    // panel border, so without priority the panel-drag arming would
    // always win on borderline clicks.
    const resize = pointToResizeTarget(mx, my);
    if (resize) {
      pushUndo();
      const ds = { kind: `resizing-${resize.edge}` };
      // Capture reference frame at press so the moving edge doesn't
      // drift the math on each motion event. Both boundary and corner
      // need the column extents + upper.y / combinedH; corner is just
      // boundary + simultaneous col-resize.
      if (resize.edge === 'left-boundary' || resize.edge === 'right-boundary' || resize.edge === 'corner') {
        // Corner carries an explicit column (the side its boundary lives in);
        // boundary edges encode the column in their edge name.
        const column = resize.column || (resize.edge === 'left-boundary' ? 'left' : 'right');
        const b = resize.boundary;
        ds.column = column;
        ds.upper = b.upper;
        ds.lower = b.lower;
        ds.upperStartY = S.panelBounds[b.upper.type].y;
        ds.combinedH = S.panelBounds[b.upper.type].h + S.panelBounds[b.lower.type].h;
        ds.availH = columnTotalH(column);
        if (ds.availH < 1) ds.availH = 1;
        ds.detailIsUpper = b.upper.type === 'detail';
        ds.detailIsLower = b.lower.type === 'detail';
        // Freeze the column's other flex panels at their current
        // displayed heights — without this they'd absorb the
        // boundary motion proportionally and the cursor would
        // outrun the seam.
        freezeColumnFlex(column, b.upper, b.lower, ds.availH);
      }
      dragState = ds;
      return;
    }

    const hit = panelAt(mx, my);
    if (!hit) { dragState = null; return; }
    dragState = {
      kind: 'armed',
      sourceType: hit,
      startX: mx,
      startY: my,
      curX: mx,
      curY: my,
      target: null,
    };
    // Also move keyboard selection to the clicked panel so the keyboard
    // hint in the footer matches what the user just touched.
    const all = allDesignPanels();
    const idx = all.findIndex(p => p.type === hit);
    if (idx >= 0) designState.selectedIdx = idx;
    return;
  }

  if (kind === 'motion') {
    if (!dragState) return;

    // Drag-resize: motion directly mutates the resize target. No
    // armed→dragging promotion; the gesture is committed at press.
    if (dragState.kind === 'resizing-col') {
      applyColResize(mx);
      return;
    }
    if (dragState.kind === 'resizing-left-boundary'
        || dragState.kind === 'resizing-right-boundary') {
      applyBoundaryResize(my);
      return;
    }
    if (dragState.kind === 'resizing-corner') {
      applyColResize(mx);
      applyBoundaryResize(my);
      return;
    }

    dragState.curX = mx;
    dragState.curY = my;
    if (dragState.kind === 'armed') {
      // Promote to dragging only after ≥1 cell movement — guards
      // against accidental drag on a noisy click.
      if (mx !== dragState.startX || my !== dragState.startY) {
        dragState.kind = 'dragging';
      } else {
        return;
      }
    }
    dragState.target = pointToDropTarget(dragState.sourceType, mx, my);
    return;
  }

  if (kind === 'release') {
    if (!dragState) return;
    if (dragState.kind === 'dragging' && dragState.target && dragState.target.valid) {
      pushUndo();
      applyDrop(dragState.sourceType, dragState.target);
    }
    dragState = null;
    return;
  }
}

/**
 * Check whether (mx, my) lands on a draggable separator. Returns
 * `{ edge, boundary? }` or null. Edges:
 *   'corner'         — col-separator × any right-col boundary (both
 *                       axes drag in one gesture).
 *   'col'            — col-separator only.
 *   'right-boundary' — horizontal seam between two right-col panels.
 *                       If detail is one of the two, motion routes
 *                       to detailHeightPct; otherwise it splits two
 *                       adjacent heightPct values.
 *   'left-boundary'  — horizontal seam between two left-col panels.
 *
 * `boundary` carries `{ upper, lower, y }` for boundary/corner hits
 * so the motion handler doesn't have to re-discover the pair. ±1
 * tolerance on both axes — same forgiveness as the col separator.
 * Exported for tests.
 */
function pointToResizeTarget(mx, my) {
  const leftW = S.layout.leftWidth;
  const COLS = cols();
  const colMatch = Math.abs(mx - leftW) <= 1;
  const rightB = boundaryNear(S.layout.rightPanels, my);
  const leftB  = boundaryNear(S.layout.leftPanels,  my);

  // Corner first — both axes match at the intersection of col-sep
  // and a column boundary (either side). A col-sep-only press wins
  // on the same row when no boundary is nearby, so col-resize still
  // works on every other row of the col separator. Right-col wins
  // ties (both columns happen to have a seam at the same y), since
  // that was the only corner shape before this commit.
  if (colMatch && rightB) return { edge: 'corner', boundary: rightB, column: 'right' };
  if (colMatch && leftB)  return { edge: 'corner', boundary: leftB,  column: 'left'  };
  if (colMatch)            return { edge: 'col' };
  if (rightB && mx > leftW + 1 && mx < COLS) {
    return { edge: 'right-boundary', boundary: rightB };
  }
  if (leftB && mx >= 0 && mx < leftW) {
    return { edge: 'left-boundary', boundary: leftB };
  }
  return null;
}

/**
 * Return the horizontal boundary between two adjacent panels in
 * `panels` that's within ±1 of `my`, or null. The boundary y is
 * `upper.y + upper.h` — the row where the next panel's top border
 * sits.
 */
function boundaryNear(panels, my) {
  for (let i = 0; i < panels.length - 1; i++) {
    const b = S.panelBounds[panels[i].type];
    if (!b) continue;
    const y = b.y + b.h;
    if (Math.abs(my - y) <= 1) {
      return { upper: panels[i], lower: panels[i + 1], y };
    }
  }
  return null;
}

/** Total height of a column, summed from its rendered bounds. */
function columnTotalH(column) {
  const panels = column === 'left' ? S.layout.leftPanels : S.layout.rightPanels;
  let total = 0;
  for (const p of panels) {
    const b = S.panelBounds[p.type];
    if (b) total += b.h;
  }
  return total;
}

/**
 * Convert any panels in `column` that currently have no `heightPct`
 * (and aren't the upper/lower of the active drag, and aren't detail
 * which uses detailHeightPct) to anchored at their current rendered
 * height. Without this, the moment motion shrinks the dragged pair,
 * the flex panels would absorb the freed rows proportionally and
 * the boundary visual would lag behind the cursor.
 */
function freezeColumnFlex(column, upper, lower, availH) {
  const panels = column === 'left' ? S.layout.leftPanels : S.layout.rightPanels;
  for (const p of panels) {
    if (p === upper || p === lower) continue;
    if (p.type === 'detail') continue;
    if (typeof p.heightPct === 'number') continue;
    const b = S.panelBounds[p.type];
    if (!b) continue;
    p.heightPct = Math.round((b.h / availH) * 100);
  }
}

const MIN_PANEL_H = 3;

/**
 * Column-separator drag: leftWidth follows cursor, clamped to [20, 60].
 * Pulled out so corner drag can reuse it.
 */
function applyColResize(mx) {
  const newW = Math.max(20, Math.min(60, mx + 1));
  if (newW !== S.layout.leftWidth) {
    S.layout.leftWidth = newW;
    S.layoutDirty = true;
  }
}

/**
 * Within-column boundary drag: redistributes height between the two
 * panels adjacent to the boundary captured at press. Only those two
 * are touched (D1 semantics — steal from neighbor only). When one
 * side is `detail`, its share is written to `S.layout.detailHeightPct`
 * (the layout-level knob) and clamped to [20, 90] to match the
 * existing keyboard +/- bounds; the non-detail neighbor takes the
 * complement. With two non-detail panels, both get `heightPct`.
 * Reused by corner drag for the height axis.
 */
const DETAIL_MIN_PCT = 20;
const DETAIL_MAX_PCT = 90;

function applyBoundaryResize(my) {
  const ds = dragState;
  if (!ds) return;
  let upperH = Math.max(MIN_PANEL_H, Math.min(ds.combinedH - MIN_PANEL_H, my - ds.upperStartY));
  let lowerH = ds.combinedH - upperH;

  // Detail-pct clamp [20, 90] — snap the detail side, then re-derive
  // the neighbor's height from the snapped value so the seam visually
  // stops at the clamp boundary instead of continuing past it.
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
    if (panel.heightPct !== pct) {
      panel.heightPct = pct;
      S.layoutDirty = true;
    }
  };
  const setDetailPct = (pct) => {
    if (S.layout.detailHeightPct !== pct) {
      S.layout.detailHeightPct = pct;
      S.layoutDirty = true;
    }
  };
  if (ds.detailIsUpper)      { setDetailPct(upperPct); setPct(ds.lower, lowerPct); }
  else if (ds.detailIsLower) { setDetailPct(lowerPct); setPct(ds.upper, upperPct); }
  else                       { setPct(ds.upper, upperPct); setPct(ds.lower, lowerPct); }
}

// --- Keyboard height resize (`]` / `[`) ----------------------------
//
// Mirrors the within-column boundary drag from the keyboard. Grows
// or shrinks the focused panel's heightPct by Δ percentage points,
// stealing from (or giving to) the panel immediately below in the
// same column. Detail is skipped — its `+`/`-` binding stays put.
// No-op at the last position (no panel below to swap with) or when
// the move would push the neighbor below its min-height clamp.

function panelHeightPct(p, availH) {
  if (p.type === 'detail') return S.layout.detailHeightPct;
  if (typeof p.heightPct === 'number') return p.heightPct;
  const b = S.panelBounds[p.type];
  return b ? Math.round(b.h / availH * 100) : 0;
}

function setPanelHeightPct(p, pct) {
  if (p.type === 'detail') S.layout.detailHeightPct = pct;
  else p.heightPct = pct;
}

function resizeFocusedPanelHeight(deltaPct) {
  if (!designState) return;
  const all = allDesignPanels();
  const sel = all[designState.selectedIdx];
  if (!sel || sel.type === 'detail') return;  // detail uses +/-

  const isLeft = designState.selectedIdx < S.layout.leftPanels.length;
  const column = isLeft ? S.layout.leftPanels : S.layout.rightPanels;
  const colName = isLeft ? 'left' : 'right';
  const idx = column.indexOf(sel);
  if (idx < 0 || idx === column.length - 1) return;  // no neighbor below
  const next = column[idx + 1];

  const availH = columnTotalH(colName);
  if (availH < 6) return;

  // Match drag semantics: freeze any other flex panels first so the
  // adjustment stays between sel and next, not redistributed.
  freezeColumnFlex(colName, sel, next, availH);

  const selCur  = panelHeightPct(sel,  availH);
  const nextCur = panelHeightPct(next, availH);
  const combined = selCur + nextCur;

  // Minimum pct for each panel — detail has its own [20, 90] band;
  // others bottom at the row-equivalent of MIN_PANEL_H.
  const rowsToPct = (rows) => Math.max(1, Math.ceil(rows / availH * 100));
  const minPct = (p) => p.type === 'detail' ? DETAIL_MIN_PCT : rowsToPct(MIN_PANEL_H);
  const maxPct = (p) => p.type === 'detail' ? DETAIL_MAX_PCT : 100;

  let newSel  = selCur  + deltaPct;
  let newNext = nextCur - deltaPct;
  // Clamp newSel, derive newNext from combined to preserve the column's
  // total. Then clamp newNext and re-derive newSel symmetrically.
  if (newSel < minPct(sel))  { newSel = minPct(sel);  newNext = combined - newSel; }
  if (newSel > maxPct(sel))  { newSel = maxPct(sel);  newNext = combined - newSel; }
  if (newNext < minPct(next)){ newNext = minPct(next); newSel = combined - newNext; }
  if (newNext > maxPct(next)){ newNext = maxPct(next); newSel = combined - newNext; }

  if (newSel === selCur && newNext === nextCur) return;
  pushUndo();
  setPanelHeightPct(sel, newSel);
  setPanelHeightPct(next, newNext);
  S.layoutDirty = true;
}

/**
 * Hit-test a point against rendered panel bounds. Returns the panel
 * type at (mx, my) or null. Uses S.panelBounds which layout.js rebuilds
 * every frame; the test is frame-synchronous.
 */
function panelAt(mx, my) {
  for (const p of allDesignPanels()) {
    const b = S.panelBounds[p.type];
    if (!b) continue;
    if (mx >= b.x && mx < b.x + b.w && my >= b.y && my < b.y + b.h) {
      return p.type;
    }
  }
  return null;
}

/**
 * Resolve a screen point to a drop target — pure function modulo
 * S.panelBounds + S.layout (no side effects, no module state). Exported
 * for tests.
 *
 * Returns:
 *   { column: 'left'|'right', index: int, valid: bool, reason?: string }
 *   or null when the cursor is outside both columns entirely.
 *
 * Drop rules:
 *   - Within a panel's top half → insert BEFORE that panel (index = i)
 *   - Within a panel's bottom half → insert AFTER (index = i + 1)
 *   - Below the last panel in a column → append (index = column.length)
 *   - Empty column at the column's x range → insert at index 0
 *   - Detail / actions panels in left column → valid: false
 */
function pointToDropTarget(srcType, mx, my) {
  const leftPanels = S.layout.leftPanels;
  const rightPanels = S.layout.rightPanels;
  const leftW = S.layout.leftWidth;

  // First try left column hit-testing through panel bounds. NB the
  // return value can be 0 (insert at top), so explicit null-check.
  const inLeft = matchColumn(leftPanels, mx, my);
  if (inLeft !== null) return validateTarget(srcType, 'left', inLeft);

  const inRight = matchColumn(rightPanels, mx, my);
  if (inRight !== null) return validateTarget(srcType, 'right', inRight);

  // Fallback: empty-column case (no panels to hit-test against). Use
  // leftWidth heuristic to decide which column the cursor is "over."
  const COLS = cols();
  if (mx >= 0 && mx < leftW && leftPanels.length === 0) {
    return validateTarget(srcType, 'left', 0);
  }
  if (mx >= leftW && mx < COLS && rightPanels.length === 0) {
    return validateTarget(srcType, 'right', 0);
  }
  return null;
}

function matchColumn(panels, mx, my) {
  // Walk the column from top to bottom; return the insertion index
  // for (mx, my), or null if the point isn't horizontally inside any
  // of these panels (none of the panel x-ranges contain mx).
  let anyXMatch = false;
  for (let i = 0; i < panels.length; i++) {
    const b = S.panelBounds[panels[i].type];
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w) continue;
    anyXMatch = true;
    if (my < b.y) {
      // Above this panel but inside its x — insert before.
      return i;
    }
    if (my < b.y + b.h) {
      // Inside this panel — top half = insert before, bottom half = after.
      return (my < b.y + b.h / 2) ? i : i + 1;
    }
    // my >= b.y + b.h → cursor is below this panel; keep walking.
  }
  // Cursor was inside the column's x-range but below all panels.
  if (anyXMatch) return panels.length;
  return null;
}

function validateTarget(srcType, column, index) {
  if (column === 'left' && (srcType === 'detail' || srcType === 'actions')) {
    return { column, index, valid: false, reason: `${srcType} can't live in left column` };
  }
  return { column, index, valid: true };
}

/**
 * Mutate S.layout to reflect the drop. The source panel object is
 * spliced out of its current array (left or right) and inserted at
 * the target column/index. `reassignHotkeys` re-derives hotkeys
 * positionally so the hotkey overlay stays consistent. Sets
 * S.layoutDirty true so the footer surfaces "unsaved" and the user
 * knows to run :save-layout.
 */
function applyDrop(srcType, target) {
  const leftPanels = S.layout.leftPanels;
  const rightPanels = S.layout.rightPanels;

  // Locate source — note we search both columns since the panel might
  // be on either side.
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

  // Splice out first; then adjust target index if the splice came from
  // the same column at a lower index (the target slot shifted up by one).
  if (fromCol === 'left') leftPanels.splice(fromIdx, 1);
  else rightPanels.splice(fromIdx, 1);

  let insertAt = target.index;
  if (fromCol === target.column && fromIdx < insertAt) insertAt--;

  const dest = target.column === 'left' ? leftPanels : rightPanels;
  // Don't push detail past the end's intent: detail's natural slot is
  // last in the right column. Existing keyboard `right`/`l` enforced
  // this. Here we let drag put it anywhere the user wants, which is
  // what "drag-and-drop" means — the user is explicit. Skip the
  // detail-bumping heuristic from the keyboard path.
  dest.splice(insertAt, 0, src);
  src.column = target.column;

  reassignHotkeys();
  S.layoutDirty = true;
}

// ---------------------------------------------------------------- render

/**
 * Paint the design overlay. Phase 2: no centered modal — that gets in
 * the way of the layout you're editing. Just paints the insertion line
 * during an active drag. Banner / status lives in the footer (see
 * `getDesignFooter`).
 */
function renderDesignOverlay() {
  if (!designState) return;
  if (!dragState || dragState.kind !== 'dragging') return;
  const t = dragState.target;
  if (!t) return;

  const COLS = cols();
  const leftW = S.layout.leftWidth;
  const colX = t.column === 'left' ? 0 : leftW;
  const colW = t.column === 'left' ? leftW : COLS - leftW;

  // Resolve insertion y from S.panelBounds. If t.index === 0 → top of
  // the column; otherwise → bottom edge of panel at index t.index - 1.
  const panels = t.column === 'left' ? S.layout.leftPanels : S.layout.rightPanels;
  let lineY;
  if (panels.length === 0) {
    lineY = 0;
  } else if (t.index <= 0) {
    const first = S.panelBounds[panels[0].type];
    lineY = first ? first.y : 0;
  } else {
    const beforeIdx = Math.min(t.index, panels.length) - 1;
    const before = S.panelBounds[panels[beforeIdx].type];
    lineY = before ? before.y + before.h - 1 : 0;
  }

  const color = t.valid ? 'green' : 'red';
  const bar = '═'.repeat(Math.max(1, colW));
  const markup = `[bold ${color}]${bar}[/]`;
  stdout.write(`\x1b[${lineY + 1};${colX + 1}H` + richToAnsi(markup) + RESET);
}

// ---------------------------------------------------------------- keyboard

function handleDesignKey(key) {
  const all = allDesignPanels();
  const sel = designState.selectedIdx;
  const selPanel = all[sel];
  if (!selPanel) return;

  const isLeft = sel < S.layout.leftPanels.length;
  const localIdx = isLeft ? sel : sel - S.layout.leftPanels.length;
  const column = isLeft ? S.layout.leftPanels : S.layout.rightPanels;

  switch (key) {
    case 'up': case 'k':
      if (sel > 0) designState.selectedIdx--;
      break;
    case 'down': case 'j':
      if (sel < all.length - 1) designState.selectedIdx++;
      break;

    case 'K':
      if (localIdx > 0) {
        pushUndo();
        [column[localIdx], column[localIdx - 1]] = [column[localIdx - 1], column[localIdx]];
        designState.selectedIdx--;
        reassignHotkeys();
        S.layoutDirty = true;
      }
      break;
    case 'J':
      if (localIdx < column.length - 1) {
        pushUndo();
        [column[localIdx], column[localIdx + 1]] = [column[localIdx + 1], column[localIdx]];
        designState.selectedIdx++;
        reassignHotkeys();
        S.layoutDirty = true;
      }
      break;

    case 'left': case 'h':
      if (!isLeft && selPanel.type !== 'detail' && selPanel.type !== 'actions') {
        if (S.layout.leftPanels.length < 6) {
          pushUndo();
          S.layout.rightPanels.splice(localIdx, 1);
          S.layout.leftPanels.push(selPanel);
          selPanel.column = 'left';
          designState.selectedIdx = S.layout.leftPanels.length - 1;
          reassignHotkeys();
          S.layoutDirty = true;
        }
      }
      break;
    case 'right': case 'l':
      if (isLeft && S.layout.rightPanels.length < 3) {
        pushUndo();
        S.layout.leftPanels.splice(localIdx, 1);
        const detailIdx = S.layout.rightPanels.findIndex(p => p.type === 'detail');
        const insertAt = detailIdx >= 0 ? detailIdx : S.layout.rightPanels.length;
        S.layout.rightPanels.splice(insertAt, 0, selPanel);
        selPanel.column = 'right';
        selPanel.hotkey = '';
        designState.selectedIdx = S.layout.leftPanels.length + insertAt;
        reassignHotkeys();
        S.layoutDirty = true;
      }
      break;

    case '+': case '=':
      if (selPanel.type === 'detail' && S.layout.detailHeightPct < 90) {
        pushUndo();
        S.layout.detailHeightPct = Math.min(90, S.layout.detailHeightPct + 5);
        S.layoutDirty = true;
      } else if (isLeft && S.layout.leftWidth < 60) {
        pushUndo();
        S.layout.leftWidth = Math.min(60, S.layout.leftWidth + 2);
        S.layoutDirty = true;
      }
      break;
    case '-':
      if (selPanel.type === 'detail' && S.layout.detailHeightPct > 20) {
        pushUndo();
        S.layout.detailHeightPct = Math.max(20, S.layout.detailHeightPct - 5);
        S.layoutDirty = true;
      } else if (isLeft && S.layout.leftWidth > 20) {
        pushUndo();
        S.layout.leftWidth = Math.max(20, S.layout.leftWidth - 2);
        S.layoutDirty = true;
      }
      break;

    case ']':
      resizeFocusedPanelHeight(+5);
      break;
    case '[':
      resizeFocusedPanelHeight(-5);
      break;

    case 't':
      // Enter title-edit sub-mode for the currently focused panel.
      // The sub-mode flag sits ABOVE designMode in the modeChain so
      // this handler is skipped while editing.
      enterDesignTitleEdit();
      break;

    case 'u':
      undo();
      break;
    case 'ctrl-r':
      redo();
      break;

    // Enter and q/Esc both exit design mode without writing. Use
    // `:save-layout` to persist runtime changes.
    case 'return':
    case 'q': case 'escape': {
      const cb = designState.onDone;
      designState = null;
      dragState = null;
      S.designMode = false;
      cb();
      return;
    }
  }

  const newAll = allDesignPanels();
  if (designState.selectedIdx >= newAll.length) designState.selectedIdx = newAll.length - 1;
  if (designState.selectedIdx < 0) designState.selectedIdx = 0;
}

function reassignHotkeys() {
  S.layout.leftPanels.forEach((p, i) => { p.hotkey = String(i + 1); });
  S.layout.rightPanels.forEach(p => {
    if (p.type === 'actions') p.hotkey = '0';
    else if (p.type === 'detail') p.hotkey = 'o';
    else p.hotkey = '';
  });
}

// ---------------------------------------------------------------- title edit

function enterDesignTitleEdit() {
  if (!designState) return;
  const all = allDesignPanels();
  const panel = all[designState.selectedIdx];
  if (!panel) return;
  titleEditPanel = panel;
  titleEditBuf = panel.title || '';
  S.designTitleEditMode = true;
}

/**
 * Sub-mode key handler — installed in dispatch.js's modeChain ABOVE
 * the designMode handler. Esc cancels (no commit), Enter commits if
 * the buffer is non-empty, Backspace edits, printable chars append.
 */
function handleDesignTitleEditKey(key, seq) {
  if (key === 'escape') {
    S.designTitleEditMode = false;
    titleEditPanel = null;
    titleEditBuf = '';
    return;
  }
  if (key === 'return') {
    if (titleEditPanel && titleEditBuf.length > 0 && titleEditBuf !== titleEditPanel.title) {
      pushUndo();
      titleEditPanel.title = titleEditBuf;
      S.layoutDirty = true;
    }
    S.designTitleEditMode = false;
    titleEditPanel = null;
    titleEditBuf = '';
    return;
  }
  if (key === 'backspace' || seq === '\x7f' || seq === '\b') {
    titleEditBuf = titleEditBuf.slice(0, -1);
    return;
  }
  // Append a single printable character. Multi-char sequences (arrow
  // keys, function keys, etc.) are ignored — title is a single-line
  // text field.
  if (seq && seq.length === 1 && seq >= ' ' && seq < '\x7f') {
    titleEditBuf += seq;
  }
}

function titleEditText() {
  return titleEditBuf;
}

module.exports = {
  enterDesign, handleDesignKey, renderDesignOverlay, getDesignFooter,
  onMouseEvent,
  handleDesignTitleEditKey, titleEditText,
  // Exported for tests — pure functions, no module state.
  pointToDropTarget, pointToResizeTarget,
  // Exported for :restore-layout to clear undo when the layout is
  // reset from disk.
  _clearUndoStacks,
  // Test helpers: peek at internals.
  _getDragState:  () => dragState,
  _getUndoDepth:  () => undoStack.length,
  _getRedoDepth:  () => redoStack.length,
};
