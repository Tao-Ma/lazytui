/**
 * Core Component — detail (the viewer).
 *
 * Owns the viewer slice (`lines` / `scroll` / `tab` / `search` /
 * `select` / `cursor` / `contentTabs` / `ephemeralTerminals`). Every
 * viewer-* mutation is handled inside `update(msg, slice)` here; the
 * root reducer doesn't touch the slice.
 *
 * Cross-layer concerns:
 *   - When a viewer write also flips model.modes / getFocus() (tab-open
 *     focuses 'detail' + sets/clears terminalMode; search enter/commit toggles
 *     detailSearchMode), the slice write happens inline and the cross-layer
 *     flag write is returned as an apply_msg Cmd (root reducer applies it).
 *   - When the cascade originates in the root reducer (group change in
 *     nav_select clears viewer chrome), it emits a dispatch_msg Cmd carrying
 *     viewer_reset_chrome → routed back here by the Component fan-out.
 *
 * Tab bar rendering (the Info | actionTabs | termTabs | contentTabs strip
 * and tab click bounds) stays inside this module's render path so the panel
 * def is the single home for the viewer's view.
 */
'use strict';

const { getTabInfo, isTerminalTab, activeContentTab } = require('./tabs');
const {
  renderPanel,
  getInstanceSlice, getFocus, getPanelDef, getItems, wrap, instanceKind,
} = require('../api');
const ms = require('../../leaves/search');
const pt = require('../../leaves/pane-tabs');
const mpool = require('../../leaves/pool');
const { buildTabStrip } = require('../../render/panel-widgets');
const { getModel } = require('../../app/runtime');
const { getSel } = require('../../app/state');

// --- internal slice transforms (pure return-new) ---
//
// Shared by the explicit `select_*` Msg arms (mouse path dispatches them via
// overlay/select.js) and the visual-mode keyboard handler in the `key` arm.
// Each takes the slice + payload and returns a new slice. The `_moveCursor`
// helper resolves display width through overlay/select.js's pure ANSI-aware
// reader.

function _beginSelect(slice, line, col, kind) {
  const n = slice.lines.length;
  const l = n === 0 ? 0 : Math.max(0, Math.min(n - 1, line | 0));
  const c = Math.max(0, col | 0);
  return {
    ...slice,
    select: {
      active: true,
      kind: kind === 'line' ? 'line' : 'char',
      anchor: { line: l, col: c },
      cursor: { line: l, col: c },
    },
    cursor: { line: l, col: c },
  };
}

// Effective viewport for scroll/cursor clamps. The slice's `innerH` is
// written from render() each frame (viewer_set_viewport Msg) so the
// reducer stays a pure function of (slice, msg) — no cross-slice read of
// layout's render-time geometry. The pre-first-render fallback is `1`:
// any viewer_scroll/append/cursor before paint still clamps inside
// [0, lines.length - 1] instead of overshooting (the pre-fix bug was
// `(0 || 0) - 2 = -2` viewport → `maxScroll = lines.length + 2`, leaving
// the slice with scroll past the last line until the next render).
// Tests that need a specific viewport seed `slice.innerH` directly.
function _innerH(slice) { return slice.innerH > 0 ? slice.innerH : 1; }

function _setCursor(slice, line, col, extend) {
  const cursor = { line: line | 0, col: col | 0 };
  const innerH = _innerH(slice);
  const top = slice.scroll || 0;
  let scroll = slice.scroll || 0;
  if (cursor.line < top)                       scroll = cursor.line;
  else if (cursor.line >= top + innerH)        scroll = cursor.line - innerH + 1;
  const next = { ...slice, cursor, scroll };
  if (extend && slice.select && slice.select.active) {
    next.select = { ...slice.select, cursor: { line: cursor.line, col: cursor.col } };
  }
  return next;
}

// T3 — resolve `slice.tab` (a numeric idx into the flat strip) to a
// stable string key for the per-tab state map. Keys outlive the
// numeric idx: adding/removing a content tab shifts indices but the
// remaining tabs' keys are identical, so their `tabState` entries
// survive the renumbering automatically.
// B4 — per-group kinds (action / terminal / content) are
// group-qualified: two groups whose YAML share an action name (a
// common pattern — every group has a `test`) would otherwise collide
// on `tabState['action:test']`, restoring group A's view state onto
// group B's tab. Info and Transcript stay unprefixed: Info's content
// is per-focus (not strictly per-group) and Transcript's buffer is a
// singleton accumulator cross-group.
function _activeTabKey(slice, model) {
  const idx = (slice && slice.tab) | 0;
  if (idx === 0) return 'info';
  if (idx === 1) return 'transcript';
  if (!model || !model.config || !model.config.groups) return null;
  const groupName = model.currentGroup;
  const info = pt.flatTabInfo(slice || {}, model, groupName);
  if (idx >= 2 && idx <= 1 + info.actionTabs.length) {
    const [key] = info.actionTabs[idx - 2];
    return `${groupName}:action:${key}`;
  }
  const termBase = 2 + info.actionTabs.length;
  if (idx >= termBase && idx < termBase + info.termTabs.length) {
    const [key] = info.termTabs[idx - termBase];
    return `${groupName}:terminal:${key}`;
  }
  const contentBase = 2 + info.actionTabs.length + info.termTabs.length;
  if (idx >= contentBase && idx < contentBase + info.contentTabs.length) {
    const [key] = info.contentTabs[idx - contentBase];
    return `${groupName}:content:${key}`;
  }
  return null;
}

// T3 — read a per-tab field with a fallback. Returns the stored value
// when present (even if 0 / null), else the fallback.
function _tabFieldOf(slice, key, field, fallback) {
  if (!slice || !slice.tabState || !key) return fallback;
  const entry = slice.tabState[key];
  if (!entry || !(field in entry)) return fallback;
  return entry[field];
}

