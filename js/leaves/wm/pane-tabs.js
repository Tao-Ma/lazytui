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
 *      ctx = { paneId, wrap }.
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
//
// U2c P2 — the injected merged-actions provider (setMergedActionsProvider /
// _mergedProvider / _mergedFor, wired by panel/api at boot) is removed with the
// action-tab machinery it fed: its only consumer was the action-tab enumeration
// in flatTabInfo / flatTabInfoFromBundle. Action output now lives in text-view
// instances, so the leaf no longer needs the merged (YAML + plugin) action set.

// T2 — view-derived lines for the viewer's active tab. Pure projection
// of (slice, model, focused-Navigator). Order of precedence:
//   1. slice.viewerOverride — discrete-doc writers (history replay,
//      config-status diff, help text, job info card). Cleared on
//      tab_switch.
//   2. Per-tab derivation by tab kind:
//        idx 0 (Info)        → focused Navigator's getInfo(item)
//        idx 1 (Transcript)  → slice.viewerStreamBuffer.lines
//        term tab            → []  (PTY-rendered separately)
//        content tab         → slice.contentTabs[group][key].lines
//   3. Degenerate tab idx falls back to empty (P3 — the legacy
//      slice.lines field is DELETED; Info's home is slice.infoLines).
//
// Takes a `lookups` bag of host-bound helpers so the leaf stays
// import-free for the cross-tier concerns (focused-panel resolution,
// getInfo lookup). Caller supplies them via panel/viewer/tabs facade.
// Shared body for viewerLines / viewerLinesFromBundle. `infoFn` is a thunk
// computing flatTabInfo, called LAZILY (only for tab>=2) so the hot
// info/transcript tabs (0/1) never pay for it. `groupName` keys the
// action/content buffers (== bundle.currentGroup in the from-bundle path).
function _viewerLinesCore(slice, groupName, infoFn, lookups) {
  if (slice && slice.viewerOverride && Array.isArray(slice.viewerOverride.lines)) {
    return slice.viewerOverride.lines;
  }
  const tab = (slice && slice.tab) | 0;
  // Info — P0 (viewer-lines selector arc): canonical home is
  // slice.infoLines (written by viewer_show_info from dispatcher-
  // computed msg.lines). The optional lookups.infoFromFocus hook is the
  // RENDER-time live projection (display follows the focused Navigator
  // even between show_selected_info events); reducer-side callers (the
  // finalizer) omit it and read the stored basis.
  if (tab === 0) {
    if (lookups && typeof lookups.infoFromFocus === 'function') {
      const lines = lookups.infoFromFocus();
      if (Array.isArray(lines) && lines.length > 0) return lines;
    }
    return (slice && slice.infoLines) || [];
  }
  // Transcript — unrouted accumulator.
  if (tab === 1) {
    const vsb = slice && slice.viewerStreamBuffer;
    if (vsb && Array.isArray(vsb.lines) && vsb.lines.length > 0) return vsb.lines;
    return ['[dim](no transcript yet)[/]'];
  }
  const info = infoFn();
  // Term tab — PTY-rendered, no slice-side content. (U2c P2 — action tabs
  // retired; action output lives in its own text-view instance now, so terms
  // start right after Info + Transcript.)
  const termBase = 2;
  if (tab >= termBase && tab < termBase + info.termTabs.length) return [];
  // Content tab.
  const contentBase = 2 + info.termTabs.length;
  if (tab >= contentBase && tab < contentBase + info.contentTabs.length) {
    const [contentKey] = info.contentTabs[tab - contentBase];
    const ct = slice && slice.contentTabs
      && slice.contentTabs[groupName]
      && slice.contentTabs[groupName][contentKey];
    if (ct && Array.isArray(ct.lines)) return ct.lines;
  }
  // Fallback (degenerate tab idx, etc.) — nothing to show.
  return [];
}

function viewerLines(slice, model, groupName, lookups) {
  return _viewerLinesCore(slice, groupName,
    () => flatTabInfo(slice || {}, model, groupName), lookups);
}

