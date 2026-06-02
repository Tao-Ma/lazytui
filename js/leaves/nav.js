/**
 * Pure leaf for per-panel nav chrome (cursor / scroll / multiSel / filter).
 *
 * Phase 4a moved cursor/scroll/multiSel onto each Navigator's slice;
 * Phase 4c folded the committed filter text in. v0.6.1 Phase 3 collapses
 * single-panel Components' nav from `slice.nav[panelType]` to a direct
 * entry at `slice.nav` — one entry per instance. Multi-panel Components
 * (today: `files` owning `files` + `file-browser`) keep the panelType-
 * keyed shape until Phase 4 mints separate instances per panelType.
 *
 * **Slice shape** (detected by presence of `cursor` on slice.nav):
 *   - single-panel Component: `slice.nav = { cursor, scroll, multiSel,
 *                                            filter }`
 *   - multi-panel Component:  `slice.nav[panelType] = { cursor, scroll,
 *                                                       multiSel, filter }`
 *
 * **Pure-TEA shape:** returns a NEW slice with the matching nav entry
 * replaced. Returns `undefined` when the Msg is not a nav Msg — the
 * caller's signal to keep handling.
 *
 * Msg shapes (`panel:` field carried on every Msg; ignored when the
 * slice is single-shape):
 *
 *   { type: 'set_cursor',         panel?, index }
 *   { type: 'set_scroll',         panel?, offset }
 *   { type: 'multisel_toggle',    panel?, id }
 *   { type: 'multisel_select_all',panel?, ids }
 *   { type: 'multisel_clear',     panel? }
 *   { type: 'set_filter',         panel?, text }
 *   { type: 'clear_filter',       panel? }
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
    case 'set_cursor': {
      const cursor = msg.index | 0;
      return cursor === entry.cursor ? entry : { ...entry, cursor };
    }
    case 'set_scroll': {
      const scroll = msg.offset | 0;
      return scroll === entry.scroll ? entry : { ...entry, scroll };
    }
    case 'multisel_toggle': {
      const next = new Set(entry.multiSel);
      if (next.has(msg.id)) next.delete(msg.id); else next.add(msg.id);
      return { ...entry, multiSel: next };
    }
    case 'multisel_select_all': {
      // Skip the allocation when every id is already in the Set —
      // filter_key dispatches this each keystroke; the typical "still
      // selected" case shouldn't churn the slice.
      const ids = msg.ids || [];
      let added = false;
      for (const id of ids) { if (!entry.multiSel.has(id)) { added = true; break; } }
      if (!added) return entry;
      const next = new Set(entry.multiSel);
      for (const id of ids) next.add(id);
      return { ...entry, multiSel: next };
    }
    case 'multisel_clear':
      // Skip the allocation if the Set was already empty — common path on
      // re-clears + on group changes where the panel had no selection.
      return entry.multiSel.size === 0 ? entry : { ...entry, multiSel: new Set() };
    case 'set_filter': {
      const text = typeof msg.text === 'string' ? msg.text : '';
      return text === entry.filter ? entry : { ...entry, filter: text };
    }
    case 'clear_filter':
      return entry.filter === '' ? entry : { ...entry, filter: '' };
    default:
      return entry;
  }
}

/**
 * Apply a nav Msg to `slice`. Returns a NEW slice (with the matching
 * nav entry replaced) on match, the same slice if no matching entry
 * (quietly drop — not this Component's panel), or `undefined` to
 * signal "not a nav Msg" so the Component's own update can take over.
 *
 * Detects shape by presence of `cursor` on slice.nav: direct entry
 * (single-panel Component) vs panel-keyed map (multi-panel Component).
 */
function apply(slice, msg) {
  if (!isNavMsg(msg)) return undefined;
  if (!slice || !slice.nav) return slice;
  // Single-panel: slice.nav IS the entry.
  if ('cursor' in slice.nav) {
    const nextEntry = _stepEntry(slice.nav, msg);
    if (nextEntry === slice.nav) return slice;
    return { ...slice, nav: nextEntry };
  }
  // Multi-panel: slice.nav[msg.panel] is the entry.
  const entry = slice.nav[msg.panel];
  if (!entry) return slice;        // not this Component's panel; quietly drop
  const nextEntry = _stepEntry(entry, msg);
  if (nextEntry === entry) return slice;
  return { ...slice, nav: { ...slice.nav, [msg.panel]: nextEntry } };
}

module.exports = { init, apply, isNavMsg, NAV_TYPES };
