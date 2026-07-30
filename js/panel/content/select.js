/**
 * Detail-panel text selection — the viewer's selection STATE + service layer.
 *
 * The pure geometry (display-col ↔ codepoint mapping, selected-text extraction,
 * reverse-highlight decoration) now lives in the shared bottom leaf
 * `leaves/text/select-core.js`, which BOTH the viewer (here) and the per-pane
 * selection used by every other pane (docs/pane-selection.md) delegate to — one
 * source of truth for the geometry. This module is the viewer-specific half: it
 * owns the coordinate contract and the impure service (read the detail slice's
 * `select`, dispatch the `select_*` Msgs, push a commit to the yank register).
 *
 * Coordinate system (unchanged): the selection lives in ABSOLUTE detail-line
 * indices and DISPLAY columns, so it stays anchored to content as the user
 * scrolls; a 2-cell CJK glyph occupies cols [c, c+1] and clicking either resolves
 * to that char. Kinds: 'char' (drag / vim `v`) and 'line' (vim `V`). Selection is
 * transient — after commit()/cancel() `select.active` is false; the register
 * keeps the value (mirrored to the OS clipboard via OSC 52).
 *
 * Why the viewer keeps its OWN selection state (not the shared model.selection):
 * the viewer's is PER-TAB persisted and driven by a keyboard visual-mode state
 * machine — neither fits a single-owner model field. The two backends share the
 * geometry core, not the state shape.
 */
'use strict';

const { getInstanceSlice } = require('../api');
const core = require('../../leaves/text/select-core');

// All reads target the active content-slot instance (info / text-view / transcript):
// its lines / select / cursor / scroll / search. resolveTarget lands on the focused
// slot's ACTIVE tab in multi-content setups; undefined if none is placed (callers
// null-guard).
function _detail() {
  const route = require('../../panel/route');
  return getInstanceSlice(route.resolveTarget('viewer'));
}

// The displayed lines — the active content instance stores its buffer on
// slice.lines directly (U2f — the viewer's flat-strip derivation is gone).
function _lines() {
  const sl = _detail();
  return (sl && Array.isArray(sl.lines)) ? sl.lines : [];
}

// Selection writes fold onto the update spine (select_* Msgs). This module can't
// be imported by the reducer (runtime cycle), so the mouse path calls these
// service fns and they dispatch to the focused-or-sticky viewer. null target =
// no viewer, drop.
function _apply(msg) {
  const route = require('../../panel/route');
  const target = route.resolveTarget('viewer');
  if (!target) return;
  require('../../hosts/panel-host').dispatchMsg(route.wrap(target, msg));
}

// ── Service API (impure — read/write the viewer slice) ──────────────────────

function beginAt(line, col, kind) { _apply({ type: 'select_begin', line, col, kind }); }
function extendTo(line, col)       { _apply({ type: 'select_extend', line, col }); }
function cancel()                  { _apply({ type: 'select_cancel' }); }

function isActive() {
  const sel = _detail()?.select;
  return !!(sel && sel.active);
}

// (U2f — `activeSelection` retired with the viewer's render: each content
// instance (info / text-view) resolves its OWN `slice.select` in its render path
// now, so the cross-pane focused-viewer selection accessor has no caller.)

/** The current selection resolved to plain text (from the live viewer lines). */
function selectedText() { return core.selectedTextFrom(_lines(), _detail()?.select); }

/**
 * Commit the current selection: push to the register, clear active. Returns the
 * text ('' if nothing active). register_push is a ROOT-reducer Msg (model.register
 * on the root), so route via applyMsg, not the Component fan-out.
 */
function commit() {
  const sel = _detail()?.select;
  if (!sel || !sel.active) return '';
  const text = selectedText();
  _apply({ type: 'select_cancel' });
  if (text) require('../../hosts/panel-host').applyMsg({ type: 'register_push', text });
  return text;
}

/**
 * Settle a mouse drag on release: push the selected text to the register
 * (auto-copy) but KEEP the selection active so it persists — highlighted and
 * offered to the right-click "Copy selection" — until the next press. A bare
 * click (press→release, no motion) leaves anchor === cursor: a zero-width char
 * "selection" whose selectedText would still yank a stray char AND trap keyboard
 * nav in visual mode, so cancel it instead. (A 'line'-kind click still settles —
 * a single line-mode click is a deliberate full-line pick.)
 */
function settle() {
  const sel = _detail()?.select;
  if (!sel || !sel.active) return '';
  const noDrag = sel.kind !== 'line'
    && sel.anchor.line === sel.cursor.line
    && sel.anchor.col === sel.cursor.col;
  const text = noDrag ? '' : selectedText();
  if (!text) { _apply({ type: 'select_cancel' }); return ''; }
  require('../../hosts/panel-host').applyMsg({ type: 'register_push', text });
  return text;  // active stays true → persistent selection (highlight + copyable)
}

/**
 * Apply the active selection's highlight to a window of content lines. Thin
 * impure wrapper over the shared core: reads the live viewer selection and
 * decorates the given window (`opts.offset` = the window's absolute start).
 * Returns `lines` unchanged when there is no active selection.
 */
function decorateLines(lines, opts) {
  return core.decorateWindow(lines, _detail()?.select, (opts && opts.offset) || 0);
}

module.exports = {
  // Service (impure — the mouse path + render read/write the viewer slice).
  beginAt, extendTo, cancel, commit, settle, isActive, selectedText, decorateLines,
  // PURE geometry, re-exported from the shared core so the viewer's reducer arms
  // (which thread `lines` in explicitly) and tests keep the same surface.
  selectedTextFrom: core.selectedTextFrom,
  plainLineWidthFrom: core.plainLineWidthFrom,
  highlightLine: core.highlightLine,
};
