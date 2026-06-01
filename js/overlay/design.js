/**
 * Design mode — interactive panel layout editor (render half).
 *
 * Fully folded onto the update spine: the keyboard handler, the title-edit
 * sub-mode, undo/redo, AND the mouse drag/resize state machine now live in the
 * reducer (runtime: design_* / design_mouse_* Msgs) backed by the
 * dependency-free `leaves/design` leaf. design.js is now render-only — the
 * overlay (drag insertion line) + the footer text — reading the owned model
 * via getModel(). The drag/resize gesture state lives on model.modal.design
 * .drag; the working draft IS getModel().layout.
 *
 * Save is decoupled: `:save-layout` writes the runtime layout to YAML,
 * `:restore-layout` reverts it and clears undo history.
 *
 * The remaining non-render exports (onMouseEvent + the pointTo* hit-tests) are
 * thin TEST-FACING shims that drive the real reducer path (applyMsg) / inject
 * the owned model + terminal width into the leaf hit-tests.
 */
'use strict';

const { esc, RESET, richToAnsi } = require('../io/ansi');
const { cols, stdout } = require('../io/term');
const { getModel } = require('../app/runtime');
const { getComponentSlice } = require('../panel/api');
const mdesign = require('../leaves/design');

// The layout Component's slice + its design sub-slice (Phase 1f). Lazy
// because tests can boot without layout. Post-1e the read helpers take the
// slice directly — model isn't threaded into mdesign anymore.
function _slice() { return getComponentSlice('layout'); }
function _design() {
  const slice = _slice();
  return slice ? slice.design : null;
}

function panelTitle(type) {
  const slice = _slice();
  if (!slice) return type;
  const p = mdesign.allDesignPanels(slice).find(x => x.type === type);
  return p ? p.title : type;
}

/**
 * Footer text contribution for renderFooter (read when freeConfigMode is set).
 * Idle: ` | <title> (<column>)`. Dragging: includes the live drop target.
 */
function getDesignFooter() {
  if (!getModel().modes.freeConfigMode) return '';
  const d = _design();
  if (!d) return '';
  const drag = d.drag;
  if (drag && drag.kind === 'dragging') {
    const t = drag.target;
    const srcTitle = panelTitle(drag.sourceType);
    if (!t) return ` | dragging ${esc(srcTitle)} → [yellow](drop outside)[/]`;
    if (!t.valid) return ` | dragging ${esc(srcTitle)} → [red]✗ ${esc(t.reason || 'blocked')}[/]`;
    return ` | dragging ${esc(srcTitle)} → ${t.column} @ ${t.index}`;
  }
  // v0.6 — pool drag from the panel-list overlay. The overlay closes
  // at drag-start so the layout drop targets are visible; this footer
  // is the only live indicator of what's being dragged.
  if (drag && (drag.kind === 'pool-armed' || drag.kind === 'pool-dragging')) {
    const slice = _slice();
    const entry = slice && slice.arrange.pool ? slice.arrange.pool[drag.sourceId] : null;
    const srcTitle = entry ? (entry.title || entry.id) : drag.sourceId;
    if (drag.kind === 'pool-armed') {
      return ` | from pool: ${esc(srcTitle)} → [dim](move to drop)[/]`;
    }
    const t = drag.target;
    if (!t)             return ` | from pool: ${esc(srcTitle)} → [yellow](drop outside cancels)[/]`;
    if (!t.valid) {
      const reason = t.kind === 'replace' ? 'detail is essential' : `${t.column} column is full`;
      return ` | from pool: ${esc(srcTitle)} → [red]✗ ${reason}[/]`;
    }
    if (t.kind === 'replace') {
      return ` | from pool: ${esc(srcTitle)} → [bold yellow]replace[/] ${esc(t.occupantId)} (${t.column})`;
    }
    return ` | from pool: ${esc(srcTitle)} → [bold green]append[/] to ${t.column}`;
  }
  const slice = _slice();
  const all = slice ? mdesign.allDesignPanels(slice) : [];
  const sel = slice ? all[mdesign.selectedIdx(slice)] : null;
  return sel ? ` | ${esc(sel.title)} (${sel.column})` : '';
}

