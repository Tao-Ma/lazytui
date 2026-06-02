/**
 * Thin facade — singleton-detail specialisation over the pane-tabs leaf.
 *
 * Every read helper (getTabInfo / isTerminalTab / activeContentTab /
 * activeTerminalId / etc.) is a one-line call into leaves/pane-tabs,
 * pinning the slice = `getComponentSlice('detail')` and the group =
 * `getModel().currentGroup`. Phase 4 will retarget these singleton
 * pins to real pane ids; the leaf's *In(slice, model, groupName)
 * variants are already paneId-agnostic.
 *
 * Mutation surface (addEphemeralTab / removeEphemeralTab / addContentTab
 * / updateContentTabLines / removeContentTab) dispatches viewer_*
 * Msgs wrapped with 'detail'. The reducer (leaves/pane-tabs#reduceTabMsg)
 * is paneId-parameterised, so Phase 4's retarget swaps the wrap target
 * without touching the mutator surface.
 *
 * The detail panel's tab bar is conceptually:
 *
 *   [Info] [actionTabs...] [termTabs...] [contentTabs...]
 *      0     1..A            A+1..A+T     A+T+1..A+T+C
 *
 * actionTabs come from `group.actions[*].tab` (YAML); termTabs come from
 * `group.terminals` (YAML) plus slice.ephemeralTerminals (runtime);
 * contentTabs come from slice.contentTabs (runtime). slice.tab is the
 * flat integer index into this strip.
 */
'use strict';

const { getModel } = require('../../app/runtime');
const pt = require('../../leaves/pane-tabs');

// --- Singleton-detail slice fetcher ---------------------------------------

/** Resolve the detail Component's slice. Empty fallback so callers don't
 *  have to guard before the Component is registered (mid-boot, tests). */
function _detailSlice() {
  return require('../api').getComponentSlice('detail')
      || { contentTabs: {}, ephemeralTerminals: {}, tab: 0 };
}

// --- Read helpers (used by the layout + render paths) ---------------------

function getGroupTerminals(groupName) {
  return pt.groupTerminals(getModel(), _detailSlice(), groupName);
}

function getGroupContentTabs(groupName) {
  return pt.groupContentTabs(_detailSlice(), groupName);
}

/** Tab info for the current group: action + terminal + content tabs +
 *  total count (Info inclusive). */
function getTabInfo() {
  return pt.flatTabInfo(_detailSlice(), getModel(), getModel().currentGroup);
}

function isTerminalTab() {
  return pt.isTerminalTabIn(_detailSlice(), getModel(), getModel().currentGroup);
}

function isContentTab() {
  return pt.isContentTabIn(_detailSlice(), getModel(), getModel().currentGroup);
}

function activeContentTab() {
  return pt.activeContentTabIn(_detailSlice(), getModel(), getModel().currentGroup);
}

function activeTerminalId() {
  return pt.activeTerminalIdIn(_detailSlice(), getModel(), getModel().currentGroup);
}

function activeTerminalConfig() {
  return pt.activeTerminalConfigIn(_detailSlice(), getModel(), getModel().currentGroup);
}

function findEphemeralByid(id) {
  return pt.findEphemeralByIdIn(_detailSlice(), id);
}

// --- Mutation surface (all routed through update — single-writer) ---------

/** Add an ephemeral terminal tab at runtime. Used by plugins to open
 *  interactive shells against an item (e.g. docker exec). If a tab
 *  with the same key exists, switches to it. */
function addEphemeralTab(groupName, key, cmd, label) {
  const api = require('../api');
  api.dispatchMsg(api.wrap('detail',
    { type: 'viewer_add_ephemeral_terminal', groupName, key, cmd, label }));
}

function removeEphemeralTab(groupName, key) {
  const api = require('../api');
  api.dispatchMsg(api.wrap('detail',
    { type: 'viewer_remove_ephemeral_terminal', groupName, key }));
}

function addContentTab(groupName, key, label, lines) {
  const api = require('../api');
  api.dispatchMsg(api.wrap('detail',
    { type: 'viewer_add_content_tab', groupName, key, label, lines }));
}

function updateContentTabLines(groupName, key, lines) {
  const api = require('../api');
  api.dispatchMsg(api.wrap('detail',
    { type: 'viewer_update_content_tab_lines', groupName, key, lines }));
}

function removeContentTab(groupName, key) {
  const api = require('../api');
  api.dispatchMsg(api.wrap('detail',
    { type: 'viewer_remove_content_tab', groupName, key }));
}

/** Hook called by terminal.ensureSession's `onExit` when a PTY
 *  terminates with exit code 0. Cleans up the matching ephemeral tab
 *  if any (YAML terminals stay put — only runtime tabs auto-disappear).
 *  Returns true if a cleanup happened (caller can scheduleRender). */
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