// T3 — write a per-tab field; returns a fresh slice with the per-tab
// entry merged. No-key calls are no-ops.
function _withTabField(slice, key, field, value) {
  if (!key) return slice;
  const tabState = slice.tabState || {};
  const cur = tabState[key] || {};
  if (cur[field] === value) return slice;  // identity preserve
  return {
    ...slice,
    tabState: { ...tabState, [key]: { ...cur, [field]: value } },
  };
}

// T3 — merge multiple per-tab fields in one write. Used when scroll +
// `bottomSticky` need to land together (the sticky bit drives re-snap
// behavior on tab restore).
function _withTabFields(slice, key, patch) {
  if (!key || !patch) return slice;
  const tabState = slice.tabState || {};
  const cur = tabState[key] || {};
  return {
    ...slice,
    tabState: { ...tabState, [key]: { ...cur, ...patch } },
  };
}

/** Cap an array of lines to maxLen by dropping the oldest. Returns
 *  [cappedLines, droppedCount] so callers can adjust scroll for the
 *  shift. */
function _capLines(lines, maxLen) {
  if (lines.length <= maxLen) return [lines, 0];
  const dropped = lines.length - maxLen;
  return [lines.slice(dropped), dropped];
}

function _scrollView(slice, delta) {
  const innerH = _innerH(slice);
  const maxScroll = Math.max(0, slice.lines.length - innerH);
  const scroll = Math.max(0, Math.min(maxScroll, (slice.scroll || 0) + (delta || 0)));
  if (scroll === (slice.scroll || 0)) return slice;
  return { ...slice, scroll };
}

function _moveCursor(slice, dline, dcol) {
  const cur = slice.cursor || { line: 0, col: 0 };
  const n = slice.lines.length;
  if (n === 0) return slice;
  const newLine = Math.max(0, Math.min(n - 1, cur.line + dline));
  let newCol = (dcol === 0) ? cur.col : Math.max(0, cur.col + dcol);
  const select = require('../../overlay/select');
  const w = select.plainLineWidth(newLine);
  newCol = (w === 0) ? 0 : Math.min(w - 1, newCol);
  const active = !!(slice.select && slice.select.active);
  return _setCursor(slice, newLine, newCol, active);
}

// --- init ---

function init() {
  return {
    lines: [],
    scroll: 0,
    tab: 0,
    // Effective viewport rows (panel height minus 2-row border chrome).
    // Written from render() via viewer_set_viewport once the layout pass
    // settles a panelBounds.detail — owning slice, not cross-slice, so the
    // reducer is a pure function of (slice, msg). 0 = not-yet-rendered;
    // _innerH() falls back to lines.length in that degenerate so clamps
    // collapse to "everything fits".
    innerH: 0,
    search: { active: false, term: '', matches: [], idx: 0, typing: '' },
    select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
    cursor: { line: 0, col: 0 },
    contentTabs: {},          // [groupName]: { [key]: { label, lines } }
    ephemeralTerminals: {},   // [groupName]: { [key]: { cmd, label } }
    // [groupName]: { [actionKey]: { lines } } — survives tab switches
    // so a tabbed action's output isn't lost when the user navigates away.
    actionTabBuffers: {},
    // Singleton accumulator for unrouted streams (tabless type:run,
    // docker logs/inspect verbs). Appends across commands; cap at 1000
    // lines (drop oldest when over). Transcript tab (idx 1) is the
    // display home — viewerLines() derives Transcript content from this
    // buffer. Survives tab switches and group changes; only ever
    // appended to (or capped) — never reset by the producer.
    viewerStreamBuffer: { lines: [], cap: 1000 },
    // T2 override slot — discrete-document writers (history replay,
    // config-status diff, help text, Running-overlay job info) write
    // here instead of slice.lines. Render's viewerLines() consults
    // this first; non-null override beats the per-tab derivation.
    // Cleared on tab_switch (the user's navigation gesture clears
    // the override; explicit setViewerContent re-arms it).
    viewerOverride: null,
    // T3 per-tab encapsulation — each tab's view state lives keyed
    // by stable tab identity. Survives tab switches: scrolling
    // Build, switching away, switching back restores Build's scroll
    // position. Pre-T3 this state was slice-level (shared across
    // all tabs); the resulting cross-tab leakage (scroll/search/
    // select/cursor referencing wrong content) was fragile.
    //
    // Keys: 'info' | 'transcript' | '<group>:action:<key>' |
    // '<group>:terminal:<key>' | '<group>:content:<key>'. Per-group
    // kinds carry a group prefix (B4) so two groups sharing an action
    // name don't collide. Info / Transcript are intentionally
    // unprefixed: Info is per-focus, Transcript is the singleton
    // unrouted accumulator. Resolved per-render from (slice.tab,
    // model) via the _activeTabKey helper.
    //
    // T3b ships per-tab scroll only. slice.scroll still mirrors the
    // active tab's scroll for backward-compat (search/select/render
    // still read it). T3c-e will migrate search/select/cursor; T3f
    // drops the mirrors.
    tabState: {},
    // Tab-list overlay (the `[≡]` switcher anchored to detail's top-left).
    // `cursor` is the row index in the flat tab list (Info..actions..
    // terminals..content); `scroll` is the first visible row when the
    // overlay's body is smaller than the tab count.
    // Open/closed is tracked by model.modes.tabListMode + layout's
    // tabListOwnerPaneId. The per-pane slice holds the cursor/scroll
    // bookkeeping only (AR2 — was a third co-replica of open-state).
    tabList: { cursor: 0, scroll: 0 },
  };
}

