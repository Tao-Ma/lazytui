/**
 * Pure model transforms for the Viewer layer's tabs (content + ephemeral
 * terminals). Called from `detail.update`. Each mutator takes
 * (slice, model, payload) and returns `[newSlice, info]` where `info`
 * is the cross-layer payload the caller folds into the Component's
 * effect list (focusDetail, terminalEnter/Exit, sessionId,
 * needShowSelectedInfo). Read helpers (groupTerminals /
 * groupContentTabs / actionTabCount) take `model` (+ slice for the
 * ephemeral set) and stay pure.
 *
 * The leaves don't write `model.modes` / `getFocus()` themselves (those are
 * root chrome — the calling reducer branch emits apply_msg Cmds for any
 * cross-layer write). Single-writer per layer.
 */
'use strict';

function actionTabCount(model, groupName) {
  const group = model.config.groups[groupName];
  if (!group) return 0;
  return Object.values(group.actions || {}).filter(a => a.tab).length;
}

/** Merged terminals: YAML-defined first, then runtime-ephemeral. Reads the
 *  ephemeral set off the viewer slice — passed in by the caller (detail.update
 *  has it directly; outside callers via getComponentSlice('detail')). */
function groupTerminals(model, slice, groupName) {
  const group = model.config.groups[groupName];
  if (!group) return {};
  const yaml = group.terminals || {};
  const eph = (slice.ephemeralTerminals && slice.ephemeralTerminals[groupName]) || {};
  return { ...yaml, ...eph };
}

function groupContentTabs(slice, groupName) {
  return (slice.contentTabs && slice.contentTabs[groupName]) || {};
}

// --- mutators (return [newSlice, info]) ---

function addEphemeral(slice, model, { groupName, key, cmd, label }) {
  if (!model.config.groups[groupName]) return [slice, { focusDetail: false, terminalEnter: false }];

  // Build the new ephemeral subtree for this group.
  // T27 / R21 dup-key contract: when an entry already exists at this
  // key, the new {cmd, label} is INTENTIONALLY DROPPED — the call is
  // a "switch to existing tab" gesture (the live PTY session at
  // ${groupName}_${key} is reused). Callers wanting a fresh shell
  // must destroy the session + remove the tab first, then re-add.
  // Auto-respawn here would silently kill running work; safer to
  // require explicit teardown.
  const ephGroup = slice.ephemeralTerminals[groupName] || {};
  const ephGroupNext = ephGroup[key] ? ephGroup : { ...ephGroup, [key]: { cmd, label } };
  const ephAllNext = { ...slice.ephemeralTerminals, [groupName]: ephGroupNext };
  const next = { ...slice, ephemeralTerminals: ephAllNext };

  // T27 — cross-group guard. slice.tab / lines / scroll are meaningful
  // only for model.currentGroup; updating them with a tab index that's
  // meaningful in `groupName` would silently jump the user's cursor in
  // the CURRENT group. Leave the per-group map updated but don't touch
  // the current-group cursor — mirror what updateContentLines does.
  if (groupName !== model.currentGroup) return [next, { focusDetail: false, terminalEnter: false }];

  const termIdx = Object.keys(groupTerminals(model, next, groupName)).indexOf(key);
  if (termIdx < 0) return [next, { focusDetail: false, terminalEnter: false }];
  return [
    { ...next, tab: 1 + actionTabCount(model, groupName) + termIdx },
    { focusDetail: true, terminalEnter: true },
  ];
}

function removeEphemeral(slice, model, { groupName, key }) {
  const eph = slice.ephemeralTerminals[groupName];
  if (!eph || !eph[key]) return [slice, { sessionId: null, terminalExit: false }];

  const id = `${groupName}_${key}`;

  // Build the new ephemeral state for this group (drop the key;
  // drop the group entry if it's now empty).
  const { [key]: _removed, ...ephGroupRest } = eph;
  const ephAllNext = { ...slice.ephemeralTerminals };
  if (Object.keys(ephGroupRest).length === 0) delete ephAllNext[groupName];
  else ephAllNext[groupName] = ephGroupRest;

  // T27 — cross-group guard. The tab-index math below uses indices
  // meaningful in `groupName`'s tab ordering, not the current group's.
  // When the user has switched away mid-PTY-life (real trigger:
  // handleSessionCleanExit firing after group switch), only update the
  // per-group map; leave slice.tab alone.
  if (groupName !== model.currentGroup) {
    return [{ ...slice, ephemeralTerminals: ephAllNext }, { sessionId: id, terminalExit: false }];
  }

  const aCount = actionTabCount(model, groupName);
  const oldOrder = Object.keys(groupTerminals(model, slice, groupName));
  const removedTermIdx = oldOrder.indexOf(key);
  const removedTabIdx = 1 + aCount + removedTermIdx;

  // Resolve the new tab using the AFTER-state terminals count (yaml + new eph).
  const yaml = (model.config.groups[groupName] || {}).terminals || {};
  const newCount = Object.keys({ ...yaml, ...ephGroupRest }).length;

  let tab = slice.tab;
  let terminalExit = false;
  if (slice.tab === removedTabIdx) {
    if (newCount > 0) tab = 1 + aCount + Math.min(removedTermIdx, newCount - 1);
    else              tab = 0;
    terminalExit = true;
  } else if (slice.tab > removedTabIdx) {
    tab = slice.tab - 1;
  }

  return [{ ...slice, ephemeralTerminals: ephAllNext, tab }, { sessionId: id, terminalExit }];
}

