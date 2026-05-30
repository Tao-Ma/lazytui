/**
 * Pure leaf for per-panel nav chrome (cursor / scroll / multiSel / filter).
 *
 * Phase 4a moved cursor/scroll/multiSel onto each Navigator's slice;
 * Phase 4c folded the committed filter text in too. All four fields live
 * at `slice.nav[panelType] = { cursor, scroll, multiSel, filter }`. One
 * shared transform handles every Navigator — each Component's update()
 * calls `apply(slice, msg)` first and falls through on miss.
 *
 * **Pure-TEA shape:** returns a NEW slice with the matching nav entry
 * replaced (other entries pass through by reference; the rest of the
 * slice is shallow-spread). Returns `undefined` when the Msg is not a
 * nav Msg — the caller's signal to keep handling.
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
 * Compute the next nav entry for `msg`. Pure: doesn't mutate `entry`.
 * Returns either the same entry (no-op for unknown msg.type — already
 * filtered by isNavMsg, but a defensive fall-through stays) or a new
 * entry with the updated field. multiSel uses copy-on-write Set ops.
 */
function _stepEntry(entry, msg) {
  switch (msg.type) {
    case 'set_cursor':
      return { ...entry, cursor: msg.index | 0 };
    case 'set_scroll':
      return { ...entry, scroll: msg.offset | 0 };
    case 'multisel_toggle': {
      const next = new Set(entry.multiSel);
      if (next.has(msg.id)) next.delete(msg.id); else next.add(msg.id);
      return { ...entry, multiSel: next };
    }
    case 'multisel_select_all': {
      const next = new Set(entry.multiSel);
      for (const id of (msg.ids || [])) next.add(id);
      return { ...entry, multiSel: next };
    }
    case 'multisel_clear':
      // Skip the allocation if the Set was already empty — common path on
      // re-clears + on group changes where the panel had no selection.
      return entry.multiSel.size === 0 ? entry : { ...entry, multiSel: new Set() };
    case 'set_filter':
      return { ...entry, filter: typeof msg.text === 'string' ? msg.text : '' };
    case 'clear_filter':
      return entry.filter === '' ? entry : { ...entry, filter: '' };
    default:
      return entry;
  }
}

/**
 * Apply a nav Msg to `slice`. Returns a NEW slice (with the matching
 * nav entry replaced) on match, the same slice if `nav` or `nav[panel]`
 * is missing (quietly drop — not this Component's panel), or `undefined`
 * to signal "not a nav Msg" so the Component's own update can take over.
 */
function apply(slice, msg) {
  if (!isNavMsg(msg)) return undefined;
  if (!slice || !slice.nav) return slice;
  const entry = slice.nav[msg.panel];
  if (!entry) return slice;        // not this Component's panel; quietly drop
  const nextEntry = _stepEntry(entry, msg);
  if (nextEntry === entry) return slice;
  return { ...slice, nav: { ...slice.nav, [msg.panel]: nextEntry } };
}

module.exports = { init, apply, isNavMsg, NAV_TYPES };
