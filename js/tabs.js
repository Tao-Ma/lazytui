/**
 * Tab arithmetic + ephemeral-tab lifecycle.
 *
 * The detail panel's tab bar is conceptually:
 *
 *   [Info] [actionTabs...] [termTabs...] [contentTabs...]
 *      0     1..A            A+1..A+T     A+T+1..A+T+C
 *
 * `actionTabs` come from `group.actions[*].tab` (YAML); `termTabs`
 * come from `group.terminals` (YAML) plus `S.ephemeralTerminals`
 * (runtime, added by plugins via `addEphemeralTab`); `contentTabs`
 * come from `S.contentTabs` (runtime, added by plugins via
 * `addContentTab` — used by file-browser to open files and any
 * future plugin that wants a read-only content surface in detail).
 * `S.activeTab` is a single integer indexing this flat list; helpers
 * below do the mapping from integer → kind/item.
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
 * Content tabs for a group — read-only text/hex surfaces opened at
 * runtime (e.g. file-browser opening a file). Shape mirrors
 * S.ephemeralTerminals: { groupName: { key: { label, lines, source } } }.
 * `lines` is an array of Rich-markup-ready strings (already
 * formatted, ready to setDetail).
 */
function getGroupContentTabs(groupName) {
  return (S.contentTabs && S.contentTabs[groupName]) || {};
}

/**
 * Tab info for the current group: action tabs + terminal tabs +
 * content tabs + total count (Info tab inclusive).
 */
function getTabInfo() {
  const group = S.config.groups[S.currentGroup];
  if (!group) return { actionTabs: [], termTabs: [], contentTabs: [], total: 1 };
  const actionTabs = Object.entries(group.actions || {}).filter(([, a]) => a.tab);
  const termTabs = Object.entries(getGroupTerminals(S.currentGroup));
  const contentTabs = Object.entries(getGroupContentTabs(S.currentGroup));
  return {
    actionTabs, termTabs, contentTabs,
    total: 1 + actionTabs.length + termTabs.length + contentTabs.length,
  };
}

/** True when the active tab is a terminal tab (kind === 'terminal'). */
function isTerminalTab() {
  const { actionTabs, termTabs } = getTabInfo();
  if (termTabs.length === 0) return false;
  const start = 1 + actionTabs.length;
  return S.activeTab >= start && S.activeTab < start + termTabs.length;
}

/** True when the active tab is a content tab (kind === 'content'). */
function isContentTab() {
  const { actionTabs, termTabs, contentTabs } = getTabInfo();
  if (contentTabs.length === 0) return false;
  const start = 1 + actionTabs.length + termTabs.length;
  return S.activeTab >= start && S.activeTab < start + contentTabs.length;
}

/** Active content-tab entry — [key, { label, lines, source }] or null. */
function activeContentTab() {
  const { actionTabs, termTabs, contentTabs } = getTabInfo();
  const idx = S.activeTab - 1 - actionTabs.length - termTabs.length;
  if (idx < 0 || idx >= contentTabs.length) return null;
  return contentTabs[idx];
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

/**
 * Add a content tab at runtime (e.g. file-browser opening a file).
 * If a tab with the same key already exists in this group, refresh
 * its lines/label (re-open = re-read) and switch to it rather than
 * accumulating duplicates. The caller is responsible for the content
 * itself; tabs just hold and route to it.
 *
 * Side effects: writes S.contentTabs, S.activeTab, S.focus. Switches
 * the detail panel into content-tab mode (terminalMode false).
 */
function addContentTab(groupName, key, label, lines) {
  if (!S.config.groups[groupName]) return;
  if (!S.contentTabs) S.contentTabs = {};
  if (!S.contentTabs[groupName]) S.contentTabs[groupName] = {};
  S.contentTabs[groupName][key] = { label, lines: lines || [] };
  // Compute the tab's index in the merged tab order.
  const order = Object.keys(getGroupContentTabs(groupName));
  const contentIdx = order.indexOf(key);
  if (contentIdx < 0) return;
  const group = S.config.groups[groupName];
  const actionTabCount = Object.values(group.actions || {}).filter(a => a.tab).length;
  const termTabCount = Object.keys(getGroupTerminals(groupName)).length;
  S.activeTab = 1 + actionTabCount + termTabCount + contentIdx;
  S.terminalMode = false;
  S.focus = 'detail';
  // Push content into S.detailLines so the existing detail render
  // (which reads from there) shows the file content immediately. Reset
  // scroll so the user sees the top of the file. Importing setDetail
  // lazily avoids a top-level cycle with state.js.
  const { setDetail } = require('./state');
  setDetail((lines || []).join('\n'));
}

/**
 * Update a content tab's lines without stealing focus or moving
 * S.activeTab. Used by async producers (file-loader resolving after
 * the initial addContentTab placeholder, future log-tailer plugins,
 * etc.) so a slow load can't yank the user out of whatever they
 * moved on to. When the tab being updated IS the user's current
 * active view, we DO re-emit setDetail so the body reflects the new
 * lines on the next render.
 *
 * No-op if the tab doesn't exist (the user may have closed it).
 */
function updateContentTabLines(groupName, key, lines) {
  if (!S.contentTabs || !S.contentTabs[groupName] || !S.contentTabs[groupName][key]) return;
  S.contentTabs[groupName][key].lines = lines || [];
  // Refresh detail body only if the user is still parked on this tab.
  if (groupName !== S.currentGroup) return;
  const active = activeContentTab();
  if (!active || active[0] !== key) return;
  const { setDetail } = require('./state');
  setDetail((lines || []).join('\n'));
}

/**
 * Remove a content tab — drop the entry and adjust S.activeTab so the
 * remaining tab list stays consistent. If the removed tab was active,
 * jump to the preceding sibling (or back to Info if it was the only one).
 */
function removeContentTab(groupName, key) {
  const ct = S.contentTabs && S.contentTabs[groupName];
  if (!ct || !ct[key]) return;
  const group = S.config.groups[groupName];
  const actionTabCount = group ? Object.values(group.actions || {}).filter(a => a.tab).length : 0;
  const termTabCount = Object.keys(getGroupTerminals(groupName)).length;
  const oldOrder = Object.keys(ct);
  const removedContentIdx = oldOrder.indexOf(key);
  const removedTabIdx = 1 + actionTabCount + termTabCount + removedContentIdx;

  delete ct[key];
  if (Object.keys(ct).length === 0) delete S.contentTabs[groupName];

  if (S.activeTab === removedTabIdx) {
    const newCount = Object.keys(getGroupContentTabs(groupName)).length;
    if (newCount > 0) {
      const newContentIdx = Math.min(removedContentIdx, newCount - 1);
      S.activeTab = 1 + actionTabCount + termTabCount + newContentIdx;
      // Refresh the detail body to the sibling tab's content — without
      // this, S.detailLines still holds the closed file's text under
      // the new tab's title (visual desync).
      const siblingKey = Object.keys(getGroupContentTabs(groupName))[newContentIdx];
      const sibling = getGroupContentTabs(groupName)[siblingKey];
      if (sibling) {
        const { setDetail } = require('./state');
        setDetail((sibling.lines || []).join('\n'));
      }
    } else {
      S.activeTab = 0;
      // Back to Info — re-emit the focused panel's info instead of
      // leaving the closed file's body painted on screen.
      require('./detail').showSelectedInfo();
    }
  } else if (S.activeTab > removedTabIdx) {
    S.activeTab--;
  }
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
