/**
 * Tab arithmetic + ephemeral-tab lifecycle.
 *
 * The detail panel's tab bar is conceptually:
 *
 *   [Info] [actionTabs...] [termTabs...] [contentTabs...]
 *      0     1..A            A+1..A+T     A+T+1..A+T+C
 *
 * `actionTabs` come from `group.actions[*].tab` (YAML); `termTabs` come
 * from `group.terminals` (YAML) plus the detail slice's `ephemeralTerminals`
 * (runtime, added by plugins via `addEphemeralTab`); `contentTabs` come
 * from the detail slice's `contentTabs` (runtime, added by plugins via
 * `addContentTab` — used by the files panel to open files and any future
 * plugin that wants a read-only content surface in the viewer).
 * The detail slice's `tab` is a single integer indexing this flat list;
 * helpers below do the mapping from integer → kind/item.
 *
 * The MUTATION surface (add/remove/update) routes through `update` via
 * viewer_* Msgs — single-writer through the reducer (see docs/v0.5-layering.md).
 * This module's mutation functions are thin facades that dispatch those Msgs;
 * the tab-arithmetic + lifecycle logic lives in the model-tabs leaf, called
 * from the reducer.
 *
 * Lives separately from `terminal.js` so terminal.js stays focused on PTY-
 * session lifecycle.
 */
'use strict';

const { getModel } = require('./runtime');
const mt = require('./model-tabs');

// --- Read helpers (used by the layout + render paths) ---

/** Resolve the detail Component's slice (where the viewer tab maps now live —
 *  Phase B). Empty fallback so callers don't have to guard before the
 *  Component is registered (e.g. mid-boot reads, tests). */
function _detailSlice() {
  return require('./plugins/api').getComponentSlice('detail')
      || { contentTabs: {}, ephemeralTerminals: {} };
}

/** All terminal definitions for a group: YAML-defined first, then ephemeral
 *  (runtime-added by plugins). */
function getGroupTerminals(groupName) {
  return mt.groupTerminals(getModel(), _detailSlice(), groupName);
}

/** Content tabs for a group — read-only text/hex surfaces opened at runtime
 *  (e.g. file-browser opening a file). */
function getGroupContentTabs(groupName) {
  return mt.groupContentTabs(_detailSlice(), groupName);
}

/** Tab info for the current group: action tabs + terminal tabs + content tabs
 *  + total count (Info tab inclusive). */
function getTabInfo() {
  const m = getModel();
  const group = m.config.groups[m.currentGroup];
  if (!group) return { actionTabs: [], termTabs: [], contentTabs: [], total: 1 };
  const actionTabs = Object.entries(group.actions || {}).filter(([, a]) => a.tab);
  const termTabs = Object.entries(getGroupTerminals(m.currentGroup));
  const contentTabs = Object.entries(getGroupContentTabs(m.currentGroup));
  return {
    actionTabs, termTabs, contentTabs,
    total: 1 + actionTabs.length + termTabs.length + contentTabs.length,
  };
}

/** True when the active tab is a terminal tab. */
function isTerminalTab() {
  const { actionTabs, termTabs } = getTabInfo();
  if (termTabs.length === 0) return false;
  const activeTab = _detailSlice().tab;
  const start = 1 + actionTabs.length;
  return activeTab >= start && activeTab < start + termTabs.length;
}

/** True when the active tab is a content tab. */
function isContentTab() {
  const { actionTabs, termTabs, contentTabs } = getTabInfo();
  if (contentTabs.length === 0) return false;
  const activeTab = _detailSlice().tab;
  const start = 1 + actionTabs.length + termTabs.length;
  return activeTab >= start && activeTab < start + contentTabs.length;
}

/** Active content-tab entry — [key, { label, lines }] or null. */
function activeContentTab() {
  const { actionTabs, termTabs, contentTabs } = getTabInfo();
  const idx = _detailSlice().tab - 1 - actionTabs.length - termTabs.length;
  if (idx < 0 || idx >= contentTabs.length) return null;
  return contentTabs[idx];
}

