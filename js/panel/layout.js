/**
 * Core Component — layout (chrome-only, no panelTypes).
 *
 * The frame surrounding the panel grid. Owns:
 *   - arrange        — { columns: [{width?, panels}], detailHeightPct, pool }
 *   - focus          — currently focused panel type
 *   - viewMode       — normal / half / full
 *   - dirty          — layout has unsaved changes (drives `:save-layout` hint)
 *   - design         — free-config working state (drag, undo/redo, titleEdit)
 *   - panelHeights / panelBounds — view-output, written by the render pass
 *   - panelList      — `w` overlay state (open, cursor)
 *
 * No `panelTypes` — this Component renders chrome, not panel content. Spec:
 * docs/v0.5-layout-component.md.
 */
'use strict';

// Pure leaves — take this Component's slice and return a new one.
// No in-place writes, no panel/api reach-around. Called from this
// Component's update, preserving single-writer-per-slice.
const mfc = require('../leaves/free-config');
const mpoolDrag = require('../leaves/free-config-pool-drag');
const mtabDrag = require('../leaves/tab-drag');
const mpool = require('../leaves/pool');
const route = require('../leaves/route');
const { getModel } = require('../app/runtime');

const { LEFT_HOTKEY_POOL, RIGHT_HOTKEY_POOL } = require('../leaves/hotkeys');

/** Hotkey pool for the column at `columnIndex` in an `N`-column layout.
 *  First column → LEFT_HOTKEY_POOL, last → RIGHT_HOTKEY_POOL, middle
 *  columns get empty (no auto-assigned hotkeys). Mirrors
 *  parser/index.js#hotkeyPoolForColumn. */
function hotkeyPoolForColumn(columnIndex, N) {
  if (columnIndex === 0) return LEFT_HOTKEY_POOL;
  if (columnIndex === N - 1) return RIGHT_HOTKEY_POOL;
  return [];
}

/** Reassign positional hotkeys for a column after a hide/show mutation.
 *  Matches the free-config behavior — hotkey is the panel's slot index
 *  within its column. Explicit YAML hotkeys are NOT preserved across
 *  runtime mutations (consistent with how free-config reorder works). */
function rekeyColumn(panels, pool) {
  return panels.map((p, i) => ({ ...p, hotkey: pool[i] || '' }));
}

/** Compare two drag drop targets for visual equality. Used by both
 *  free_config_mouse_motion and pool_drag_motion to decide whether the cursor
 *  moved between drop zones (force_full_repaint + preview recompute
 *  needed) or just within one (no repaint).
 *
 *  Compares every field that affects the preview render — without `kind`
 *  an insert@N and a swap@N at the same columnIndex compare equal; without
 *  `index` two distinct inserts compare equal; without `occupantType`
 *  /`occupantId` distinct swap/replace targets compare equal. curX/curY
 *  are not visual; ignore them. */
function _dragTargetsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind
      && a.columnIndex === b.columnIndex
      && a.index === b.index
      && a.occupantId === b.occupantId
      && a.occupantType === b.occupantType
      && a.valid === b.valid;
}

