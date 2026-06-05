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

// Safe lookup of model.config.groups[groupName] — returns the group
// object or null. Every reader in this leaf goes through this so
// pre-loadConfig states (runtime.init() leaves `model.config: null`
// until config loads; bootless tests reach this leaf directly) don't
// crash on the raw `null.groups` read. The four guards below correspond
// to: defended-against-null model / pre-loadConfig config / pre-parse
// groups / unknown group name.
function _groupOf(model, groupName) {
  if (!model || !model.config || !model.config.groups) return null;
  return model.config.groups[groupName] || null;
}

// Merged-action lookup — yields YAML+plugin actions for `groupName`.
// Lazy-require avoids a module-load cycle (panel/api itself imports
// nothing from this leaf). Data flow stays pure: the leaf only READS
// from the registry; nothing mutates here. v0.6.2 — pre-v0.6.2 the
// tab system read group.actions directly and missed plugin-synth
// tab:true actions (postgres demo's `pg:status` was invisible). See
// panel/api.js getMergedActions for the contract.
function _mergedFor(model, groupName) {
  if (!_groupOf(model, groupName)) return {};
  return require('../panel/api').getMergedActions(groupName);
}

function actionTabCount(model, groupName) {
  return Object.values(_mergedFor(model, groupName)).filter(a => a.tab).length;
}

// T2 — view-derived lines for the viewer's active tab. Pure projection
// of (slice, model, focused-Navigator). Order of precedence:
//   1. slice.viewerOverride — discrete-doc writers (history replay,
//      config-status diff, help text, job info card). Cleared on
//      tab_switch.
//   2. Per-tab derivation by tab kind:
//        idx 0 (Info)        → focused Navigator's getInfo(item)
//        idx 1 (Transcript)  → slice.viewerStreamBuffer.lines
//        action tab          → slice.actionTabBuffers[group][key].lines
//                              (else "Press Enter to run." placeholder)
//        term tab            → []  (PTY-rendered separately)
//        content tab         → slice.contentTabs[group][key].lines
//   3. Fallback to slice.lines (legacy field still maintained by some
//      reducer arms in this transition; T2d retires it).
//
// Takes a `lookups` bag of host-bound helpers so the leaf stays
// import-free for the cross-tier concerns (focused-panel resolution,
// getInfo lookup). Caller supplies them via panel/viewer/tabs facade.
function viewerLines(slice, model, groupName, lookups) {
  if (slice && slice.viewerOverride && Array.isArray(slice.viewerOverride.lines)) {
    return slice.viewerOverride.lines;
  }
  const tab = (slice && slice.tab) | 0;
  // Info — derive from focused Navigator.
  if (tab === 0) {
    if (lookups && typeof lookups.infoFromFocus === 'function') {
      const lines = lookups.infoFromFocus();
      if (Array.isArray(lines) && lines.length > 0) return lines;
    }
    return (slice && slice.lines) || [];
  }
  // Transcript — unrouted accumulator.
  if (tab === 1) {
    const vsb = slice && slice.viewerStreamBuffer;
    if (vsb && Array.isArray(vsb.lines) && vsb.lines.length > 0) return vsb.lines;
    return ['[dim](no transcript yet)[/]'];
  }
  const info = flatTabInfo(slice || {}, model, groupName);
  // Action tab.
  if (tab >= 2 && tab <= 1 + info.actionTabs.length) {
    const [actionKey] = info.actionTabs[tab - 2];
    const buf = slice && slice.actionTabBuffers
      && slice.actionTabBuffers[groupName]
      && slice.actionTabBuffers[groupName][actionKey];
    if (buf && Array.isArray(buf.lines) && buf.lines.length > 0) return buf.lines;
    return ['[dim]Press Enter to run.[/]'];
  }
  // Term tab — PTY-rendered, no slice-side content.
  const termBase = 2 + info.actionTabs.length;
  if (tab >= termBase && tab < termBase + info.termTabs.length) return [];
  // Content tab.
  const contentBase = 2 + info.actionTabs.length + info.termTabs.length;
  if (tab >= contentBase && tab < contentBase + info.contentTabs.length) {
    const [contentKey] = info.contentTabs[tab - contentBase];
    const ct = slice && slice.contentTabs
      && slice.contentTabs[groupName]
      && slice.contentTabs[groupName][contentKey];
    if (ct && Array.isArray(ct.lines)) return ct.lines;
  }
  // Fallback (degenerate tab idx, etc.) — legacy slice.lines.
  return (slice && slice.lines) || [];
}

