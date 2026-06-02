/**
 * Design mode — read-side helpers for free-config.
 *
 * The keyboard handler, title-edit sub-mode, undo/redo, and mouse drag/resize
 * state machine all live in the reducer (runtime: free_config_* / free_config_mouse_*
 * Msgs) backed by the dependency-free `leaves/free-config` leaf. The drag-target
 * affordance is now the live layout preview painted by render/layout.js
 * (swaps slice.arrange for drag.previewArrange during the paint pass), so
 * this file holds no overlay paint of its own — just the free-config footer
 * text (getFreeConfigFooter), the title-edit buffer accessor, and a small set
 * of test-facing shims that drive the real reducer path.
 *
 * Save is decoupled: `:save-layout` writes the runtime layout to YAML,
 * `:restore-layout` reverts it and clears undo history.
 */
'use strict';

const { esc } = require('../io/ansi');
const { cols } = require('../io/term');
const { getModel } = require('../app/runtime');
const { getInstanceSlice } = require('../panel/api');
const mfc = require('../leaves/free-config');

// The layout Component's slice + its design sub-slice (Phase 1f). Lazy
// because tests can boot without layout. Post-1e the read helpers take the
// slice directly — model isn't threaded into mfc anymore.
function _slice() { return getInstanceSlice('layout'); }
function _design() {
  const slice = _slice();
  return slice ? slice.freeConfig : null;
}

function panelTitle(type) {
  const slice = _slice();
  if (!slice) return type;
  const p = mfc.allFreeConfigPanels(slice).find(x => x.type === type);
  return p ? p.title : type;
}

/**
 * Footer text contribution for renderFooter (read when freeConfigMode is set).
 * Idle: ` | <title> (<column>)`. Dragging: includes the live drop target.
 */
function getFreeConfigFooter() {
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
      // Self-swap (source == occupant) is valid but a no-op on release;
      // rendering it as "swap X" in bold yellow looks like a real action
      // and primed the user to expect a move that doesn't come.
      if (t.occupantType === drag.sourceType) {
        return ` | dragging ${esc(srcTitle)} → [dim](no-op — release to cancel)[/]`;
      }
      return ` | dragging ${esc(srcTitle)} → [bold yellow]swap[/] ${esc(panelTitle(t.occupantType))} (col ${t.columnIndex + 1})`;
    }
    if (t.kind === 'new_column') {
      return ` | dragging ${esc(srcTitle)} → [bold green]new column[/] at position ${t.position + 1}`;
    }
    const clampSuffix = t.clamp ? ` [dim](clamped — ${esc(t.clamp)})[/]` : '';
    return ` | dragging ${esc(srcTitle)} → col ${t.columnIndex + 1} @ ${t.index}${clampSuffix}`;
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
      const reason = t.kind === 'replace' ? (t.reason || 'detail is essential') : (t.reason || `col ${t.columnIndex + 1} blocked`);
      return ` | from pool: ${esc(srcTitle)} → [red]✗ ${reason}[/]`;
    }
    if (t.kind === 'replace') {
      return ` | from pool: ${esc(srcTitle)} → [bold yellow]replace[/] ${esc(t.occupantId)} (col ${t.columnIndex + 1})`;
    }
    if (t.kind === 'new_column') {
      return ` | from pool: ${esc(srcTitle)} → [bold green]new column[/] at position ${t.position + 1}`;
    }
    const clampSuffix = t.clamp ? ` [dim](clamped — ${esc(t.clamp)})[/]` : '';
    return ` | from pool: ${esc(srcTitle)} → [bold green]insert[/] at col ${t.columnIndex + 1}:${t.index}${clampSuffix}`;
  }
  const slice = _slice();
  const all = slice ? mfc.allFreeConfigPanels(slice) : [];
  const sel = slice ? all[mfc.selectedIdx(slice)] : null;
  return sel ? ` | ${esc(sel.title)} (col ${(sel.columnIndex != null ? sel.columnIndex + 1 : '?')})` : '';
}

/** Title-edit footer text — the live buffer (reads the layout slice). */
function titleEditText() {
  const d = _design();
  return d ? d.titleEdit.text : '';
}

/** `:restore-layout` escape hatch — wipe the session's undo history when the
 *  user resets the layout from disk. Production routes through the layout
 *  Component (`free_config_clear_undo` Msg); this test-only shim mirrors that. */
function _clearUndoStacks() {
  const api = require('../panel/api');
  api.dispatchMsg(api.wrap('layout', { type: 'free_config_clear_undo' }));
}

// --- test-facing shims (production drives these via input.js → applyMsg /
//     the reducer's free_config_mouse_* branches; tests keep the old call shape) ---

function onMouseEvent(kind, mx, my) {
  const msg = kind === 'press'  ? { type: 'free_config_mouse_press',  mx, my, cols: cols() }
            : kind === 'motion' ? { type: 'free_config_mouse_motion', mx, my, cols: cols() }
            : kind === 'release' ? { type: 'free_config_mouse_release' }
            : null;
  if (msg) {
    const api = require('../panel/api');
    api.dispatchMsg(api.wrap('layout', msg));
  }
}

function pointToResizeTarget(mx, my) { return mfc.pointToResizeTarget(_slice(), mx, my, cols()); }
function pointToDropTarget(srcType, mx, my) { return mfc.pointToDropTarget(_slice(), srcType, mx, my, cols()); }

module.exports = {
  getFreeConfigFooter, titleEditText,
  onMouseEvent,
  pointToDropTarget, pointToResizeTarget,
  _clearUndoStacks,
  _getDragState:  () => _design()?.drag,
  _getUndoDepth:  () => _design()?.undo.length,
  _getRedoDepth:  () => _design()?.redo.length,
};