function init() {
  return {
    // { columns: [{width?, panels}], detailHeightPct, pool }.
    // `pool` is the v0.6 id → entry map for placed + hidden panels;
    // pool derivations live in `js/leaves/pool`. state.js's initState
    // replaces this default with the parsed config
    // (leaves/arrange.rebuildLayoutFromConfig).
    arrange: { columns: [{ width: 30, panels: [] }, { panels: [] }], detailHeightPct: 60, pool: {} },
    // Default focus = first declared panel. state.js's initState() overrides
    // this once the parsed layout is in.
    focus: 'groups',
    viewMode: 'normal',
    dirty: false,
    // Free-config working state — the reducer's drag/undo/title-edit
    // sub-state. The active panel (formerly `selectedIdx` here) is
    // derived from `slice.focus` via `mfc.selectedIdx(slice)` — single
    // source of truth.
    freeConfig: {
      drag: null,
      undo: [],
      redo: [],
      titleEdit: { active: false, text: '' },
      // Transient hint surfaced in the footer when a free-config /
      // view-mode transition is blocked. Cleared when the user reaches
      // a state where the block no longer applies (free_config_exit,
      // successful view change).
      notice: null,
    },
    // View-output (written by the render pass, read by mouse hit-tests
    // and free-config drag math). The renderer-as-writer pattern is the
    // documented exception to single-writer — see render/layout.js header.
    panelHeights: {},
    panelBounds: {},
    // Panel-list overlay state. Opened by `w` (or auto-opened on
    // free-config entry when the pool has hidden entries). Arrow keys
    // navigate, Enter context-picks (hide if placed, show if hidden,
    // no-op on detail).
    panelList: { open: false, cursor: 0 },
    // Half-view's left-side panel — tracks the most recently focused
    // non-viewer-kind tab. When focus sits on a viewer-kind tab in
    // half view, the renderer reads this to decide what to paint on
    // the left instead of duplicating the viewer on both sides.
    // Updated in `focus_set` only when the new focus is non-viewer-
    // kind; stays sticky while focus sits on a viewer. Falls back to
    // first non-viewer panel if unset/stale.
    halfLeftPanel: null,
    // v0.6.1 Phase 4 — pane id that owns the open tab-list overlay.
    // Companion to model.modes.tabListMode: the mode flag says "an
    // overlay is open" (chain-mode keyboard routing); this field says
    // "this specific pane's overlay is open" (geometry + slice
    // anchoring). null when no overlay open. Written by pane-tabs
    // reducer's tab_list_open/tab_list_close via wrapped layout Msgs.
    tabListOwnerPaneId: null,
    // v0.6.1 Phase 5 — sticky pointer to the most recent viewer-kind
    // tab the user focused. resolveTarget('viewer') falls back to
    // this when no viewer-kind tab is currently focused (e.g. user
    // is on a Navigator). Written in focus_set when the new focus
    // resolves to a viewer-kind instance.
    lastViewerTab: null,
    // Soft-fail diagnostics surfaced by parser/validate (today: column
    // over soft cap). Seeded at boot by state.initState via
    // `set_boot_warnings`. Painted in the footer until dismissed
    // (`:dismiss-warnings`) or the next config reload. Each entry is
    // a plain string (the user-facing message).
    bootWarnings: [],
  };
}

// Pure reducer for the `viewMode` field. Returns the next value
// given the current value + a Msg. No side effects.
function reduceViewMode(viewMode, msg) {
  switch (msg.type) {
    case 'view_expand':
      if (viewMode === 'normal') return 'half';
      if (viewMode === 'half')   return 'full';
      return viewMode;
    case 'view_shrink':
      if (viewMode === 'full') return 'half';
      if (viewMode === 'half') return 'normal';
      return viewMode;
    case 'view_set':
      return (msg.mode === 'normal' || msg.mode === 'half' || msg.mode === 'full')
        ? msg.mode : viewMode;
    case 'view_drop_full_to_normal':
      // Cross-layer ask: terminal_exit emits this so a 'full' auto-zoom
      // tied to a terminal tab drops back to 'normal' on PTY exit. The
      // root reducer can't write viewMode anymore (single-writer); layout
      // owns the conditional.
      return viewMode === 'full' ? 'normal' : viewMode;
    default:
      return viewMode;
  }
}

/** What notice (if any) would this Msg's blocked-action arm set?
 *  Used for the notice auto-clear short-circuit: a Msg that would
 *  RE-ASSERT the current notice preserves slice identity (no churn on
 *  repeated identical blocked attempts); a Msg that wouldn't reassert
 *  triggers the auto-clear so notice doesn't persist across unrelated
 *  user intents. */
function _potentialBlockedNotice(slice, msg) {
  if (msg.type === 'view_expand' || msg.type === 'view_shrink') {
    const md = getModel().modes;
    if (md && md.freeConfigMode) return 'exit free-config (q) to change view mode';
  }
  if (msg.type === 'free_config_enter' && slice.viewMode !== 'normal') {
    return 'free-config requires normal view ([ to return)';
  }
  return null;
}

