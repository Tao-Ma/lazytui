/**
 * Core Component — detail (the viewer).
 *
 * Owns the viewer slice (`lines` / `scroll` / `tab` / `search` /
 * `select` / `cursor` / `contentTabs`). Every viewer-* mutation is handled
 * inside `update(msg, slice)` here; the root reducer doesn't touch the slice.
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
 * Tab bar rendering (the Info | Transcript | contentTabs strip and tab click
 * bounds) stays inside this module's render path so the panel def is the single
 * home for the viewer's view.
 */
'use strict';

const {
  renderPanel,
  getInstanceSlice, wrap,
} = require('../api');
const tvu = require('../../leaves/text/text-view-update');
const { paneInnerH } = require('../pane-viewport');
const pt = require('../../leaves/wm/pane-tabs');
const tc = require('../../leaves/wm/tab-container');
const { buildTextView } = require('../../leaves/text-view/render');
const mpool = require('../../leaves/wm/pool');
const { buildTabStrip } = require('./tab-strip');
const { getModel } = require('../../model/store');

// --- internal slice transforms (pure return-new) ---
//
// U2c P0 — the scroll/search/select/cursor transforms (_beginSelect, _setCursor,
// _scrollView, _lineWidth, _moveCursor, _enterSearchReturn) moved to the shared
// leaf leaves/text/text-view-update.js, reached via `tvu.reduce` from the
// interaction arms below (so the viewer + any minted text-view instance share
// one implementation). `_innerH` / `_pts` / `_capLines` stay — they serve the
// content arms (append / stream_start / set_content) that remain viewer-specific.

// Effective viewport for scroll/cursor clamps. The slice's `innerH` is set by
// the viewer's OWN reducer (`update`) from the `msg.innerH` fact that
// `augmentMsg` stamps onto every viewer Msg (v0.6.6 FIX-2 — retired
// blessed-exception B, the finalizer's direct same-slice write; before that
// it was finalizer-written, and before resize-as-Msg, render-written). The
// reducer stays a pure function of (slice, msg) — no cross-slice read of
// layout geometry; the read lives in the impure shell (augmentMsg).
// The pre-first-render fallback is `1`:
// any viewer_scroll/append/cursor before paint still clamps inside
// [0, lines.length - 1] instead of overshooting (the pre-fix bug was
// `(0 || 0) - 2 = -2` viewport → `maxScroll = lines.length + 2`, leaving
// the slice with scroll past the last line until the next render).
// Tests that need a specific viewport seed `slice.innerH` directly.
function _innerH(slice) { return slice.innerH > 0 ? slice.innerH : 1; }

// Per-tab view-state via the tab-container interface (U1, docs/one-tab-system.md).
// The viewer is tabState-backed; the accessor is slice-only (the key is already
// resolved), so it needs no model/bundle and behaves the same in the reducer,
// the finalizer, and the shell. (The dead _tabFieldOf/_withTabField singular
// aliases retired here — only the multi-field capture was ever a live consumer.)
function _pts(slice, key) { return tc.perTabState(tc.containerFor('viewer', { slice }), key); }

/** Cap an array of lines to maxLen by dropping the oldest. Returns
 *  [cappedLines, droppedCount] so callers can adjust scroll for the
 *  shift. */
