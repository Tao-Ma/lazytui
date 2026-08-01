/**
 * Per-tab state store — pure, pane-agnostic (docs/pane-tabs-unification.md, P1).
 *
 * A slice carries `tabState`, a keyed map `{ <tabKey>: { <field>: value } }`
 * where each entry holds one tab's persisted view state (scroll / cursor /
 * filter / selection / search …). These four accessors are the whole store
 * mechanism, consumed through the tab-container contract's `perTabState` verb
 * (leaves/wm/tab-container.js). Since U2f a position tab's view state lives
 * NATIVELY on its own instance slice — this keyed store remains the mechanics
 * behind the container verb, not the primary home it was when the viewer
 * Component multiplexed tabs over one slice.
 *
 * What lives HERE: the store mechanics (read a field with a fallback, merge a
 * field/patch immutably, drop an entry). What stays per-caller: the KEY scheme
 * and which tabs exist. Pure leaf — no model/global reads, no imports.
 */
'use strict';

/** Read tab `key`'s `field`, or `fallback` when unset. A stored 0 / null / ''
 *  wins over the fallback (presence, not truthiness). */
function field(slice, key, name, fallback) {
  if (!slice || !slice.tabState || !key) return fallback;
  const entry = slice.tabState[key];
  if (!entry || !(name in entry)) return fallback;
  return entry[name];
}

/** Read tab `key`'s whole entry (every stored field at once), or null when
 *  unset. The one home for "grab the entry" — a tab_switch restore reads
 *  scroll/search/select/cursor together — shared by the tab-container
 *  perTabState accessor and pane-tabs' restore, so the raw `slice.tabState[key]`
 *  reach lives in exactly one place. */
function entry(slice, key) {
  if (!slice || !slice.tabState || !key) return null;
  return slice.tabState[key] || null;
}

/** Merge one field into tab `key`, returning a fresh slice. No-key = no-op;
 *  an unchanged value preserves the slice identity (cheap re-render). */
function withField(slice, key, name, value) {
  if (!key) return slice;
  const tabState = slice.tabState || {};
  const cur = tabState[key] || {};
  if (cur[name] === value) return slice;
  return { ...slice, tabState: { ...tabState, [key]: { ...cur, [name]: value } } };
}

/** Merge several fields into tab `key` in one write (e.g. scroll + a sticky
 *  bit that must land together). No-key / no-patch = no-op. */
function withFields(slice, key, patch) {
  if (!key || !patch) return slice;
  const tabState = slice.tabState || {};
  const cur = tabState[key] || {};
  return { ...slice, tabState: { ...tabState, [key]: { ...cur, ...patch } } };
}

/** Drop tab `key`'s entry (a tab was removed) so a stale entry can't be
 *  restored onto a later tab that reuses the key. No-op when absent. */
function dropEntry(slice, key) {
  if (!slice || !slice.tabState || !(key in slice.tabState)) return slice;
  const { [key]: _drop, ...rest } = slice.tabState;
  return { ...slice, tabState: rest };
}

module.exports = { field, entry, withField, withFields, dropEntry };