// --- update (the viewer_* reducer; absorbed from runtime.update Phase B) ---

// T2d — re-derive slice.lines from viewerLines() after every Msg so
// the invariant `slice.lines === viewerLines(slice)` holds without
// each reducer arm having to maintain the mirror explicitly. Manual
// writes in reducer arms become harmless redundancy (overwritten by
// the finalizer) and can be cleaned up incrementally. Identity-
// preserving: when the reducer returns its input unchanged (no-op
// branch), the finalizer passes through without allocating.
// Resolves Info-tab content by calling the focused Navigator's plugin
// hooks (def.getItems, def.getInfo). PURITY CONTRACT: both hooks must
// be pure projections of (slice → items) and (item → display lines).
// This function runs from the viewer's finalizer on every dispatch
// (viewerLines for tab=0 consults it), so any side effect or
// non-determinism in a plugin's getItems/getInfo will be amplified
// 1:1 with Msg count. v0.7 candidate: move this read to the
// dispatcher side (showSelectedInfo) and thread the resolved lines
// through msg.lines so the finalizer can drop the plugin call.
function _infoFromFocus() {
  const focus = getFocus();
  const def = require('../api').getPanelDef(focus);
  if (!def || typeof def.getItems !== 'function' || typeof def.getInfo !== 'function') return null;
  const items = require('../api').getItems(focus);
  const { getSel } = require('../../app/state');
  const item = items[getSel(focus)];
  if (!item) return null;
  const out = def.getInfo(item);
  if (!out || !out.length) return null;
  return out.join('\n').split('\n');
}
// T2d + T3f-fix — derive slice.lines, AND capture the leaving-tab's
// view state into tabState when the reducer transitioned slice.tab.
// Detecting the transition in the finalizer (vs in tab_switch) catches
// every path that mutates slice.tab — tab_switch, stream_start's
// auto-jump, viewer_set_tab, future Msgs — without each one having
// to remember to capture. Single source of truth for "per-tab
// persistence on transition."
// R5 — does fromKey still correspond to an existing tab in `next`?
// When a tab is removed (removeContent / removeEphemeral), the FROM-
// capture in the finalizer would otherwise re-create the tabState
// entry we just dropped. Detection: parse the key shape and check
// against next's content/ephemeral stores. Info / Transcript / action
// (YAML+plugin sources, not removable via tab API) always count as
// existing.
function _tabKeyExistsIn(next, model, key) {
  if (!key || key === 'info' || key === 'transcript') return true;
  const m = key.match(/^([^:]+):(action|terminal|content):(.+)$/);
  if (!m) return true;
  const [, keyGroup, kind, restKey] = m;
  if (kind === 'action') return true;  // action tabs derive from YAML/plugins
  if (kind === 'content') {
    const all = (next && next.contentTabs) || {};
    const group = all[keyGroup];
    return !!(group && group[restKey]);
  }
  if (kind === 'terminal') {
    // Ephemeral terminal removal is the primary path. YAML-declared
    // terminals are persistent and live in model.config; their keys
    // wouldn't disappear via tab removal.
    const eph = (next && next.ephemeralTerminals) || {};
    const ephGroup = eph[keyGroup];
    if (ephGroup && ephGroup[restKey]) return true;
    const groupCfg = model && model.config && model.config.groups
      && model.config.groups[keyGroup];
    const yamlTerms = (groupCfg && groupCfg.terminals) || {};
    return !!yamlTerms[restKey];
  }
  return true;
}

function _withDerivedFields(next, originalSlice) {
  const m = getModel();
  const lines = pt.viewerLines(next, m, m.currentGroup, { infoFromFocus: _infoFromFocus });
  let updated = { ...next, lines };
  // B2 — skip the FROM-tab capture when the leaving slice had
  // viewerOverride active. Override-bound scroll/search/select/cursor
  // belong to the discrete-doc, not to the underlying tab; capturing
  // them into tabState[fromKey] would clobber the pre-override saved
  // state (the user's real position on that tab).
  // R5 — also skip when the FROM tab was REMOVED (key no longer
  // resolves in next). Otherwise removeContent / removeEphemeral's
  // tabState drop is silently undone by this capture.
  if (originalSlice
      && next.tab !== originalSlice.tab
      && !originalSlice.viewerOverride) {
    const fromKey = _activeTabKey(originalSlice, m);
    if (fromKey && _tabKeyExistsIn(next, m, fromKey)) {
      const innerH = originalSlice.innerH > 0 ? originalSlice.innerH : 1;
      const linesLen = (originalSlice.lines || []).length;
      const maxScroll = Math.max(0, linesLen - innerH);
      const captured = {
        scroll: originalSlice.scroll || 0,
        bottomSticky: (originalSlice.scroll || 0) >= maxScroll,
        search: originalSlice.search,
        select: originalSlice.select,
        cursor: originalSlice.cursor,
      };
      updated = _withTabFields(updated, fromKey, captured);
    }
  }
  return updated;
}
function _finalize(result, originalSlice) {
  if (result === undefined) return result;
  if (Array.isArray(result)) {
    const [next, cmds] = result;
    if (!next || next === originalSlice) return result;
    return [_withDerivedFields(next, originalSlice), cmds];
  }
  if (result === originalSlice) return result;
  return _withDerivedFields(result, originalSlice);
}

function update(msg, slice) {
  return _finalize(_updateInner(msg, slice), slice);
}