function _capLines(lines, maxLen) {
  if (lines.length <= maxLen) return [lines, 0];
  const dropped = lines.length - maxLen;
  return [lines.slice(dropped), dropped];
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
    // Written by the per-dispatch finalizer (dispatch/runtime/finalize.finalizeDispatch)
    // via a direct setInstanceSlice on our OWN slice (blessed-exception B) once a
    // dispatch settles the layout — owning slice, not cross-slice, so the reducer
    // is a pure function of (slice, msg). 0 = not-yet-dispatched; _innerH() falls
    // back to 1 in that degenerate (see _innerH) so clamps collapse to
    // "everything fits". See docs/v0.6.5-tea-reaudit.md (exception B) for why this
    // stays a direct write while the adjacent scroll-clamp routes a set_scroll Msg.
    innerH: 0,
    search: { active: false, term: '', idx: 0, typing: '' },
    select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
    cursor: { line: 0, col: 0 },
    contentTabs: {},          // [groupName]: { [key]: { label, lines } }
    // (U2c P2 — slice.actionTabBuffers retired: a tab:true action's output now
    // lives in its own text-view instance minted as a position-tab. U2d P2b —
    // slice.ephemeralTerminals retired: embedded terminals are `terminal` panes.)
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
//     tabState entry we just dropped. Info/Transcript always exist; content is
//     checked against next's store. (U2d P2b — the terminal-key branch is gone:
//     resolveTabKeyFromBundle only yields info/transcript/content keys now.)
function _activeTabKeyFromBundle(slice, bundle) {
  return pt.resolveTabKeyFromBundle((slice && slice.tab) | 0, slice, bundle);
}
function _tabKeyExistsInFromBundle(next, bundle, key) {
  if (!key || key === 'info' || key === 'transcript') return true;
  const mt = key.match(/^(.+?):content:(.+)$/);
  if (!mt) return true;
  const [, keyGroup, restKey] = mt;
  const all = (next && next.contentTabs) || {};
  const group = all[keyGroup];
  return !!(group && group[restKey]);
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
  // resolves in next). Otherwise removeContent's tabState drop is
  // silently undone by this capture.
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
      updated = _pts(updated, fromKey).withFields(captured);
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
  // v0.6.6 FIX-2 — `innerH` (the pane's viewport height) arrives as a stamped
  // Msg fact (augmentMsg computes it in the shell from the pane's committed
  // geometry), so the viewer's OWN reducer is the single writer of
  // slice.innerH — retiring blessed-exception B (the finalizer's direct
  // setInstanceSlice into our slice). Project it onto the working slice at
  // entry so every arm + delegated leaf reducer reads it through the usual
  // `_innerH(slice)` / `slice.innerH` path with no signature changes. The
  // `!==` guard preserves slice ref-identity when innerH is unchanged (the
  // layout memo + downstream ref-equality depend on it). Tests that seed
  // slice.innerH directly still work: they call update() with no msg.innerH,
  // so the seeded value is preserved.
  if (msg && msg.innerH > 0 && slice.innerH !== msg.innerH) slice = { ...slice, innerH: msg.innerH };
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
          captureFirst = _pts(slice, fromKey).withFields(captured);
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
      const entry = _pts(slice, 'info').entry();
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
    // viewer_scroll + the search/select/key interaction Msgs delegate to the
    // shared reducer (U2c P0). `lines` is the boundary-derived active-tab content;
    // ownKind 'detail' gates the key state machine (byte-identical to the inline
    // arms this replaced). tvu.reduce owns the scroll clamp / per-Msg mirror.
    case 'viewer_scroll':
      return tvu.reduce(msg, slice, lines, 'detail');
    case 'viewer_append': {
      // Unrouted stream append → the Transcript accumulator (viewerStreamBuffer,
      // capped ring). U2c P2 — the routed action-tab branch retired: a tab:true
      // action's output now streams into its own text-view instance (tv_append),
      // not actionTabBuffers, so this arm only serves the unrouted Transcript path.
      // slice.lines is finalizer-derived; this writes only the buffer + scroll.
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
      // U2c P2 — routed action-tab branch retired (see viewer_append); only the
      // unrouted Transcript bulk-append remains.
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
      // U2c P2 — the routed action-tab branch retired: a tab:true action's
      // stream_start now seeds its own text-view instance (tv_stream_start), so
      // this arm only serves the UNROUTED stream (tabless type:run, docker verbs).
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
      const entry = toKey ? _pts(slice, toKey).entry() : null;
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

    // --- search (typing + committed) + visual-mode select + the keyboard state
    // machine all delegate to the shared reducer (U2c P0, leaves/text/
    // text-view-update). The mouse path still dispatches select_* here
    // (panel/viewer/select.js); the keyboard `/`, n/N, v/V, y, j/k/h/l, 0/$ live
    // in tvu's `key` arm, gated by ownKind 'detail' (byte-identical to the inline
    // arms this replaced — including the mode_set/mode_clear detailSearchMode
    // effects and the register_push yank).
    case 'viewer_search_enter':
    case 'viewer_search_key':
    case 'viewer_search_nav':
    case 'viewer_search_commit':
    case 'viewer_search_cancel':
    case 'viewer_search_clear_committed':
    case 'select_begin':
    case 'select_extend':
    case 'select_cancel':
    case 'select_set_cursor':
    case 'select_scroll_view':
    case 'key':
      return tvu.reduce(msg, slice, lines, 'detail');
    default:
      return slice;
  }
}

// --- panel renderer (reads the slice directly) ---

// Build ONE viewer pane's tab strip — pure (no slice write). Used by render
// (for the title) and by the input hit-test (for the tab bounds). The hotkey
// comes from the pane being acted on (render threads panel.hotkey; the input
// layer resolves it from the pane def) — it shifts each tab's hit-zone x, so
// title and bounds must agree on it. `slice` is THIS pane's own slice, so two
// viewers don't share. (U2c P2 — the running-glyph set retired with the action
// tabs it decorated; a running action's indicator moves to its text-view
// position-tab when the slot strip gains that decoration — a follow-on.)
function tabStripFor(slice, model, hotkey) {
  const group = model.currentGroup;
  const tabInfo = pt.flatTabInfo(slice, model, group);
  // hasTabTrigger reflects chromeFor()'s decision for detail panes: `[≡]` is
  // painted when the viewer has ≥2 tabs (Info + Transcript alone qualify). The
  // trigger occupies 3 cells between `(hk)` and the title; buildTabStrip needs
  // it to compute the correct x for each tab's hit-zone (the [x] glyph).
  const hasTabTrigger = (tabInfo && Number.isFinite(tabInfo.total) ? tabInfo.total : 0) >= 2;
  return buildTabStrip(tabInfo, slice.tab, hotkey, hasTabTrigger);
}

// v0.6.4 blessed-exceptions tabBounds follow-on — the viewer tab-strip's
// hit-test bounds, recomputed ON DEMAND by the input layer (was render-written
// to `slice.tabBounds`, the last render-side slice write). render() is now a
// pure view: it computes the strip only for the title and writes nothing. Mouse
// hit-tests are rare vs frames, so recompute-on-read is cheap (same rationale
// as the derived pane-bounds selector). Returns the bounds array (empty if no strip).
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
  // T2c — display lines come from viewerLines() (derives from active
  // tab + buffers + override + focused-Navigator's getInfo). Content
  // derivation stays here (viewer/tab-kind-aware, arc D3); the scrollable
  // text RENDERING (window + decorate + render-args) is delegated to the
  // pure leaves/text-view leaf (U2a). infoFromFocus is the module-level helper.
  const derived = pt.viewerLines(slice, m, m.currentGroup, { infoFromFocus: _infoFromFocus });
  // Resolve the decoration inputs in the impure shell, then hand the pure leaf
  // resolved state. Selection wins over search (unchanged precedence); the
  // selection reads the focused viewer's slice (as before), search reads THIS
  // pane's slice (the P4 multi-viewer fix) — both preserved by resolving here.
  const select = require('./select');
  const search = require('./search');
  const sel = select.activeSelection();
  const searchDecoration = sel ? null : search.decorationFor(slice, derived);
  // A3 windowed-decorate (window FIRST, then decorate only the ~innerH visible
  // rows) lives inside buildTextView — byte-identical to whole-buffer-then-slice.
  const args = buildTextView({
    lines: derived, scroll: slice.scroll, innerH,
    select: sel, searchDecoration,
    width: w, height: h,
    title: detailTitle(slice, hotkey), hotkey,
    panelType: 'detail', focused: isFocused, chrome,
  });
  // renderPanel here is the selection-aware panel/api wrapper — it captures the
  // window for the per-pane MOUSE selection pipeline before drawing, so the args
  // must flow through it (not the leaf renderPanel).
  return renderPanel(args);
}

// blessed-exceptions #3 — the framework (loop._augment) calls this in the impure
// dispatch shell to thread the viewer's model bundle + viewport height into
// every Msg, so update() stays pure of getModel() and of layout geometry.
// Idempotent: pre-attached facts win. The viewport height (v0.6.6 FIX-2) now
// comes from the shared `paneInnerH` helper (U2c P0 — shared with text-view).
function augmentMsg(msg, model, slice) {
  let out = msg;
  if (!out.viewerModel) {
    out = { ...out, viewerModel: pt.viewerModelBundle(model, model && model.currentGroup) };
  }
  if (!(out.innerH > 0)) {
    const ih = paneInnerH(slice);
    if (ih > 0) out = { ...out, innerH: ih };
  }
  return out;
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
