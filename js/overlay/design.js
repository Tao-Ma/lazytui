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
 * Footer text contribution for renderFooter (read when designMode is set).
 * Idle: ` | <title> (<column>)`. Dragging: includes the live drop target.
 */
function getDesignFooter() {
  if (!getModel().modes.designMode) return '';
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
  const slice = _slice();
  const all = slice ? mdesign.allDesignPanels(slice) : [];
  const sel = all[d.selectedIdx];
  return sel ? ` | ${esc(sel.title)} (${sel.column})` : '';
}

/**
 * Paint the design overlay — just the insertion line during an active drag.
 * Banner / status lives in the footer (getDesignFooter).
 */
function renderDesignOverlay() {
  if (!getModel().modes.designMode) return;
  const d = _design();
  const drag = d && d.drag;
  if (!drag || drag.kind !== 'dragging') return;
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