/**
 * Pool-drag drop-target affordance: paints a colored frame on the
 * target cell (replace) or a colored bar at the column's append slot,
 * so the user can SEE where the dragged pool panel will land. Pure
 * stdout writes at absolute screen positions; reads panelBounds (the
 * frame geometry written by the render pass).
 */
function renderPoolDragOverlay(drag) {
  const layoutSlice = getComponentSlice('layout');
  if (!layoutSlice) return;
  const t = drag.target;
  if (!t) return;

  if (t.kind === 'replace') {
    // Outline the cell that would be replaced. Yellow on a valid
    // replace, red on detail (invalid — see leaves/design#poolDrop).
    const occ = (t.column === 'left' ? layoutSlice.arrange.leftPanels : layoutSlice.arrange.rightPanels)
      .find(p => p.id === t.occupantId);
    if (!occ) return;
    const b = layoutSlice.panelBounds[occ.type];
    if (!b) return;
    const color = t.valid ? 'bold yellow' : 'bold red';
    _drawFrame(b.x, b.y, b.w, b.h, color);
    return;
  }

  // Append: bar painted at the SEAM where the new panel will land.
  //   Left column   → bottom of last cell (panel appends at tail).
  //   Right column  → top of detail (panel inserts before detail,
  //                    keeping detail-at-end convention).
  // Color reflects validity — green when the drop will commit, red
  // when it would be refused (column at cap). Without the red flag
  // the user saw a "valid"-looking green bar, released, and nothing
  // happened (the cancel branch silently fired in poolDragRelease).
  const COLS = cols();
  const leftW = layoutSlice.arrange.leftWidth;
  const colX = t.column === 'left' ? 0 : leftW;
  const colW = t.column === 'left' ? leftW : COLS - leftW;
  const panels = t.column === 'left' ? layoutSlice.arrange.leftPanels : layoutSlice.arrange.rightPanels;
  let lineY = 0;
  if (t.column === 'right') {
    const detail = panels.find(p => p.type === 'detail');
    const b = detail ? layoutSlice.panelBounds[detail.type] : null;
    lineY = b ? b.y : 0;
  } else if (panels.length > 0) {
    const last = layoutSlice.panelBounds[panels[panels.length - 1].type];
    if (last) lineY = last.y + last.h - 1;
  }
  const barColor = t.valid ? 'bold green' : 'bold red';
  const bar = '═'.repeat(Math.max(1, colW));
  stdout.write(`\x1b[${lineY + 1};${colX + 1}H` + richToAnsi(`[${barColor}]${bar}[/]`) + RESET);
}

/** Paint a single-line frame around (x, y, w, h) in the given color.
 *  Used by the pool-drag replace affordance to highlight the cell that
 *  would be replaced without disturbing its content (top, sides, bottom
 *  borders only). The painted characters overwrite the cell's existing
 *  border, so the effect is "the border just lit up in <color>".
 *
 *  All cursor-move + glyph sequences are accumulated into one buffer
 *  and emitted via a single stdout.write — pre-fix this issued 2 + 2*(h-2)
 *  separate writes (one per cell), so a 20-row panel meant 38 syscalls
 *  per drag-motion frame and the frame edges could tear under load. */
function _drawFrame(x, y, w, h, color) {
  if (w < 2 || h < 2) return;
  const tl = '╭', tr = '╮', bl = '╰', br = '╯';
  const top    = `[${color}]${tl}${'─'.repeat(w - 2)}${tr}[/]`;
  const bot    = `[${color}]${bl}${'─'.repeat(w - 2)}${br}[/]`;
  const sideC  = `[${color}]│[/]`;
  let buf = `\x1b[${y + 1};${x + 1}H` + richToAnsi(top) + RESET;
  for (let row = 1; row < h - 1; row++) {
    buf += `\x1b[${y + row + 1};${x + 1}H` + richToAnsi(sideC) + RESET;
    buf += `\x1b[${y + row + 1};${x + w}H` + richToAnsi(sideC) + RESET;
  }
  buf += `\x1b[${y + h};${x + 1}H` + richToAnsi(bot) + RESET;
  stdout.write(buf);
}