function _updateInner(msg, slice) {
  // Generic tab Msgs (tab_switch / tab_cycle / tab_list_* / viewer_add_* /
  // viewer_remove_* / viewer_update_content_tab_lines /
  // viewer_reorder_content_tab) lift through the pane-tabs leaf,
  // parameterised by this pane's id. Returns null when msg isn't a tab
  // Msg, in which case the switch below handles it.
  const tabResult = pt.reduceTabMsg(msg, slice, {
    paneId: 'detail',
    wrap,
    getModel,
    getTabInfo,
    activeContentTab,
  });
  if (tabResult !== null) return tabResult;

  switch (msg.type) {
    case 'viewer_set_content': {
      // T2c — discrete-doc writers (history replay, config-status
      // diff, help text, Running-overlay job info) route here. Write
      // to slice.viewerOverride; render's viewerLines() consults
      // override before deriving per-tab content. Override clears on
      // tab_switch (pane-tabs.js reducer) — the user's navigation
      // gesture dismisses the override.
      const next = {
        ...slice,
        viewerOverride: { lines: Array.isArray(msg.lines) ? msg.lines : [] },
        scroll: 0,
      };
      if (slice.search && slice.search.active) {
        next.search = { active: false, term: '', matches: [], idx: 0, typing: '' };
      }
      return next;
    }
    case 'viewer_show_info': {
      // Pull focused-Navigator info into the viewer + yank to Info as a
      // single semantic. The getInfo precondition below is the gate:
      // focus on a list panel with getInfo → yank to Info + populate;
      // focus elsewhere (detail, no-getInfo panels like stats) → bail.
      //
      // The bail covers the `addContentTab → focus_set(detail)` cascade
      // — `detail` has no getInfo, so we don't yank away from the
      // freshly-opened content tab.
      //
      // v0.6.2 T1 — pre-T1 the reducer bailed on slice.tab !== 0 and
      // navSelect read the slice from the handler to choose between
      // viewer_show_info (on Info) and tab_switch idx=0 (off-Info).
      // That mid-cascade handler read was a TEA-discipline smell;
      // folding the yank into the reducer itself eliminates the
      // observation between dispatches.
      //
      // v0.6.2 R1 — drop the redundant def.getInfo(item) lines
      // computation. The finalizer's _withDerivedFields path calls
      // viewerLines() which calls _infoFromFocus() → def.getInfo for
      // tab=0 anyway; computing lines here was a dead double-call
      // (overwritten by the finalizer's derivation moments later).
      // The bail conditions still invoke def.getItems / def.getInfo
      // for the precondition check; eliminating those from the reducer
      // body entirely is a v0.7 task (move the plugin reads to the
      // handler side via showSelectedInfo).
      const focus = getFocus();
      const def = getPanelDef(focus);
      if (!def || typeof def.getItems !== 'function' || typeof def.getInfo !== 'function') return slice;
      const items = getItems(focus);
      const item = items[getSel(focus)];
      if (!item) return slice;
      // v0.6.2 R3 — Info's per-tab view state needs to flow through
      // this arm too. Two cases:
      //   1. Already on Info (slice.tab === 0): item content changed
      //      (j/k in a Navigator), scroll resets to 0 (display new
      //      item's info from line 0). search/select/cursor untouched
      //      (they belong to the previous item but search-during-Info
      //      is a rare niche and clearing on every Navigator keystroke
      //      would defeat post-typing match navigation).
      //   2. From another tab (slice.tab !== 0): yanking back to Info.
      //      Restore tabState['info'].{scroll, search, select, cursor}
      //      (same shape tab_switch performs). Without this restore,
      //      navSelect from an action tab landed on Info with scroll: 0
      //      and the user's saved Info scroll position was dropped.
      if (slice.tab === 0) return { ...slice, scroll: 0 };
      const entry = (slice.tabState && slice.tabState.info) || null;
      return {
        ...slice,
        tab: 0,
        scroll: (entry && entry.scroll !== undefined) ? entry.scroll : 0,
        search: (entry && entry.search) || { active: false, term: '', matches: [], idx: 0, typing: '' },
        select: (entry && entry.select) || { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
        cursor: (entry && entry.cursor) || { line: 0, col: 0 },
      };
    }
    case 'viewer_scroll': {
      // T2d — read displayed-lines length from viewerLines (derives
      // from the active tab's source); needs to be right DURING the
      // reducer body for scroll bounds.
      // T3b — write per-tab scroll so the position survives a tab
      // switch round-trip. slice.scroll still tracks the active tab's
      // value as a mirror (search/select/render still read it).
      const innerH = _innerH(slice);
      const m = getModel();
      const displayed = pt.viewerLines(slice, m, m.currentGroup, { infoFromFocus: _infoFromFocus });
      const maxScroll = Math.max(0, displayed.length - innerH);
      let next;
      if (msg.to === 'top') next = 0;
      else if (msg.to === 'bottom') next = maxScroll;
      else next = slice.scroll + (msg.delta || 0);
      const scroll = Math.max(0, Math.min(maxScroll, next));
      if (scroll === slice.scroll) return slice;
      // T3f — tab_switch captures slice.scroll into tabState on the
      // way out; per-Msg mirror retired (was redundant — slice.scroll
      // is the active-tab view, and tab_switch is the only point
      // where we leave a tab).
      return { ...slice, scroll };
    }
    case 'viewer_append': {
      // Hot path — streamed action output can fire 500-1000 lines/sec.
      // Per the arc rule, no in-place exception: spread lines fresh each
      // call. Bench (js/test/bench-hotpaths.js) clears the 1k/sec target.
      //
      // Routed (msg.tabKey set) → write to actionTabBuffers[group][tabKey];
      // mirror to slice.lines only when the active tab in current group
      // is that action's. Unrouted → append to viewerStreamBuffer (capped
      // ring); mirror to slice.lines only when on Info tab.
      // T2d — scroll bookkeeping is computed from the BUFFER length
      // (the source of truth), not slice.lines (the finalizer-derived
      // mirror). slice.lines no longer needs a manual mirror write —
      // the finalizer recomputes from viewerLines() post-reducer.
      if (msg.tabKey && msg.groupName) {
        const all = slice.actionTabBuffers || {};
        const group = all[msg.groupName] || {};
        const buf = group[msg.tabKey] || { lines: [] };
        const bufLines = [...buf.lines, msg.line];
        const nextAll = {
          ...all,
          [msg.groupName]: { ...group, [msg.tabKey]: { lines: bufLines } },
        };
        const m = getModel();
        if (msg.groupName === m.currentGroup) {
          const active = pt.activeActionTabIn(slice, m, m.currentGroup);
          if (active && active[0] === msg.tabKey) {
            const innerH = _innerH(slice);
            const maxScrollOld = Math.max(0, buf.lines.length - innerH);
            const wasAtBottom = slice.scroll >= maxScrollOld;
            const newMaxScroll = Math.max(0, bufLines.length - innerH);
            const scroll = wasAtBottom ? newMaxScroll : slice.scroll;
            return { ...slice, actionTabBuffers: nextAll, scroll };
          }
        }
        return { ...slice, actionTabBuffers: nextAll };
      }
      // Unrouted: append to viewerStreamBuffer (cap-aware). Scroll
      // bookkeeping from the buffer length when on Transcript.
      const vsb = slice.viewerStreamBuffer || { lines: [], cap: 1000 };
      const [vsbLines, dropped] = _capLines([...vsb.lines, msg.line], vsb.cap);
      const nextBuf = { ...vsb, lines: vsbLines };
      const m = getModel();
      const info = pt.flatTabInfo(slice, m, m.currentGroup);
      if (slice.tab === pt.transcriptTabIdx(info)) {
        const innerH = _innerH(slice);
        const maxScrollOld = Math.max(0, vsb.lines.length - innerH);
        const wasAtBottom = slice.scroll >= maxScrollOld;
        const newMaxScroll = Math.max(0, vsbLines.length - innerH);
        const scroll = wasAtBottom
          ? newMaxScroll
          : Math.max(0, (slice.scroll || 0) - dropped);
        return { ...slice, viewerStreamBuffer: nextBuf, scroll };
      }
      return { ...slice, viewerStreamBuffer: nextBuf };
    }
    case 'viewer_append_lines': {
      // Bulk variant of viewer_append. Producers fire one Msg for
      // multi-line bursts (preempt footer, stream-end footer, decoder
      // tail flush) so the cascade is one reducer pass instead of N.
      // Same routed/unrouted split as viewer_append; bottom-stick check
      // happens once over the whole batch.
      const incoming = Array.isArray(msg.lines) ? msg.lines : [];
      if (incoming.length === 0) return slice;
      // T2d — scroll bookkeeping computed from buffer length; lines
      // mirror retired (finalizer re-derives slice.lines post-reducer).
      if (msg.tabKey && msg.groupName) {
        const all = slice.actionTabBuffers || {};
        const group = all[msg.groupName] || {};
        const buf = group[msg.tabKey] || { lines: [] };
        const bufLines = [...buf.lines, ...incoming];
        const nextAll = {
          ...all,
          [msg.groupName]: { ...group, [msg.tabKey]: { lines: bufLines } },
        };
        const m = getModel();
        if (msg.groupName === m.currentGroup) {
          const active = pt.activeActionTabIn(slice, m, m.currentGroup);
          if (active && active[0] === msg.tabKey) {
            const innerH = _innerH(slice);
            const maxScrollOld = Math.max(0, buf.lines.length - innerH);
            const wasAtBottom = slice.scroll >= maxScrollOld;
            const newMaxScroll = Math.max(0, bufLines.length - innerH);
            const scroll = wasAtBottom ? newMaxScroll : slice.scroll;
            return { ...slice, actionTabBuffers: nextAll, scroll };
          }
        }
        return { ...slice, actionTabBuffers: nextAll };
      }
      // Unrouted bulk.
      const vsb = slice.viewerStreamBuffer || { lines: [], cap: 1000 };
      const [vsbLines, dropped] = _capLines([...vsb.lines, ...incoming], vsb.cap);
      const nextBuf = { ...vsb, lines: vsbLines };
      const m = getModel();
      const info = pt.flatTabInfo(slice, m, m.currentGroup);
      if (slice.tab === pt.transcriptTabIdx(info)) {
        const innerH = _innerH(slice);
        const maxScrollOld = Math.max(0, vsb.lines.length - innerH);
        const wasAtBottom = slice.scroll >= maxScrollOld;
        const newMaxScroll = Math.max(0, vsbLines.length - innerH);
        const scroll = wasAtBottom
          ? newMaxScroll
          : Math.max(0, (slice.scroll || 0) - dropped);
        return { ...slice, viewerStreamBuffer: nextBuf, scroll };
      }
      return { ...slice, viewerStreamBuffer: nextBuf };
    }
    case 'stream_start': {
      // Routed (msg.tabKey set) → seed actionTabBuffers + auto-jump to
      // the action's tab so the user sees the new run regardless of
      // where focus was when they pressed Enter. Cross-group runs skip
      // the jump (buffer still seeded; visible on next group switch).
      if (msg.tabKey && msg.groupName) {
        const all = slice.actionTabBuffers || {};
        const group = all[msg.groupName] || {};
        const nextAll = {
          ...all,
          [msg.groupName]: { ...group, [msg.tabKey]: { lines: [msg.header] } },
        };
        // R4 — buffer reset invalidates the matching tabState entry.
        // The captured search.matches and select.{anchor, cursor}
        // reference line/col positions from the PRE-reset buffer;
        // restoring them onto the fresh buffer (the next time the user
        // visits this tab) would paint highlights / selection
        // rectangle on wrong content. Drop the entry so the next visit
        // gets fresh defaults via tab_switch's first-visit fallback.
        const dropKey = `${msg.groupName}:action:${msg.tabKey}`;
        let nextTabState = slice.tabState;
        if (slice.tabState && (dropKey in slice.tabState)) {
          const { [dropKey]: _drop, ...rest } = slice.tabState;
          nextTabState = rest;
        }
        const m = getModel();
        if (msg.groupName === m.currentGroup) {
          const info = pt.flatTabInfo(slice, m, m.currentGroup);
          const idx = info.actionTabs.findIndex(([k]) => k === msg.tabKey);
          if (idx >= 0) {
            // Auto-jump skips tab_switch — emit terminal_exit so
            // terminalMode doesn't survive the jump. v0.6.2 — action
            // tabs start at idx 2 (Info=0, Transcript=1).
            // B3 — clear viewerOverride on the auto-jump: the override
            // (e.g. job-info card from a Running-overlay activate) is
            // dismissed by the stream event that's taking over the
            // visible viewer.
            // R4 — also reset slice.{search, select, cursor} for the
            // auto-jump landing: the user is now viewing the fresh
            // buffer, so view-state should be empty defaults (not the
            // leaving tab's residual fields).
            return [
              {
                ...slice,
                actionTabBuffers: nextAll,
                tabState: nextTabState,
                lines: [msg.header],
                scroll: 0,
                tab: 2 + idx,
                viewerOverride: null,
                search: { active: false, term: '', matches: [], idx: 0, typing: '' },
                select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
                cursor: { line: 0, col: 0 },
              },
              [{ type: 'msg', msg: { type: 'terminal_exit' } }],
            ];
          }
        }
        // Cross-group: no auto-jump, no transition — override stays
        // (it's bound to whatever the user is currently viewing).
        // R4 — still drop the target's tabState entry so the next visit
        // doesn't restore stale matches onto the fresh buffer.
        return { ...slice, actionTabBuffers: nextAll, tabState: nextTabState };
      }
      // Unrouted stream_start: append header to viewerStreamBuffer
      // (does NOT clear — the buffer is an accumulator across cmds).
      // Auto-jump to Transcript so the user sees the running stream.
      // v0.6.2 — pre-fix jumped to Info because Info doubled as the
      // transcript host; the refactor moved hosting to a dedicated
      // tab and the auto-jump follows.
      const vsb = slice.viewerStreamBuffer || { lines: [], cap: 1000 };
      const [vsbLines] = _capLines([...vsb.lines, msg.header], vsb.cap);
      const nextBuf = { ...vsb, lines: vsbLines };
      const innerH = _innerH(slice);
      const scroll = Math.max(0, vsbLines.length - innerH);
      const info = pt.flatTabInfo(slice, getModel(), getModel().currentGroup);
      const tIdx = pt.transcriptTabIdx(info);
      if (slice.tab !== tIdx) {
        // B3 — clear viewerOverride on the auto-jump (same rationale
        // as the routed branch above).
        return [
          { ...slice, viewerStreamBuffer: nextBuf, tab: tIdx, lines: vsbLines.slice(), scroll, viewerOverride: null },
          [{ type: 'msg', msg: { type: 'terminal_exit' } }],
        ];
      }
      // Already on Transcript: mirror the cap-aware lines to slice.lines.
      // No transition, so any pre-existing override stays (user can
      // dismiss it explicitly via tab_switch).
      return { ...slice, viewerStreamBuffer: nextBuf, lines: vsbLines.slice(), scroll };
    }
    case 'viewer_set_tab': {
      const tab = msg.tab | 0;
      if (tab === slice.tab) return slice;
      // B2 — Producer-initiated set-tab (history replay, docker pre-
      // stream) also needs target-tab view-state restore. Without it,
      // slice.{scroll, search, select, cursor} retain the LEAVING tab's
      // values — visible as search highlights / selection rectangle
      // painted onto the wrong content after setActiveTab.
      //
      // Skip restore when viewerOverride is active: the override is a
      // discrete-doc with its own scroll/search/select/cursor (committed
      // by the override-writer, viewer_set_content). Restoring tabState
      // [toKey] would clobber what the producer just set.
      //
      // Unlike tab_switch, this does NOT clear viewerOverride or fire
      // terminal_exit — those are the user-initiated cascade's concerns.
      if (slice.viewerOverride) return { ...slice, tab };
      const toKey = _activeTabKey({ ...slice, tab }, getModel());
      const entry = (slice.tabState && toKey) ? slice.tabState[toKey] : null;
      return {
        ...slice,
        tab,
        scroll: (entry && entry.scroll !== undefined) ? entry.scroll : 0,
        search: (entry && entry.search) || { active: false, term: '', matches: [], idx: 0, typing: '' },
        select: (entry && entry.select) || { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
        cursor: (entry && entry.cursor) || { line: 0, col: 0 },
      };
    }
    case 'viewer_reset_chrome': {
      // Dispatched (via dispatch_msg Cmd) from the groups Component when a
      // tree cascade changes currentGroup. Single-writer per layer: root
      // chrome reset goes through the reset_group_context Msg; the viewer-
      // slice half lives here. See Phase A.
      // B3 — clear viewerOverride on group switch: the override is
      // group-bound (job-info from a Running overlay activation, history
      // replay of a per-group action, config-status diff for a group's
      // worktree). Crossing groups invalidates it.
      const next = { ...slice, tab: 0, cursor: { line: 0, col: 0 }, viewerOverride: null };
      if (slice.select) next.select = { ...slice.select, active: false };
      // Group switch closes the tab-list overlay too — the per-group tab
      // set is fundamentally different across groups, so lingering would
      // be confusing. v0.6.1 Phase 4 — clear the owner pane id companion
      // alongside the mode flag.
      if (getModel().modes.tabListMode) {
        return [next, [
          { type: 'msg', msg: { type: 'mode_clear', flag: 'tabListMode' } },
          { type: 'msg', msg: wrap('layout', { type: 'tab_list_set_owner', paneId: null }) },
        ]];
      }
      return next;
    }

    // --- viewer-search (typing phase, folded into the viewer Component).
    // leaves/search returns [newSlice, info]; the detailSearchMode flag
    // (root chrome) is set/cleared via apply_msg → mode_set / mode_clear.
    case 'viewer_search_enter': {
      const [next, info] = ms.enter(slice);
      return [next, info.enableSearchMode
        ? [{ type: 'msg', msg: { type: 'mode_set', flag: 'detailSearchMode' } }]
        : []];
    }
    case 'viewer_search_key':    return ms.keystroke(slice, msg.seq);
    case 'viewer_search_nav':    return msg.dir > 0 ? ms.next(slice, _innerH(slice)) : ms.prev(slice, _innerH(slice));
    case 'viewer_search_commit': {
      const [next, info] = ms.commit(slice, _innerH(slice));
      return [next, info.disableSearchMode
        ? [{ type: 'msg', msg: { type: 'mode_clear', flag: 'detailSearchMode' } }]
        : []];
    }
    case 'viewer_search_cancel': {
      const [next, info] = ms.cancel(slice);
      return [next, info.disableSearchMode
        ? [{ type: 'msg', msg: { type: 'mode_clear', flag: 'detailSearchMode' } }]
        : []];
    }
    // Committed-search adapter Msgs — exposed for the non-reducer
    // facade (overlay/viewer-search.js) so its callers route through
    // viewer.update rather than writing the slice directly (single-
    // writer-per-slice per docs/PRINCIPLES.md §12).
    case 'viewer_search_clear_committed': return ms.clearCommitted(slice);
    case 'viewer_search_recompute':       return ms.recompute(slice);
    case 'viewer_search_recompute_for':   return ms.recomputeFor(slice, msg.term);

    // --- visual-mode select. The mouse path dispatches the select_* Msgs
    // (overlay/select.js); the keyboard path lives in `case 'key':` below.
    // Both flow through the same pure slice transforms (`_beginSelect` /
    // `_setCursor` / `_scrollView` / `_moveCursor`) defined above the
    // reducer. The pure ANSI-aware reads (selectedText / plainLineWidth)
    // stay in select.js.
    case 'select_begin':
      return _beginSelect(slice, msg.line, msg.col, msg.kind);
    case 'select_extend': {
      if (!slice.select || !slice.select.active) return slice;
      const n = slice.lines.length;
      const l = n === 0 ? 0 : Math.max(0, Math.min(n - 1, msg.line | 0));
      return { ...slice, select: { ...slice.select, cursor: { line: l, col: Math.max(0, msg.col | 0) } } };
    }
    case 'select_cancel':
      if (!slice.select) return slice;
      return { ...slice, select: { ...slice.select, active: false } };
    case 'select_set_cursor':
      return _setCursor(slice, msg.line, msg.col, msg.extend);
    case 'select_scroll_view':
      return _scrollView(slice, msg.delta);

    // --- keyboard: the detail-panel visual-mode state machine. Lives here
    // (instead of as a dispatch.js hijack) because the claim is conditional
    // on slice state — the `_claimed` sentinel returned with `[slice, …]`
    // is consumed by `dispatchKeyToFocused` to gate the framework default.
    //
    // Two modes:
    //   Reading mode (no selection active):
    //     j / down  scroll +1
    //     k / up    scroll -1
    //     h / l     NOT claimed → framework focus-shift
    //     v / V     enter char / line visual
    //     n / N     search-nav (when committed search is active)
    //   Visual mode (selection active):
    //     j / k / h / l / arrows  cursor + extend
    //     0 / $ / Home / End      cursor jump
    //     y                       commit → register_push
    //     v / V                   toggle off
    //     escape                  cancel
    case 'key': {
      const m = getModel();
      if (instanceKind(getFocus()) !== 'detail' || m.modes.terminalMode) return slice;
      // Higher-priority modes (menu/cmd/etc.) are filtered upstream by the
      // modeChain in dispatch.handleKey; this guard is belt-and-suspenders.
      if (m.modes.menuOpen || m.modes.cmdMode || m.modes.confirmMode ||
          m.modes.promptMode || m.modes.copyMode) return slice;

      const active = !!(slice.select && slice.select.active);
      const claim = [{ type: '_claimed' }];

      // Detail-search post-commit n/N nav; Esc clears.
      if (slice.search && slice.search.active) {
        if (msg.seq === 'n' || msg.key === 'n') return [ms.next(slice, _innerH(slice)), claim];
        if (msg.seq === 'N' || msg.key === 'N') return [ms.prev(slice, _innerH(slice)), claim];
        if (msg.key === 'escape' && !active)    return [ms.clearCommitted(slice), claim];
      }

      // v / V — toggle visual mode. Anchor at the top of the current viewport
      // (matches what mouse-drag effectively does — cursor where it lands).
      if (msg.seq === 'v' || msg.key === 'v') {
        const next = (active && slice.select.kind === 'char')
          ? { ...slice, select: { ...slice.select, active: false } }
          : _beginSelect(slice, slice.scroll || 0, 0, 'char');
        return [next, claim];
      }
      if (msg.seq === 'V' || msg.key === 'V') {
        const next = (active && slice.select.kind === 'line')
          ? { ...slice, select: { ...slice.select, active: false } }
          : _beginSelect(slice, slice.scroll || 0, 0, 'line');
        return [next, claim];
      }

      // y — commit + push to register. The text resolution + OSC52 ride out
      // as apply_msg → register_push (root reducer owns the register).
      if ((msg.seq === 'y' || msg.key === 'y') && active) {
        const text = require('../../overlay/select').selectedText();
        const next = { ...slice, select: { ...slice.select, active: false } };
        const effects = [{ type: '_claimed' }];
        if (text) effects.push({ type: 'msg', msg: { type: 'register_push', text } });
        return [next, effects];
      }
      if (msg.key === 'escape' && active) {
        return [{ ...slice, select: { ...slice.select, active: false } }, claim];
      }

      // Vertical movement: reading → scroll view, visual → cursor + extend.
      if (msg.key === 'down' || msg.seq === 'j' || msg.key === 'j') {
        const next = active ? _moveCursor(slice, +1, 0) : _scrollView(slice, +1);
        return [next, claim];
      }
      if (msg.key === 'up' || msg.seq === 'k' || msg.key === 'k') {
        const next = active ? _moveCursor(slice, -1, 0) : _scrollView(slice, -1);
        return [next, claim];
      }

      // Horizontal h/l — only claim in visual mode so reading-mode focus-shift
      // still works (`l` to step out of detail into the next panel).
      if (active) {
        if (msg.key === 'left'  || msg.seq === 'h' || msg.key === 'h') return [_moveCursor(slice, 0, -1), claim];
        if (msg.key === 'right' || msg.seq === 'l' || msg.key === 'l') return [_moveCursor(slice, 0, +1), claim];
      }

      // 0 / $ — line-start / line-end jumps. Only meaningful with a cursor.
      if (active && (msg.seq === '0' || msg.key === 'home')) {
        return [_setCursor(slice, slice.cursor.line, 0, true), claim];
      }
      if (active && (msg.seq === '$' || msg.key === 'end')) {
        const w = require('../../overlay/select').plainLineWidth(slice.cursor.line);
        return [_setCursor(slice, slice.cursor.line, Math.max(0, w - 1), true), claim];
      }
      return slice;
    }
    default:
      return slice;
  }
}

// --- panel renderer (reads the slice directly) ---

function detailTitle(slice) {
  const tabInfo = getTabInfo();
  const layoutSlice = getInstanceSlice('layout');
  const dp = layoutSlice ? mpool.findDetailPane(layoutSlice.arrange) : null;
  const hotkey = dp ? dp.hotkey : '';
  // Running indicator (Phase 4.4) — set of action keys whose
  // stream-routed job is alive in the current group. buildTabStrip
  // prefixes those tab labels with a `●` glyph.
  const m = getModel();
  const jobsList = require('../../feature/jobs').list();
  const runningActionKeys = new Set(
    jobsList
      .filter(j => j.kind === 'stream-routed' && j.status === 'running'
                && j.owner && j.owner.groupName === m.currentGroup)
      .map(j => j.owner.tabKey)
  );
  const built = buildTabStrip(tabInfo, slice.tab, hotkey, runningActionKeys);
  // Blessed exception (docs/v0.5-layering.md §5): the mouse hit-test
  // cache for the tab bar is a view-output write — populated during
  // the layout Component's render pass + consumed by input.js. Pure-
  // TEA doesn't apply to render-time writes into the owning Component's
  // own slice; the alternative would be a parallel structure
  // round-tripping per-frame.
  if (layoutSlice && layoutSlice.panelBounds.detail) {
    layoutSlice.panelBounds.detail.tabs = built ? built.tabBounds : [];
  }
  return built ? built.title : 'Detail';
}

function render(panel, w, h, slice) {
  const m = getModel();
  const innerH = h - 2;
  const dp = mpool.findDetailPane(getInstanceSlice('layout').arrange);
  const hotkey = dp ? dp.hotkey : '';
  const isFocused = instanceKind(getFocus()) === 'detail' || m.modes.terminalMode;
  if (isTerminalTab()) {
    return renderPanel({
      width: w, height: h, lines: [],
      title: detailTitle(slice), hotkey,
      panelType: 'detail',
      focused: isFocused,
    });
  }
  // T2c — display lines come from viewerLines() (derives from active
  // tab + buffers + override + focused-Navigator's getInfo). Falls
  // back to slice.lines for tabs whose reducer arms still maintain
  // it; T2d retires the fallback.
  const _infoFromFocus = () => {
    const focus = getFocus();
    const def = require('../api').getPanelDef(focus);
    if (!def || typeof def.getItems !== 'function' || typeof def.getInfo !== 'function') return null;
    const items = require('../api').getItems(focus);
    const { getSel } = require('../../app/state');
    const item = items[getSel(focus)];
    if (!item) return null;
    const out = def.getInfo(item);
    if (!out || !out.length) return null;
    return out.join('\n').split('\n');
  };
  const derived = pt.viewerLines(slice, m, m.currentGroup, { infoFromFocus: _infoFromFocus });
  let lines = derived;
  let count = null;
  if (lines.length > innerH) {
    count = [slice.scroll + innerH, lines.length];
  }
  const select = require('../../overlay/select');
  const search = require('../../overlay/viewer-search');
  if (select.isActive()) {
    lines = select.decorateLines(lines);
  } else {
    lines = search.decorateLines(lines);
  }
  return renderPanel({
    width: w, height: h, lines,
    title: detailTitle(slice), hotkey,
    panelType: 'detail',
    focused: isFocused,
    count,
    scrollOffset: slice.scroll,
  });
}

module.exports = {
  name: 'detail',
  init,
  update,
  panelTypes: {
    detail: { render },
  },
  // Test-only exports — not part of the Component contract.
  _init: init,
  _update: update,
};
