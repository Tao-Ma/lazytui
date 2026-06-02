/**
 * Generic pane-tabs leaf.
 *
 * Two surfaces, both pure (return-new, no globals):
 *
 *   1. Slice mutators (lifecycle of content/ephemeral tabs)
 *      addEphemeral / removeEphemeral / addContent / updateContentLines /
 *      removeContent / reorderContent — each takes (slice, model, payload)
 *      and returns [newSlice, info] where info carries cross-layer flags
 *      the caller folds into Cmds (focusDetail, terminalEnter/Exit,
 *      sessionId, needShowSelectedInfo).
 *
 *   2. reduceTabMsg(msg, slice, ctx) — the Msg reducer for tab-related
 *      Msgs. Returns:
 *        null          → msg.type is not a tab Msg (caller handles)
 *        slice         → handled, no Cmds
 *        [next, cmds]  → handled with Cmds
 *
 *      ctx = { paneId, wrap, getModel, getTabInfo, activeContentTab }.
 *      paneId-parameterised: every `wrap(paneId, …)` self-reference and
 *      every focus_set target uses ctx.paneId, so the same leaf can drive
 *      a non-detail pane once Phase 4 retargets the singleton call sites.
 *
 * Was `leaves/tabs.js` (mutators only) before Phase 2 — the case-arms
 * lived inline in panel/viewer/viewer.js#211-407.
 *
 * Single-writer per layer: writes to model.modes / getFocus() are
 * returned as apply_msg / dispatch_msg Cmds, never side-effected here.
 */
'use strict';

// --- Pure read helpers ----------------------------------------------------

function actionTabCount(model, groupName) {
  const group = model.config.groups[groupName];
  if (!group) return 0;
  return Object.values(group.actions || {}).filter(a => a.tab).length;
}

/** Merged terminals: YAML-defined first, then runtime-ephemeral. */
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

// --- Pure read derivatives (slice-only, no globals) -----------------------

/** Flat tab info for a pane's slice + a group:
 *    { actionTabs, termTabs, contentTabs, total }
 *  actionTabs comes from group.actions[*].tab (YAML); termTabs merges
 *  group.terminals (YAML) + slice.ephemeralTerminals[groupName] (runtime);
 *  contentTabs comes from slice.contentTabs[groupName]. `total` includes
 *  the implicit Info tab at index 0. */
function flatTabInfo(slice, model, groupName) {
  const group = model.config.groups[groupName];
  if (!group) return { actionTabs: [], termTabs: [], contentTabs: [], total: 1 };
  const actionTabs = Object.entries(group.actions || {}).filter(([, a]) => a.tab);
  const termTabs = Object.entries(groupTerminals(model, slice, groupName));
  const contentTabs = Object.entries(groupContentTabs(slice, groupName));
  return {
    actionTabs, termTabs, contentTabs,
    total: 1 + actionTabs.length + termTabs.length + contentTabs.length,
  };
}

/** True when the slice's active tab is a terminal tab in `groupName`. */
function isTerminalTabIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  if (info.termTabs.length === 0) return false;
  const start = 1 + info.actionTabs.length;
  const t = slice.tab | 0;
  return t >= start && t < start + info.termTabs.length;
}

/** True when the slice's active tab is a content tab in `groupName`. */
function isContentTabIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  if (info.contentTabs.length === 0) return false;
  const start = 1 + info.actionTabs.length + info.termTabs.length;
  const t = slice.tab | 0;
  return t >= start && t < start + info.contentTabs.length;
}

/** [key, { label, lines }] for the active content tab, or null. */
function activeContentTabIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  const idx = (slice.tab | 0) - 1 - info.actionTabs.length - info.termTabs.length;
  if (idx < 0 || idx >= info.contentTabs.length) return null;
  return info.contentTabs[idx];
}

/** Session id (`${group}_${key}`) for the active terminal tab, or null. */
function activeTerminalIdIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  const idx = (slice.tab | 0) - 1 - info.actionTabs.length;
  if (idx < 0 || idx >= info.termTabs.length) return null;
  return `${groupName}_${info.termTabs[idx][0]}`;
}

