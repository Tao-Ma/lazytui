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
