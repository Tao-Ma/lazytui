/**
 * Core Component — layout (chrome-only, no panelTypes).
 *
 * The frame surrounding the panel grid. Owns:
 *   - arrange        — { leftWidth, leftPanels, rightPanels, detailHeightPct, pool }
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
const mdesign = require('../leaves/design');
const mpoolDrag = require('../leaves/design-pool-drag');
const mtabDrag = require('../leaves/tab-drag');
const mpool = require('../leaves/pool');
const { getModel } = require('../app/runtime');

const { LEFT_HOTKEY_POOL, RIGHT_HOTKEY_POOL } = require('../leaves/hotkeys');

/** Reassign positional hotkeys for a column after a hide/show mutation.
 *  Matches the design-mode behavior — hotkey is the panel's slot index
 *  within its column. Explicit YAML hotkeys are NOT preserved across
 *  runtime mutations (consistent with how design-mode reorder works). */
function rekeyColumn(panels, pool) {
  return panels.map((p, i) => ({ ...p, hotkey: pool[i] || '' }));
}

/** Compare two drag drop targets for visual equality. Used by both
 *  design_mouse_motion and pool_drag_motion to decide whether the cursor
 *  moved between drop zones (force_full_repaint + preview recompute
 *  needed) or just within one (no repaint).
 *
 *  Compares every field that affects the preview render — without `kind`
 *  an insert@N and a swap@N at the same column compare equal; without
 *  `index` two distinct inserts compare equal; without `occupantType`
 *  /`occupantId` distinct swap/replace targets compare equal. curX/curY
 *  are not visual; ignore them. */
function _dragTargetsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind
      && a.column === b.column
      && a.index === b.index
      && a.occupantId === b.occupantId
      && a.occupantType === b.occupantType
      && a.valid === b.valid;
}

