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

// Pure design-mode layout transforms — mutate `slice.design` (via
// `getComponentSlice('layout').design` internally). Called from this
// Component's update, so the slice writes happen within layout.update's
// call stack (single-writer per slice preserved).
const mdesign = require('../model-design');

function init() {
  return {
    // 1g: { leftPanels, rightPanels, leftWidth, detailHeightPct }.
    // Default matches runtime.init pre-1g; state.js's initState replaces
    // it with the parsed config (rebuildLayoutFromConfig).
    arrange: { leftWidth: 30, leftPanels: [], rightPanels: [], detailHeightPct: 60 },
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
    // design-mode state (post-Phase-6 follow-up — single-writer cleanup).
    // Pre-fix: `runtime.update` wrote `slice.design.*` from a dozen
    // branches. Now layout.update owns every slice write; the root chrome
    // mode flags (`designMode`, `designTitleEditMode`) ride on `apply_msg`
    // Cmds the reducer applies (`mode_set` / `mode_clear`). The mdesign
    // leaf functions still take `model` and write the slice in place via
    // `getComponentSlice('layout').design` — same access path, but now
    // their writes originate inside layout.update's call stack.
    case 'design_enter': {
      // Reset working state on entry; preserve `enabled` (the boot-time
      // --design CLI flag).
      const enabled = slice.design && slice.design.enabled;
      slice.design = { enabled, selectedIdx: 0, drag: null, undo: [], redo: [], titleEdit: { active: false, text: '' } };
      return [slice, [{ type: 'apply_msg', msg: { type: 'mode_set', flag: 'designMode' } }]];
    }
    case 'design_exit': {
      const enabled = slice.design && slice.design.enabled;
      slice.design = { enabled, selectedIdx: 0, drag: null, undo: [], redo: [], titleEdit: { active: false, text: '' } };
      return [slice, [
        { type: 'apply_msg', msg: { type: 'mode_clear', flag: 'designMode' } },
        { type: 'apply_msg', msg: { type: 'mode_clear', flag: 'designTitleEditMode' } },
        { type: 'show_selected_info' },
      ]];
    }
    case 'design_nav':
    case 'design_reorder':
    case 'design_move_col':
    case 'design_resize':
    case 'design_panel_height':
    case 'design_undo':
    case 'design_redo':
    case 'design_title_enter':
    case 'design_title_submit':
    case 'design_mouse_press':
    case 'design_mouse_motion':
    case 'design_mouse_release': {
      // mdesign.* leaves read app-global state (model.config, model.modes)
      // + mutate slice.design in place via getComponentSlice. The model is
      // resolved inline here so callers don't have to thread it into the
      // Msg.
      const m = require('../runtime').getModel();
      const cmds = [];
      switch (msg.type) {
        case 'design_nav':          mdesign.navSelect(m, msg.dir); break;
        case 'design_reorder':      mdesign.reorderWithin(m, msg.dir); mdesign.clampSelected(m); break;
        case 'design_move_col':     mdesign.moveColumn(m, msg.col);    mdesign.clampSelected(m); break;
        case 'design_resize':       mdesign.resizeWidthOrDetail(m, msg.delta); break;
        case 'design_panel_height': mdesign.resizeFocusedPanelHeight(m, msg.delta); break;
        case 'design_undo':         mdesign.undo(m); mdesign.clampSelected(m); break;
        case 'design_redo':         mdesign.redo(m); mdesign.clampSelected(m); break;
        case 'design_title_enter':
          mdesign.titleEnter(m);
          cmds.push({ type: 'apply_msg', msg: { type: 'mode_set', flag: 'designTitleEditMode' } });
          break;
        case 'design_title_submit': {
          const text = slice.design ? slice.design.titleEdit.text : '';
          mdesign.setSelectedTitle(m, text);
          if (slice.design) slice.design.titleEdit = { active: false, text: '' };
          cmds.push({ type: 'apply_msg', msg: { type: 'mode_clear', flag: 'designTitleEditMode' } });
          break;
        }
        case 'design_mouse_press':   mdesign.mousePress(m, msg.mx, msg.my, msg.cols); break;
        case 'design_mouse_motion':  mdesign.mouseMotion(m, msg.mx, msg.my, msg.cols); break;
        case 'design_mouse_release': mdesign.mouseRelease(m); break;
      }
      return cmds.length ? [slice, cmds] : slice;
    }
    case 'design_title_key': {
      const te = slice.design && slice.design.titleEdit;
      if (!te) return slice;
      if (msg.key === 'backspace' || msg.seq === '\x7f' || msg.seq === '\b') { te.text = te.text.slice(0, -1); return slice; }
      if (msg.seq && msg.seq.length === 1 && msg.seq >= ' ' && msg.seq < '\x7f') { te.text += msg.seq; return slice; }
      return slice;
    }
    case 'design_title_cancel': {
      if (slice.design) slice.design.titleEdit = { active: false, text: '' };
      return [slice, [{ type: 'apply_msg', msg: { type: 'mode_clear', flag: 'designTitleEditMode' } }]];
    }
    // Wipe the session's undo/redo history. :restore-layout emits this
    // because the runtime layout the user was editing is gone — the
    // history pointed at it no longer makes sense.
    case 'design_clear_undo':
      mdesign.clearUndoStacks(require('../runtime').getModel());
      return slice;
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
