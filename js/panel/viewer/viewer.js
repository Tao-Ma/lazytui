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
  getInstanceSlice, wrap,
} = require('../api');
const ms = require('../../leaves/search');
const pt = require('../../leaves/pane-tabs');
const mpool = require('../../leaves/pool');
const { stripMarkup, charWidth } = require('../../io/ansi');
const { buildTabStrip } = require('./tab-strip');
const { getModel } = require('../../model/store');

// --- internal slice transforms (pure return-new) ---
//
// Shared by the explicit `select_*` Msg arms (mouse path dispatches them via
// panel/viewer/select.js) and the visual-mode keyboard handler in the `key` arm.
// Each takes the slice + payload and returns a new slice. The `_moveCursor`
// helper resolves display width through panel/viewer/select.js's pure ANSI-aware
// reader.

function _beginSelect(slice, line, col, kind, lines) {
  const n = lines.length;
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
// written by the per-dispatch finalizer (`panel/api._finalizeDispatch`,
// direct setInstanceSlice on our own slice — was a wrapped
// viewer_set_viewport Msg) so the reducer stays a pure function of
// (slice, msg) — no cross-slice read of layout's render-time geometry.
// (Pre-resize-as-Msg this was written from render() each frame.)
// The pre-first-render fallback is `1`:
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

function _scrollView(slice, delta, lines) {
  const innerH = _innerH(slice);
  const maxScroll = Math.max(0, lines.length - innerH);
  const scroll = Math.max(0, Math.min(maxScroll, (slice.scroll || 0) + (delta || 0)));
  if (scroll === (slice.scroll || 0)) return slice;
  return { ...slice, scroll };
}

// P2 (viewer-lines selector) — width computed from the boundary-derived
// `lines` directly (was select.plainLineWidth, which re-read the STORED
// slice mid-update — a stale-read wart this threading retires).
function _lineWidth(lines, i) {
  const ln = lines[i];
  if (ln == null) return 0;
  const plain = stripMarkup(ln);
  let w = 0;
  for (const ch of plain) w += charWidth(ch.codePointAt(0));
  return w;
}

function _moveCursor(slice, dline, dcol, lines) {
  const cur = slice.cursor || { line: 0, col: 0 };
  const n = lines.length;
  if (n === 0) return slice;
  const newLine = Math.max(0, Math.min(n - 1, cur.line + dline));
  let newCol = (dcol === 0) ? cur.col : Math.max(0, cur.col + dcol);
  const w = _lineWidth(lines, newLine);
  newCol = (w === 0) ? 0 : Math.min(w - 1, newCol);
  const active = !!(slice.select && slice.select.active);
  return _setCursor(slice, newLine, newCol, active);
}

// --- init ---

function init(paneId) {
  return {
    // v0.6.4 multi-viewer — the placed pane this slice belongs to (mirrors
    // the files/docker Arc-2 self-identity pattern). state.js mints one
    // instance per placed detail pane via comp.init(paneId); the slice
    // carries its own paneId so detailTitle's tabBounds write + every
    // dispatch lands on THIS pane, not the kind primary. null for the
    // register-time singleton fallback (resolves to 'detail').
    paneId: paneId || null,
    scroll: 0,
    tab: 0,
    // Effective viewport rows (panel height minus 2-row border chrome).
    // Written from render() via a direct setInstanceSlice (R4.9) once the
    // layout pass settles our paneBounds — owning slice, not cross-slice,
    // so the reducer is a pure function of (slice, msg). 0 = not-yet-rendered;
    // _innerH() falls back to lines.length in that degenerate so clamps
    // collapse to "everything fits".
    innerH: 0,
    search: { active: false, term: '', idx: 0, typing: '' },
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
    // v0.6.4 #1 Step 2 — the `[≡]` switcher's cursor/scroll moved OFF the
    // viewer slice onto `layout.paneMenu` when the two `[≡]` overlays
    // unioned into one pane-menu (a single cursor must span tabs + panes,
    // so it lives in one pane-type-agnostic home). Open-state =
    // model.modes.paneMenuMode; the target paneId + nav live on layout.
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
  // P0 (viewer-lines selector arc) — the implementation moved to
  // api.infoLinesFromFocus (the dispatcher-side compute that
  // showSelectedInfo threads as msg.lines). This wrapper remains for
  // RENDER only: Info display stays a live view projection of the
  // focused Navigator (TEA: derived in view), while slice.infoLines is
  // the stored reducer-side basis (bounds/search). The two diverge only
  // when item info changes without a show_selected_info — the same
  // window slice.lines had (the viewer finalizer never ran on other
  // Components' Msgs either).
  return require('../nav-state').infoLinesFromFocus();
}

// P0 — content equality for info payloads (length + per-line ===).
// Info is small (a screenful); the scan is cheap and buys ref-stable
// slice.infoLines across no-change refreshes.
function _linesEq(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
// T2d + T3f-fix — derive slice.lines, AND capture the leaving-tab's
// view state into tabState when the reducer transitioned slice.tab.
// Detecting the transition in the finalizer (vs in tab_switch) catches
// every path that mutates slice.tab — tab_switch, stream_start's
// auto-jump, viewer_set_tab, future Msgs — without each one having
// to remember to capture. Single source of truth for "per-tab
// persistence on transition."
// blessed-exceptions #3 — the finalizer's tab-key helpers, keyed off the
// threaded viewerModelBundle so it never reads getModel().
//   _activeTabKeyFromBundle: slice.tab → stable per-tab key (info/transcript
//     unprefixed; per-group kinds carry the group prefix).
//   _tabKeyExistsInFromBundle: R5 — does fromKey still resolve in `next`?
//     When a tab is removed the FROM-capture would otherwise re-create the
//     tabState entry we just dropped. Info/Transcript/action always exist;
//     content/terminal are checked against next's stores. The capture only
//     resolves CURRENT-group keys, which the bundle describes, so the
//     yaml-terminal check keys off bundle.yamlTerminals (== the model path
//     for keyGroup === currentGroup).
function _activeTabKeyFromBundle(slice, bundle) {
  return pt.resolveTabKeyFromBundle((slice && slice.tab) | 0, slice, bundle);
}
function _tabKeyExistsInFromBundle(next, bundle, key) {
  if (!key || key === 'info' || key === 'transcript') return true;
  const mt = key.match(/^(.+?):(action|terminal|content):(.+)$/);
  if (!mt) return true;
  const [, keyGroup, kind, restKey] = mt;
  if (kind === 'action') return true;
  if (kind === 'content') {
    const all = (next && next.contentTabs) || {};
    const group = all[keyGroup];
    return !!(group && group[restKey]);
  }
  if (kind === 'terminal') {
    const eph = (next && next.ephemeralTerminals) || {};
    const ephGroup = eph[keyGroup];
    if (ephGroup && ephGroup[restKey]) return true;
    const yamlTerms = (bundle && keyGroup === bundle.currentGroup && bundle.yamlTerminals) || {};
    return !!yamlTerms[restKey];
  }
  return true;
}

// blessed-exceptions #3 — the finalizer reads the threaded `vm`
// (pt.viewerModelBundle from msg.viewerModel), never getModel(). The
// tab-transition capture only ever resolves CURRENT-group keys, which the
// bundle describes, so the *FromBundle readers are exact here.
function _withDerivedFields(next, originalSlice, vm) {
  // P3 (viewer-lines selector) — the slice.lines derivation that named
  // this function is GONE: the field is deleted; consumers derive via
  // pt.viewerLines (content) and ms.matchesFor (search). What remains
  // is T3f — capture the leaving tab's view state on a tab transition.
  // (P1 already removed the B2 transition-detect: derived matches
  // cannot go stale, so nothing has to notice content changed.)
  //
  // B2 — skip the FROM-tab capture when the leaving slice had
  // viewerOverride active. Override-bound scroll/search/select/cursor
  // belong to the discrete-doc, not to the underlying tab; capturing
  // them into tabState[fromKey] would clobber the pre-override saved
  // state (the user's real position on that tab).
  // R5 — also skip when the FROM tab was REMOVED (key no longer
  // resolves in next). Otherwise removeContent / removeEphemeral's
  // tabState drop is silently undone by this capture.
  let updated = next;
  if (originalSlice
      && next.tab !== originalSlice.tab
      && !originalSlice.viewerOverride) {
    const fromKey = _activeTabKeyFromBundle(originalSlice, vm);
    if (fromKey && _tabKeyExistsInFromBundle(next, vm, fromKey)) {
      const innerH = originalSlice.innerH > 0 ? originalSlice.innerH : 1;
      // bottomSticky derives from the ORIGINAL slice's displayed lines
      // (tab transitions are rare — the derive is off the hot path).
      const fromLines = pt.viewerLinesFromBundle(originalSlice, vm);
      const maxScroll = Math.max(0, fromLines.length - innerH);
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
function _finalize(result, originalSlice, vm) {
  if (result === undefined) return result;
  if (Array.isArray(result)) {
    const [next, cmds] = result;
    if (!next || next === originalSlice) return result;
    return [_withDerivedFields(next, originalSlice, vm), cmds];
  }
  if (result === originalSlice) return result;
  return _withDerivedFields(result, originalSlice, vm);
}

function update(msg, slice) {
  // blessed-exceptions #3 — the viewer reducer is now PURE of getModel().
  // The model facts its line-derivation + tab-transition capture need are
  // threaded in as `msg.viewerModel` (a pt.viewerModelBundle) by the
  // framework's augmentMsg hook (api.js), computed once in the shell. The
  // active-tab lines are still derived ONCE at the boundary and handed to the
  // arms as a fact — now from the bundle, not getModel(). Bare/degenerate
  // calls with no bundle degrade safely (info/transcript still resolve; per-
  // group tabs read empty).
  const vm = msg && msg.viewerModel;
  const lines = pt.viewerLinesFromBundle(slice, vm);
  return _finalize(_updateInner(msg, slice, lines), slice, vm);
}

// MSG ROUTING — the viewer's update is split across two homes:
//
//   pane-tabs.reduceTabMsg (leaf, paneId-parameterized):
//     tab_switch, tab_cycle,
//     viewer_add_ephemeral_terminal, viewer_remove_ephemeral_terminal,
//     viewer_add_content_tab, viewer_update_content_tab_lines,
//     viewer_remove_content_tab, viewer_reorder_content_tab,
//     tab_list_open / _close / _nav / _pick / _close_selected.
//   These are the GENERIC pane-tab lifecycle + tab-list overlay Msgs.
//   They're paneId-parameterized so a future multi-pane future routes
//   identical reducer code through different slice instances.
//
//   viewer.js's switch (this file, below):
//     viewer_set_content, viewer_show_info (content writers),
//     viewer_set_tab, viewer_reset_chrome (primitive tab + group reset),
//     viewer_scroll, viewer_append, viewer_append_lines, stream_start
//     (scroll + streaming content),
//     viewer_search_* (search), select_* (selection),
//     key (key handler).
//   These are VIEWER-SPECIFIC behaviors: scroll math, search, selection,
//   content derivation — tied to the viewer's slice shape, not generic
//   to any pane-with-tabs.
//
// When adding a tab-related Msg: if it's about tab lifecycle / tab-list
// chrome, put it in the leaf. If it's about viewing content (scroll
// math, search match navigation, content-tab body update with
// viewer-specific semantics), put it here.
function _updateInner(msg, slice, lines) {
  // Boundary-derived active-tab lines (update() always passes them;
  // bare internal calls degrade to empty).
  if (lines === undefined) lines = [];
  // Generic tab Msgs (tab_switch / tab_cycle / tab_list_* / viewer_add_* /
  // viewer_remove_* / viewer_update_content_tab_lines /
  // viewer_reorder_content_tab) lift through the pane-tabs leaf,
  // parameterised by this pane's id. Returns null when msg isn't a tab
  // Msg, in which case the switch below handles it.
  // v0.6.3 Phase 3f: ctx no longer carries getModel — every reducer
  // arm reads currentGroup + targetKey from msg (threaded by
  // dispatchers via pt.modelBundle / pt.resolveTabKey).
  const tabResult = pt.reduceTabMsg(msg, slice, {
    // v0.6.4 multi-viewer — focus side-effects (add-content-tab /
    // add-terminal / tab_list pick) must focus THIS pane, not the
    // hardcoded 'detail' kind (which focus_set resolves to the PRIMARY
    // viewer — stealing focus from a focused second viewer and stranding
    // its async content-tab load on "Loading…" forever). slice.paneId is
    // stamped by init(paneId); fall back to 'detail' for the singleton.
    paneId: slice.paneId || 'detail',
    wrap,
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
      // R6 — optional msg.tab lets callers land on a specific tab in
      // the same dispatch (history.replay parks on Info so the
      // override has a clear "home"). Without this, history.replay
      // dispatched viewer_set_content + viewer_set_tab in two
      // imperative steps from its effect handler.
      //
      // v0.6.2 B6 — when the arm CLEARS slice.{scroll, search} in
      // place (the override-arming write below) WITHOUT changing
      // slice.tab, no transition fires and the finalizer's auto-
      // capture skips. The user's pre-override view-state on the
      // current tab is silently lost. Capture it manually here,
      // BEFORE the in-place clobber. Two conditions gate the capture:
      //   1. !slice.viewerOverride — only the FIRST arming-write
      //      (subsequent override rewrites have override-bound state
      //      already, per the B2 carve-out logic; capturing again
      //      would clobber the pre-override entry).
      //   2. typeof msg.tab !== 'number' — when msg.tab is set, the
      //      finalizer's auto-capture handles it (the originalSlice
      //      doesn't have override yet, so the B2 skip doesn't apply
      //      and the transition-detect captures correctly).
      let captureFirst = slice;
      if (!slice.viewerOverride && typeof msg.tab !== 'number') {
        // v0.6.3 Phase D1 — dispatcher threads msg.fromTabKey (the
        // currently-active tab's stable key) so the reducer stays
        // pure of getModel().
        const fromKey = msg.fromTabKey;
        if (fromKey) {
          const innerH = slice.innerH > 0 ? slice.innerH : 1;
          const linesLen = lines.length;
          const maxScroll = Math.max(0, linesLen - innerH);
          const captured = {
            scroll: slice.scroll || 0,
            bottomSticky: (slice.scroll || 0) >= maxScroll,
            search: slice.search,
            select: slice.select,
            cursor: slice.cursor,
          };
          captureFirst = _withTabFields(slice, fromKey, captured);
        }
      }
      const next = {
        ...captureFirst,
        viewerOverride: { lines: Array.isArray(msg.lines) ? msg.lines : [] },
        scroll: 0,
      };
      if (slice.search && slice.search.active) {
        next.search = { active: false, term: '', idx: 0, typing: '' };
      }
      if (typeof msg.tab === 'number') {
        // v0.6.2 R13 — clamp to in-range. Pre-R13 `msg.tab | 0` silently
        // accepted negative / non-numeric values: -5 | 0 === -5, 'foo'
        // | 0 === 0, NaN | 0 === 0. Mirrors tab_switch's guard
        // (pane-tabs.js: `if (idx < 0 || idx >= total) return slice`).
        // v0.6.3 Phase D1 — dispatcher threads msg.total (flatTabInfo
        // total at dispatch time) so the reducer stays pure.
        const tab = msg.tab | 0;
        const total = typeof msg.total === 'number' ? msg.total : Infinity;
        if (tab >= 0 && tab < total) next.tab = tab;
      }
      return next;
    }
    case 'viewer_show_info': {
      // Pull focused-Navigator info into the viewer + yank to Info as a
      // single semantic.
      //
      // P0 (viewer-lines selector arc) — info content arrives
      // PRECOMPUTED on msg.lines: dispatch.showSelectedInfo (the one
      // chokepoint every producer routes through) resolves it via
      // api.infoLinesFromFocus and SKIPS the dispatch when the focused
      // pane has no getInfo / no selection — the old arm-side plugin-
      // read bail (getFocus/getPanelDef/getItems/getSel), now retired
      // from the reducer (the "v0.7 task" the R1 comment predicted).
      // The skip still covers the `addContentTab → focus_set(detail)`
      // cascade: `detail` has no getInfo, so no yank away from the
      // freshly-opened content tab. A missing payload here = a
      // legacy/test caller → same bail.
      //
      // The arm STORES the content as slice.infoLines — Info's
      // canonical per-tab home (sticky: persists while focus sits on a
      // no-getInfo pane, replacing the slice.lines fixed-point trick).
      if (!Array.isArray(msg.lines)) return slice;
      // v0.6.2 R3 — Info's per-tab view state needs to flow through
      // this arm too. Two cases:
      //   1. Already on Info (slice.tab === 0): item content changed
      //      (j/k in a Navigator), scroll resets to 0 (display new
      //      item's info from line 0). A4 — also drop stale
      //      search.matches if a committed search is active: the
      //      matches reference line/col positions in the PREVIOUS
      //      item's text; preserving them paints highlights on the
      //      wrong content. search.term is kept so the user can
      //      `/[Up]` to recall and re-run.
      //   2. From another tab (slice.tab !== 0): yanking back to Info.
      //      Restore tabState['info'].{scroll, search, select, cursor}
      //      (same shape tab_switch performs). Without this restore,
      //      navSelect from an action tab landed on Info with scroll: 0
      //      and the user's saved Info scroll position was dropped.
      // Content-equal payloads keep the previous infoLines REF so the
      // derived-lines ref stays stable across no-change refreshes
      // (redraw() fires this before every paint) — downstream ref-
      // equality (search recompute) then fires only on real change,
      // where the old per-Msg fresh-array derivation over-recomputed.
      const sameLines = _linesEq(slice.infoLines, msg.lines);
      const infoLines = sameLines ? slice.infoLines : msg.lines;
      if (slice.tab === 0) {
        // P1 — the A4 stale-matches drop is gone with stored matches:
        // highlights derive from the CURRENT content (ms.matchesFor),
        // so they re-aim at the new item's text automatically (what A4
        // + the finalizer recompute achieved in two steps — and without
        // A4's wart of losing highlights when content was ref-equal).
        // Only the match CURSOR resets on real content change.
        const needIdxReset = !sameLines && slice.search && (slice.search.idx || 0) !== 0;
        // True no-op (content + view state already in target shape) —
        // return the input ref so dispatch bookkeeping sees no change.
        if (sameLines && (slice.scroll || 0) === 0) return slice;
        const next = { ...slice, scroll: 0, infoLines };
        if (needIdxReset) {
          next.search = { ...slice.search, idx: 0 };
        }
        return next;
      }
      const entry = (slice.tabState && slice.tabState.info) || null;
      return {
        ...slice,
        tab: 0,
        infoLines,
        scroll: (entry && entry.scroll !== undefined) ? entry.scroll : 0,
        search: (entry && entry.search) || { active: false, term: '', idx: 0, typing: '' },
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
      // v0.6.3 Phase D1 — slice.lines is finalizer-derived (set by
      // _withDerivedFields after the previous Msg). When this arm
      // runs, slice.lines already reflects the current displayed
      // content. Read .length from there instead of re-calling
      // pt.viewerLines (which would need getModel + infoFromFocus).
      // Reducer pure of getModel().
      const innerH = _innerH(slice);
      const maxScroll = Math.max(0, lines.length - innerH);
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
      // Routed (msg.tabKey set) → write to
      // actionTabBuffers[group][tabKey]. Unrouted → append to
      // viewerStreamBuffer (capped ring). slice.lines is finalizer-
      // derived from the active tab's source via viewerLines() (T2d);
      // this arm writes only to the buffer + scroll bookkeeping, never
      // to slice.lines. Scroll bookkeeping reads from the BUFFER length
      // (the source of truth), not slice.lines (the derived mirror).
      if (msg.tabKey && msg.groupName) {
        const all = slice.actionTabBuffers || {};
        const group = all[msg.groupName] || {};
        const buf = group[msg.tabKey] || { lines: [] };
        const bufLines = [...buf.lines, msg.line];
        const nextAll = {
          ...all,
          [msg.groupName]: { ...group, [msg.tabKey]: { lines: bufLines } },
        };
        // v0.6.3 Phase D1 — pure reducer: dispatcher (dispatch/stream.js)
        // threads msg.currentGroup + (when groupName matches)
        // msg.activeActionTabKey. Saves the 71µs activeActionTabIn
        // (getMergedActions iteration) per streamed line.
        if (msg.groupName === msg.currentGroup && msg.activeActionTabKey === msg.tabKey) {
          const innerH = _innerH(slice);
          const maxScrollOld = Math.max(0, buf.lines.length - innerH);
          const wasAtBottom = slice.scroll >= maxScrollOld;
          const newMaxScroll = Math.max(0, bufLines.length - innerH);
          const scroll = wasAtBottom ? newMaxScroll : slice.scroll;
          return { ...slice, actionTabBuffers: nextAll, scroll };
        }
        return { ...slice, actionTabBuffers: nextAll };
      }
      // Unrouted: append to viewerStreamBuffer (cap-aware). Scroll
      // bookkeeping from the buffer length when on Transcript.
      const vsb = slice.viewerStreamBuffer || { lines: [], cap: 1000 };
      const [vsbLines, dropped] = _capLines([...vsb.lines, msg.line], vsb.cap);
      const nextBuf = { ...vsb, lines: vsbLines };
      // v0.6.3 Phase D2 — was computing `const info = pt.flatTabInfo(...)`
      // and `const m = getModel()` here without using either. flatTabInfo
      // is the 71µs/op getMergedActions call (per bench-tea-overhead);
      // the streaming hot path was paying it per-line for nothing.
      if (slice.tab === pt.transcriptTabIdx()) {
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
        // v0.6.3 Phase D1 — same threading shape as viewer_append.
        if (msg.groupName === msg.currentGroup && msg.activeActionTabKey === msg.tabKey) {
          const innerH = _innerH(slice);
          const maxScrollOld = Math.max(0, buf.lines.length - innerH);
          const wasAtBottom = slice.scroll >= maxScrollOld;
          const newMaxScroll = Math.max(0, bufLines.length - innerH);
          const scroll = wasAtBottom ? newMaxScroll : slice.scroll;
          return { ...slice, actionTabBuffers: nextAll, scroll };
        }
        return { ...slice, actionTabBuffers: nextAll };
      }
      // Unrouted bulk.
      const vsb = slice.viewerStreamBuffer || { lines: [], cap: 1000 };
      const [vsbLines, dropped] = _capLines([...vsb.lines, ...incoming], vsb.cap);
      const nextBuf = { ...vsb, lines: vsbLines };
      // v0.6.3 Phase D2 — same dead-work removal as viewer_append.
      if (slice.tab === pt.transcriptTabIdx()) {
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
        // v0.6.3 Phase D1 — dispatcher threads msg.currentGroup +
        // msg.actionTabIdx (the action's position in flatTabInfo.
        // actionTabs at dispatch time); cross-group skips the
        // jump branch entirely.
        if (msg.groupName === msg.currentGroup) {
          const idx = typeof msg.actionTabIdx === 'number' ? msg.actionTabIdx : -1;
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
            // N2 — slice.lines mirror dropped; the finalizer derives it
            // from actionTabBuffers[group][tabKey] (just seeded above).
            return [
              {
                ...slice,
                actionTabBuffers: nextAll,
                tabState: nextTabState,
                scroll: 0,
                tab: 2 + idx,
                viewerOverride: null,
                search: { active: false, term: '', idx: 0, typing: '' },
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
      // v0.6.3 Phase D1 — was `const info = pt.flatTabInfo(...)` here,
      // unused. Same dead-work as D2 (viewer_append).
      const tIdx = pt.transcriptTabIdx();
      if (slice.tab !== tIdx) {
        // B3 — clear viewerOverride on the auto-jump (same rationale
        // as the routed branch above).
        // N2 — slice.lines mirror dropped; finalizer derives from
        // viewerStreamBuffer (nextBuf, just updated above).
        // v0.6.2 B7 — also reset slice.{search, select, cursor} for
        // the auto-jump landing (parity with the routed branch's R4
        // reset). Pre-B7 the unrouted branch left the FROM tab's
        // search-match list, visual-mode anchors, and cursor on slice,
        // so the selection rectangle and search highlights painted on
        // Transcript content using line/col positions from the
        // wrong buffer.
        return [
          {
            ...slice,
            viewerStreamBuffer: nextBuf,
            tab: tIdx,
            scroll,
            viewerOverride: null,
            search: { active: false, term: '', idx: 0, typing: '' },
            select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
            cursor: { line: 0, col: 0 },
          },
          [{ type: 'msg', msg: { type: 'terminal_exit' } }],
        ];
      }
      // Already on Transcript: no tab transition, but a new stream is
      // taking over the visible surface — clear viewerOverride (A5).
      // Pre-A5 a user on Transcript viewing an override (e.g. a
      // background-job info card armed via viewer_set_content) would
      // see the override keep painting while the new stream's bytes
      // accumulated INVISIBLY behind it (viewerLines consults
      // viewerOverride first). Symmetric with the auto-jump branch
      // above (B3: stream takeover dismisses any discrete-doc
      // override).
      // N2 — slice.lines mirror dropped (finalizer-derived from
      // nextBuf).
      return { ...slice, viewerStreamBuffer: nextBuf, scroll, viewerOverride: null };
    }
    case 'viewer_set_tab': {
      // v0.6.2 R13 — clamp to in-range. Pre-R13 `msg.tab | 0` silently
      // accepted negative / non-numeric values: -5 | 0 === -5, 'foo'
      // | 0 === 0, NaN | 0 === 0. Mirrors tab_switch's guard
      // (pane-tabs.js: `if (idx < 0 || idx >= total) return slice`).
      // v0.6.3 Phase D1 — dispatcher (panel/api.js#setActiveTab)
      // threads msg.total + msg.toTabKey so the reducer stays pure
      // of getModel() / pt.flatTabInfo / _activeTabKey.
      const tab = msg.tab | 0;
      const total = typeof msg.total === 'number' ? msg.total : Infinity;
      if (tab < 0 || tab >= total) return slice;
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
      const toKey = msg.toTabKey || null;
      const entry = (slice.tabState && toKey) ? slice.tabState[toKey] : null;
      // R12 (v0.7 candidate) — `bottomSticky` tail-tracking semantics
      // differ from tab_switch's _resolveScroll. Today no production
      // caller passes a non-zero `tab` to viewer_set_tab (the docker /
      // history paths were retired in R6b/R6c), so the divergence is
      // a future-risk only. If a future plugin restores
      // setActiveTab(actionTabIdx) usage, mirror tab_switch's sticky
      // resolution here (or factor _resolveScroll out as a shared
      // helper).
      return {
        ...slice,
        tab,
        scroll: (entry && entry.scroll !== undefined) ? entry.scroll : 0,
        search: (entry && entry.search) || { active: false, term: '', idx: 0, typing: '' },
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
      // Group switch closes the `[≡]` pane-menu too — the per-group tab
      // set is fundamentally different across groups, so lingering would
      // be confusing. v0.6.4 #1 Step 2 — one `pane_menu_close` Cmd clears
      // the mode flag + the menu target together (was a mode_clear +
      // tab_list_set_owner pair). Dispatcher threads msg.paneMenuMode so
      // the reducer stays pure. Three dispatchers (app/state.js,
      // panel/navigator/groups.js × 2) read modes.paneMenuMode at
      // dispatch time.
      if (msg.paneMenuMode) {
        return [next, [
          { type: 'msg', msg: wrap('layout', { type: 'pane_menu_close' }) },
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
    // P1 (viewer-lines selector) — nav during the TYPING phase steps the
    // typing-term's derived matches; lines = the active-tab content
    // (slice.lines until P3 threads it).
    case 'viewer_search_nav':    return msg.dir > 0
      ? ms.next(slice, _innerH(slice), lines, slice.search.typing || '')
      : ms.prev(slice, _innerH(slice), lines, slice.search.typing || '');
    case 'viewer_search_commit': {
      const [next, info] = ms.commit(slice, _innerH(slice), lines);
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
    // Committed-search adapter Msg — exposed for the non-reducer
    // facade (panel/viewer/search.js) so its callers route through
    // viewer.update rather than writing the slice directly (single-
    // writer-per-slice per docs/PRINCIPLES.md §12).
    // P1 (viewer-lines selector) — viewer_search_recompute(_for) arms
    // retired: matches derive via ms.matchesFor (chained selector), so
    // there is no stored match list to refresh.
    case 'viewer_search_clear_committed': return ms.clearCommitted(slice);

    // --- visual-mode select. The mouse path dispatches the select_* Msgs
    // (panel/viewer/select.js); the keyboard path lives in `case 'key':` below.
    // Both flow through the same pure slice transforms (`_beginSelect` /
    // `_setCursor` / `_scrollView` / `_moveCursor`) defined above the
    // reducer. The ANSI-aware reads the key arms need (selectedTextFrom /
    // plainLineWidthFrom) are select.js's PURE variants — fed the threaded
    // `lines` + our own `slice`, so no getModel()/resolveTarget reach.
    case 'select_begin':
      return _beginSelect(slice, msg.line, msg.col, msg.kind, lines);
    case 'select_extend': {
      if (!slice.select || !slice.select.active) return slice;
      const n = lines.length;
      const l = n === 0 ? 0 : Math.max(0, Math.min(n - 1, msg.line | 0));
      return { ...slice, select: { ...slice.select, cursor: { line: l, col: Math.max(0, msg.col | 0) } } };
    }
    case 'select_cancel':
      if (!slice.select) return slice;
      return { ...slice, select: { ...slice.select, active: false } };
    case 'select_set_cursor':
      return _setCursor(slice, msg.line, msg.col, msg.extend);
    case 'select_scroll_view':
      return _scrollView(slice, msg.delta, lines);

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
      // v0.6.3 Phase D1: dispatcher (panel/api.js#dispatchKeyToFocused)
      // threads msg.focusKind + msg.terminalMode so the reducer stays
      // pure. Higher-priority chain modes (menu/cmd/confirm/prompt/copy)
      // are already filtered upstream by _dispatchActiveMode in
      // dispatch.handleKey; this arm only ever runs when NO chain mode
      // is active. terminalMode is non-chain (per modes.js) so it has
      // to be checked here.
      if (msg.focusKind !== 'detail' || msg.terminalMode) return slice;

      const active = !!(slice.select && slice.select.active);
      const claim = [{ type: '_claimed' }];

      // Detail-search post-commit n/N nav; Esc clears. P1 — committed
      // phase steps the committed term's derived matches.
      if (slice.search && slice.search.active) {
        if (msg.seq === 'n' || msg.key === 'n') return [ms.next(slice, _innerH(slice), lines, slice.search.term || ''), claim];
        if (msg.seq === 'N' || msg.key === 'N') return [ms.prev(slice, _innerH(slice), lines, slice.search.term || ''), claim];
        if (msg.key === 'escape' && !active)    return [ms.clearCommitted(slice), claim];
      }

      // v / V — toggle visual mode. Anchor at the top of the current viewport
      // (matches what mouse-drag effectively does — cursor where it lands).
      if (msg.seq === 'v' || msg.key === 'v') {
        const next = (active && slice.select.kind === 'char')
          ? { ...slice, select: { ...slice.select, active: false } }
          : _beginSelect(slice, slice.scroll || 0, 0, 'char', lines);
        return [next, claim];
      }
      if (msg.seq === 'V' || msg.key === 'V') {
        const next = (active && slice.select.kind === 'line')
          ? { ...slice, select: { ...slice.select, active: false } }
          : _beginSelect(slice, slice.scroll || 0, 0, 'line', lines);
        return [next, claim];
      }

      // y — commit + push to register. The text resolution + OSC52 ride out
      // as apply_msg → register_push (root reducer owns the register).
      if ((msg.seq === 'y' || msg.key === 'y') && active) {
        const text = require('./select').selectedTextFrom(lines, slice.select);
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
        const next = active ? _moveCursor(slice, +1, 0, lines) : _scrollView(slice, +1, lines);
        return [next, claim];
      }
      if (msg.key === 'up' || msg.seq === 'k' || msg.key === 'k') {
        const next = active ? _moveCursor(slice, -1, 0, lines) : _scrollView(slice, -1, lines);
        return [next, claim];
      }

      // Horizontal h/l — only claim in visual mode so reading-mode focus-shift
      // still works (`l` to step out of detail into the next panel).
      if (active) {
        if (msg.key === 'left'  || msg.seq === 'h' || msg.key === 'h') return [_moveCursor(slice, 0, -1, lines), claim];
        if (msg.key === 'right' || msg.seq === 'l' || msg.key === 'l') return [_moveCursor(slice, 0, +1, lines), claim];
      }

      // 0 / $ — line-start / line-end jumps. Only meaningful with a cursor.
      if (active && (msg.seq === '0' || msg.key === 'home')) {
        return [_setCursor(slice, slice.cursor.line, 0, true), claim];
      }
      if (active && (msg.seq === '$' || msg.key === 'end')) {
        const w = require('./select').plainLineWidthFrom(lines, slice.cursor.line);
        return [_setCursor(slice, slice.cursor.line, Math.max(0, w - 1), true), claim];
      }
      return slice;
    }
    default:
      return slice;
  }
}

// --- panel renderer (reads the slice directly) ---

// Build ONE viewer pane's tab strip — pure (no slice write). Used by render
// (for the title) and by the input hit-test (for the tab bounds). The hotkey
// comes from the pane being acted on (render threads panel.hotkey; the input
// layer resolves it from the pane def) — it shifts each tab's hit-zone x, so
// title and bounds must agree on it. Reads the jobs list (out-of-TEA) for the
// running-glyph set — fine at these render / handler boundaries (not a
// reducer). `slice` is THIS pane's own slice, so two viewers don't share.
function tabStripFor(slice, model, hotkey) {
  const group = model.currentGroup;
  const tabInfo = pt.flatTabInfo(slice, model, group);
  // Running indicator (Phase 4.4) — action keys whose stream-routed job is
  // alive in the current group; buildTabStrip prefixes those labels with `●`.
  const runningActionKeys = new Set(
    require('../../feature/jobs').list()
      .filter(j => j.kind === 'stream-routed' && j.status === 'running'
                && j.owner && j.owner.groupName === group)
      .map(j => j.owner.tabKey)
  );
  // hasTabTrigger reflects chromeFor()'s decision for detail panes: `[≡]` is
  // painted when the viewer has ≥2 tabs (Info + Transcript alone qualify). The
  // trigger occupies 3 cells between `(hk)` and the title; buildTabStrip needs
  // it to compute the correct x for each tab's hit-zone (the [x] glyph).
  const hasTabTrigger = (tabInfo && Number.isFinite(tabInfo.total) ? tabInfo.total : 0) >= 2;
  return buildTabStrip(tabInfo, slice.tab, hotkey, runningActionKeys, hasTabTrigger);
}

// v0.6.4 blessed-exceptions tabBounds follow-on — the viewer tab-strip's
// hit-test bounds, recomputed ON DEMAND by the input layer (was render-written
// to `slice.tabBounds`, the last render-side slice write). render() is now a
// pure view: it computes the strip only for the title and writes nothing. Mouse
// hit-tests are rare vs frames, so recompute-on-read is cheap (same rationale
// as the paneBounds selector). Returns the bounds array (empty if no strip).
function tabBoundsFor(slice, model, hotkey) {
  const built = tabStripFor(slice, model, hotkey);
  return built ? built.tabBounds : [];
}

function detailTitle(slice, hotkey) {
  const built = tabStripFor(slice, getModel(), hotkey);
  return built ? built.title : 'Detail';
}

function render(panel, w, h, slice, opts) {
  const m = getModel();
  const innerH = h - 2;
  // v0.6.4 multi-viewer — hotkey from the pane being rendered (panel.hotkey),
  // not the first/major-viewer fallback. Threaded into detailTitle so the
  // tab strip labels THIS viewer's hotkey.
  const hotkey = panel ? panel.hotkey : '';
  // v0.6.4 Theme A Phase 5 — per-pane focus (opts.focused, from
  // paneMatchesFocus). terminalMode keeps the viewer lit while a terminal
  // tab is live regardless of focus. No-op under single-pane configs.
  const isFocused = !!(opts && opts.focused) || m.modes.terminalMode;
  const chrome = opts && opts.chrome;
  if (isTerminalTab()) {
    return renderPanel({
      width: w, height: h, lines: [],
      title: detailTitle(slice, hotkey), hotkey,
      panelType: 'detail',
      focused: isFocused,
      chrome,
    });
  }
  // T2c — display lines come from viewerLines() (derives from active
  // tab + buffers + override + focused-Navigator's getInfo). Falls
  // back to slice.lines for tabs whose reducer arms still maintain
  // it; T2d retires the fallback. infoFromFocus is the module-level
  // helper (was an identical inline closure here pre-cleanup).
  const derived = pt.viewerLines(slice, m, m.currentGroup, { infoFromFocus: _infoFromFocus });
  let lines = derived;
  let count = null;
  if (lines.length > innerH) {
    count = [slice.scroll + innerH, lines.length];
  }
  const select = require('./select');
  const search = require('./search');
  if (select.isActive()) {
    lines = select.decorateLines(lines);
  } else {
    // P4 review fix — thread THIS pane's slice so an unfocused viewer
    // is decorated with its own search state (multi-viewer).
    lines = search.decorateLines(lines, slice);
  }
  return renderPanel({
    width: w, height: h, lines,
    title: detailTitle(slice, hotkey), hotkey,
    panelType: 'detail',
    focused: isFocused,
    count,
    scrollOffset: slice.scroll,
    chrome,
  });
}

// blessed-exceptions #3 — the framework (api.js) calls this in the impure
// dispatch shell to thread the viewer's model bundle into every Msg, so
// update() stays pure of getModel(). Idempotent: a pre-attached bundle wins.
function augmentMsg(msg, model) {
  if (msg && msg.viewerModel) return msg;
  return { ...msg, viewerModel: pt.viewerModelBundle(model, model && model.currentGroup) };
}

module.exports = {
  name: 'detail',
  init,
  update,
  augmentMsg,
  panelTypes: {
    detail: { render },
  },
  // v0.6.4 blessed-exceptions tabBounds follow-on — the input layer
  // recomputes the tab-strip hit-test bounds on demand (render no longer
  // writes slice.tabBounds). Pure: (slice, model, hotkey) → bounds.
  tabBoundsFor,
  // Test-only exports — not part of the Component contract.
  _init: init,
  _update: update,
};
