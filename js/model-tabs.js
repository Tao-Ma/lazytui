/**
 * Pure model transforms for the Viewer layer's tabs (content + ephemeral
 * terminals). Called from `detail.update`; each mutation takes
 * (slice, model, payload) and mutates the slice in place. Read helpers
 * (groupTerminals / groupContentTabs / actionTabCount) take `model` only —
 * they read config + the slice (via the current Component slice).
 *
 * The leaves don't write `model.modes` / `getComponentSlice("layout").focus` themselves (those are
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

// --- mutations (called from detail.update) ---

/** Returns the cross-layer Msgs the caller should re-dispatch (focus_set,
 *  terminal_enter). Slice writes only. */
function addEphemeral(slice, model, { groupName, key, cmd, label }) {
  if (!model.config.groups[groupName]) return { focusDetail: false, terminalEnter: false };
  if (!slice.ephemeralTerminals[groupName]) slice.ephemeralTerminals[groupName] = {};
  if (!slice.ephemeralTerminals[groupName][key]) {
    slice.ephemeralTerminals[groupName][key] = { cmd, label };
  }
  const termIdx = Object.keys(groupTerminals(model, slice, groupName)).indexOf(key);
  if (termIdx < 0) return { focusDetail: false, terminalEnter: false };
  slice.tab = 1 + actionTabCount(model, groupName) + termIdx;
  return { focusDetail: true, terminalEnter: true };
}

function removeEphemeral(slice, model, { groupName, key }) {
  const eph = slice.ephemeralTerminals[groupName];
  if (!eph || !eph[key]) return { sessionId: null, terminalExit: false };

  const id = `${groupName}_${key}`;
  const aCount = actionTabCount(model, groupName);
  const oldOrder = Object.keys(groupTerminals(model, slice, groupName));
  const removedTermIdx = oldOrder.indexOf(key);
  const removedTabIdx = 1 + aCount + removedTermIdx;

  delete eph[key];
  if (Object.keys(eph).length === 0) delete slice.ephemeralTerminals[groupName];

  let terminalExit = false;
  if (slice.tab === removedTabIdx) {
    const newCount = Object.keys(groupTerminals(model, slice, groupName)).length;
    if (newCount > 0) {
      const newTermIdx = Math.min(removedTermIdx, newCount - 1);
      slice.tab = 1 + aCount + newTermIdx;
    } else {
      slice.tab = 0;
    }
    terminalExit = true;
  } else if (slice.tab > removedTabIdx) {
    slice.tab--;
  }
  return { sessionId: id, terminalExit };
}

function addContent(slice, model, { groupName, key, label, lines }) {
  if (!model.config.groups[groupName]) return { focusDetail: false, terminalExit: false };
  if (!slice.contentTabs) slice.contentTabs = {};
  if (!slice.contentTabs[groupName]) slice.contentTabs[groupName] = {};
  slice.contentTabs[groupName][key] = { label, lines: lines || [] };

  const contentIdx = Object.keys(groupContentTabs(slice, groupName)).indexOf(key);
  if (contentIdx < 0) return { focusDetail: false, terminalExit: false };
  const aCount = actionTabCount(model, groupName);
  const tCount = Object.keys(groupTerminals(model, slice, groupName)).length;
  slice.tab = 1 + aCount + tCount + contentIdx;

  slice.lines = lines || [];
  slice.scroll = 0;
  if (slice.search && slice.search.active) {
    slice.search = { active: false, term: '', matches: [], idx: 0, typing: '' };
  }
  return { focusDetail: true, terminalExit: true };
}

function updateContentLines(slice, model, { groupName, key, lines }) {
  if (!slice.contentTabs
      || !slice.contentTabs[groupName]
      || !slice.contentTabs[groupName][key]) return;
  slice.contentTabs[groupName][key].lines = lines || [];
  // Refresh body only if user is still parked on this tab (active in current group).
  if (groupName !== model.currentGroup) return;
  const order = Object.keys(groupContentTabs(slice, groupName));
  const aCount = actionTabCount(model, groupName);
  const tCount = Object.keys(groupTerminals(model, slice, groupName)).length;
  const idx = slice.tab - 1 - aCount - tCount;
  if (idx < 0 || idx >= order.length || order[idx] !== key) return;
  slice.lines = lines || [];
  slice.scroll = 0;
}

/** Returns { needShowSelectedInfo: bool } — true when the closed tab was the
 *  last content tab so the body falls back to Info (caller emits the Cmd). */
function removeContent(slice, model, { groupName, key }) {
  const ct = slice.contentTabs && slice.contentTabs[groupName];
  if (!ct || !ct[key]) return { needShowSelectedInfo: false };

  const aCount = actionTabCount(model, groupName);
  const tCount = Object.keys(groupTerminals(model, slice, groupName)).length;
  const oldOrder = Object.keys(ct);
  const removedContentIdx = oldOrder.indexOf(key);
  const removedTabIdx = 1 + aCount + tCount + removedContentIdx;

  delete ct[key];
  if (Object.keys(ct).length === 0) delete slice.contentTabs[groupName];

  let needShowSelectedInfo = false;
  if (slice.tab === removedTabIdx) {
    const newCount = Object.keys(groupContentTabs(slice, groupName)).length;
    if (newCount > 0) {
      const newContentIdx = Math.min(removedContentIdx, newCount - 1);
      slice.tab = 1 + aCount + tCount + newContentIdx;
      const siblingKey = Object.keys(groupContentTabs(slice, groupName))[newContentIdx];
      const sibling = groupContentTabs(slice, groupName)[siblingKey];
      if (sibling) {
        slice.lines = sibling.lines || [];
        slice.scroll = 0;
      }
    } else {
      slice.tab = 0;
      needShowSelectedInfo = true;
    }
  } else if (slice.tab > removedTabIdx) {
    slice.tab--;
  }
  return { needShowSelectedInfo };
}

module.exports = {
  actionTabCount, groupTerminals, groupContentTabs,
  addEphemeral, removeEphemeral,
  addContent, updateContentLines, removeContent,
};
