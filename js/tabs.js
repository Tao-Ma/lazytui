/**
 * Tab arithmetic + ephemeral-tab lifecycle.
 *
 * The detail panel's tab bar is conceptually:
 *
 *   [Info] [actionTabs...] [termTabs...]
 *      0     1..N            N+1..M
 *
 * `actionTabs` come from `group.actions[*].tab` (YAML); `termTabs`
 * come from `group.terminals` (YAML) plus `S.ephemeralTerminals`
 * (runtime, added by plugins via `addEphemeralTab`). `S.activeTab` is
 * a single integer indexing this flat list; helpers below do the
 * mapping from integer → kind/item.
 *
 * Lives separately from `terminal.js` so terminal.js stays focused on
 * PTY-session lifecycle. This module imports terminal.js (one
 * direction) for `destroySession`; terminal.js imports back lazily
 * from `ensureSession`'s onExit handler — see `_handleSessionExit`.
 *
 * Zero npm deps.
 */
'use strict';

const { S } = require('./state');

/**
 * All terminal definitions for a group: YAML-defined first, then
 * ephemeral (runtime-added by plugins). Returns plain object
 * { key: { cmd, label } }. Order matters — drives tab placement.
 */
function getGroupTerminals(groupName) {
  const group = S.config.groups[groupName];
  const yaml = group ? (group.terminals || {}) : {};
  const ephemeral = (S.ephemeralTerminals && S.ephemeralTerminals[groupName]) || {};
  return { ...yaml, ...ephemeral };
}

/**
 * Tab info for the current group: action tabs + terminal tabs +
 * total count (Info tab inclusive).
 */
function getTabInfo() {
  const group = S.config.groups[S.currentGroup];
  if (!group) return { actionTabs: [], termTabs: [], total: 1 };
  const actionTabs = Object.entries(group.actions || {}).filter(([, a]) => a.tab);
  const termTabs = Object.entries(getGroupTerminals(S.currentGroup));
  return { actionTabs, termTabs, total: 1 + actionTabs.length + termTabs.length };
}

/** True when the active tab is a terminal tab (kind === 'terminal'). */
function isTerminalTab() {
  const { actionTabs, termTabs } = getTabInfo();
  return termTabs.length > 0 && S.activeTab > actionTabs.length;
}

/**
 * Session ID for the active terminal tab — `${group}_${key}`.
 * Returns null when active tab is not a terminal tab.
 */
function activeTerminalId() {
  const { actionTabs, termTabs } = getTabInfo();
  const idx = S.activeTab - 1 - actionTabs.length;
  if (idx < 0 || idx >= termTabs.length) return null;
  return `${S.currentGroup}_${termTabs[idx][0]}`;
}

/** Terminal config for the active terminal tab — { cmd, label } or null. */
function activeTerminalConfig() {
  const { actionTabs, termTabs } = getTabInfo();
  const idx = S.activeTab - 1 - actionTabs.length;
  if (idx < 0 || idx >= termTabs.length) return null;
  return termTabs[idx][1];
}

/**
 * Reverse-lookup an ephemeral entry from a session id. id format is
 * `${group}_${key}`, but groups can contain underscores so we have
 * to scan rather than split.
 */
function findEphemeralByid(id) {
  const eph = S.ephemeralTerminals || {};
  for (const group of Object.keys(eph)) {
    for (const key of Object.keys(eph[group])) {
      if (`${group}_${key}` === id) return { group, key };
    }
  }
  return null;
}

/**
 * Add an ephemeral terminal tab at runtime (not from YAML). Used by
 * plugins to open interactive shells against an item (e.g. docker
 * exec). If a tab with the same key already exists, switches to it
 * (the existing PTY session is reused).
 *
 * Stored in `S.ephemeralTerminals` (separate from `S.config`) so
 * that future config reloads or YAML edits don't clobber the
 * runtime-added tab.
 *
 * Side effects: writes `S.ephemeralTerminals`, `S.activeTab`,
 * `S.focus`, `S.terminalMode`. The PTY session itself is lazy —
 * terminal.ensureSession is called on the next render.
 */
function addEphemeralTab(groupName, key, cmd, label) {
  if (!S.config.groups[groupName]) return;
  if (!S.ephemeralTerminals[groupName]) S.ephemeralTerminals[groupName] = {};
  if (!S.ephemeralTerminals[groupName][key]) {
    S.ephemeralTerminals[groupName][key] = { cmd, label };
  }
  // Compute the tab's index in the merged tab order
  const all = getGroupTerminals(groupName);
  const termIdx = Object.keys(all).indexOf(key);
  if (termIdx < 0) return;
  const actions = S.config.groups[groupName].actions || {};
  const actionTabCount = Object.values(actions).filter(a => a.tab).length;
  S.activeTab = 1 + actionTabCount + termIdx;
  S.terminalMode = true;
  S.focus = 'detail';
}

/**
 * Remove an ephemeral terminal tab — destroy its session, drop the
 * entry from `S.ephemeralTerminals`, and adjust `S.activeTab` so the
 * tab list stays consistent. If the removed tab was active, jump to
 * the preceding sibling (or the first tab if none).
 */
function removeEphemeralTab(groupName, key) {
  const eph = S.ephemeralTerminals[groupName];
  if (!eph || !eph[key]) return;

  const id = `${groupName}_${key}`;
  const group = S.config.groups[groupName];
  const actionTabCount = group ? Object.values(group.actions || {}).filter(a => a.tab).length : 0;
  const oldOrder = Object.keys(getGroupTerminals(groupName));
  const removedTermIdx = oldOrder.indexOf(key);
  const removedTabIdx = 1 + actionTabCount + removedTermIdx;

  // Destroy the PTY session (no-op if it never started — sessions
  // are lazy via ensureSession). Loaded eagerly here, not lazily —
  // tabs.js → terminal.js is the natural direction.
  const { destroySession } = require('./terminal');
  destroySession(id);

  delete eph[key];
  if (Object.keys(eph).length === 0) delete S.ephemeralTerminals[groupName];

  if (S.activeTab === removedTabIdx) {
    const newCount = Object.keys(getGroupTerminals(groupName)).length;
    if (newCount > 0) {
      const newTermIdx = Math.min(removedTermIdx, newCount - 1);
      S.activeTab = 1 + actionTabCount + newTermIdx;
    } else {
      S.activeTab = 0;
    }
    S.terminalMode = false;
  } else if (S.activeTab > removedTabIdx) {
    S.activeTab--;
  }
}

/**
 * Hook called by terminal.ensureSession's `onExit` callback when a
 * PTY terminates with exit code 0. Cleans up the matching ephemeral
 * tab if there is one (yaml-defined terminals stay put — only
 * runtime tabs auto-disappear). Returns true if a cleanup happened
 * (caller can scheduleRender).
 *
 * Defined here (not in terminal.js) so the cleanup path doesn't
 * leak knowledge of S.ephemeralTerminals into the PTY-lifecycle
 * module.
 */
function handleSessionCleanExit(id) {
  const found = findEphemeralByid(id);
  if (!found) return false;
  removeEphemeralTab(found.group, found.key);
  return true;
}

module.exports = {
  getGroupTerminals, getTabInfo,
  isTerminalTab, activeTerminalId, activeTerminalConfig,
  findEphemeralByid,
  addEphemeralTab, removeEphemeralTab,
  handleSessionCleanExit,
};