// blessed-exceptions #3 P1 — the from-bundle twin of viewerLines. Same body,
// facts sourced from a `viewerModelBundle` instead of the live model, so the
// viewer reducer can derive lines without reading getModel().
function viewerLinesFromBundle(slice, bundle, lookups) {
  return _viewerLinesCore(slice, bundle && bundle.currentGroup,
    () => flatTabInfoFromBundle(slice || {}, bundle), lookups);
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
 *    { termTabs, contentTabs, total }
 *  Tab strip layout, left → right:
 *    [Info] [Transcript] [termTabs...] [contentTabs...]
 *       0        1          2..1+T        2+T..1+T+C
 *  Two implicit globals (Info, Transcript) lead; per-group tabs follow.
 *  (U2c P2 — action tabs retired: a tab:true action's output now lives in its
 *  own text-view instance minted as a position-tab, so it no longer appears in
 *  this viewer-internal strip.) termTabs merges group.terminals (YAML) + slice.
 *  ephemeralTerminals[groupName] (runtime); contentTabs comes from
 *  slice.contentTabs[groupName]. `total` = 2 globals + T + C. */
function flatTabInfo(slice, model, groupName) {
  const group = _groupOf(model, groupName);
  if (!group) return { termTabs: [], contentTabs: [], total: 2 };
  const termTabs = Object.entries(groupTerminals(model, slice, groupName));
  const contentTabs = Object.entries(groupContentTabs(slice, groupName));
  return {
    termTabs, contentTabs,
    total: 2 + termTabs.length + contentTabs.length,
  };
}

// blessed-exceptions #3 P1 — the from-bundle twin of flatTabInfo. Identical
// result, sourced from a `viewerModelBundle` (mergedActions pre-computed,
// group/yamlTerminals snapshotted) instead of the live model. `bundle.
// currentGroup` is the group the bundle describes, so it keys ephemerals /
// content exactly as the model-path `groupName` does.
function flatTabInfoFromBundle(slice, bundle) {
  if (!bundle || !bundle.group) return { termTabs: [], contentTabs: [], total: 2 };
  const gn = bundle.currentGroup;
  const eph = (slice && slice.ephemeralTerminals && slice.ephemeralTerminals[gn]) || {};
  const termTabs = Object.entries({ ...(bundle.yamlTerminals || {}), ...eph });
  const contentTabs = Object.entries(groupContentTabs(slice || {}, gn));
  return {
    termTabs, contentTabs,
    total: 2 + termTabs.length + contentTabs.length,
  };
}

/** Flat-index of the Transcript tab — always 1 (right after Info). */
function transcriptTabIdx() {
  return 1;
}

// N1 — single canonical resolver for "tab idx → stable string key".
// Three copies of this mapping used to exist (viewer.js _activeTabKey,
// pane-tabs.js inline-in-tab_switch, pane-tabs.js dead _resolveKey).
// All three are now thin wrappers / calls into this. Per-group kinds
// carry the group prefix (B4); Info / Transcript are unprefixed.
function resolveTabKey(idx, slice, model) {
  if (idx === 0) return 'info';
  if (idx === 1) return 'transcript';
  if (!model || !model.config || !model.config.groups) return null;
  const groupName = model.currentGroup;
  const info = flatTabInfo(slice || {}, model, groupName);
  const termBase = 2;
  if (idx >= termBase && idx < termBase + info.termTabs.length) {
    return `${groupName}:terminal:${info.termTabs[idx - termBase][0]}`;
  }
  const contentBase = 2 + info.termTabs.length;
  if (idx >= contentBase && idx < contentBase + info.contentTabs.length) {
    return `${groupName}:content:${info.contentTabs[idx - contentBase][0]}`;
  }
  return null;
}

// blessed-exceptions #3 P1 — the from-bundle twin of resolveTabKey.
function resolveTabKeyFromBundle(idx, slice, bundle) {
  if (idx === 0) return 'info';
  if (idx === 1) return 'transcript';
  if (!bundle || !bundle.group) return null;
  const groupName = bundle.currentGroup;
  const info = flatTabInfoFromBundle(slice || {}, bundle);
  const termBase = 2;
  if (idx >= termBase && idx < termBase + info.termTabs.length) {
    return `${groupName}:terminal:${info.termTabs[idx - termBase][0]}`;
  }
  const contentBase = 2 + info.termTabs.length;
  if (idx >= contentBase && idx < contentBase + info.contentTabs.length) {
    return `${groupName}:content:${info.contentTabs[idx - contentBase][0]}`;
  }
  return null;
}

/** True when the slice's active tab is a terminal tab in `groupName`. */
function isTerminalTabIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  if (info.termTabs.length === 0) return false;
  const start = 2;
  const t = slice.tab | 0;
  return t >= start && t < start + info.termTabs.length;
}

