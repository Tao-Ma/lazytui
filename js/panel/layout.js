/**
 * Core Component — layout (chrome-only, no panelTypes).
 *
 * The frame surrounding the panel grid. Owns arrangement, focus, view
 * mode, design state, and view-pass geometry — concerns that today live
 * scattered across root-model fields and a few render-only modules.
 * Spec: docs/v0.5-layout-component.md.
 *
 * **Phase 1a (this commit): inert skeleton.** The Component is
 * registered with an initial slice shape, but every concern is still
 * authored at the root model. Subsequent sub-phases migrate concerns
 * one-by-one into this slice, retiring the root-model fields as they
 * move:
 *
 *   - 1b → viewMode
 *   - 1c → focus
 *   - 1d → layoutDirty       → slice.dirty
 *   - 1e → panelHeights / panelBounds (view-output, written during render)
 *   - 1f → modal.design + designEnabled → slice.design{ ..., enabled }
 *   - 1g → model.layout (arrange struct) → slice.arrange
 *
 * **Until Phase 3, `getModel().layout` is the legacy arrange struct, and
 * the layout Component's slice lives at `getComponentSlice('layout')`.**
 * The names overlap but the access paths are distinct. Phase 3 nests panel
 * slices under `slice.panels`; the final `getModel().layout` shape (root-
 * exposed slice) lands at that point.
 *
 * Chrome-only Component: no `panelTypes`, no panel rendered in the grid.
 * Updates that would mutate frame state arrive as wrapped Msgs (Phase 2
 * onward) or as flat Msgs during the back-compat window.
 */
'use strict';

// Pure design-mode layout transforms — take this Component's slice and
// return a new slice (the leaf converted to return-new in the pure-TEA
// arc on this branch; not to be confused with the layout-Component
// arc's own "Phase 1e" which moved panelBounds/Heights into the slice).
// No in-place writes, no panel/api reach-around. Called from this
// Component's update, preserving single-writer-per-slice.
const mdesign = require('../leaves/design');
const mpool = require('../leaves/pool');

// Hotkey pools — match parser/index.js LEFT/RIGHT_HOTKEY_POOL.
const LEFT_HOTKEY_POOL  = ['1', '2', '3', '4', '5', '6'];
const RIGHT_HOTKEY_POOL = ['7', '8', '9'];

/** Reassign positional hotkeys for a column after a hide/show mutation.
 *  Matches the design-mode behavior — hotkey is the panel's slot index
 *  within its column. Explicit YAML hotkeys are NOT preserved across
 *  runtime mutations (consistent with how design-mode reorder works). */
function rekeyColumn(panels, pool) {
  return panels.map((p, i) => ({ ...p, hotkey: pool[i] || '' }));
}

/** Compare two pool-drag drop targets for visual equality. Used by
 *  pool_drag_motion to decide whether the cursor moved between drop
 *  zones (force_full_repaint needed) or just within one (no repaint).
 *  curX/curY are not visual; ignore them. */
function _dropTargetsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.kind === b.kind
      && a.column === b.column
      && a.occupantId === b.occupantId
      && a.valid === b.valid;
}

/** Compare two in-grid drag drop targets for visual equality. Same
 *  pattern as `_dropTargetsEqual` but for the {column, index, valid}
 *  shape returned by `pointToDropTarget`. The insertion-line overlay's
 *  visible position is a pure function of (column, index, valid); a
 *  curX/curY change inside the same seam zone is invisible. */
function _insertionTargetsEqual(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.column === b.column
      && a.index === b.index
      && a.valid === b.valid;
}

/** Build a runtime placement object from a pool entry. Mirrors the
 *  flattening that `state.rebuildLayoutFromConfig` does on initial load
 *  — plugin-specific config spread first, framework fields override. */
function placementFromPoolEntry(entry, column) {
  return {
    ...(entry.config || {}),
    id: entry.id,
    type: entry.type,
    title: entry.title,
    hotkey: '',
    column,
  };
}