/** Merged terminals: YAML-defined first, then runtime-ephemeral. */
function groupTerminals(model, slice, groupName) {
  const group = _groupOf(model, groupName);
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
 *  Tab strip layout, left → right:
 *    [Info] [Transcript] [actionTabs...] [termTabs...] [contentTabs...]
 *       0        1          2..1+A          2+A..1+A+T   2+A+T..1+A+T+C
 *  Two implicit globals (Info, Transcript) lead; per-group tabs follow.
 *  actionTabs comes from `group.actions[*].tab` merged with plugin-
 *  synthesized actions (see panel/api.js getMergedActions — v0.6.2
 *  fix for plugin tab:true actions that were invisible to this leaf
 *  pre-merge). termTabs merges group.terminals (YAML) + slice.
 *  ephemeralTerminals[groupName] (runtime); contentTabs comes from
 *  slice.contentTabs[groupName]. `total` = 2 globals + A + T + C
 *  (v0.6.2 — Transcript took over hosting the unrouted accumulator
 *  so Info could be pure selection-info; placed right after Info so
 *  it stays adjacent regardless of how long the per-group strip
 *  grows). */
function flatTabInfo(slice, model, groupName) {
  const group = _groupOf(model, groupName);
  if (!group) return { actionTabs: [], termTabs: [], contentTabs: [], total: 2 };
  const actionTabs = Object.entries(_mergedFor(model, groupName)).filter(([, a]) => a.tab);
  const termTabs = Object.entries(groupTerminals(model, slice, groupName));
  const contentTabs = Object.entries(groupContentTabs(slice, groupName));
  return {
    actionTabs, termTabs, contentTabs,
    total: 2 + actionTabs.length + termTabs.length + contentTabs.length,
  };
}

/** Flat-index of the Transcript tab — always 1 (right after Info). */
function transcriptTabIdx(_info) {
  return 1;
}

/** True when the slice's active tab is the Transcript tab. */
function isTranscriptTabIn(slice, _model, _groupName) {
  return (slice.tab | 0) === 1;
}

/** True when the slice's active tab is a terminal tab in `groupName`. */
function isTerminalTabIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  if (info.termTabs.length === 0) return false;
  const start = 2 + info.actionTabs.length;
  const t = slice.tab | 0;
  return t >= start && t < start + info.termTabs.length;
}

/** True when the slice's active tab is an action tab in `groupName`. */
function isActionTabIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  if (info.actionTabs.length === 0) return false;
  const t = slice.tab | 0;
  return t >= 2 && t <= 1 + info.actionTabs.length;
}

/** [key, action] for the active action tab, or null. */
function activeActionTabIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  const idx = (slice.tab | 0) - 2;
  if (idx < 0 || idx >= info.actionTabs.length) return null;
  return info.actionTabs[idx];
}

/** True when the slice's active tab is a content tab in `groupName`. */
function isContentTabIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  if (info.contentTabs.length === 0) return false;
  const start = 2 + info.actionTabs.length + info.termTabs.length;
  const t = slice.tab | 0;
  return t >= start && t < start + info.contentTabs.length;
}

/** [key, { label, lines }] for the active content tab, or null. */
function activeContentTabIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  const idx = (slice.tab | 0) - 2 - info.actionTabs.length - info.termTabs.length;
  if (idx < 0 || idx >= info.contentTabs.length) return null;
  return info.contentTabs[idx];
}

/** Session id (`${group}_${key}`) for the active terminal tab, or null. */
function activeTerminalIdIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  const idx = (slice.tab | 0) - 2 - info.actionTabs.length;
  if (idx < 0 || idx >= info.termTabs.length) return null;
  return `${groupName}_${info.termTabs[idx][0]}`;
}