function update(msg, slice) {
  // Notice lifecycle (v0.6 view-guard polish):
  //   - Continuous-motion Msgs (drag-in-flight) preserve the notice — one
  //     intent in flight; cursor drift through zones shouldn't disturb an
  //     unrelated hint from an earlier refused action.
  //   - A Msg that would re-assert the same notice preserves it (no
  //     identity churn on repeated identical blocked attempts).
  //   - Everything else implicitly clears notice: any layout-touching
  //     user intent that isn't re-asserting the block is treated as the
  //     user having moved on.
  const continuousMotion = msg.type === 'free_config_mouse_motion' ||
                           msg.type === 'pool_drag_motion' ||
                           msg.type === 'tab_drag_motion';
  const oldNotice = slice.freeConfig && slice.freeConfig.notice;
  if (oldNotice && !continuousMotion) {
    const wouldReassert = _potentialBlockedNotice(slice, msg);
    if (wouldReassert !== oldNotice) {
      slice = { ...slice, freeConfig: { ...slice.freeConfig, notice: null } };
    }
  }

  switch (msg.type) {
    // viewMode. Each transition that actually changes the value asks
    // the effects layer for a full repaint — a view change re-exposes
    // panels the diff cache can't tell changed.
    case 'view_expand':
    case 'view_shrink':
    case 'view_set':
    case 'view_drop_full_to_normal': {
      // Block user-input view changes (`[` / `]`) while in free-config —
      // the drag/resize gestures need a fully-visible grid, which half/
      // full don't show. Programmatic Msgs (`view_set` from cmdline /
      // pty-lifecycle, `view_drop_full_to_normal` from terminal exit)
      // are system-driven and stay unguarded.
      const md = getModel().modes;
      const isUserInput = msg.type === 'view_expand' || msg.type === 'view_shrink';
      if (md && md.freeConfigMode && isUserInput) {
        const target = 'exit free-config (q) to change view mode';
        // Short-circuit: if notice already matches, slice ref is preserved
        // (the auto-clear above also preserved it via wouldReassert).
        if (slice.freeConfig && slice.freeConfig.notice === target) return slice;
        return { ...slice, freeConfig: { ...slice.freeConfig, notice: target } };
      }
      const next = reduceViewMode(slice.viewMode, msg);
      if (next === slice.viewMode) return slice;
      return [{ ...slice, viewMode: next }, [{ type: 'force_full_repaint' }]];
    }
    // focus. Stores the focused panel; refresh of the detail body for
    // the newly-focused panel is an effect (Cmd). msg.focus == null
    // leaves the value put.
    case 'focus_set': {
      const next = msg.focus != null ? msg.focus : slice.focus;
      // Track non-detail focus for half view — the left-side panel
      // sticks at the last non-detail focus so moving focus to detail
      // doesn't make the other half vanish behind a duplicate detail.
      const halfLeftPanel = route.instanceKind(next) !== 'detail' ? next : slice.halfLeftPanel;
      // v0.6.1 Phase 5 — sticky pointer to the most recent viewer-
      // kind tab. resolveTarget('viewer') reads this when no viewer
      // is currently focused. instanceKind() == VIEWER_KIND filters
      // out Navigators / Monitors that should NOT advance the
      // pointer.
      const lastViewerTab = route.isViewerKind(next) ? next : slice.lastViewerTab;
      return [{ ...slice, focus: next, halfLeftPanel, lastViewerTab }, [{ type: 'show_selected_info' }]];
    }
    // v0.6.1 Phase 4 — pane id that owns the open tab-list overlay.
    // Dispatched from the pane-tabs leaf reducer's tab_list_open
    // (paneId set) / tab_list_close (paneId null). Identity-preserved
    // on no-op so a redundant close doesn't churn the slice.
    case 'tab_list_set_owner': {
      const paneId = msg.paneId != null ? msg.paneId : null;
      if (slice.tabListOwnerPaneId === paneId) return slice;
      return { ...slice, tabListOwnerPaneId: paneId };
    }
    // Boot warnings — whole-array replace (state.initState dispatches
    // this once after parse). dismiss_warnings clears them. The footer
    // renderer paints `⚠ N config warning(s)` when length > 0.
    case 'set_boot_warnings': {
      const next = Array.isArray(msg.warnings) ? msg.warnings.slice() : [];
      if (next.length === slice.bootWarnings.length &&
          next.every((w, i) => w === slice.bootWarnings[i])) return slice;
      return { ...slice, bootWarnings: next };
    }
    case 'dismiss_warnings':
      if (slice.bootWarnings.length === 0) return slice;
      return { ...slice, bootWarnings: [] };
    // arrange + dirty writes. :save-layout sends `{ dirty: false }`;
    // :restore-layout sends `{ arrange, dirty: false }` (the rebuilt
    // struct from `leaves/arrange.rebuildLayoutFromConfig`). Both are
    // wrapped Msgs dispatched into layout — single-writer.
    case 'set_arrange': {
      const next = { ...slice };
      if (msg.arrange !== undefined) next.arrange = msg.arrange;
      if (msg.dirty   !== undefined) next.dirty   = !!msg.dirty;
      return next;
    }
    // Design-mode state — pure return-new. The mfc leaf takes this
    // Component's slice and returns a new slice; layout.update threads
    // it through, preserving single-writer-per-slice. The root chrome
    // mode flags (`freeConfigMode`, `freeConfigTitleEditMode`) ride on
    // `apply_msg` Cmds the reducer applies (`mode_set` / `mode_clear`).
    case 'free_config_enter': {
      // Refuse entry from half/full view — the drag/resize gestures
      // operate on the full grid and need every cell visible. Surface a
      // notice so the user knows why `q` / `:free-config` didn't fire.
      if (slice.viewMode !== 'normal') {
        const target = 'free-config requires normal view ([ to return)';
        if (slice.freeConfig && slice.freeConfig.notice === target) return slice;
        return { ...slice, freeConfig: { ...slice.freeConfig, notice: target } };
      }
      // Reset working state on entry. Auto-open the panel-list overlay
      // when the pool has hidden entries — the discoverability hint
      // that there are more panels available than currently in the grid.
      // Preserve the current focus when it points at a placed panel
      // (mfc.selectedIdx derives the index); fall back to the first
      // placed panel when current focus isn't in the layout (hidden in
      // the pool, or never set).
      const hasHidden = mpool.hiddenIds(slice.arrange).length > 0;
      const all = mfc.allFreeConfigPanels(slice);
      const focusedIsPlaced = all.some(p => p.type === slice.focus);
      const focus = focusedIsPlaced ? slice.focus : (all[0] ? all[0].type : slice.focus);
      const next = {
        ...slice,
        focus,
        freeConfig: { drag: null, undo: [], redo: [], titleEdit: { active: false, text: '' }, notice: null },
        panelList: { open: hasHidden, cursor: 0 },
      };
      return [next, [{ type: 'apply_msg', msg: { type: 'mode_set', flag: 'freeConfigMode' } }]];
    }
    case 'free_config_exit': {
      // Free-config nav (free_config_nav / free_config_reorder /
      // free_config_move / mousePress) writes `focus` directly via the
      // mfc leaf, NOT through `focus_set`, so halfLeftPanel didn't
      // track in-mode movement. Commit the current focus on exit so
      // half-view's left-panel fallback reflects where the user landed.
      const halfLeftPanel = route.instanceKind(slice.focus) !== 'detail' ? slice.focus : slice.halfLeftPanel;
      const next = {
        ...slice,
        freeConfig: { drag: null, undo: [], redo: [], titleEdit: { active: false, text: '' }, notice: null },
        panelList: { open: false, cursor: 0 },
        halfLeftPanel,
      };
      return [next, [
        { type: 'apply_msg', msg: { type: 'mode_clear', flag: 'freeConfigMode' } },
        { type: 'apply_msg', msg: { type: 'mode_clear', flag: 'freeConfigTitleEditMode' } },
        { type: 'show_selected_info' },
      ]];
    }
    case 'free_config_nav':          return mfc.navSelect(slice, msg.dir);
    case 'free_config_reorder':      return mfc.clampSelected(mfc.reorderWithin(slice, msg.dir));
    case 'free_config_move_col':     return mfc.clampSelected(mfc.moveColumn(slice, msg.dir));
    case 'free_config_resize':       return mfc.resizeWidthOrDetail(slice, msg.delta);
    case 'free_config_panel_height': return mfc.resizeFocusedPanelHeight(slice, msg.delta);
    case 'free_config_undo':         return mfc.clampSelected(mfc.undo(slice));
    case 'free_config_redo':         return mfc.clampSelected(mfc.redo(slice));
    case 'free_config_title_enter':
      return [mfc.titleEnter(slice), [{ type: 'apply_msg', msg: { type: 'mode_set', flag: 'freeConfigTitleEditMode' } }]];
    case 'free_config_title_submit': {
      const text = slice.freeConfig ? slice.freeConfig.titleEdit.text : '';
      let next = mfc.setSelectedTitle(slice, text);
      if (next.freeConfig) next = { ...next, freeConfig: { ...next.freeConfig, titleEdit: { active: false, text: '' } } };
      return [next, [{ type: 'apply_msg', msg: { type: 'mode_clear', flag: 'freeConfigTitleEditMode' } }]];
    }
    case 'free_config_mouse_press':  return mfc.mousePress(slice, msg.mx, msg.my, msg.cols);
    case 'free_config_mouse_motion': {
      // Diff-painter trap: between targets, panel content is frozen but
      // the layout reshuffles in the preview render — paintColumns can't
      // tell anything changed, so force a full repaint when the target
      // shifts. Same-zone motion no-ops.
      const next = mfc.mouseMotion(slice, msg.mx, msg.my, msg.cols);
      if (next === slice) return slice;
      const ds = slice.freeConfig && slice.freeConfig.drag;
      const ns = next.freeConfig  && next.freeConfig.drag;
      const isInsertionDrag = ns && (ns.kind === 'dragging' || ns.kind === 'armed');
      if (!isInsertionDrag) return next;
      const oldT = ds && ds.target;
      const newT = ns && ns.target;
      if (_dragTargetsEqual(oldT, newT)) return next;
      // Target changed — recompute the preview arrange (what the layout
      // looks like on release). Stored on drag.previewArrange; the render
      // path swaps slice.arrange for it during paint, restoring after so
      // hit-tests stay anchored to the original layout.
      const previewArrange = mfc.computeDragPreviewArrange(next);
      const withPreview = { ...next, freeConfig: { ...next.freeConfig, drag: { ...ns, previewArrange } } };
      return [withPreview, [{ type: 'force_full_repaint' }]];
    }
    case 'free_config_mouse_release': return mfc.mouseRelease(slice);
    // Pool-drag gesture from the panel-list overlay. Source is the
    // overlay cursor's item id; drop is on a layout cell (replace) or
    // column gap (append). poolDragRelease returns the [next, cmds]
    // tuple directly so its dispatch_msg Cmds re-enter the pool_hide
    // / pool_show handlers.
    case 'pool_drag_start': {
      // poolDragStart closes the overlay so the user can see the drop
      // targets — force_full_repaint wipes the overlay's pixels.
      const next = mpoolDrag.poolDragStart(slice, msg.id, msg.mx, msg.my);
      return [next, [{ type: 'force_full_repaint' }]];
    }
    case 'pool_drag_motion': {
      // Target shifts between zones → preview repaints (panels relocate);
      // motion within one zone is a no-op. Same diff-painter rule as the
      // in-grid drag — emitting force_full_repaint every motion was
      // causing visible blinking under rapid drag.
      const next = mpoolDrag.poolDragMotion(slice, msg.mx, msg.my, msg.cols);
      if (next === slice) return slice;
      const oldT = slice.freeConfig && slice.freeConfig.drag && slice.freeConfig.drag.target;
      const newT = next.freeConfig  && next.freeConfig.drag  && next.freeConfig.drag.target;
      if (_dragTargetsEqual(oldT, newT)) return next;
      // Target changed — recompute preview arrange (same pattern as
      // free_config_mouse_motion). Stored on drag.previewArrange.
      const ns = next.freeConfig && next.freeConfig.drag;
      const previewArrange = mpoolDrag.computePoolDragPreviewArrange(next);
      const withPreview = { ...next, freeConfig: { ...next.freeConfig, drag: { ...ns, previewArrange } } };
      return [withPreview, [{ type: 'force_full_repaint' }]];
    }
    case 'pool_drag_release': return mpoolDrag.poolDragRelease(slice);
    // Tab-reorder drag — free-config mouse drag on a detail-panel content
    // tab. Live reorder: tabDragMotion emits viewer_reorder_content_tab
    // Cmds each time the cursor crosses into a new content-tab slot;
    // viewer.update permutes contentTabs[group] via the reorderContent
    // leaf. The drag itself only touches layout's slice (freeConfig.drag).
    case 'tab_drag_start': {
      const next = mtabDrag.tabDragStart(slice, msg.sourceKey, msg.fromIdx, msg.mx, msg.my);
      return [next, [{ type: 'force_full_repaint' }]];
    }
    case 'tab_drag_motion':
      return mtabDrag.tabDragMotion(slice, msg.mx, msg.my, slice.panelBounds && slice.panelBounds.detail, getModel().currentGroup);
    case 'tab_drag_release':  return mtabDrag.tabDragRelease(slice);
    case 'free_config_title_key': {
      const te = slice.freeConfig && slice.freeConfig.titleEdit;
      if (!te) return slice;
      if (msg.key === 'backspace' || msg.seq === '\x7f' || msg.seq === '\b') {
        return { ...slice, freeConfig: { ...slice.freeConfig, titleEdit: { ...te, text: te.text.slice(0, -1) } } };
      }
      if (msg.seq && msg.seq.length === 1 && msg.seq >= ' ' && msg.seq < '\x7f') {
        return { ...slice, freeConfig: { ...slice.freeConfig, titleEdit: { ...te, text: te.text + msg.seq } } };
      }
      return slice;
    }
    case 'free_config_title_cancel': {
      const next = slice.freeConfig
        ? { ...slice, freeConfig: { ...slice.freeConfig, titleEdit: { active: false, text: '' } } }
        : slice;
      return [next, [{ type: 'apply_msg', msg: { type: 'mode_clear', flag: 'freeConfigTitleEditMode' } }]];
    }
    // Wipe the session's undo/redo history. :restore-layout emits this
    // because the runtime layout the user was editing is gone — the
    // history pointed at it no longer makes sense.
    case 'free_config_clear_undo':
      return mfc.clearUndoStacks(slice);
    // Pool hide/show. The pool entry stays in the pool; only the
    // placement in leftPanels/rightPanels changes. Detail is essential
    // (the layout invariant requires exactly one) — the overlay UX
    // surfaces this as "essential" rather than offering hide.
    // pool_show refuses to create a second detail or actions panel —
    // same invariant the parser enforces at load.
    // v0.6.1 — flip a multi-tab pane's active tab. The wide intermediate
    // form means legacy Panel fields (id/type/title/config + spread
    // config keys) mirror the active tab's pool entry; switching active
    // rebuilds those from the new active's pool entry while preserving
    // placement-only fields (paneId, tabs, hotkey, column, heightPct,
    // collapsed). Idempotent no-op when the target is already active.
    // Refuses missing pane / tab not in pane.tabs / unknown pool id.
    case 'set_active_tab': {
      const arrange = slice.arrange;
      const paneId = msg.paneId;
      const tabPoolId = msg.tabPoolId;
      if (!paneId || !tabPoolId) return slice;
      const loc = mpool.findPaneLocation(arrange, p => p.paneId === paneId);
      if (!loc) return slice;
      const pane = loc.pane;
      if (!pane.tabs || !pane.tabs.some(t => t.id === tabPoolId)) return slice;
      if (pane.activeTabId === tabPoolId) return slice;
      const entry = (arrange.pool || {})[tabPoolId];
      if (!entry) return slice;
      const nextPane = {
        ...(entry.config || {}),
        id: entry.id,
        type: entry.type,
        title: entry.title,
        hotkey: pane.hotkey,
        columnIndex: pane.columnIndex,
        config: entry.config,
        paneId: pane.paneId,
        tabs: pane.tabs,
        activeTabId: tabPoolId,
      };
      if (pane.heightPct !== undefined) nextPane.heightPct = pane.heightPct;
      if (pane.collapsed === true)      nextPane.collapsed = true;
      const nextArrange = mpool.updateColumn(arrange, loc.columnIndex, panels => {
        const out = panels.slice();
        out[loc.paneIndex] = nextPane;
        return out;
      });
      const next = { ...slice, arrange: nextArrange, dirty: true };
      // Focus follow — when the switched pane was focused, retarget
      // focus to the new active tab id. Otherwise render's
      // `focus === p.type` highlight (`render/layout.js:369`) misses
      // the new type and the user's freshly-switched pane drops its
      // focus highlight. The old pane.id (= pane.activeTabId before
      // switch) is the canonical focus value most producers write;
      // pane.paneId is the alternative (pane-tabs.js producers).
      // Bouncing through focus_set keeps halfLeftPanel + lastViewerTab
      // + show_selected_info in sync (single source for focus logic).
      const wasFocused = slice.focus === pane.id || slice.focus === pane.paneId;
      if (wasFocused) {
        return [next, [{ type: 'dispatch_msg',
          msg: route.wrap('layout', { type: 'focus_set', focus: tabPoolId }) }]];
      }
      return next;
    }
    case 'pool_hide': {
      const arrange = slice.arrange;
      const id = msg.id;
      const entry = (arrange.pool || {})[id];
      if (!entry) return slice;
      if (mpool.isDetailPane(entry)) return slice;
      const loc = mpool.findPaneLocation(arrange, p => p.id === id);
      if (!loc) return slice;  // already hidden
      const N = mpool.columnCount(arrange);
      const pool = hotkeyPoolForColumn(loc.columnIndex, N);
      const nextArrange = mpool.updateColumn(arrange, loc.columnIndex, panels =>
        rekeyColumn(panels.filter((_, i) => i !== loc.paneIndex), pool));
      const next = { ...slice, arrange: nextArrange, dirty: true };
      // If the hidden panel was focused, focus is now stale (points at
      // a no-longer-placed type). clampSelected snaps it back to a
      // valid panel.
      return mfc.clampSelected(next);
    }
    // Panel-list overlay state Msgs. Open/close, cursor nav, context-
    // pick. The pick re-emits a pool_hide / pool_show Msg back into
    // the layout Component via a dispatch_msg Cmd so the existing
    // handlers do the work (single source of truth).
    //
    // Toggle paths emit `force_full_repaint` — the panel-list overlay
    // is a sub-state of the layout slice (not its own mode flag), so
    // the render layer's overlay-set fingerprint doesn't change on
    // toggle. Without the repaint, closing leaves the modal's pixels
    // on screen (residue) and opening can race with the diff-painter
    // skipping rows it thinks are unchanged.
    case 'panel_list_open': {
      const next = { ...slice, panelList: { open: true, cursor: msg.cursor || 0 } };
      return [next, [{ type: 'force_full_repaint' }]];
    }
    case 'panel_list_close': {
      const next = { ...slice, panelList: { ...slice.panelList, open: false } };
      return [next, [{ type: 'force_full_repaint' }]];
    }
    case 'panel_list_nav': {
      const items = mpool.panelListItems(slice.arrange);
      if (items.length === 0) return slice;
      const cur = slice.panelList ? slice.panelList.cursor : 0;
      const next = Math.max(0, Math.min(items.length - 1, cur + (msg.dir | 0)));
      if (next === cur) return slice;
      return { ...slice, panelList: { ...slice.panelList, cursor: next } };
    }
    case 'panel_list_pick': {
      const items = mpool.panelListItems(slice.arrange);
      const item = items[slice.panelList ? slice.panelList.cursor : 0];
      if (!item || item.status === 'essential') return slice;
      const closed = { ...slice, panelList: { ...slice.panelList, open: false } };
      const verb = item.status === 'placed' ? 'pool_hide' : 'pool_show';
      return [closed, [
        { type: 'dispatch_msg', msg: { kind: 'layout', msg: { type: verb, id: item.id } } },
        { type: 'force_full_repaint' },
      ]];
    }
    // v0.6 — collapse toggle. Flips placement.collapsed for the given
    // panel id. Works in BOTH free-config and normal mode (the widget /
    // keybinding are wired in both); detail is essential and refuses.
    case 'panel_collapse_toggle': {
      const arrange = slice.arrange;
      const id = msg.id;
      const loc = mpool.findPaneLocation(arrange, p => p.id === id);
      if (!loc) return slice;
      const p = loc.pane;
      if (mpool.isDetailPane(p)) return slice;  // essential
      const nextArrange = mpool.updateColumn(arrange, loc.columnIndex, panels => {
        const out = panels.slice();
        out[loc.paneIndex] = { ...p, collapsed: !p.collapsed };
        return out;
      });
      // Mark dirty: collapsed is a real layout field that round-trips
      // through :save-layout. The free-config unsaved-banner only
      // surfaces in that mode (footerKeys check), so normal-mode
      // toggles silently arm the dirty flag — :save-layout (a cmdline
      // command available everywhere) commits it.
      return { ...slice, arrange: nextArrange, dirty: true };
    }
    case 'pool_show': {
      const arrange = slice.arrange;
      const id = msg.id;
      const entry = (arrange.pool || {})[id];
      if (!entry) return slice;
      if (mpool.placedIdSet(arrange).has(id)) return slice;  // already placed
      // Invariant guard: refuse a second detail / actions.
      if (mpool.isDetailPane(entry)  && mpool.hasDetailPane(arrange))  return slice;
      if (mpool.isActionsPane(entry) && mpool.hasActionsPane(arrange)) return slice;
      const N = mpool.columnCount(arrange);
      const lastIdx = N - 1;
      let columnIndex = (typeof msg.columnIndex === 'number')
        ? msg.columnIndex
        : lastIdx;  // default to last column (legacy 'right')
      if (columnIndex < 0 || columnIndex >= N) return slice;
      // detail / actions live in the last column only. Pool-drag's
      // validateInsert already refuses to even propose other columns
      // for them; this is the defense-in-depth guard for any future
      // caller that emits pool_show with a non-last columnIndex directly.
      if (columnIndex !== lastIdx && mpool.isReservedPane(entry)) return slice;
      // Column caps are SOFT — exceeded at parse time emits a warning;
      // runtime placement just allows. The renderer's MIN_PANEL_H +
      // terminal-row floor is the only physical limit.
      const target = mpool.columnPanels(arrange, columnIndex);
      const placement = mpool.placementFromPoolEntry(entry, columnIndex);
      // Last column keeps `detail` as the last cell (convention shared
      // with moveColumn). When `msg.index` is supplied (pool-drag drops),
      // splice at that position — clamped to detail's slot in last column.
      // Without `index`, append at the tail (with the same detail clamp).
      const isLast = columnIndex === lastIdx;
      const detailIdx = isLast ? target.findIndex(mpool.isDetailPane) : -1;
      let idx;
      if (typeof msg.index === 'number') {
        idx = Math.max(0, Math.min(msg.index, target.length));
      } else {
        idx = target.length;
      }
      if (isLast && detailIdx >= 0 && idx > detailIdx) idx = detailIdx;
      const inserted = target.slice(0, idx).concat([placement], target.slice(idx));
      const nextArrange = mpool.updateColumn(arrange, columnIndex, () =>
        rekeyColumn(inserted, hotkeyPoolForColumn(columnIndex, N)));
      const next = { ...slice, arrange: nextArrange, dirty: true };
      // Move focus to the newly-shown panel — matches the overlay UX
      // where picking from the pool surfaces it as the active one.
      return mfc.clampSelected(next, entry.type);
    }
    default:
      return slice;
  }
}

module.exports = {
  name: 'layout',
  init,
  update,
  // Exposed for tests.
  reduceViewMode,
};