/** { cmd, label } for the active terminal tab, or null. */
function activeTerminalConfigIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  const idx = (slice.tab | 0) - 1 - info.actionTabs.length;
  if (idx < 0 || idx >= info.termTabs.length) return null;
  return info.termTabs[idx][1];
}

/** Reverse-lookup an ephemeral entry from a session id. Groups can
 *  contain underscores, so we scan rather than split. */
function findEphemeralByIdIn(slice, id) {
  const eph = (slice && slice.ephemeralTerminals) || {};
  for (const group of Object.keys(eph)) {
    for (const key of Object.keys(eph[group])) {
      if (`${group}_${key}` === id) return { group, key };
    }
  }
  return null;
}

// --- Pure slice mutators (return [newSlice, info]) ------------------------

function addEphemeral(slice, model, { groupName, key, cmd, label }) {
  if (!model.config.groups[groupName]) return [slice, { focusDetail: false, terminalEnter: false }];

  // T27 / R21 dup-key contract: when an entry already exists at this
  // key, the new {cmd, label} is INTENTIONALLY DROPPED — the call is
  // a "switch to existing tab" gesture (the live PTY session at
  // ${groupName}_${key} is reused). Callers wanting a fresh shell
  // must destroy the session + remove the tab first, then re-add.
  const ephGroup = slice.ephemeralTerminals[groupName] || {};
  const ephGroupNext = ephGroup[key] ? ephGroup : { ...ephGroup, [key]: { cmd, label } };
  const ephAllNext = { ...slice.ephemeralTerminals, [groupName]: ephGroupNext };
  const next = { ...slice, ephemeralTerminals: ephAllNext };

  // T27 — cross-group guard. Don't touch the current-group cursor when
  // the add lands in a group the user has switched away from.
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

  const { [key]: _removed, ...ephGroupRest } = eph;
  const ephAllNext = { ...slice.ephemeralTerminals };
  if (Object.keys(ephGroupRest).length === 0) delete ephAllNext[groupName];
  else ephAllNext[groupName] = ephGroupRest;

  if (groupName !== model.currentGroup) {
    return [{ ...slice, ephemeralTerminals: ephAllNext }, { sessionId: id, terminalExit: false }];
  }

  const aCount = actionTabCount(model, groupName);
  const oldOrder = Object.keys(groupTerminals(model, slice, groupName));
  const removedTermIdx = oldOrder.indexOf(key);
  const removedTabIdx = 1 + aCount + removedTermIdx;

  const yaml = (model.config.groups[groupName] || {}).terminals || {};
  const newCount = Object.keys({ ...yaml, ...ephGroupRest }).length;

  let tab = slice.tab;
  let lines = slice.lines;
  let scroll = slice.scroll;
  let terminalExit = false;
  if (slice.tab === removedTabIdx) {
    if (newCount > 0) {
      tab = 1 + aCount + Math.min(removedTermIdx, newCount - 1);
    } else {
      tab = 0;
      lines = [];
      scroll = 0;
    }
    terminalExit = true;
  } else if (slice.tab > removedTabIdx) {
    tab = slice.tab - 1;
  }

  return [{ ...slice, ephemeralTerminals: ephAllNext, tab, lines, scroll }, { sessionId: id, terminalExit }];
}

function addContent(slice, model, { groupName, key, label, lines }) {
  if (!model.config.groups[groupName]) return [slice, { focusDetail: false, terminalExit: false }];

  const ctAll = slice.contentTabs || {};
  const ctGroup = ctAll[groupName] || {};
  const ctGroupNext = { ...ctGroup, [key]: { label, lines: lines || [] } };
  const ctAllNext = { ...ctAll, [groupName]: ctGroupNext };
  let next = { ...slice, contentTabs: ctAllNext };

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

  if (groupName !== model.currentGroup) return [next, null];
  const order = Object.keys(ctGroupNext);
  const aCount = actionTabCount(model, groupName);
  const tCount = Object.keys(groupTerminals(model, next, groupName)).length;
  const idx = next.tab - 1 - aCount - tCount;
  if (idx < 0 || idx >= order.length || order[idx] !== key) return [next, null];
  return [{ ...next, lines: lines || [], scroll: 0 }, null];
}

