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
 * the config file via `js/yaml-layout.js`. Exiting design mode with
 * `q`, `Esc`, or Enter does NOT auto-write — the user runs
 * `:save-layout` when they want their changes on disk.
 *
 * **Drag-and-drop (Phase 2).** When design mode is active, mouse
 * press on a panel arms the drag. Motion ≥1 cell from the press
 * point enters dragging state and paints an insertion line at the
 * drop target. Release commits the drop (or snaps back on invalid
 * target). Mode 1002 mouse reporting (button-with-motion) carries
 * the events; press/motion/release fan out from `js/input.js`'s
 * `handleMouse` into `onMouseEvent` here.
 *
 * Keys (still work; mouse is additive):
 *   ↑/↓       Select panel
 *   J/K       Reorder panel within column (shift+j/k)
 *   ←/→       Move panel between columns
 *   +/-       Resize (left width or detail height %)
 *   Enter     Exit design mode (does NOT save — use :save-layout)
 *   q/Esc     Exit design mode (does NOT save — use :save-layout)
 */
'use strict';

const { esc, RESET, richToAnsi } = require('./ansi');
const { cols, rows, stdout } = require('./term');
const { S } = require('./state');

let designState = null; // null when not in design mode
// Drag lifecycle: null → armed(press, no motion yet) → dragging (motion seen).
// Captured at press time; cleared on release. `target` is recomputed on every
// motion event so renderDesignOverlay can paint the current drop indicator.
let dragState = null;

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
  S.designMode = true;
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
      applyDrop(dragState.sourceType, dragState.target);
    }
    dragState = null;
    return;
  }
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
        [column[localIdx], column[localIdx - 1]] = [column[localIdx - 1], column[localIdx]];
        designState.selectedIdx--;
        reassignHotkeys();
        S.layoutDirty = true;
      }
      break;
    case 'J':
      if (localIdx < column.length - 1) {
        [column[localIdx], column[localIdx + 1]] = [column[localIdx + 1], column[localIdx]];
        designState.selectedIdx++;
        reassignHotkeys();
        S.layoutDirty = true;
      }
      break;

    case 'left': case 'h':
      if (!isLeft && selPanel.type !== 'detail' && selPanel.type !== 'actions') {
        if (S.layout.leftPanels.length < 6) {
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
      if (selPanel.type === 'detail') {
        S.layout.detailHeightPct = Math.min(90, S.layout.detailHeightPct + 5);
        S.layoutDirty = true;
      } else if (isLeft) {
        S.layout.leftWidth = Math.min(60, S.layout.leftWidth + 2);
        S.layoutDirty = true;
      }
      break;
    case '-':
      if (selPanel.type === 'detail') {
        S.layout.detailHeightPct = Math.max(20, S.layout.detailHeightPct - 5);
        S.layoutDirty = true;
      } else if (isLeft) {
        S.layout.leftWidth = Math.max(20, S.layout.leftWidth - 2);
        S.layoutDirty = true;
      }
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

module.exports = {
  enterDesign, handleDesignKey, renderDesignOverlay, getDesignFooter,
  onMouseEvent,
  // Exported for tests — pure, takes (srcType, mx, my) and reads
  // S.panelBounds + S.layout. No side effects.
  pointToDropTarget,
  // Test helper: peek at the internal drag state.
  _getDragState: () => dragState,
};
