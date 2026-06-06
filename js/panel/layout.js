/**
 * Core Component — layout (chrome-only, no panelTypes).
 *
 * The frame surrounding the panel grid. Owns:
 *   - arrange        — { columns: [{width?, panels}], detailHeightPct, pool }
 *   - focus          — currently focused panel type
 *   - viewMode       — normal / half / full
 *   - dirty          — layout has unsaved changes (drives `:save-layout` hint)
 *   - freeConfig     — free-config working state (drag, undo/redo, titleEdit)
 *   - panelBounds — view-output, written by the render pass
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
const mpane = require('../leaves/pane');
const route = require('../leaves/route');
const { getModel } = require('../app/runtime');


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
/** Push the current arrange onto the undo stack (unless the Msg is a
 *  no-undo follow-up like the second hop of a pool-drag replace) and
 *  swap in the new arrange with dirty:true. Single helper for the
 *  pattern repeated across every arrange-mutating arm (pool_hide,
 *  pool_show, pool_show_new_column, add_column, remove_column,
 *  panel_collapse_toggle, set_active_tab) — keeps the snapshot timing
 *  and the dirty-flag write in lockstep. */
function _commitArrange(slice, nextArrange, opts) {
  const skipUndo = opts && opts.skipUndo;
  const withUndo = skipUndo ? slice : mfc.pushUndo(slice);
  return { ...withUndo, arrange: nextArrange, dirty: true };
}

/** Apply the focus-side fields of the `focus_set` Msg inline — focus,
 *  halfLeftPanel (sticky non-detail), lastViewerTab (sticky viewer-kind).
 *  Callers that ALSO want the standard `show_selected_info` Cmd emit it
 *  alongside. Exists so reducer arms that already produce a layout-
 *  mutating slice + a status notice can fold focus into the same return
 *  value, rather than emit `dispatch_msg(focus_set)` whose re-entry
 *  would trip the notice-auto-clear preface and wipe the status.
 *
 *  Considered inlining (R4 review's R4.11) — rejected: 7 callers all
 *  in this file would each grow to 3 lines of identical sticky-pointer
 *  logic, net +17 lines vs the 5-line helper. The helper carries real
 *  derivation (not just a spread); it stays. */
function _withFocus(slice, focus) {
  if (focus == null) return slice;
  const halfLeftPanel = route.instanceKind(focus) !== 'detail' ? focus : slice.halfLeftPanel;
  const lastViewerTab = route.isViewerKind(focus) ? focus : slice.lastViewerTab;
  return { ...slice, focus, halfLeftPanel, lastViewerTab };
}

function _dragTargetsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind
      && a.columnIndex === b.columnIndex
      && a.index === b.index
      && a.position === b.position
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
      titleEdit: { text: '' },
      // Transient hint surfaced in the footer when a free-config /
      // view-mode transition is blocked. Cleared when the user reaches
      // a state where the block no longer applies (free_config_exit,
      // successful view change).
      notice: null,
      // Paired with `notice`: 'error' (red, refusal) or 'info' (green,
      // success status). Seeded null alongside notice so the slice
      // shape is explicit at boot — the renderer fell back to 'error'
      // when the field was missing, masking the gap.
      noticeKind: null,
    },
    // View-output (written by the render pass, read by mouse hit-tests
    // and free-config drag math). The renderer-as-writer pattern is the
    // documented exception to single-writer — see render/layout.js header.
    // (Per-panel heights live in a module-local map inside
    // `render/layout.js`, NOT on the slice — see `getPanelViewportH`
    // for the public view-mode-aware accessor.)
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

