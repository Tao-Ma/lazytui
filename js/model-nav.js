/**
 * Pure leaf for per-panel nav chrome (cursor / scroll / multiSel).
 *
 * Phase 4a moved nav chrome off the root model and into each Navigator
 * Component's slice under `slice.nav[panelType] = { cursor, scroll,
 * multiSel }`. The same five Msg shapes apply to every Navigator, so
 * the handlers live here as a shared pure transform — each Navigator's
 * update() calls `apply(slice, msg)` first and falls through on miss.
 *
 * Returns `slice` (passed through, with the matching nav entry mutated
 * in place) when a nav Msg matched, or `undefined` when the Msg is not
 * a nav Msg — the caller's signal to keep handling.
 *
 * Msg shapes (all carry `panel:` so multi-panel-type Components — `files`
 * owns `files` + `file-browser` — disambiguate which nav entry to write):
 *
 *   { type: 'set_cursor',         panel, index }
 *   { type: 'set_scroll',         panel, offset }
 *   { type: 'multisel_toggle',    panel, id }
 *   { type: 'multisel_select_all',panel, ids }
 *   { type: 'multisel_clear',     panel }
 */
'use strict';

const NAV_TYPES = new Set([
  'set_cursor', 'set_scroll',
  'multisel_toggle', 'multisel_select_all', 'multisel_clear',
]);

function isNavMsg(msg) {
  return !!(msg && typeof msg.type === 'string' && NAV_TYPES.has(msg.type));
}

/** Init a fresh nav entry. Multi-panel Components seed one per panel type. */
function init() {
  return { cursor: 0, scroll: 0, multiSel: new Set() };
}

/**
 * Apply a nav Msg to `slice`. Mutates the matching `slice.nav[msg.panel]`
 * in place (mirrors the in-place style of the other reducer leaves —
 * model-design / model-register / model-search / model-tabs). Returns the
 * passed slice on match, or `undefined` to signal "not a nav Msg" so the
 * Component's own update can take over.
 */
function apply(slice, msg) {
  if (!isNavMsg(msg)) return undefined;
  if (!slice || !slice.nav) return slice;
  const entry = slice.nav[msg.panel];
  if (!entry) return slice;        // not this Component's panel; quietly drop
  switch (msg.type) {
    case 'set_cursor':
      entry.cursor = msg.index | 0;
      return slice;
    case 'set_scroll':
      entry.scroll = msg.offset | 0;
      return slice;
    case 'multisel_toggle': {
      if (entry.multiSel.has(msg.id)) entry.multiSel.delete(msg.id);
      else entry.multiSel.add(msg.id);
      return slice;
    }
    case 'multisel_select_all':
      for (const id of (msg.ids || [])) entry.multiSel.add(id);
      return slice;
    case 'multisel_clear':
      entry.multiSel.clear();
      return slice;
    default:
      return slice;
  }
}

module.exports = { init, apply, isNavMsg, NAV_TYPES };
