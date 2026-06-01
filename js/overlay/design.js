/**
 * Design mode — read-side helpers for free-config.
 *
 * The keyboard handler, title-edit sub-mode, undo/redo, and mouse drag/resize
 * state machine all live in the reducer (runtime: design_* / design_mouse_*
 * Msgs) backed by the dependency-free `leaves/design` leaf. The drag-target
 * affordance is now the live layout preview painted by render/layout.js
 * (swaps slice.arrange for drag.previewArrange during the paint pass), so
 * this file holds no overlay paint of its own — just the free-config footer
 * text (getDesignFooter), the title-edit buffer accessor, and a small set
 * of test-facing shims that drive the real reducer path.
 *
 * Save is decoupled: `:save-layout` writes the runtime layout to YAML,
 * `:restore-layout` reverts it and clears undo history.
 */
'use strict';

const { esc } = require('../io/ansi');
const { cols } = require('../io/term');
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
    if (t.kind === 'swap') {
      return ` | dragging ${esc(srcTitle)} → [bold yellow]swap[/] ${esc(panelTitle(t.occupantType))} (${t.column})`;
    }
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
    return ` | from pool: ${esc(srcTitle)} → [bold green]insert[/] at ${t.column}:${t.index}`;
  }
  const slice = _slice();
  const all = slice ? mdesign.allDesignPanels(slice) : [];
  const sel = slice ? all[mdesign.selectedIdx(slice)] : null;
  return sel ? ` | ${esc(sel.title)} (${sel.column})` : '';
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
  getDesignFooter, titleEditText,
  onMouseEvent,
  pointToDropTarget, pointToResizeTarget,
  _clearUndoStacks,
  _getDragState:  () => _design()?.drag,
  _getUndoDepth:  () => _design()?.undo.length,
  _getRedoDepth:  () => _design()?.redo.length,
};