function init() {
  return {
    // { leftPanels, rightPanels, leftWidth, detailHeightPct, pool }.
    // `pool` is the v0.6 id → entry map for placed + hidden panels;
    // pool derivations live in `js/leaves/pool`. state.js's initState
    // replaces this default with the parsed config (rebuildLayoutFromConfig).
    arrange: { leftWidth: 30, leftPanels: [], rightPanels: [], detailHeightPct: 60, pool: {} },
    // Default focus = first declared panel. state.js's initState() overrides
    // this once the parsed layout is in.
    focus: 'groups',
    viewMode: 'normal',
    dirty: false,
    // Free-config working state. `enabled` is the boot-time --design CLI
    // flag; the rest is the design-mode reducer's drag/undo/title-edit
    // state. The active panel (formerly `selectedIdx` here) is derived
    // from `slice.focus` via `mdesign.selectedIdx(slice)` — single
    // source of truth.
    design: {
      enabled: false,
      drag: null,
      undo: [],
      redo: [],
      titleEdit: { active: false, text: '' },
      // Transient hint surfaced in the footer when a free-config / view-mode
      // transition is blocked. Cleared when the user reaches a state where
      // the block no longer applies (design_exit, successful view change).
      notice: null,
    },
    // View-output (written by the render pass, read by mouse hit-tests
    // and design-mode drag math). The renderer-as-writer pattern is the
    // documented exception to single-writer — see render/layout.js header.
    panelHeights: {},
    panelBounds: {},
    // Panel-list overlay state. Opened by `w` (or auto-opened on
    // free-config entry when the pool has hidden entries). Arrow keys
    // navigate, Enter context-picks (hide if placed, show if hidden,
    // no-op on detail).
    panelList: { open: false, cursor: 0 },
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
  if (msg.type === 'design_enter' && slice.viewMode !== 'normal') {
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
  const continuousMotion = msg.type === 'design_mouse_motion' ||
                           msg.type === 'pool_drag_motion' ||
                           msg.type === 'tab_drag_motion';
  const oldNotice = slice.design && slice.design.notice;
  if (oldNotice && !continuousMotion) {
    const wouldReassert = _potentialBlockedNotice(slice, msg);
    if (wouldReassert !== oldNotice) {
      slice = { ...slice, design: { ...slice.design, notice: null } };
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
        if (slice.design && slice.design.notice === target) return slice;
        return { ...slice, design: { ...slice.design, notice: target } };
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
      return [{ ...slice, focus: next }, [{ type: 'show_selected_info' }]];
    }
    // arrange + dirty writes. :save-layout sends `{ dirty: false }`;
    // :restore-layout sends `{ arrange, dirty: false }` (the rebuilt
    // struct from `state.rebuildLayoutFromConfig`). Both are wrapped
    // Msgs dispatched into layout — single-writer.
    case 'set_arrange': {
      const next = { ...slice };
      if (msg.arrange !== undefined) next.arrange = msg.arrange;
      if (msg.dirty   !== undefined) next.dirty   = !!msg.dirty;
      return next;
    }
    // Design-mode state — pure return-new. The mdesign leaf takes this
    // Component's slice and returns a new slice; layout.update threads
    // it through, preserving single-writer-per-slice. The root chrome
    // mode flags (`freeConfigMode`, `designTitleEditMode`) ride on
    // `apply_msg` Cmds the reducer applies (`mode_set` / `mode_clear`).
    case 'design_enter': {
      // Refuse entry from half/full view — the drag/resize gestures
      // operate on the full grid and need every cell visible. Surface a
      // notice so the user knows why `q` / `:free-config` didn't fire.
      if (slice.viewMode !== 'normal') {
        const target = 'free-config requires normal view ([ to return)';
        if (slice.design && slice.design.notice === target) return slice;
        return { ...slice, design: { ...slice.design, notice: target } };
      }
      // Reset working state on entry; preserve `enabled` (the boot-time
      // --design CLI flag). v0.6: auto-open the panel-list overlay when
      // the pool has hidden entries — the discoverability hint that
      // there are more panels available than currently in the grid.
      // Preserve the current focus when it points at a placed panel
      // (mdesign.selectedIdx derives the index); fall back to the
      // first placed panel when current focus isn't in the layout
      // (hidden in the pool, or never set).
      const enabled = slice.design && slice.design.enabled;
      const hasHidden = mpool.hiddenIds(slice.arrange).length > 0;
      const all = mdesign.allDesignPanels(slice);
      const focusedIsPlaced = all.some(p => p.type === slice.focus);
      const focus = focusedIsPlaced ? slice.focus : (all[0] ? all[0].type : slice.focus);
      const next = {
        ...slice,
        focus,
        design: { enabled, drag: null, undo: [], redo: [], titleEdit: { active: false, text: '' }, notice: null },
        panelList: { open: hasHidden, cursor: 0 },
      };
      return [next, [{ type: 'apply_msg', msg: { type: 'mode_set', flag: 'freeConfigMode' } }]];
    }
    case 'design_exit': {
      const enabled = slice.design && slice.design.enabled;
      const next = {
        ...slice,
        design: { enabled, drag: null, undo: [], redo: [], titleEdit: { active: false, text: '' }, notice: null },
        panelList: { open: false, cursor: 0 },
      };
      return [next, [
        { type: 'apply_msg', msg: { type: 'mode_clear', flag: 'freeConfigMode' } },
        { type: 'apply_msg', msg: { type: 'mode_clear', flag: 'designTitleEditMode' } },
        { type: 'show_selected_info' },
      ]];
    }
    case 'design_nav':          return mdesign.navSelect(slice, msg.dir);
    case 'design_reorder':      return mdesign.clampSelected(mdesign.reorderWithin(slice, msg.dir));
    case 'design_move_col':     return mdesign.clampSelected(mdesign.moveColumn(slice, msg.col));
    case 'design_resize':       return mdesign.resizeWidthOrDetail(slice, msg.delta);
    case 'design_panel_height': return mdesign.resizeFocusedPanelHeight(slice, msg.delta);
    case 'design_undo':         return mdesign.clampSelected(mdesign.undo(slice));
    case 'design_redo':         return mdesign.clampSelected(mdesign.redo(slice));
    case 'design_title_enter':
      return [mdesign.titleEnter(slice), [{ type: 'apply_msg', msg: { type: 'mode_set', flag: 'designTitleEditMode' } }]];
    case 'design_title_submit': {
      const text = slice.design ? slice.design.titleEdit.text : '';
      let next = mdesign.setSelectedTitle(slice, text);
      if (next.design) next = { ...next, design: { ...next.design, titleEdit: { active: false, text: '' } } };
      return [next, [{ type: 'apply_msg', msg: { type: 'mode_clear', flag: 'designTitleEditMode' } }]];
    }
    case 'design_mouse_press':  return mdesign.mousePress(slice, msg.mx, msg.my, msg.cols);
    case 'design_mouse_motion': {
      // Diff-painter trap: between targets, panel content is frozen but
      // the layout reshuffles in the preview render — paintColumns can't
      // tell anything changed, so force a full repaint when the target
      // shifts. Same-zone motion no-ops.
      const next = mdesign.mouseMotion(slice, msg.mx, msg.my, msg.cols);
      if (next === slice) return slice;
      const ds = slice.design && slice.design.drag;
      const ns = next.design  && next.design.drag;
      const isInsertionDrag = ns && (ns.kind === 'dragging' || ns.kind === 'armed');
      if (!isInsertionDrag) return next;
      const oldT = ds && ds.target;
      const newT = ns && ns.target;
      if (_dragTargetsEqual(oldT, newT)) return next;
      // Target changed — recompute the preview arrange (what the layout
      // looks like on release). Stored on drag.previewArrange; the render
      // path swaps slice.arrange for it during paint, restoring after so
      // hit-tests stay anchored to the original layout.
      const previewArrange = mdesign.computeDragPreviewArrange(next);
      const withPreview = { ...next, design: { ...next.design, drag: { ...ns, previewArrange } } };
      return [withPreview, [{ type: 'force_full_repaint' }]];
    }
    case 'design_mouse_release': return mdesign.mouseRelease(slice);
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
      const next = mpoolDrag.poolDragMotion(slice, msg.mx, msg.my);
      if (next === slice) return slice;
      const oldT = slice.design && slice.design.drag && slice.design.drag.target;
      const newT = next.design  && next.design.drag  && next.design.drag.target;
      if (_dragTargetsEqual(oldT, newT)) return next;
      // Target changed — recompute preview arrange (same pattern as
      // design_mouse_motion). Stored on drag.previewArrange.
      const ns = next.design && next.design.drag;
      const previewArrange = mpoolDrag.computePoolDragPreviewArrange(next);
      const withPreview = { ...next, design: { ...next.design, drag: { ...ns, previewArrange } } };
      return [withPreview, [{ type: 'force_full_repaint' }]];
    }
    case 'pool_drag_release': return mpoolDrag.poolDragRelease(slice);
    // Tab-reorder drag — free-config mouse drag on a detail-panel content
    // tab. Live reorder: tabDragMotion emits viewer_reorder_content_tab
    // Cmds each time the cursor crosses into a new content-tab slot;
    // viewer.update permutes contentTabs[group] via the reorderContent
    // leaf. The drag itself only touches layout's slice (design.drag).
    case 'tab_drag_start': {
      const next = mtabDrag.tabDragStart(slice, msg.sourceKey, msg.fromIdx, msg.mx, msg.my);
      return [next, [{ type: 'force_full_repaint' }]];
    }
    case 'tab_drag_motion':
      return mtabDrag.tabDragMotion(slice, msg.mx, msg.my, slice.panelBounds && slice.panelBounds.detail, getModel().currentGroup);
    case 'tab_drag_release':  return mtabDrag.tabDragRelease(slice);
    case 'design_title_key': {
      const te = slice.design && slice.design.titleEdit;
      if (!te) return slice;
      if (msg.key === 'backspace' || msg.seq === '\x7f' || msg.seq === '\b') {
        return { ...slice, design: { ...slice.design, titleEdit: { ...te, text: te.text.slice(0, -1) } } };
      }
      if (msg.seq && msg.seq.length === 1 && msg.seq >= ' ' && msg.seq < '\x7f') {
        return { ...slice, design: { ...slice.design, titleEdit: { ...te, text: te.text + msg.seq } } };
      }
      return slice;
    }
    case 'design_title_cancel': {
      const next = slice.design
        ? { ...slice, design: { ...slice.design, titleEdit: { active: false, text: '' } } }
        : slice;
      return [next, [{ type: 'apply_msg', msg: { type: 'mode_clear', flag: 'designTitleEditMode' } }]];
    }
    // Wipe the session's undo/redo history. :restore-layout emits this
    // because the runtime layout the user was editing is gone — the
    // history pointed at it no longer makes sense.
    case 'design_clear_undo':
      return mdesign.clearUndoStacks(slice);
    // Pool hide/show. The pool entry stays in the pool; only the
    // placement in leftPanels/rightPanels changes. Detail is essential
    // (the layout invariant requires exactly one) — the overlay UX
    // surfaces this as "essential" rather than offering hide.
    // pool_show refuses to create a second detail or actions panel —
    // same invariant the parser enforces at load.
    case 'pool_hide': {
      const arrange = slice.arrange;
      const id = msg.id;
      const entry = (arrange.pool || {})[id];
      if (!entry) return slice;
      if (entry.type === 'detail') return slice;
      const leftIdx  = arrange.leftPanels.findIndex(p => p.id === id);
      const rightIdx = arrange.rightPanels.findIndex(p => p.id === id);
      let nextLeft  = arrange.leftPanels;
      let nextRight = arrange.rightPanels;
      if (leftIdx >= 0) {
        nextLeft = rekeyColumn(arrange.leftPanels.filter((_, i) => i !== leftIdx), LEFT_HOTKEY_POOL);
      } else if (rightIdx >= 0) {
        nextRight = rekeyColumn(arrange.rightPanels.filter((_, i) => i !== rightIdx), RIGHT_HOTKEY_POOL);
      } else {
        return slice;  // already hidden
      }
      const next = { ...slice, arrange: { ...arrange, leftPanels: nextLeft, rightPanels: nextRight }, dirty: true };
      // If the hidden panel was focused, focus is now stale (points at
      // a no-longer-placed type). clampSelected snaps it back to a
      // valid panel.
      return mdesign.clampSelected(next);
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
      const leftIdx  = arrange.leftPanels.findIndex(p => p.id === id);
      const rightIdx = arrange.rightPanels.findIndex(p => p.id === id);
      let col = null, idx = -1;
      if (leftIdx >= 0)       { col = 'left';  idx = leftIdx;  }
      else if (rightIdx >= 0) { col = 'right'; idx = rightIdx; }
      else return slice;
      const arr = col === 'left' ? arrange.leftPanels : arrange.rightPanels;
      const p = arr[idx];
      if (p.type === 'detail') return slice;  // essential
      const next = { ...p, collapsed: !p.collapsed };
      const nextArr = arr.slice(); nextArr[idx] = next;
      const nextArrange = col === 'left'
        ? { ...arrange, leftPanels:  nextArr }
        : { ...arrange, rightPanels: nextArr };
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
      const all = arrange.leftPanels.concat(arrange.rightPanels);
      if (entry.type === 'detail'  && all.some(p => p.type === 'detail'))  return slice;
      if (entry.type === 'actions' && all.some(p => p.type === 'actions')) return slice;
      const column = msg.column === 'left' ? 'left' : 'right';
      // Column cap: 6 left, 3 right (matches parser/schema constraints).
      const cap = column === 'left' ? 6 : 3;
      const target = column === 'left' ? arrange.leftPanels : arrange.rightPanels;
      if (target.length >= cap) return slice;
      const placement = mpool.placementFromPoolEntry(entry, column);
      // Right column keeps `detail` as the last cell (convention shared
      // with moveColumn). When `msg.index` is supplied (pool-drag drops),
      // splice at that position — clamped to detail's slot in right column.
      // Without `index`, append at the tail (with the same detail clamp).
      let inserted;
      const detailIdx = column === 'right' ? target.findIndex(p => p.type === 'detail') : -1;
      let idx;
      if (typeof msg.index === 'number') {
        idx = Math.max(0, Math.min(msg.index, target.length));
      } else {
        idx = target.length;
      }
      if (column === 'right' && detailIdx >= 0 && idx > detailIdx) idx = detailIdx;
      inserted = target.slice(0, idx).concat([placement], target.slice(idx));
      const nextCol = rekeyColumn(inserted, column === 'left' ? LEFT_HOTKEY_POOL : RIGHT_HOTKEY_POOL);
      const nextArrange = column === 'left'
        ? { ...arrange, leftPanels:  nextCol }
        : { ...arrange, rightPanels: nextCol };
      const next = { ...slice, arrange: nextArrange, dirty: true };
      // Move focus to the newly-shown panel — matches the overlay UX
      // where picking from the pool surfaces it as the active one.
      return mdesign.clampSelected(next, entry.type);
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
