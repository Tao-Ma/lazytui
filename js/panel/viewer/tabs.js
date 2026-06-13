/**
 * Thin facade — singleton-detail specialisation over the pane-tabs leaf.
 *
 * Every read helper (getTabInfo / isTerminalTab / activeContentTab /
 * activeTerminalId / etc.) is a one-line call into leaves/pane-tabs,
 * pinning the slice via `resolveTarget('viewer')` and the group =
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

// --- Active-viewer slice fetcher ------------------------------------------

/** Resolve the active viewer Component's slice. Routes via
 *  `route.resolveTarget('viewer')` (paneId-aware post-Phase B1) so
 *  multi-viewer setups land on the focused viewer's slice; falls back
 *  to the kind-name lookup for the legacy primary. Empty fallback so
 *  callers don't have to guard before the Component is registered
 *  (mid-boot, tests). */
function _detailSlice() {
  const api = require('../api');
  const route = require('../../panel/route');
  const id = route.resolveTarget('viewer') || 'detail';
  return api.getInstanceSlice(id)
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

function isActionTab() {
  return pt.isActionTabIn(_detailSlice(), getModel(), getModel().currentGroup);
}

function activeContentTab() {
  return pt.activeContentTabIn(_detailSlice(), getModel(), getModel().currentGroup);
}

function activeActionTab() {
  return pt.activeActionTabIn(_detailSlice(), getModel(), getModel().currentGroup);
}

function activeTerminalId(paneId) {
  // No-arg callers mean "the viewer" — resolve like _detailSlice does.
  // The old `paneId = 'detail'` default was a kind name that only the
  // (deleted) getInstanceSlice fallback bridged to the minted pane
  // instance; post split-arc P2 it strictly missed, returning the empty
  // stub and breaking terminal activation/input/paint on real boots.
  if (paneId == null) {
    return pt.activeTerminalIdIn(_detailSlice(), getModel(), getModel().currentGroup);
  }
  const slice = require('../api').getInstanceSlice(paneId)
              || { contentTabs: {}, ephemeralTerminals: {}, tab: 0 };
  return pt.activeTerminalIdIn(slice, getModel(), getModel().currentGroup);
}

function activeTerminalConfig() {
  return pt.activeTerminalConfigIn(_detailSlice(), getModel(), getModel().currentGroup);
}

function findEphemeralByid(id, paneId) {
  // Same default rule as activeTerminalId — no-arg means "the viewer".
  if (paneId == null) return pt.findEphemeralByIdIn(_detailSlice(), id);
  const slice = require('../api').getInstanceSlice(paneId)
              || { ephemeralTerminals: {} };
  return pt.findEphemeralByIdIn(slice, id);
}

/** v0.6.1 Phase 4 — locate the viewer-kind instance whose ephemeral
 *  terminal set owns session id `${group}_${key}`. Returns the
 *  instance id (== paneId for singleton-detail) or null when no
 *  owner. Scans every viewer-kind instance via the route registry —
 *  works for Phase 4 singletons and Phase 5+ multi-instance alike. */
function paneForSessionId(id) {
  const route = require('../../panel/route');
  let found = null;
  route.eachInstance(inst => {
    if (found) return;
    if (inst.kind !== 'detail') return;          // only viewers host PTY tabs
    if (pt.findEphemeralByIdIn(inst.slice, id)) found = inst.id;
  });
  return found;
}

// --- Mutation surface (all routed through update — single-writer) ---------
//
// v0.6.1 Phase 6 — each entry point resolves its destination via
// route.resolveTarget(intent). The five mutators split across two
// intents: ephemeral terminal mutations are 'terminal'; content-tab
// mutations are 'viewer_tab_add' (one intent for the cohesive add /
// update / remove triple, since they all key into the same per-pane
// content-tab map). Phase 5 resolveTarget collapses all intents to
// the same body — the distinction is reserved for v0.7. null target
// (no viewer registered) drops the dispatch silently.

function _viewerTarget(intent) {
  return require('../../panel/route').resolveTarget(intent);
}

/** Add an ephemeral terminal tab at runtime. Used by plugins to open
 *  interactive shells against an item (e.g. docker exec). If a tab
 *  with the same key exists, switches to it. */
// Dispatchers thread the model-derived bundle (currentGroup,
// groupExists, yamlTerminals, actionCount) so the reducer arm and
// the leaf can be pure of getModel(). pt.modelBundle is the single
// helper that computes the bundle from (model, groupName).

function _getModel() {
  return require('../../app/runtime').getModel();
}

function addEphemeralTab(groupName, key, cmd, label) {
  const target = _viewerTarget('terminal');
  if (target == null) return;
  const api = require('../api');
  api.dispatchMsg(api.wrap(target,
    { type: 'viewer_add_ephemeral_terminal', groupName, key, cmd, label,
      ...pt.modelBundle(_getModel(), groupName) }));
}

function removeEphemeralTab(groupName, key) {
  const target = _viewerTarget('terminal');
  if (target == null) return;
  const api = require('../api');
  api.dispatchMsg(api.wrap(target,
    { type: 'viewer_remove_ephemeral_terminal', groupName, key,
      ...pt.modelBundle(_getModel(), groupName) }));
}

function addContentTab(groupName, key, label, lines) {
  const target = _viewerTarget('viewer_tab_add');
  if (target == null) return;
  const api = require('../api');
  api.dispatchMsg(api.wrap(target,
    { type: 'viewer_add_content_tab', groupName, key, label, lines,
      ...pt.modelBundle(_getModel(), groupName) }));
}

function updateContentTabLines(groupName, key, lines) {
  const target = _viewerTarget('viewer_tab_add');
  if (target == null) return;
  const api = require('../api');
  api.dispatchMsg(api.wrap(target,
    { type: 'viewer_update_content_tab_lines', groupName, key, lines,
      ...pt.modelBundle(_getModel(), groupName) }));
}

function removeContentTab(groupName, key) {
  const target = _viewerTarget('viewer_tab_add');
  if (target == null) return;
  const api = require('../api');
  api.dispatchMsg(api.wrap(target,
    { type: 'viewer_remove_content_tab', groupName, key,
      ...pt.modelBundle(_getModel(), groupName) }));
}

/** Hook called by terminal.ensureSession's `onExit` when a PTY
 *  terminates with exit code 0. Cleans up the matching ephemeral tab
 *  if any (YAML terminals stay put — only runtime tabs auto-disappear).
 *  Returns true if a cleanup happened (caller can scheduleRender).
 *
 *  v0.6.1 Phase 4 — `paneId` threads the owning instance so multi-
 *  detail routes the remove Msg to the right slice; no-arg resolves
 *  the viewer (the sole production caller threads an explicit id). */
function handleSessionCleanExit(id, paneId) {
  const found = findEphemeralByid(id, paneId);
  if (!found) return false;
  removeEphemeralTab(found.group, found.key);
  return true;
}

module.exports = {
  getGroupTerminals, getGroupContentTabs, getTabInfo,
  isTerminalTab, activeTerminalId, activeTerminalConfig,
  isContentTab, activeContentTab,
  isActionTab, activeActionTab,
  findEphemeralByid, paneForSessionId,
  addEphemeralTab, removeEphemeralTab,
  addContentTab, removeContentTab, updateContentTabLines,
  handleSessionCleanExit,
};