/** { cmd, label } for the active terminal tab, or null. */
function activeTerminalConfigIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  const idx = (slice.tab | 0) - 2 - info.actionTabs.length;
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
  if (!_groupOf(model, groupName)) return [slice, { focusDetail: false, terminalEnter: false }];

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
    { ...next, tab: 2 + actionTabCount(model, groupName) + termIdx },
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
  const removedTabIdx = 2 + aCount + removedTermIdx;

  const yaml = (_groupOf(model, groupName) || {}).terminals || {};
  const newCount = Object.keys({ ...yaml, ...ephGroupRest }).length;

  let tab = slice.tab;
  let lines = slice.lines;
  let scroll = slice.scroll;
  let terminalExit = false;
  if (slice.tab === removedTabIdx) {
    if (newCount > 0) {
      tab = 2 + aCount + Math.min(removedTermIdx, newCount - 1);
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
  if (!_groupOf(model, groupName)) return [slice, { focusDetail: false, terminalExit: false }];

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
    tab: 2 + aCount + tCount + contentIdx,
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
  const idx = next.tab - 2 - aCount - tCount;
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
  const removedTabIdx = 2 + aCount + tCount + removedContentIdx;

  let tab = slice.tab;
  let lines = slice.lines;
  let scroll = slice.scroll;
  let needShowSelectedInfo = false;

  if (slice.tab === removedTabIdx) {
    const remainingKeys = Object.keys(ctGroupRest);
    if (remainingKeys.length > 0) {
      const newContentIdx = Math.min(removedContentIdx, remainingKeys.length - 1);
      tab = 2 + aCount + tCount + newContentIdx;
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
  const contentBase = 2 + aCount + tCount;
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
      // T2c — tab_switch clears the discrete-doc override; the user's
      // navigation gesture dismisses whatever override was active.
      let next = { ...slice, tab: idx, viewerOverride: null };
      // No kill_proc — the producer keeps writing into its buffer
      // while the user is off-tab. Singleton preempt happens inside
      // streamCommand when a new run starts.
      const effects = [
        { type: 'msg', msg: { type: 'terminal_exit' } },
      ];
      // T3b — resolve target tab key for per-tab scroll restore. Same
      // mapping as viewer.js _activeTabKey; kept inline to keep the
      // leaf import-free.
      let targetKey = null;
      const groupName = getModel().currentGroup;
      if (idx === 0) targetKey = 'info';
      else if (idx === 1) targetKey = 'transcript';
      else if (idx <= 1 + actionTabs.length) {
        targetKey = `action:${actionTabs[idx - 2][0]}`;
      } else if (idx <= 1 + actionTabs.length + termTabs.length) {
        const termIdx = idx - 2 - actionTabs.length;
        targetKey = `terminal:${termTabs[termIdx][0]}`;
      } else {
        const ct = activeContentTab();
        if (ct) targetKey = `content:${ct[0]}`;
      }
      const tabEntry = slice.tabState && targetKey && slice.tabState[targetKey];
      const storedScroll = tabEntry ? tabEntry.scroll : undefined;
      const storedSticky = tabEntry ? !!tabEntry.bottomSticky : false;
      // T3c/d/e — restore the target tab's stored view state
      // (search / select / cursor). Cross-tab leakage retired:
      // each tab's selection / search / cursor refer to its own
      // content, not whatever was on the previous tab. Fresh
      // defaults when never visited.
      const _emptySearch = () => ({ active: false, term: '', matches: [], idx: 0, typing: '' });
      const _emptySelect = () => ({ active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } });
      const _emptyCursor = () => ({ line: 0, col: 0 });
      next = {
        ...next,
        search: (tabEntry && tabEntry.search)  || _emptySearch(),
        select: (tabEntry && tabEntry.select)  || _emptySelect(),
        cursor: (tabEntry && tabEntry.cursor)  || _emptyCursor(),
      };
      // T3b — resolve scroll for the target tab:
      //   1. If the user left bottom-stuck, snap to the new bottom
      //      (tail-tracking semantics — live streams that grew while
      //      off-tab should show the new tail).
      //   2. Else if a stored scroll exists, restore literally.
      //   3. Else (first visit) fall back to the kind-specific default
      //      (bottom-pin for buffers, 0 for everything else).
      const _resolveScroll = (defaultScroll, currentBottom) => {
        if (storedSticky) return currentBottom;
        if (storedScroll !== undefined) return storedScroll;
        return defaultScroll;
      };

      if (idx === 0) {
        // Info — pure selection-info. Always clear + ask the focused
        // Navigator to repopulate via show_selected_info.
        next = { ...next, lines: [], scroll: _resolveScroll(0, 0) };
        effects.push({ type: 'msg', msg: wrap(paneId, { type: 'viewer_show_info' }) });
      } else if (idx === 1) {
        // Transcript — the unrouted accumulator's display home.
        // Restore from viewerStreamBuffer. Bottom-pin on first visit
        // or when sticky; literal restore otherwise.
        const vsb = slice.viewerStreamBuffer;
        const lines = vsb && Array.isArray(vsb.lines) && vsb.lines.length > 0
          ? vsb.lines.slice()
          : ['[dim](no transcript yet)[/]'];
        const innerH = slice.innerH > 0 ? slice.innerH : 1;
        const bottom = Math.max(0, lines.length - innerH);
        next = { ...next, lines, scroll: _resolveScroll(bottom, bottom) };
      } else if (idx <= 1 + actionTabs.length) {
        // View-only restore from actionTabBuffers, else placeholder.
        // Sticky → snap to new bottom (live tail); stored → literal
        // restore; first visit → bottom-pin.
        const [actionKey] = actionTabs[idx - 2];
        const buf = slice.actionTabBuffers
          && slice.actionTabBuffers[groupName]
          && slice.actionTabBuffers[groupName][actionKey];
        const lines = buf && Array.isArray(buf.lines) && buf.lines.length > 0
          ? buf.lines.slice()
          : ['[dim]Press Enter to run.[/]'];
        const innerH = slice.innerH > 0 ? slice.innerH : 1;
        const bottom = Math.max(0, lines.length - innerH);
        next = { ...next, lines, scroll: _resolveScroll(bottom, bottom) };
      } else if (idx <= 1 + actionTabs.length + termTabs.length) {
        next = { ...next, lines: [], scroll: _resolveScroll(0, 0) };
      } else {
        const ct = activeContentTab();
        if (ct) {
          const [, info] = ct;
          next = { ...next, lines: (info.lines || []).slice(), scroll: _resolveScroll(0, 0) };
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
      return [slice, [{ type: 'msg', msg: wrap(paneId, { type: 'tab_switch', idx: next }) }]];
    }

    // --- tab lifecycle ---
    case 'viewer_add_ephemeral_terminal': {
      const [next, info] = addEphemeral(slice, getModel(), msg);
      const effects = [];
      if (info.focusDetail)   effects.push({ type: 'msg', msg: wrap('layout', { type: 'focus_set', focus: paneId }) });
      if (info.terminalEnter) effects.push({ type: 'msg', msg: { type: 'terminal_enter' } });
      return [next, effects];
    }
    case 'viewer_remove_ephemeral_terminal': {
      const [next, { sessionId, terminalExit }] = removeEphemeral(slice, getModel(), msg);
      const effects = [];
      if (sessionId)    effects.push({ type: 'destroy_pty_session', id: sessionId });
      if (terminalExit) effects.push({ type: 'msg', msg: { type: 'terminal_exit' } });
      return [next, effects];
    }
    case 'viewer_add_content_tab': {
      const [next, info] = addContent(slice, getModel(), msg);
      const effects = [];
      if (info.focusDetail)  effects.push({ type: 'msg', msg: wrap('layout', { type: 'focus_set', focus: paneId }) });
      if (info.terminalExit) effects.push({ type: 'msg', msg: { type: 'terminal_exit' } });
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
        { ...slice, tabList: { cursor, scroll } },
        [
          // Mode flag drives keyboard routing (chain mode) AND is the
          // canonical "tab list is open" bit (AR2 — was duplicated on
          // the per-pane slice as `tabList.open`).
          { type: 'msg', msg: { type: 'mode_set', flag: 'tabListMode' } },
          // v0.6.1 Phase 4 — record which pane the overlay anchors to,
          // so the renderer + hit-test can stop assuming singleton-detail.
          { type: 'msg', msg: wrap('layout', { type: 'tab_list_set_owner', paneId }) },
        ],
      ];
    }
    case 'tab_list_close':
      if (!getModel().modes.tabListMode) return slice;
      return [
        slice,
        [
          { type: 'msg', msg: { type: 'mode_clear', flag: 'tabListMode' } },
          { type: 'msg', msg: wrap('layout', { type: 'tab_list_set_owner', paneId: null }) },
          { type: 'force_full_repaint' },
        ],
      ];
    case 'tab_list_nav': {
      if (!getModel().modes.tabListMode) return slice;
      const tl = slice.tabList || { cursor: 0, scroll: 0 };
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
      if (!getModel().modes.tabListMode) return slice;
      const tl = slice.tabList || { cursor: 0 };
      const idx = tl.cursor | 0;
      return [
        slice,
        [
          { type: 'msg', msg: { type: 'mode_clear', flag: 'tabListMode' } },
          { type: 'msg', msg: wrap('layout', { type: 'tab_list_set_owner', paneId: null }) },
          { type: 'msg', msg: wrap('layout', { type: 'focus_set', focus: paneId }) },
          { type: 'msg', msg: wrap(paneId, { type: 'tab_switch', idx }) },
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
      return [slice, [{ type: 'msg', msg: wrap(paneId, removeMsg) }]];
    }

    default:
      return null;
  }
}

module.exports = {
  actionTabCount, groupTerminals, groupContentTabs,
  flatTabInfo, transcriptTabIdx, isTranscriptTabIn,
  viewerLines,
  isTerminalTabIn, isContentTabIn, isActionTabIn,
  activeContentTabIn, activeActionTabIn, activeTerminalIdIn, activeTerminalConfigIn,
  findEphemeralByIdIn,
  addEphemeral, removeEphemeral,
  addContent, updateContentLines, removeContent, reorderContent,
  reduceTabMsg,
};
