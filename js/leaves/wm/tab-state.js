/**
 * Per-tab state store — pure, pane-agnostic (docs/pane-tabs-unification.md, P1).
 *
 * A pane's slice carries `tabState`, a keyed map `{ <tabKey>: { <field>: value } }`
 * where each entry holds one tab's persisted view state (scroll / cursor /
 * filter / selection / search …). These four accessors are the whole store
 * mechanism; both the viewer (panel/viewer) and — as the arc lands — every
 * other pane read/write per-tab state through them.
 *
 * What lives HERE: the store mechanics (read a field with a fallback, merge a
 * field/patch immutably, drop an entry). What stays per-pane: the KEY scheme and
 * which tabs exist (the viewer's `<group>:<kind>:<key>` keys live in
 * leaves/wm/pane-tabs). Pure leaf — no model/global reads, no imports.
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

module.exports = { field, withField, withFields, dropEntry };