function addContent(slice, model, { groupName, key, label, lines }) {
  if (!model.config.groups[groupName]) return [slice, { focusDetail: false, terminalExit: false }];

  const ctAll = slice.contentTabs || {};
  const ctGroup = ctAll[groupName] || {};
  const ctGroupNext = { ...ctGroup, [key]: { label, lines: lines || [] } };
  const ctAllNext = { ...ctAll, [groupName]: ctGroupNext };
  let next = { ...slice, contentTabs: ctAllNext };

  // T27 — cross-group guard. Real trigger: files.js loadDir captures
  // `originGroup` so a mid-flight group switch doesn't misfile the
  // resolved tab. Pre-fix this still clobbered slice.tab + slice.lines
  // with values meaningful in the origin group, not the current group.
  // Update the per-group map only; leave current-group cursor alone.
  if (groupName !== model.currentGroup) return [next, { focusDetail: false, terminalExit: false }];

  const contentIdx = Object.keys(ctGroupNext).indexOf(key);
  if (contentIdx < 0) return [next, { focusDetail: false, terminalExit: false }];

  const aCount = actionTabCount(model, groupName);
  const tCount = Object.keys(groupTerminals(model, next, groupName)).length;
  next = {
    ...next,
    tab: 1 + aCount + tCount + contentIdx,
    lines: lines || [],
    scroll: 0,
  };
  if (next.search && next.search.active) {
    next = { ...next, search: { active: false, term: '', matches: [], idx: 0, typing: '' } };
  }
  return [next, { focusDetail: true, terminalExit: true }];
}

function updateContentLines(slice, model, { groupName, key, lines }) {
  const ctAll = slice.contentTabs;
  if (!ctAll || !ctAll[groupName] || !ctAll[groupName][key]) return [slice, null];

  const ctGroupNext = { ...ctAll[groupName], [key]: { ...ctAll[groupName][key], lines: lines || [] } };
  const ctAllNext = { ...ctAll, [groupName]: ctGroupNext };
  let next = { ...slice, contentTabs: ctAllNext };

  // Refresh body only if user is still parked on this tab (active in current group).
  if (groupName !== model.currentGroup) return [next, null];
  const order = Object.keys(ctGroupNext);
  const aCount = actionTabCount(model, groupName);
  const tCount = Object.keys(groupTerminals(model, next, groupName)).length;
  const idx = next.tab - 1 - aCount - tCount;
  if (idx < 0 || idx >= order.length || order[idx] !== key) return [next, null];
  return [{ ...next, lines: lines || [], scroll: 0 }, null];
}

/** Returns [newSlice, { needShowSelectedInfo: bool }] — needShowSelectedInfo
 *  is true when the closed tab was the last content tab so the body falls
 *  back to Info (caller emits the Cmd). */
function removeContent(slice, model, { groupName, key }) {
  const ctAll = slice.contentTabs;
  const ct = ctAll && ctAll[groupName];
  if (!ct || !ct[key]) return [slice, { needShowSelectedInfo: false }];

  // Build the new content-tabs subtree (drop the key; drop group if empty).
  const { [key]: _removed, ...ctGroupRest } = ct;
  const ctAllNext = { ...ctAll };
  if (Object.keys(ctGroupRest).length === 0) delete ctAllNext[groupName];
  else ctAllNext[groupName] = ctGroupRest;

  // T27 — cross-group guard. When the user is parked in a different
  // group than `groupName`, only update the per-group map; don't touch
  // slice.tab / slice.lines / slice.scroll (the indices are meaningful
  // in `groupName`'s tab ordering, not the current group's).
  if (groupName !== model.currentGroup) {
    return [{ ...slice, contentTabs: ctAllNext }, { needShowSelectedInfo: false }];
  }

  const aCount = actionTabCount(model, groupName);
  const tCount = Object.keys(groupTerminals(model, slice, groupName)).length;
  const oldOrder = Object.keys(ct);
  const removedContentIdx = oldOrder.indexOf(key);
  const removedTabIdx = 1 + aCount + tCount + removedContentIdx;

  let tab = slice.tab;
  let lines = slice.lines;
  let scroll = slice.scroll;
  let needShowSelectedInfo = false;

  if (slice.tab === removedTabIdx) {
    const remainingKeys = Object.keys(ctGroupRest);
    if (remainingKeys.length > 0) {
      const newContentIdx = Math.min(removedContentIdx, remainingKeys.length - 1);
      tab = 1 + aCount + tCount + newContentIdx;
      const siblingKey = remainingKeys[newContentIdx];
      const sibling = ctGroupRest[siblingKey];
      if (sibling) {
        lines = sibling.lines || [];
        scroll = 0;
      }
    } else {
      tab = 0;
      needShowSelectedInfo = true;
    }
  } else if (slice.tab > removedTabIdx) {
    tab = slice.tab - 1;
  }

  return [{ ...slice, contentTabs: ctAllNext, tab, lines, scroll }, { needShowSelectedInfo }];
}

module.exports = {
  actionTabCount, groupTerminals, groupContentTabs,
  addEphemeral, removeEphemeral,
  addContent, updateContentLines, removeContent,
};