/**
 * Paint the design overlay — drop-target affordance during an active drag.
 * Two drag kinds:
 *   - 'dragging'      : reordering an existing panel; paints an insertion
 *                       line at the target seam (green=valid, red=invalid).
 *   - 'pool-dragging' : new panel from the pool; paints a full-cell
 *                       border on REPLACE targets and a colored bar at
 *                       the bottom of the column on APPEND targets, so
 *                       the user can see WHERE the panel will land.
 * Banner / status lives in the footer (getDesignFooter).
 */
function renderDesignOverlay() {
  if (!getModel().modes.freeConfigMode) return;
  const d = _design();
  const drag = d && d.drag;
  if (!drag) return;
  if (drag.kind === 'pool-dragging') { renderPoolDragOverlay(drag); return; }
  if (drag.kind !== 'dragging') return;
  const t = drag.target;
  if (!t) return;

  const COLS = cols();
  const layoutSlice = getComponentSlice('layout');
  const leftW = layoutSlice.arrange.leftWidth;
  const colX = t.column === 'left' ? 0 : leftW;
  const colW = t.column === 'left' ? leftW : COLS - leftW;

  // Resolve insertion y: t.index === 0 → top of column; else bottom edge of
  // the panel at index t.index - 1.
  const panels = t.column === 'left' ? layoutSlice.arrange.leftPanels : layoutSlice.arrange.rightPanels;
  let lineY;
  if (panels.length === 0) {
    lineY = 0;
  } else if (t.index <= 0) {
    const first = layoutSlice.panelBounds[panels[0].type];
    lineY = first ? first.y : 0;
  } else {
    const beforeIdx = Math.min(t.index, panels.length) - 1;
    const before = layoutSlice.panelBounds[panels[beforeIdx].type];
    lineY = before ? before.y + before.h - 1 : 0;
  }

  const color = t.valid ? 'green' : 'red';
  const bar = '═'.repeat(Math.max(1, colW));
  const markup = `[bold ${color}]${bar}[/]`;
  stdout.write(`\x1b[${lineY + 1};${colX + 1}H` + richToAnsi(markup) + RESET);
}

/** Title-edit footer text — the live buffer (reads the layout slice). */
function titleEditText() {
  const d = _design();
  return d ? d.titleEdit.text : '';
}

/** `:restore-layout` escape hatch — wipe the session's undo history when the
 *  user resets the layout from disk. Production routes through the layout
 *  Component (`design_clear_undo` Msg); this test-only shim mirrors that. */
function _clearUndoStacks() {
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('layout', { type: 'design_clear_undo' }));
}

// --- test-facing shims (production drives these via input.js → applyMsg /
//     the reducer's design_mouse_* branches; tests keep the old call shape) ---

function onMouseEvent(kind, mx, my) {
  const msg = kind === 'press'  ? { type: 'design_mouse_press',  mx, my, cols: cols() }
            : kind === 'motion' ? { type: 'design_mouse_motion', mx, my, cols: cols() }
            : kind === 'release' ? { type: 'design_mouse_release' }
            : null;
  if (msg) {
    const api = require('../panel/api');
    api.dispatchMsg(api.wrap('layout', msg));
  }
}

function pointToResizeTarget(mx, my) { return mdesign.pointToResizeTarget(_slice(), mx, my, cols()); }
function pointToDropTarget(srcType, mx, my) { return mdesign.pointToDropTarget(_slice(), srcType, mx, my, cols()); }

module.exports = {
  renderDesignOverlay, getDesignFooter, titleEditText,
  onMouseEvent,
  pointToDropTarget, pointToResizeTarget,
  _clearUndoStacks,
  _getDragState:  () => _design()?.drag,
  _getUndoDepth:  () => _design()?.undo.length,
  _getRedoDepth:  () => _design()?.redo.length,
};