function init() {
  return {
    // 1g: { leftPanels, rightPanels, leftWidth, detailHeightPct }.
    // v0.6 Phase 1 adds `pool` (id → entry for placed + hidden panels);
    // pool derivations live in `js/leaves/pool`. Default matches
    // runtime.init pre-1g; state.js's initState replaces it with the
    // parsed config (rebuildLayoutFromConfig).
    arrange: { leftWidth: 30, leftPanels: [], rightPanels: [], detailHeightPct: 60, pool: {} },
    // 1c: focus defaults to 'groups' (the historical initial focus set by
    // runtime.init pre-1c). state.js's initState() overrides this once the
    // panel arrangement is known.
    focus: 'groups',
    // 1b
    viewMode: 'normal',
    // 1d
    dirty: false,
    // 1f: design-mode state. `enabled` is the boot-time --design flag;
    // the rest is the design-mode reducer's working state.
    design: {
      enabled: false,
      selectedIdx: 0,
      drag: null,
      undo: [],
      redo: [],
      titleEdit: { active: false, text: '' },
    },
    // 1e (view-output; written by the render pass, read by mouse hit-tests
    // and design-mode drag math)
    panelHeights: {},
    panelBounds: {},
    // v0.6 Phase 4 — panel-list overlay state. Nested inside free-config
    // mode: opened by `w` (or auto-opened on free-config entry when the
    // pool has hidden entries), arrow keys navigate, Enter context-
    // picks (hide if placed, show if hidden, no-op on detail).
    panelList: { open: false, cursor: 0 },
    // Phase 3 — nested panel slices land here. Empty for now.
    panels: {},
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
  switch (msg.type) {
    // viewMode (Phase 1b). Each transition that actually changes the
    // value asks the effects layer for a full repaint — a view change
    // re-exposes panels the diff cache can't tell changed.
    case 'view_expand':
    case 'view_shrink':
    case 'view_set':
    case 'view_drop_full_to_normal': {
      const next = reduceViewMode(slice.viewMode, msg);
      if (next === slice.viewMode) return slice;
      return [{ ...slice, viewMode: next }, [{ type: 'force_full_repaint' }]];
    }
    // focus (Phase 1c). Stores the focused panel; refresh of the detail
    // body for the newly-focused panel is an effect (Cmd). msg.focus ==
    // null leaves the value put (matches the pre-migration semantics).
    case 'focus_set': {
      const next = msg.focus != null ? msg.focus : slice.focus;
      return [{ ...slice, focus: next }, [{ type: 'show_selected_info' }]];
    }
    // arrange + dirty writes (post-Phase-6 follow-up). :save-layout sends
    // `{ dirty: false }`; :restore-layout sends `{ arrange, dirty: false }`
    // (the rebuilt struct from `state.rebuildLayoutFromConfig`). Both are
    // wrapped Msgs dispatched into layout — the layout Component is the
    // single writer of its own slice.
    case 'set_arrange': {
      const next = { ...slice };
      if (msg.arrange !== undefined) next.arrange = msg.arrange;
      if (msg.dirty   !== undefined) next.dirty   = !!msg.dirty;
      return next;
    }
    // design-mode state (Phase 1e — pure return-new). The mdesign leaf
    // takes this Component's slice and returns a new slice; layout.update
    // threads it through, preserving single-writer-per-slice. The root
    // chrome mode flags (`freeConfigMode`, `designTitleEditMode`) ride on
    // `apply_msg` Cmds the reducer applies (`mode_set` / `mode_clear`).
    case 'design_enter': {
      // Reset working state on entry; preserve `enabled` (the boot-time
      // --design CLI flag). v0.6: auto-open the panel-list overlay when
      // the pool has hidden entries — the discoverability hint that
      // there are more panels available than currently in the grid.
      // Also sync runtime focus to the design selection's starting
      // panel (selectedIdx=0) so the green border + nav stay in sync
      // from the first keypress; navSelect maintains this invariant.
      const enabled = slice.design && slice.design.enabled;
      const hasHidden = mpool.hiddenIds(slice.arrange).length > 0;
      const all = mdesign.allDesignPanels(slice);
      const focus = all[0] ? all[0].type : slice.focus;
      const next = {
        ...slice,
        focus,
        design: { enabled, selectedIdx: 0, drag: null, undo: [], redo: [], titleEdit: { active: false, text: '' } },
        panelList: { open: hasHidden, cursor: 0 },
      };
      return [next, [{ type: 'apply_msg', msg: { type: 'mode_set', flag: 'freeConfigMode' } }]];
    }
    case 'design_exit': {
      const enabled = slice.design && slice.design.enabled;
      const next = {
        ...slice,
        design: { enabled, selectedIdx: 0, drag: null, undo: [], redo: [], titleEdit: { active: false, text: '' } },
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
    case 'design_mouse_press':  return mdesign.mousePress(slice, require('../app/runtime').getModel(), msg.mx, msg.my, msg.cols);
    case 'design_mouse_motion': {
      // Same diff-painter trap as pool_drag_motion: the insertion bar
      // is painted at the target seam each render, but panel content
      // is frozen during the drag, so the row that hosted the PREVIOUS
      // bar looks unchanged to paintColumns and never gets rewritten.
      // Force a full repaint whenever the visible target shifts (column
      // or index or validity); same-seam motion still no-ops.
      const next = mdesign.mouseMotion(slice, msg.mx, msg.my, msg.cols);
      if (next === slice) return slice;
      const ds = slice.design && slice.design.drag;
      const ns = next.design  && next.design.drag;
      // Only the in-grid 'dragging' kind paints an insertion bar; for
      // resize / armed phases there's nothing to wipe.
      const isInsertionDrag = ns && (ns.kind === 'dragging' || ns.kind === 'armed');
      if (!isInsertionDrag) return next;
      const oldT = ds && ds.target;
      const newT = ns && ns.target;
      if (_insertionTargetsEqual(oldT, newT)) return next;
      return [next, [{ type: 'force_full_repaint' }]];
    }
    case 'design_mouse_release': return mdesign.mouseRelease(slice);
    // v0.6 Phase 5 — pool-drag gesture from the panel-list overlay.
    // Source is the overlay cursor's item id; drop is on a layout cell
    // (replace) or column gap (append). poolDragRelease returns the
    // [next, cmds] tuple directly so its dispatch_msg Cmds re-enter
    // the existing Phase 2 pool_hide / pool_show handlers.
    case 'pool_drag_start': {
      // poolDragStart closes the overlay so the user can see the drop
      // targets — force_full_repaint wipes the overlay's pixels.
      const next = mdesign.poolDragStart(slice, msg.id, msg.mx, msg.my);
      return [next, [{ type: 'force_full_repaint' }]];
    }
    case 'pool_drag_motion': {
      // The pool-drag overlay paints a frame/bar on the drop target each
      // render. When the target SHIFTS BETWEEN CELLS, the previous
      // frame's affordance needs wiping — paintColumns can't tell
      // anything changed (panels are frozen), so emit force_full_repaint.
      // When the target stays put (mouse moved within the same drop
      // zone) the affordance is painted in the same place each render,
      // so no repaint is needed and emitting one each motion was
      // causing visible blinking under rapid drag.
      const next = mdesign.poolDragMotion(slice, msg.mx, msg.my);
      if (next === slice) return slice;
      const oldT = slice.design && slice.design.drag && slice.design.drag.target;
      const newT = next.design  && next.design.drag  && next.design.drag.target;
      if (_dropTargetsEqual(oldT, newT)) return next;
      return [next, [{ type: 'force_full_repaint' }]];
    }
    case 'pool_drag_release': return mdesign.poolDragRelease(slice);
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
    // v0.6 Phase 2 — pool hide/show. The pool entry stays in the pool;
    // only the placement in leftPanels/rightPanels changes. Detail is
    // unhideable (the layout invariant requires exactly one); the
    // overlay UX in Phase 4 will surface this as "essential" rather
    // than offering hide. pool_show refuses to create a second detail
    // or actions panel — same invariant the parser enforces at load.
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
      // Restore the v0.6 focus+selectedIdx invariant. If the hidden
      // panel was focused, clampSelected falls through to its
      // selectedIdx-based pick.
      return mdesign.clampSelected(next);
    }
    // v0.6 Phase 4 — panel-list overlay state Msgs. Open/close, cursor
    // nav, context-pick. The pick re-emits a pool_hide / pool_show Msg
    // back into the layout component via a dispatch_msg Cmd so the
    // existing handlers do the work (single source of truth for the
    // pool↔grid mutation).
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
      const placement = placementFromPoolEntry(entry, column);
      // Right column keeps `detail` as the last cell (convention shared
      // with moveColumn). Insert BEFORE detail when present; otherwise
      // (left column or right with no detail yet) append at the tail.
      let inserted;
      if (column === 'right') {
        const detailIdx = target.findIndex(p => p.type === 'detail');
        if (detailIdx >= 0) inserted = target.slice(0, detailIdx).concat([placement], target.slice(detailIdx));
        else                inserted = target.concat([placement]);
      } else {
        inserted = target.concat([placement]);
      }
      const nextCol = rekeyColumn(inserted, column === 'left' ? LEFT_HOTKEY_POOL : RIGHT_HOTKEY_POOL);
      const nextArrange = column === 'left'
        ? { ...arrange, leftPanels:  nextCol }
        : { ...arrange, rightPanels: nextCol };
      const next = { ...slice, arrange: nextArrange, dirty: true };
      // Move focus + selectedIdx to the newly-shown panel — matches the
      // overlay UX where picking from the pool surfaces the new panel
      // as the active one.
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
  // Exposed for tests + Phase 1b transition; the runtime branch is gone.
  reduceViewMode,
};
