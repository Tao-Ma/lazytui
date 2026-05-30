/**
 * Pure leaf for per-panel nav chrome (cursor / scroll / multiSel / filter).
 *
 * Phase 4a moved cursor/scroll/multiSel onto each Navigator's slice;
 * Phase 4c folded the committed filter text in too. All four fields live
 * at `slice.nav[panelType] = { cursor, scroll, multiSel, filter }`. One
 * shared transform handles every Navigator — each Component's update()
 * calls `apply(slice, msg)` first and falls through on miss.
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
 *   { type: 'set_filter',         panel, text }   // Phase 4c
 *   { type: 'clear_filter',       panel }         // Phase 4c
 */
'use strict';

const NAV_TYPES = new Set([
  'set_cursor', 'set_scroll',
  'multisel_toggle', 'multisel_select_all', 'multisel_clear',
  'set_filter', 'clear_filter',
]);

function isNavMsg(msg) {
  return !!(msg && typeof msg.type === 'string' && NAV_TYPES.has(msg.type));
}

/** Init a fresh nav entry. Multi-panel Components seed one per panel type. */
function init() {
  return { cursor: 0, scroll: 0, multiSel: new Set(), filter: '' };
}

/**
 * Apply a nav Msg to `slice`. Mutates the matching `slice.nav[msg.panel]`
 * in place (mirrors the in-place style of the other reducer leaves —
 * leaves/design / leaves/register / leaves/search / leaves/tabs). Returns the
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
    case 'set_filter':
      entry.filter = typeof msg.text === 'string' ? msg.text : '';
      return slice;
    case 'clear_filter':
      entry.filter = '';
      return slice;
    default:
      return slice;
  }
}

module.exports = { init, apply, isNavMsg, NAV_TYPES };