function update(msg, slice) {
  // Notice auto-clear. Refusal arms (view_expand/shrink in free-config,
  // free_config_enter from a non-normal view) own their notice text +
  // identity short-circuit; for that short-circuit to keep working on
  // repeated refusals, the preface must NOT clear notice on a Msg the
  // refusal arm will re-assert. Continuous-motion Msgs preserve so
  // mid-drag cursor drift doesn't disturb the hint. Everything else
  // clears — user has moved on. The `freeConfigMode` cross-read tells
  // us whether view_expand/shrink will refuse this time (otherwise
  // it'd fall through and the stale notice would linger).
  const t = msg.type;
  const willReassert =
    ((t === 'view_expand' || t === 'view_shrink') && getModel().modes.freeConfigMode) ||
    (t === 'free_config_enter' && slice.viewMode !== 'normal');
  const motion = t === 'free_config_mouse_motion' || t === 'pool_drag_motion' || t === 'tab_drag_motion';
  if (slice.freeConfig && slice.freeConfig.notice && !motion && !willReassert) {
    slice = { ...slice, freeConfig: { ...slice.freeConfig, notice: null } };
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
        return { ...slice, freeConfig: { ...slice.freeConfig, notice: target, noticeKind: 'error' } };
      }
      const next = reduceViewMode(slice.viewMode, msg);
      if (next === slice.viewMode) return slice;
      return [{ ...slice, viewMode: next }, [{ type: 'force_full_repaint' }]];
    }
    // focus. Stores the focused panel; refresh of the detail body for
    // the newly-focused panel is an effect (Cmd). msg.focus == null
    // leaves the value put.
    case 'focus_set': {
      // _withFocus stamps focus + sticky halfLeftPanel + sticky
      // lastViewerTab. show_selected_info follows the focus change.
      const next = msg.focus != null ? msg.focus : slice.focus;
      return [_withFocus(slice, next), [{ type: 'show_selected_info' }]];
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
      if (msg.arrange !== undefined) {
        // Reject malformed arrange (missing `columns` array) — accepting
        // it would replace a valid layout with a corrupt one and crash
        // the next render. `:restore-layout` always passes a rebuilt
        // valid arrange; direct programmatic dispatches that don't are
        // a bug and should no-op rather than break the live layout.
        if (!msg.arrange || !Array.isArray(msg.arrange.columns)) return slice;
        next.arrange = msg.arrange;
        // An arrange swap orphans every cross-arrange pointer on the
        // slice. Clear them so :restore-layout / set_arrange leaves a
        // self-consistent slice:
        //   - drag: sourceType / target.columnIndex may name panes
        //     and columns that no longer exist.
        //   - panelList.open + cursor: overlay geometry (computed
        //     from arrange) is stale; close defensively.
        //   - tabListOwnerPaneId: paneId may no longer be placed.
        //   - focus: may name a type that's no longer placed; clamp
        //     to the first placed pane in the new arrange.
        //   - halfLeftPanel / lastViewerTab: same staleness as focus;
        //     re-derive lazily on the next focus_set rather than
        //     trying to clamp here.
        if (next.freeConfig && next.freeConfig.drag) {
          next.freeConfig = { ...next.freeConfig, drag: null };
        }
        if (next.panelList && next.panelList.open) {
          next.panelList = { open: false, cursor: 0 };
        }
        if (next.tabListOwnerPaneId) next.tabListOwnerPaneId = null;
        const allPanes = mpool.allPanesInColumns(next.arrange);
        const focusStillPlaced = allPanes.some(p => p.type === next.focus);
        if (!focusStillPlaced && allPanes.length > 0) {
          next.focus = allPanes[0].type;
        }
      }
      if (msg.dirty   !== undefined) next.dirty   = !!msg.dirty;
      return next;
    }
    // Free-config state — pure return-new. The mfc leaf takes this
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
        return { ...slice, freeConfig: { ...slice.freeConfig, notice: target, noticeKind: 'error' } };
      }
      // Reset working state on entry. Auto-open the panel-list overlay
      // when the pool has hidden entries — the discoverability hint
      // that there are more panels available than currently in the grid.
      // Preserve the current focus when it points at a placed panel
      // (mfc.selectedIdx derives the index); fall back to the first
      // placed panel when current focus isn't in the layout (hidden in
      // the pool, or never set).
      const hasHidden = mpool.hiddenIds(slice.arrange).length > 0;
      const all = mpool.allPanesInColumns(slice.arrange);
      const focusedIsPlaced = all.some(p => p.type === slice.focus);
      const focus = focusedIsPlaced ? slice.focus : (all[0] ? all[0].type : slice.focus);
      const wasOpen = slice.panelList && slice.panelList.open;
      const next = {
        ...slice,
        focus,
        freeConfig: { drag: null, undo: [], redo: [], titleEdit: { text: '' }, notice: null, noticeKind: null },
        panelList: { open: hasHidden, cursor: 0 },
      };
      // Auto-opening the panel-list overlay needs force_full_repaint
      // — the overlay's slice-subfield fingerprint doesn't change in a
      // way the diff painter sees, same reasoning as `panel_list_open`.
      // Only emit on the actual false→true transition (R4.14 — matches
      // panel_list_open's `wasOpen` check; was conditioned on hasHidden
      // alone before, which over-emitted on re-entries that didn't
      // change overlay state).
      const cmds = [{ type: 'msg', msg: { type: 'mode_set', flag: 'freeConfigMode' } }];
      if (hasHidden && !wasOpen) cmds.push({ type: 'force_full_repaint' });
      return [next, cmds];
    }
    case 'free_config_exit': {
      // Free-config nav (free_config_nav / free_config_reorder /
      // free_config_move / mousePress) writes `focus` directly via the
      // mfc leaf, NOT through `focus_set`, so halfLeftPanel and
      // lastViewerTab didn't track in-mode movement. Commit both on
      // exit so the focus_set-sticky fields reflect where the user
      // landed — same triple-update _withFocus does for any other
      // focus change.
      const next = {
        ..._withFocus(slice, slice.focus),
        freeConfig: { drag: null, undo: [], redo: [], titleEdit: { text: '' }, notice: null, noticeKind: null },
        panelList: { open: false, cursor: 0 },
      };
      return [next, [
        { type: 'msg', msg: { type: 'mode_clear', flag: 'freeConfigMode' } },
        { type: 'msg', msg: { type: 'mode_clear', flag: 'freeConfigTitleEditMode' } },
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
    case 'free_config_title_enter': {
      // titleEnter no-ops (returns the same slice ref) when no panel
      // is selected (`selectedIdx === -1`, e.g. focus is stale or the
      // grid is empty). Don't flip the chain-mode flag in that case —
      // it would route subsequent keystrokes into the title-edit
      // handler while the overlay paints nothing, leaving the user
      // stuck with no visible UI until they hit Esc.
      const next = mfc.titleEnter(slice);
      if (next === slice) return slice;
      return [next, [{ type: 'msg', msg: { type: 'mode_set', flag: 'freeConfigTitleEditMode' } }]];
    }
    case 'free_config_title_submit': {
      const text = slice.freeConfig ? slice.freeConfig.titleEdit.text : '';
      let next = mfc.setSelectedTitle(slice, text);
      // Close the title-edit sub-state only when it was actually open
      // — submitting from an inactive title edit (no panel was
      // selected at title_enter; the R1.4 short-circuit prevented the
      // mode flag from flipping but the buffer reset can still race
      // here) should preserve slice identity. setSelectedTitle already
      // identity-preserves on no-op text.
      // Title-edit "is currently open" is tracked by the root mode flag
      // (`modes.freeConfigTitleEditMode`) — not duplicated on the slice
      // (AR1). When R1.4's title_enter no-op left the flag clear (no
      // panel selected), skip the buffer reset so slice identity is
      // preserved.
      if (getModel().modes.freeConfigTitleEditMode) {
        next = { ...next, freeConfig: { ...next.freeConfig, titleEdit: { text: '' } } };
      }
      return [next, [{ type: 'msg', msg: { type: 'mode_clear', flag: 'freeConfigTitleEditMode' } }]];
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
    case 'free_config_mouse_release': {
      // Capture the would-be commit BEFORE mouseRelease clears the drag
      // state so the post-release status notice can name the position.
      const ds = slice.freeConfig && slice.freeConfig.drag;
      const wasNewColumnDrop = ds && ds.kind === 'dragging' && ds.target
                            && ds.target.kind === 'new_column' && ds.target.valid;
      const pos = wasNewColumnDrop ? ds.target.position : null;
      const next = mfc.mouseRelease(slice);
      if (pos !== null) return { ...next, freeConfig: { ...next.freeConfig, notice: `added new column at position ${pos + 1}`, noticeKind: 'info' } };
      return next;
    }
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
    case 'tab_drag_motion': {
      // Resolve the viewer instance id for the reorder dispatch. Today
      // viewer is singleton (`route.resolveTarget('viewer')` returns
      // 'detail'); v0.7 multi-viewer flips this to a per-pane id
      // without the leaf needing a route import.
      const targetKind = route.resolveTarget('viewer') || route.VIEWER_KIND;
      return mtabDrag.tabDragMotion(
        slice, msg.mx, msg.my,
        require('../render/layout').boundsFor('detail'),
        getModel().currentGroup,
        targetKind,
      );
    }
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
        ? { ...slice, freeConfig: { ...slice.freeConfig, titleEdit: { text: '' } } }
        : slice;
      return [next, [{ type: 'msg', msg: { type: 'mode_clear', flag: 'freeConfigTitleEditMode' } }]];
    }
    // Wipe the session's undo/redo history. :restore-layout emits this
    // because the runtime layout the user was editing is gone — the
    // history pointed at it no longer makes sense.
    case 'free_config_clear_undo':
      return mfc.clearUndoStacks(slice);
    // Pool hide/show. The pool entry stays in the pool; only the
    // placement in arrange.columns[].panels changes. Detail is essential
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
      // mpane.setActiveTab knows the wide-pane shape (legacy Panel
      // fields + Pane fields + placement-only fields); the Component
      // arm just splices the rebuilt pane back into the column.
      // Push undo before mutating — tab switches change `activeTabId`
      // which round-trips through :save-layout, so `:switch-tab` from
      // the cmdline should be revertable via `u` in free-config.
      const nextPane = mpane.setActiveTab(pane, tabPoolId, entry);
      const nextArrange = mpool.updateColumn(arrange, loc.columnIndex, panels => {
        const out = panels.slice();
        out[loc.paneIndex] = nextPane;
        return out;
      });
      const next = _commitArrange(slice, nextArrange);
      // Focus follow — when the switched pane was focused, retarget
      // focus to the new active tab id. Otherwise render's
      // `focus === p.type` highlight misses the new type and the
      // user's freshly-switched pane drops its focus highlight.
      // The old pane.id (= pane.activeTabId before switch) is the
      // canonical focus value most producers write; pane.paneId is
      // the alternative (pane-tabs.js producers). _withFocus stamps
      // focus + halfLeftPanel + lastViewerTab; emit show_selected_info
      // directly — sibling arms (pool_show, remove_column) do the same.
      const wasFocused = slice.focus === pane.id || slice.focus === pane.paneId;
      if (wasFocused) {
        return [_withFocus(next, tabPoolId), [{ type: 'show_selected_info' }]];
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
      // Strip the pane, then reassign hotkeys across all columns via
      // the leaf's `_reassignHotkeys` — same path used by drag/reorder
      // / new-column-spawn / addColumn / removeColumn. Inline rekey
      // here used to lose actions's '0' / detail's 'o' anchors when
      // the hidden pane shared a column with them.
      const stripped = mpool.updateColumn(arrange, loc.columnIndex, panels =>
        panels.filter((_, i) => i !== loc.paneIndex));
      const nextArrange = mfc.reassignHotkeys(stripped);
      const next = _commitArrange(slice, nextArrange);
      // If the hidden panel was focused, focus is now stale (points at
      // a no-longer-placed type). clampSelected snaps it back to a
      // valid panel. When the snap actually moves focus, route through
      // _withFocus so halfLeftPanel + lastViewerTab + show_selected_info
      // stay in lockstep with the focus_set semantics.
      const clamped = mfc.clampSelected(next);
      if (clamped.focus !== slice.focus) {
        return [_withFocus(clamped, clamped.focus), [{ type: 'show_selected_info' }]];
      }
      return clamped;
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
      // Refuse mid-drag: opening the overlay over an in-flight drag
      // hides the preview and the drag-source feedback, leaving the
      // user with a stuck drag they can't see. The user releases the
      // mouse first, THEN opens `w`.
      if (slice.freeConfig && slice.freeConfig.drag) return slice;
      const wasOpen = slice.panelList && slice.panelList.open;
      const next = { ...slice, panelList: { open: true, cursor: msg.cursor || 0 } };
      // Only force_full_repaint on actual open transition. A cursor-only
      // update (overlay already open) doesn't need the repaint — the
      // overlay's own diff cache handles cursor moves. Saves one of
      // the two repaints on the input.js overlay-row click path that
      // dispatches panel_list_open(new cursor) → pool_drag_start.
      const cmds = wasOpen ? [] : [{ type: 'force_full_repaint' }];
      return [next, cmds];
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
      // Close the overlay and re-dispatch the canonical pool_hide /
      // pool_show Msg — those arms handle undo push, hotkey rekey,
      // focus clamp, and show_selected_info on focus moves.
      // Considered inlining (R4 review's R4.13) — rejected: would
      // duplicate ~30 lines of pool_hide/pool_show body for one extra
      // Cmd hop saved. Re-dispatch wins.
      const items = mpool.panelListItems(slice.arrange);
      const item = items[slice.panelList ? slice.panelList.cursor : 0];
      if (!item || item.status === 'essential') return slice;
      const closed = { ...slice, panelList: { ...slice.panelList, open: false } };
      const verb = item.status === 'placed' ? 'pool_hide' : 'pool_show';
      return [closed, [
        { type: 'msg', msg: { kind: 'layout', msg: { type: verb, id: item.id } } },
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
      // Push undo before mutating — `c` / `[_]` / `[+]` collapse toggles
      // are real layout changes and should be revertable via `u` in
      // free-config, consistent with pool_hide / pool_show / add_column
      // / remove_column / pool_show_new_column (all of which push undo).
      // dirty marks the change for the cmdline-driven :save-layout
      // (free-config's unsaved-banner mirrors `slice.dirty`).
      const nextArrange = mpool.updateColumn(arrange, loc.columnIndex, panels => {
        const out = panels.slice();
        out[loc.paneIndex] = { ...p, collapsed: !p.collapsed };
        return out;
      });
      return _commitArrange(slice, nextArrange);
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
      // Reject non-integer columnIndex — `arrange.columns[1.5]` returns
      // undefined and crashes downstream. Same hardening as the cmdline
      // `:add-column` Number.isInteger check.
      if (!Number.isInteger(columnIndex)) return slice;
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
      // Compound ops (e.g., pool_drag replace = pool_hide + pool_show)
      // set `_skipUndo: true` on the second hop so only the first
      // pushes — otherwise one user gesture bloats the undo stack by 2
      // and `u` lands on a half-state.
      // _skipUndo carried by compound ops (pool_drag replace) so only
      // the first hop pushes — see R2.1.
      const spliced = mpool.updateColumn(slice.arrange, columnIndex, () => inserted);
      const nextArrange = mfc.reassignHotkeys(spliced);
      const next = _commitArrange(slice, nextArrange, { skipUndo: msg._skipUndo });
      // Move focus to the newly-shown panel — matches the overlay UX
      // where picking from the pool surfaces it as the active one.
      // _withFocus stamps focus + halfLeftPanel + lastViewerTab; the
      // emitted show_selected_info Cmd refreshes the detail body.
      const focused = _withFocus(next, entry.type);
      if (focused.focus !== slice.focus) {
        return [focused, [{ type: 'show_selected_info' }]];
      }
      return focused;
    }
    // v0.6.2 Phase 2 — pool drag dropping at a screen edge / column
    // gap spawns a NEW column at `position`. The pool entry becomes
    // the new column's only pane. Detail/actions sources are refused
    // by the validator (defense-in-depth: they're rejected again
    // here).
    case 'pool_show_new_column': {
      const arrange = slice.arrange;
      const id = msg.id;
      const entry = (arrange.pool || {})[id];
      if (!entry) return slice;
      if (mpool.placedIdSet(arrange).has(id)) return slice;  // already placed
      if (mpool.isReservedPane(entry)) return slice;
      const N = mpool.columnCount(arrange);
      const position = msg.position;
      if (typeof position !== 'number' || position < 0 || position > N) return slice;
      // Right-edge spawn (position == N) is refused — it'd push the
      // detail-bearing last column off "last". Same rule the validator
      // enforces at hit-test time; defense-in-depth here.
      if (position === N) return slice;
      const placement = mpool.placementFromPoolEntry(entry, position);
      // Reuse the leaf's pure transform so live preview + commit match.
      const spawned = mpoolDrag.spawnNewColumnArrange(arrange, position, placement);
      // Reassign hotkeys + stamp columnIndex across all columns —
      // splicing in shifts columns at index >= position by +1, so
      // every pane's columnIndex needs to be re-stamped.
      const nextArrange = mfc.reassignHotkeys(spawned);
      // Apply focus inline (halfLeftPanel + lastViewerTab + focus
      // stamped together via _withFocus) instead of re-dispatching
      // focus_set as a follow-up Cmd. The re-entry would trip the
      // notice-auto-clear preface at the top of update() and wipe
      // the status notice before the user saw it.
      const focused = _withFocus(_commitArrange(slice, nextArrange), entry.type);
      const spawnedSlice = { ...focused, freeConfig: { ...focused.freeConfig, notice: `added new column at position ${position + 1}`, noticeKind: 'info' } };
      return [spawnedSlice, [{ type: 'show_selected_info' }]];
    }
    // v0.6.2 Phase 3 — cmdline + programmatic column management.
    // add_column inserts an empty column at `position` (0..N-1);
    // remove_column deletes the empty column at `columnIndex`. Both
    // route through pure leaf helpers (mfc.addColumn / mfc.removeColumn)
    // that return `{ slice, error }`; the reducer threads the error
    // into freeConfig.notice (red) on refusal or a green status notice
    // on success.
    //
    // Msg-field naming convention across the column / pane Msgs:
    //   `position`     — slot BETWEEN columns to insert at (0..N). Used by
    //                    `add_column`, `pool_show_new_column`.
    //   `columnIndex`  — which existing column (0..N-1). Used by
    //                    `remove_column`, `pool_show`, drag targets.
    //   `index`        — slot WITHIN a column's panels array (0..len). Used
    //                    by `pool_show`, drag insert targets.
    case 'add_column': {
      const { slice: mutated, error } = mfc.addColumn(slice, msg.position);
      if (error) return { ...slice, freeConfig: { ...slice.freeConfig, notice: error, noticeKind: 'error' } };
      // Push undo on success so `u` can revert a cmdline-driven column
      // add (drag-driven changes already push via mouseRelease).
      const next = _commitArrange(slice, mutated.arrange);
      return { ...next, freeConfig: { ...next.freeConfig, notice: `added empty column at position ${msg.position + 1}`, noticeKind: 'info' } };
    }
    case 'remove_column': {
      const { slice: mutated, error } = mfc.removeColumn(slice, msg.columnIndex);
      if (error) return { ...slice, freeConfig: { ...slice.freeConfig, notice: error, noticeKind: 'error' } };
      const next = _commitArrange(slice, mutated.arrange);
      // Clamp focus to a still-placed panel; if focus moved, route the
      // change through _withFocus + show_selected_info (same lockstep
      // contract as pool_hide / pool_show / focus_set).
      const clamped = mfc.clampSelected(next);
      const status = { ...clamped, freeConfig: { ...clamped.freeConfig, notice: `removed column ${msg.columnIndex + 1}`, noticeKind: 'info' } };
      if (clamped.focus !== slice.focus) {
        return [_withFocus(status, clamped.focus), [{ type: 'show_selected_info' }]];
      }
      return status;
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