/** Returns [newSlice, { needShowSelectedInfo }] — needShowSelectedInfo
 *  is true when the closed tab was the last content tab so the body
 *  falls back to Info (caller emits the Cmd). */
function removeContent(slice, model, { groupName, key }) {
  const ctAll = slice.contentTabs;
  const ct = ctAll && ctAll[groupName];
  if (!ct || !ct[key]) return [slice, { needShowSelectedInfo: false }];

  const { [key]: _removed, ...ctGroupRest } = ct;
  const ctAllNext = { ...ctAll };
  if (Object.keys(ctGroupRest).length === 0) delete ctAllNext[groupName];
  else ctAllNext[groupName] = ctGroupRest;

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
      lines = [];
      scroll = 0;
      needShowSelectedInfo = true;
    }
  } else if (slice.tab > removedTabIdx) {
    tab = slice.tab - 1;
  }

  return [{ ...slice, contentTabs: ctAllNext, tab, lines, scroll }, { needShowSelectedInfo }];
}

/**
 * Reorder content tabs within a group: move tab at `fromIdx` to `toIdx`.
 * JS preserves insertion order for string keys, so we rebuild
 * contentTabs[group] with the permuted sequence. slice.tab follows the
 * moved tab when active is the one moving; otherwise it adjusts so the
 * SAME content stays focused.
 */
function reorderContent(slice, model, { groupName, fromIdx, toIdx }) {
  const ctAll = slice.contentTabs || {};
  const ct = ctAll[groupName];
  if (!ct) return slice;
  const keys = Object.keys(ct);
  const n = keys.length;
  if (fromIdx < 0 || fromIdx >= n) return slice;
  const clampedTo = Math.max(0, Math.min(n - 1, toIdx));
  if (fromIdx === clampedTo) return slice;

  const reordered = keys.slice();
  const [moved] = reordered.splice(fromIdx, 1);
  reordered.splice(clampedTo, 0, moved);
  const ctGroupNext = {};
  for (const k of reordered) ctGroupNext[k] = ct[k];
  const ctAllNext = { ...ctAll, [groupName]: ctGroupNext };
  let next = { ...slice, contentTabs: ctAllNext };

  if (groupName !== model.currentGroup) return next;

  const aCount = actionTabCount(model, groupName);
  const tCount = Object.keys(groupTerminals(model, next, groupName)).length;
  const contentBase = 1 + aCount + tCount;
  const oldContentTab = slice.tab - contentBase;
  if (oldContentTab < 0 || oldContentTab >= n) return next;

  let newTab = slice.tab;
  if (oldContentTab === fromIdx) {
    newTab = contentBase + clampedTo;
  } else if (fromIdx < clampedTo) {
    if (oldContentTab > fromIdx && oldContentTab <= clampedTo) newTab--;
  } else {
    if (oldContentTab >= clampedTo && oldContentTab < fromIdx) newTab++;
  }
  if (newTab === slice.tab) return next;
  return { ...next, tab: newTab };
}

// --- The Msg reducer (paneId-parameterised) -------------------------------

/**
 * Reduce a tab-related Msg. Returns null when msg.type is not one we
 * own (caller handles it). Otherwise returns the next slice, or
 * `[next, cmds]` when the case emits Cmds.
 *
 * ctx contract:
 *   paneId             — the pane this reducer represents. All
 *                        self-referential wrap() targets use this id.
 *   wrap(name, inner)  — Component-fan-out envelope.
 *   getModel()         — current model (for currentGroup reads).
 *   getTabInfo()       — flat tab info { actionTabs, termTabs,
 *                        contentTabs, total } for the active group.
 *   activeContentTab() — [key, info] | null for the active content tab.
 */