/** True when the slice's active tab is a content tab in `groupName`. */
function isContentTabIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  if (info.contentTabs.length === 0) return false;
  const start = 2 + info.termTabs.length;
  const t = slice.tab | 0;
  return t >= start && t < start + info.contentTabs.length;
}

/** [key, { label, lines }] for the active content tab, or null. */
function activeContentTabIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  const idx = (slice.tab | 0) - 2 - info.termTabs.length;
  if (idx < 0 || idx >= info.contentTabs.length) return null;
  return info.contentTabs[idx];
}

/** Session id (`${group}_${key}`) for the active terminal tab, or null. */
function activeTerminalIdIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  const idx = (slice.tab | 0) - 2;
  if (idx < 0 || idx >= info.termTabs.length) return null;
  return `${groupName}_${info.termTabs[idx][0]}`;
}

/** { cmd, label } for the active terminal tab, or null. */
function activeTerminalConfigIn(slice, model, groupName) {
  const info = flatTabInfo(slice, model, groupName);
  const idx = (slice.tab | 0) - 2;
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
//
// v0.6.3 TEA cleanup: these leaves used to take `(slice, model, msg)`
// and read model.config.groups + model.currentGroup directly. They
// now take `(slice, msg)` with the model-derived facts precomputed
// by the dispatcher and threaded via msg: `currentGroup`,
// `groupExists`, `yamlTerminals`, `actionCount`. Use `modelBundle()`
// (exported below) to compute the bundle once per dispatch.

/** Precompute the model-derived facts these leaves need, so dispatchers
 *  can thread them into each Msg payload and the leaves stay pure of
 *  getModel(). The bundle covers the 6 content/ephemeral tab leaves
 *  (addEphemeral / removeEphemeral / addContent / updateContentLines
 *  / removeContent / reorderContent). Spread into the dispatched Msg:
 *
 *    panelHost.dispatchMsg(wrap(target, {
 *      type: 'viewer_add_content_tab', groupName, key, label, lines,
 *      ...pt.modelBundle(model, groupName),
 *    }));
 */
function modelBundle(model, groupName) {
  const group = _groupOf(model, groupName);
  return {
    currentGroup: (model && model.currentGroup) || '',
    groupExists: !!group,
    yamlTerminals: group ? (group.terminals || {}) : null,
    // U2c P2 — action tabs retired (action output → its own text-view instance),
    // so they no longer offset the terminal/content tab indices. Kept as a 0 so the
    // terminal/content mutators' `2 + actionCount + …` index math stays correct
    // without churn (those mutators are reworked when terminals move — U2d).
    actionCount: 0,
  };
}

/** blessed-exceptions #3 — the full model fact-set the viewer's tab/content
 *  readers (flatTabInfo / viewerLines / resolveTabKey + the `is*TabIn`
 *  predicates) need, captured ONCE so `viewer.update` can read it from the
 *  Msg payload instead of `getModel()`. (U2c P2 — `mergedActions` dropped: it
 *  fed only the retired action-tab enumeration.) Pair with
 *  `flatTabInfoFromBundle` / `viewerLinesFromBundle` (P1). */
function viewerModelBundle(model, groupName) {
  const group = _groupOf(model, groupName);
  return {
    // `currentGroup` = the group this bundle describes (always the viewer's
    // current group in practice). The `*FromBundle` readers key ephemerals /
    // content / tab-key prefixes off it, so it MUST match the `groupName` the
    // facts were computed for (parity with the model-path flatTabInfo).
    currentGroup: groupName,
    group,
    yamlTerminals: group ? (group.terminals || {}) : null,
  };
}

function addEphemeral(slice, { groupName, key, cmd, label, currentGroup, groupExists, yamlTerminals, actionCount }) {
  if (!groupExists) return [slice, { focusDetail: false, terminalEnter: false }];

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
  if (groupName !== currentGroup) return [next, { focusDetail: false, terminalEnter: false }];

  const allTerms = { ...(yamlTerminals || {}), ...ephGroupNext };
  const termIdx = Object.keys(allTerms).indexOf(key);
  if (termIdx < 0) return [next, { focusDetail: false, terminalEnter: false }];
  return [
    { ...next, tab: 2 + actionCount + termIdx },
    { focusDetail: true, terminalEnter: true },
  ];
}

// R5 — drop a tabState entry when its tab is removed. Without this,
// tabState[<group>:<kind>:<key>] outlives the tab and gets restored
// the next time the user creates a new tab with the same key (e.g.
// reopening the same file path, recreating an ephemeral terminal
// under the same key) — counter to the "first visit → kind-specific
// default" rule in tab_switch's _resolveScroll.
// Store mechanics live in the pane-agnostic tab-state leaf (P1); this keeps the
// R5 name + the group:kind:key rationale at the viewer's call sites.
function _dropTabStateEntry(slice, key) {
  return require('./tab-state').dropEntry(slice, key);
}

function removeEphemeral(slice, { groupName, key, currentGroup, yamlTerminals, actionCount }) {
  const eph = slice.ephemeralTerminals[groupName];
  if (!eph || !eph[key]) return [slice, { sessionId: null, terminalExit: false }];

  const id = `${groupName}_${key}`;

  const { [key]: _removed, ...ephGroupRest } = eph;
  const ephAllNext = { ...slice.ephemeralTerminals };
  if (Object.keys(ephGroupRest).length === 0) delete ephAllNext[groupName];
  else ephAllNext[groupName] = ephGroupRest;

  // R5 — drop the matching tabState entry for the removed terminal.
  const dropKey = `${groupName}:terminal:${key}`;
  const sliceAfterDrop = _dropTabStateEntry(slice, dropKey);

  if (groupName !== currentGroup) {
    return [{ ...sliceAfterDrop, ephemeralTerminals: ephAllNext }, { sessionId: id, terminalExit: false }];
  }

  const yaml = yamlTerminals || {};
  const oldOrder = Object.keys({ ...yaml, ...eph });
  const removedTermIdx = oldOrder.indexOf(key);
  const removedTabIdx = 2 + actionCount + removedTermIdx;

  const newCount = Object.keys({ ...yaml, ...ephGroupRest }).length;

  let tab = slice.tab;
  let scroll = slice.scroll;
  let terminalExit = false;
  if (slice.tab === removedTabIdx) {
    if (newCount > 0) {
      tab = 2 + actionCount + Math.min(removedTermIdx, newCount - 1);
    } else {
      tab = 0;
      scroll = 0;
    }
    terminalExit = true;
  } else if (slice.tab > removedTabIdx) {
    tab = slice.tab - 1;
  }

  // N2 — slice.lines is finalizer-derived; mirror write retired.
  // A7 — clear viewerOverride when removing the active terminal tab
  // (same rationale as removeContent: override was painting on the
  // surface being closed).
  const out = { ...sliceAfterDrop, ephemeralTerminals: ephAllNext, tab, scroll };
  if (slice.tab === removedTabIdx && slice.viewerOverride) out.viewerOverride = null;
  return [out, { sessionId: id, terminalExit }];
}

function addContent(slice, { groupName, key, label, lines, currentGroup, groupExists, yamlTerminals, actionCount }) {
  if (!groupExists) return [slice, { focusDetail: false, terminalExit: false }];

  const ctAll = slice.contentTabs || {};
  const ctGroup = ctAll[groupName] || {};
  const ctGroupNext = { ...ctGroup, [key]: { label, lines: lines || [] } };
  const ctAllNext = { ...ctAll, [groupName]: ctGroupNext };
  let next = { ...slice, contentTabs: ctAllNext };

  if (groupName !== currentGroup) return [next, { focusDetail: false, terminalExit: false }];

  const contentIdx = Object.keys(ctGroupNext).indexOf(key);
  if (contentIdx < 0) return [next, { focusDetail: false, terminalExit: false }];

  const tCount = Object.keys({ ...(yamlTerminals || {}), ...((next.ephemeralTerminals || {})[groupName] || {}) }).length;
  // N2 — slice.lines is finalizer-derived; the lines field is stored
  // inside contentTabs (above), the slice mirror is dead.
  next = {
    ...next,
    tab: 2 + actionCount + tCount + contentIdx,
    scroll: 0,
  };
  if (next.search && next.search.active) {
    next = { ...next, search: { active: false, term: '', idx: 0, typing: '' } };
  }
  return [next, { focusDetail: true, terminalExit: true }];
}

function updateContentLines(slice, { groupName, key, lines, currentGroup, yamlTerminals, actionCount }) {
  const ctAll = slice.contentTabs;
  if (!ctAll || !ctAll[groupName] || !ctAll[groupName][key]) return [slice, null];

  const ctGroupNext = { ...ctAll[groupName], [key]: { ...ctAll[groupName][key], lines: lines || [] } };
  const ctAllNext = { ...ctAll, [groupName]: ctGroupNext };
  let next = { ...slice, contentTabs: ctAllNext };

  if (groupName !== currentGroup) return [next, null];
  const order = Object.keys(ctGroupNext);
  const tCount = Object.keys({ ...(yamlTerminals || {}), ...((next.ephemeralTerminals || {})[groupName] || {}) }).length;
  const idx = next.tab - 2 - actionCount - tCount;
  if (idx < 0 || idx >= order.length || order[idx] !== key) return [next, null];
  // N2 — slice.lines is finalizer-derived; lines live in contentTabs.
  return [{ ...next, scroll: 0 }, null];
}

/** Returns [newSlice, { needShowSelectedInfo }] — needShowSelectedInfo
 *  is true when the closed tab was the last content tab so the body
 *  falls back to Info (caller emits the Cmd). */
function removeContent(slice, { groupName, key, currentGroup, yamlTerminals, actionCount }) {
  const ctAll = slice.contentTabs;
  const ct = ctAll && ctAll[groupName];
  if (!ct || !ct[key]) return [slice, { needShowSelectedInfo: false }];

  const { [key]: _removed, ...ctGroupRest } = ct;
  const ctAllNext = { ...ctAll };
  if (Object.keys(ctGroupRest).length === 0) delete ctAllNext[groupName];
  else ctAllNext[groupName] = ctGroupRest;

  // R5 — drop the matching tabState entry for the removed content tab.
  const dropKey = `${groupName}:content:${key}`;
  const sliceAfterDrop = _dropTabStateEntry(slice, dropKey);

  if (groupName !== currentGroup) {
    return [{ ...sliceAfterDrop, contentTabs: ctAllNext }, { needShowSelectedInfo: false }];
  }

  const tCount = Object.keys({ ...(yamlTerminals || {}), ...((slice.ephemeralTerminals || {})[groupName] || {}) }).length;
  const oldOrder = Object.keys(ct);
  const removedContentIdx = oldOrder.indexOf(key);
  const removedTabIdx = 2 + actionCount + tCount + removedContentIdx;

  let tab = slice.tab;
  let scroll = slice.scroll;
  let needShowSelectedInfo = false;

  if (slice.tab === removedTabIdx) {
    const remainingKeys = Object.keys(ctGroupRest);
    if (remainingKeys.length > 0) {
      const newContentIdx = Math.min(removedContentIdx, remainingKeys.length - 1);
      tab = 2 + actionCount + tCount + newContentIdx;
      scroll = 0;
    } else {
      tab = 0;
      scroll = 0;
      needShowSelectedInfo = true;
    }
  } else if (slice.tab > removedTabIdx) {
    tab = slice.tab - 1;
  }

  // N2 — slice.lines is finalizer-derived; mirror write retired.
  // A7 — when the removed tab WAS the user's active tab AND
  // viewerOverride is set, clear the override too. The override was
  // painting on that surface; closing the surface dismisses it.
  // Falling back to a sibling or Info with the override still
  // active would paint discrete-doc content on the wrong surface.
  //
  // (The v0.6.3 "clear slice.lines on fall-back-to-Info" guard died in
  // P3 with the field: Info derives from slice.infoLines, which never
  // held the closed tab's content, so the stale-repaint wart can't
  // recur. The needShowSelectedInfo effect refreshes info regardless.)
  const out = { ...sliceAfterDrop, contentTabs: ctAllNext, tab, scroll };
  if (slice.tab === removedTabIdx && slice.viewerOverride) out.viewerOverride = null;
  return [out, { needShowSelectedInfo }];
}

/**
 * Reorder content tabs within a group: move tab at `fromIdx` to `toIdx`.
 * JS preserves insertion order for string keys, so we rebuild
 * contentTabs[group] with the permuted sequence. slice.tab follows the
 * moved tab when active is the one moving; otherwise it adjusts so the
 * SAME content stays focused.
 */
function reorderContent(slice, { groupName, fromIdx, toIdx, currentGroup, yamlTerminals, actionCount }) {
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

  if (groupName !== currentGroup) return next;

  const tCount = Object.keys({ ...(yamlTerminals || {}), ...((next.ephemeralTerminals || {})[groupName] || {}) }).length;
  const contentBase = 2 + actionCount + tCount;
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
 *
 * v0.6.6: getTabInfo/activeContentTab were retired from ctx — the only arm that
 * used getTabInfo (tab_switch) now derives counts from msg.viewerModel via the
 * pure flatTabInfoFromBundle twin, so ctx no longer carries any live-model read.
 * v0.6.3 Phase 3f: getModel() was retired from ctx. Reducer arms
 * read currentGroup + targetKey from msg (threaded by dispatchers
 * via pt.modelBundle / pt.resolveTabKey at dispatch time).
 */
function reduceTabMsg(msg, slice, ctx) {
  // v0.6.3 Phase 3f: ctx no longer carries getModel — every model read in
  // this leaf was retired (mode-flag reads dropped or threaded via msg;
  // currentGroup + targetKey threaded by dispatchers; tab_cycle Msg retired).
  // v0.6.6: the tab_switch arm's last live read (getTabInfo() → getModel()) is
  // gone too — it now derives tab counts from msg.viewerModel via the pure
  // flatTabInfoFromBundle twin, so ctx carries only paneId + wrap.
  const { paneId, wrap } = ctx;
  switch (msg.type) {
    case 'tab_switch': {
      // Full tab-switch cascade — orchestrates the cross-layer concerns
      // (kill streaming proc, exit terminal mode, then dispatch the
      // per-kind body update) that the bare `viewer_set_tab` primitive
      // doesn't. Emitted from the mouse tab-click in input.js and from
      // `tab_cycle`.
      // Tab counts come from the threaded msg.viewerModel bundle via the pure
      // flatTabInfoFromBundle twin — NOT a live getModel() read (the bundle is
      // stamped by viewer.augmentMsg on every viewer Msg, from the same model
      // this reducer runs on). Keeps the arm a pure fn of (slice, msg).
      const { termTabs, total } = flatTabInfoFromBundle(slice, msg.viewerModel);
      const idx = msg.idx | 0;
      if (idx < 0 || idx >= total) return slice;
      // N4 — same-tab click is a no-op. Pre-N4 this still fired the full
      // cascade: clear viewerOverride, emit terminal_exit, run the
      // kind-specific restore body. Most of those are identity-preserving
      // when applied to the slice's current state, but the cascade still
      // allocates + the finalizer still runs. Early-out keeps clicking
      // the active tab strictly free.
      if (idx === slice.tab) return slice;

      // T3f-fix — leaving-tab capture lives in viewer.js's finalizer
      // (_withDerivedFields) so it catches every slice.tab transition
      // path, not just tab_switch. This reducer focuses on the
      // target-tab restore.

      // T2c — tab_switch clears the discrete-doc override; the user's
      // navigation gesture dismisses whatever override was active.
      let next = { ...slice, tab: idx, viewerOverride: null };
      // No kill_proc — the producer keeps writing into its buffer
      // while the user is off-tab. Singleton preempt happens inside
      // streamCommand when a new run starts.
      const effects = [
        { type: 'msg', msg: { type: 'terminal_exit' } },
      ];
      // N1 — single canonical "tab idx → key" resolver. Every dispatcher
      // (mouse handler / chain key handler / Cmd cascade emitter +
      // internal cascades tab_cycle + the pane-menu tab pick + tests via
      // tabSwitchMsg helpers) precomputes targetKey via
      // pt.resolveTabKey and threads targetKey + currentGroup through
      // the Msg payload. Pure reducer arm — no getModel() fallback.
      const targetKey = msg.targetKey || null;
      // Read target tab's stored state. The finalizer (running AFTER
      // this reducer body) will capture the FROM-tab's view state;
      // for the to-restore we read what's currently stored.
      const tabEntry = require('./tab-state').entry(slice, targetKey);
      const storedScroll = tabEntry ? tabEntry.scroll : undefined;
      const storedSticky = tabEntry ? !!tabEntry.bottomSticky : false;
      // T3c/d/e — restore the target tab's stored view state
      // (search / select / cursor). Cross-tab leakage retired:
      // each tab's selection / search / cursor refer to its own
      // content, not whatever was on the previous tab. Fresh
      // defaults when never visited.
      const _emptySearch = () => ({ active: false, term: '', idx: 0, typing: '' });
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

      // N2 — slice.lines writes retired throughout this body. lines is
      // computed locally only to derive `bottom` for the sticky-aware
      // _resolveScroll — slice.lines itself is finalizer-derived from
      // the kind-specific source (viewerLines's precedence chain).
      if (idx === 0) {
        // Info — pure selection-info. Ask the focused Navigator to
        // repopulate via show_selected_info. P0 (viewer-lines selector) —
        // emit the dedicated Cmd (not a raw wrapped Msg) so the effects
        // layer computes msg.lines at dispatch; paneId pins THIS pane.
        next = { ...next, scroll: _resolveScroll(0, 0) };
        effects.push({ type: 'show_selected_info', paneId });
      } else if (idx === 1) {
        // Transcript — bottom-pin on first visit or when sticky;
        // literal restore otherwise. lines derived from
        // viewerStreamBuffer; the local copy here is just for scroll
        // bookkeeping.
        const vsb = slice.viewerStreamBuffer;
        const linesLen = vsb && Array.isArray(vsb.lines) && vsb.lines.length > 0
          ? vsb.lines.length : 1;  // placeholder counts as 1
        const innerH = slice.innerH > 0 ? slice.innerH : 1;
        const bottom = Math.max(0, linesLen - innerH);
        next = { ...next, scroll: _resolveScroll(bottom, bottom) };
      } else if (idx <= 1 + termTabs.length) {
        next = { ...next, scroll: _resolveScroll(0, 0) };
      } else {
        // v0.6.2 B8 — drop the `if (activeContentTab())` guard.
        // activeContentTab() reads _detailSlice() from the store which
        // still reflects the PRE-transition slice.tab. Switching FROM
        // Info / Action / Terminal TO a content tab → ct = null → the
        // scroll write was SKIPPED entirely, so next.scroll inherited
        // the leaving tab's value (via the earlier `next = { ...slice,
        // tab: idx, ... }` spread). With innerH > content-lines this
        // rendered the content tab past EOF — blank panel. We're
        // already in the content-idx range here, so unconditionally
        // resolve scroll the same way every other kind does.
        next = { ...next, scroll: _resolveScroll(0, 0) };
      }
      // v0.6.7 — a real tab switch (past the same-tab early-out above) is a
      // nav-history push point, unless it came FROM a restore (msg.noCapture).
      if (!msg.noCapture) effects.push({ type: 'nav_capture' });
      return [next, effects];
    }
    // v0.6.3 TEA Phase 3f: tab_cycle Msg retired. The root reducer's
    // _cycleViewerTab arm in dispatch/update/reducer.js now computes the next
    // tab idx + resolves targetKey directly (it has the model in
    // scope) and emits tab_switch. Removed the intermediate Msg so
    // the chain handler → tab_switch path doesn't need ctx.getModel
    // in this leaf.

    // --- tab lifecycle ---
    case 'viewer_add_ephemeral_terminal': {
      // Pure reducer arm — model-derived facts arrive via msg payload
      // (dispatcher calls modelBundle and spreads). See addEphemeral.
      const [next, info] = addEphemeral(slice, msg);
      const effects = [];
      if (info.focusDetail)   effects.push({ type: 'msg', msg: wrap('layout', { type: 'focus_set', focus: paneId }) });
      if (info.terminalEnter) effects.push({ type: 'msg', msg: { type: 'terminal_enter' } });
      return [next, effects];
    }
    case 'viewer_remove_ephemeral_terminal': {
      const [next, { sessionId, terminalExit }] = removeEphemeral(slice, msg);
      const effects = [];
      if (sessionId)    effects.push({ type: 'destroy_pty_session', id: sessionId });
      if (terminalExit) effects.push({ type: 'msg', msg: { type: 'terminal_exit' } });
      return [next, effects];
    }
    case 'viewer_add_content_tab': {
      const [next, info] = addContent(slice, msg);
      const effects = [];
      if (info.focusDetail)  effects.push({ type: 'msg', msg: wrap('layout', { type: 'focus_set', focus: paneId }) });
      if (info.terminalExit) effects.push({ type: 'msg', msg: { type: 'terminal_exit' } });
      return [next, effects];
    }
    case 'viewer_update_content_tab_lines': {
      const [next] = updateContentLines(slice, msg);
      return next;
    }
    case 'viewer_remove_content_tab': {
      const [next, { needShowSelectedInfo }] = removeContent(slice, msg);
      return [next, needShowSelectedInfo ? [{ type: 'show_selected_info' }] : []];
    }
    case 'viewer_reorder_content_tab':
      return reorderContent(slice, msg);

    // v0.6.4 #1 Step 2 — the `[≡]` tab-list overlay arms (tab_list_open /
    // _close / _nav / _pick / _close_selected) were retired here when the
    // two `[≡]` overlays unioned into one pane-menu. Open/close/nav state
    // now lives on `layout.paneMenu` (pane-type-agnostic, so a single
    // cursor can span tabs + panes); the menu's tab PICK + tab-close are
    // assembled by dispatch.handlePaneMenuKey, which still drives the
    // viewer's own `tab_switch` / `viewer_remove_*` arms below.

    default:
      return null;
  }
}

module.exports = {
  flatTabInfo, transcriptTabIdx,
  resolveTabKey,
  viewerLines,
  isTerminalTabIn, isContentTabIn,
  activeContentTabIn, activeTerminalIdIn, activeTerminalConfigIn,
  findEphemeralByIdIn,
  addEphemeral,
  addContent,
  modelBundle,
  viewerModelBundle,
  flatTabInfoFromBundle,
  viewerLinesFromBundle,
  resolveTabKeyFromBundle,
  reduceTabMsg,
};