/** Session ID for the active terminal tab — `${group}_${key}`. */
function activeTerminalId() {
  const m = getModel();
  const { actionTabs, termTabs } = getTabInfo();
  const idx = _detailSlice().tab - 1 - actionTabs.length;
  if (idx < 0 || idx >= termTabs.length) return null;
  return `${m.currentGroup}_${termTabs[idx][0]}`;
}

/** Terminal config for the active terminal tab — { cmd, label } or null. */
function activeTerminalConfig() {
  const { actionTabs, termTabs } = getTabInfo();
  const idx = _detailSlice().tab - 1 - actionTabs.length;
  if (idx < 0 || idx >= termTabs.length) return null;
  return termTabs[idx][1];
}

/** Reverse-lookup an ephemeral entry from a session id. Groups can contain
 *  underscores so we have to scan rather than split. */
function findEphemeralByid(id) {
  const eph = _detailSlice().ephemeralTerminals || {};
  for (const group of Object.keys(eph)) {
    for (const key of Object.keys(eph[group])) {
      if (`${group}_${key}` === id) return { group, key };
    }
  }
  return null;
}

// --- Mutation surface (all routed through update — single-writer) ---

/** Add an ephemeral terminal tab at runtime (not from YAML). Used by plugins
 *  to open interactive shells against an item (e.g. docker exec). If a tab
 *  with the same key already exists, switches to it. */
function addEphemeralTab(groupName, key, cmd, label) {
  require('./plugins/api').dispatchMsg(
    { type: 'viewer_add_ephemeral_terminal', groupName, key, cmd, label });
}

/** Remove an ephemeral terminal tab — drops the entry, adjusts the active tab,
 *  and emits a destroy_pty_session Cmd so the PTY child is torn down. */
function removeEphemeralTab(groupName, key) {
  require('./plugins/api').dispatchMsg(
    { type: 'viewer_remove_ephemeral_terminal', groupName, key });
}

/** Add a content tab at runtime (e.g. file-browser opening a file). If a tab
 *  with the same key exists, refreshes its lines + switches to it. */
function addContentTab(groupName, key, label, lines) {
  require('./plugins/api').dispatchMsg(
    { type: 'viewer_add_content_tab', groupName, key, label, lines });
}

/** Update a content tab's lines without stealing focus (async producer
 *  resolving). If the user is still parked on that tab, the viewer body
 *  refreshes; otherwise the update is silently stored for when they return. */
function updateContentTabLines(groupName, key, lines) {
  require('./plugins/api').dispatchMsg(
    { type: 'viewer_update_content_tab_lines', groupName, key, lines });
}

/** Remove a content tab — drops the entry, adjusts the active tab, repaints
 *  the body from the sibling tab (or refreshes Info via show_selected_info if
 *  this was the last content tab). */
function removeContentTab(groupName, key) {
  require('./plugins/api').dispatchMsg(
    { type: 'viewer_remove_content_tab', groupName, key });
}

/**
 * Hook called by terminal.ensureSession's `onExit` callback when a PTY
 * terminates with exit code 0. Cleans up the matching ephemeral tab if there
 * is one (yaml-defined terminals stay put — only runtime tabs auto-disappear).
 * Returns true if a cleanup happened (caller can scheduleRender).
 *
 * Defined here (not in terminal.js) so the cleanup path doesn't leak
 * knowledge of the detail slice's ephemeralTerminals into the
 * PTY-lifecycle module.
 */
function handleSessionCleanExit(id) {
  const found = findEphemeralByid(id);
  if (!found) return false;
  removeEphemeralTab(found.group, found.key);
  return true;
}

module.exports = {
  getGroupTerminals, getGroupContentTabs, getTabInfo,
  isTerminalTab, activeTerminalId, activeTerminalConfig,
  isContentTab, activeContentTab,
  findEphemeralByid,
  addEphemeralTab, removeEphemeralTab,
  addContentTab, removeContentTab, updateContentTabLines,
  handleSessionCleanExit,
};