function reduceTabMsg(msg, slice, ctx) {
  const { paneId, wrap, getModel, getTabInfo, activeContentTab } = ctx;
  switch (msg.type) {
    case 'tab_switch': {
      // Full tab-switch cascade — orchestrates the cross-layer concerns
      // (kill streaming proc, exit terminal mode, then dispatch the
      // per-kind body update) that the bare `viewer_set_tab` primitive
      // doesn't. Emitted from the mouse tab-click in input.js and from
      // `tab_cycle`.
      const { actionTabs, termTabs, total } = getTabInfo();
      const idx = msg.idx | 0;
      if (idx < 0 || idx >= total) return slice;
      let next = { ...slice, tab: idx };
      const effects = [
        { type: 'kill_proc' },
        { type: 'apply_msg', msg: { type: 'terminal_exit' } },
      ];
      if (idx === 0) {
        // Wipe lines+scroll BEFORE show_selected_info fires. The Cmd
        // repopulates iff focus is on a navigator; when focus is the
        // pane (the common case after clicking Info on a non-Info
        // tab), the show-info path bails and stale lines from the
        // previous tab would otherwise paint under the Info label.
        next = { ...next, lines: [], scroll: 0 };
        effects.push({ type: 'dispatch_msg', msg: wrap(paneId, { type: 'viewer_show_info' }) });
      } else if (idx <= actionTabs.length) {
        const [key, act] = actionTabs[idx - 1];
        effects.push({ type: 'stream_action', actionKey: key, script: act.script });
      } else if (idx <= actionTabs.length + termTabs.length) {
        next = { ...next, lines: [], scroll: 0 };
      } else {
        const ct = activeContentTab();
        if (ct) {
          const [, info] = ct;
          next = { ...next, lines: (info.lines || []).slice(), scroll: 0 };
        }
      }
      return [next, effects];
    }
    case 'tab_cycle': {
      // next_tab / prev_tab keyboard verbs land here — compute the
      // wrapped index and re-emit through tab_switch so both keyboard
      // and mouse paths share the cascade.
      const { total } = getTabInfo();
      if (total <= 1) return slice;
      const next = (slice.tab + (msg.dir | 0) + total) % total;
      return [slice, [{ type: 'dispatch_msg', msg: wrap(paneId, { type: 'tab_switch', idx: next }) }]];
    }

    // --- tab lifecycle ---
    case 'viewer_add_ephemeral_terminal': {
      const [next, info] = addEphemeral(slice, getModel(), msg);
      const effects = [];
      if (info.focusDetail)   effects.push({ type: 'dispatch_msg', msg: wrap('layout', { type: 'focus_set', focus: paneId }) });
      if (info.terminalEnter) effects.push({ type: 'apply_msg', msg: { type: 'terminal_enter' } });
      return [next, effects];
    }
    case 'viewer_remove_ephemeral_terminal': {
      const [next, { sessionId, terminalExit }] = removeEphemeral(slice, getModel(), msg);
      const effects = [];
      if (sessionId)    effects.push({ type: 'destroy_pty_session', id: sessionId });
      if (terminalExit) effects.push({ type: 'apply_msg', msg: { type: 'terminal_exit' } });
      return [next, effects];
    }
    case 'viewer_add_content_tab': {
      const [next, info] = addContent(slice, getModel(), msg);
      const effects = [];
      if (info.focusDetail)  effects.push({ type: 'dispatch_msg', msg: wrap('layout', { type: 'focus_set', focus: paneId }) });
      if (info.terminalExit) effects.push({ type: 'apply_msg', msg: { type: 'terminal_exit' } });
      return [next, effects];
    }
    case 'viewer_update_content_tab_lines': {
      const [next] = updateContentLines(slice, getModel(), msg);
      return next;
    }
    case 'viewer_remove_content_tab': {
      const [next, { needShowSelectedInfo }] = removeContent(slice, getModel(), msg);
      return [next, needShowSelectedInfo ? [{ type: 'show_selected_info' }] : []];
    }
    case 'viewer_reorder_content_tab':
      return reorderContent(slice, getModel(), msg);

    // --- tab-list overlay (the `[≡]` switcher anchored to the pane's
    // top-left). Cursor starts at the active tab; scroll keeps it in
    // view as it walks the list.
    case 'tab_list_open': {
      const vh = Math.max(1, msg.vh | 0);
      const tabCount = msg.tabCount | 0 || 1;
      const cursor = Math.max(0, Math.min(slice.tab | 0, tabCount - 1));
      let scroll = 0;
      if (cursor >= vh) scroll = Math.min(cursor - vh + 1, Math.max(0, tabCount - vh));
      return [
        { ...slice, tabList: { open: true, cursor, scroll } },
        [
          // Mode flag drives keyboard routing (chain mode).
          { type: 'apply_msg', msg: { type: 'mode_set', flag: 'tabListMode' } },
          // v0.6.1 Phase 4 — record which pane the overlay anchors to,
          // so the renderer + hit-test can stop assuming singleton-detail.
          { type: 'dispatch_msg', msg: wrap('layout', { type: 'tab_list_set_owner', paneId }) },
        ],
      ];
    }
    case 'tab_list_close':
      if (!slice.tabList || !slice.tabList.open) return slice;
      return [
        { ...slice, tabList: { ...slice.tabList, open: false } },
        [
          { type: 'apply_msg', msg: { type: 'mode_clear', flag: 'tabListMode' } },
          { type: 'dispatch_msg', msg: wrap('layout', { type: 'tab_list_set_owner', paneId: null }) },
          { type: 'force_full_repaint' },
        ],
      ];
    case 'tab_list_nav': {
      const tl = slice.tabList || { open: false, cursor: 0, scroll: 0 };
      if (!tl.open) return slice;
      const tabCount = msg.tabCount | 0 || 1;
      const vh = Math.max(1, msg.vh | 0);
      let cursor = tl.cursor;
      if (msg.to === 'top')           cursor = 0;
      else if (msg.to === 'bottom')   cursor = tabCount - 1;
      else if (msg.to === 'pageup')   cursor = Math.max(0, tl.cursor - vh);
      else if (msg.to === 'pagedown') cursor = Math.min(tabCount - 1, tl.cursor + vh);
      else                            cursor = tl.cursor + (msg.dir | 0);
      cursor = Math.max(0, Math.min(tabCount - 1, cursor));
      let scroll = tl.scroll | 0;
      const maxScroll = Math.max(0, tabCount - vh);
      if (cursor < scroll)              scroll = cursor;
      else if (cursor >= scroll + vh)   scroll = cursor - vh + 1;
      scroll = Math.max(0, Math.min(scroll, maxScroll));
      if (cursor === tl.cursor && scroll === tl.scroll) return slice;
      return { ...slice, tabList: { ...tl, cursor, scroll } };
    }
    case 'tab_list_pick': {
      const tl = slice.tabList || { open: false, cursor: 0 };
      if (!tl.open) return slice;
      const idx = tl.cursor | 0;
      return [
        { ...slice, tabList: { ...tl, open: false } },
        [
          { type: 'apply_msg', msg: { type: 'mode_clear', flag: 'tabListMode' } },
          { type: 'dispatch_msg', msg: wrap('layout', { type: 'tab_list_set_owner', paneId: null }) },
          { type: 'dispatch_msg', msg: wrap('layout', { type: 'focus_set', focus: paneId }) },
          { type: 'dispatch_msg', msg: wrap(paneId, { type: 'tab_switch', idx }) },
          { type: 'force_full_repaint' },
        ],
      ];
    }
    case 'tab_list_close_selected': {
      // Caller (overlay key handler) resolves the row's closeable +
      // closeKind + closeKey from the flat tab list and threads them
      // in. Non-closeable rows: silent no-op (msg.kind null).
      if (!msg.closeKind || !msg.closeKey) return slice;
      const removeMsg = msg.closeKind === 'content'
        ? { type: 'viewer_remove_content_tab', groupName: getModel().currentGroup, key: msg.closeKey }
        : { type: 'viewer_remove_ephemeral_terminal', groupName: getModel().currentGroup, key: msg.closeKey };
      return [slice, [{ type: 'dispatch_msg', msg: wrap(paneId, removeMsg) }]];
    }

    default:
      return null;
  }
}

module.exports = {
  actionTabCount, groupTerminals, groupContentTabs,
  flatTabInfo,
  isTerminalTabIn, isContentTabIn,
  activeContentTabIn, activeTerminalIdIn, activeTerminalConfigIn,
  findEphemeralByIdIn,
  addEphemeral, removeEphemeral,
  addContent, updateContentLines, removeContent, reorderContent,
  reduceTabMsg,
};
