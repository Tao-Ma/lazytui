/**
 * Input layer — raw stdin → key events; SGR mouse parsing → click events.
 *
 * Parses:
 *   - SGR mouse: \x1b[<button;x;yM (press) / m (release), left clicks only
 *   - Arrow keys, PgUp/Dn, Esc, Enter, Ctrl+C — into named keys
 *   - Anything else — passed through as both `key` and `seq` to handleKey
 *
 * Terminal mode bypasses parsing: bytes go straight to the active PTY,
 * except Ctrl+\ which exits terminal mode.
 */
'use strict';

const { allPanels, selectGroup, setSel, getSel, getScroll } = require('../app/state');
const { render } = require('../render/layout');
const { getModel } = require('../app/runtime');
const { enableMouse, enableFocusEvents, enableBracketedPaste, cols } = require('../io/term');
const { isTerminalTab, activeTerminalId } = require('../panel/viewer/tabs');
const { writeToSession, isSessionDead } = require('../io/terminal');
const {getPanelDef, getItems, getInstanceSlice, dispatchMsg, wrap, getFocus, instanceKind } = require('../panel/api');
const route = require('../panel/route');
const mpane = require('../leaves/pane');
const { isChainActive, CHAIN_MODES } = require('./modes');

function _detail() {
  // v0.6.3 T1.4 — paneId-aware lookup (post-Phase B1). resolveTarget
  // returns the focused viewer's paneId in multi-viewer setups; the
  // 'detail' fallback covers the singleton boot case.
  return getInstanceSlice(route.resolveTarget('viewer') || 'detail');
}
const { handleKey, applyMsg, showSelectedInfo, navSelect } = require('./dispatch');
const { cleanup } = require('../app/cleanup');

// --- Mouse handling ---

/**
 * Wheel-on-panel: hit-test (mx, my) against every panel's bounds and
 * scroll the one under the cursor. Returns true if any state mutated
 * (so the caller knows to repaint). Focus is intentionally NOT
 * changed — users can wheel through a side panel while keeping the
 * keyboard focused elsewhere, which is the friendlier-than-click
 * behavior most TUIs converge on.
 *
 * Per-panel behavior:
 *   detail        viewer_scroll ±1 (clamped — detail slice's `scroll`)
 *   list panels   moveSel-style ±1 on that panel's own selection
 *   anything else no-op
 *
 * In visual-mode the detail wheel still adjusts only the view; the
 * cursor's logical position stays where it is and may drift off
 * screen. Wheel back to bring it back. j/k is the way to extend the
 * selection.
 */
function _handleWheel(mx, my, delta) {
  // Use visibleBoundsFor — in half/full view, off-screen panes are
  // absent from paneBounds; boundsFor would fall back to their
  // normal-view rects in _currentLayout and we'd scroll a phantom
  // pane whose coords overlap with the visible half-view rect.
  const { visibleBoundsFor } = require('../render/layout');
  for (const p of allPanels()) {
    const b = visibleBoundsFor(p.paneId);  // v0.6.4 Phase 2 — paneId, not type (two same-kind panes share a type key)
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w || my < b.y || my >= b.y + b.h) continue;

    if (instanceKind(p.type) === 'detail') {
      const d = _detail();
      const lines = d?.lines || [];
      const curScroll = d?.scroll || 0;
      // Single source of truth for the view-mode-aware viewport (P5
      // arc fix follow-up — panelHeights[type] would have given the
      // small normal-view share even in half/full view).
      const innerH = require('../render/layout').getPanelViewportH(p.paneId);  // v0.6.4 Phase 3b — paneId
      const maxScroll = Math.max(0, lines.length - innerH);
      const next = Math.max(0, Math.min(maxScroll, curScroll + delta));
      if (next === curScroll) return false;
      // v0.6.1 Phase 8 — scroll the specific viewer tab that the wheel
      // landed on (p.type is the panel/tab id for singleton placements).
      dispatchMsg(wrap(p.type, { type: 'viewer_scroll', delta }));
      return true;
    }

    const def = getPanelDef(p.type);
    if (def && typeof def.getItems === 'function') {
      const items = getItems(p.type);
      if (!items.length) return false;
      const sel = getSel(p.type);
      const next = Math.max(0, Math.min(items.length - 1, sel + delta));
      if (next === sel) return false;
      // Focused-panel wheel: full nav cascade (cursor + auto-yank-or-
      // refresh — same path keyboard j/k uses). Unfocused (side-panel)
      // wheel: cursor only, no detail clobber. Groups still need the
      // resetGroupContext cascade even unfocused — wheel-over a side
      // groups panel should still switch the active group.
      // v0.6.2 — used to split setSel/selectGroup unconditionally and
      // call showSelectedInfo() if focused; folded into navSelect for
      // the focused case so auto-yank parity with keyboard is automatic.
      // v0.6.3 B3 — getFocus() is a paneId; tolerant compare via paneMatchesFocus
      // so wheel-over-focused-pane still hits the full-cascade navSelect path.
      if (mpane.paneMatchesFocus(p, getFocus())) {
        navSelect(p.type, next);
      } else if (p.type === 'groups') {
        selectGroup(next);
      } else {
        setSel(p.type, next);
      }
      return true;
    }
    return false;
  }
  return false;
}

/** Suppress chrome-glyph clicks when a mode owns the user's input or
 *  paints a centered popup over the chrome. Free-config is explicitly
 *  let through — the [_] widget is supposed to work there. Same for
 *  filter/detailSearch/prefix/listSelect (no centered overlay covering
 *  chrome). */
function _suppressesChromeClicks(md) {
  return md.cmdMode || md.menuOpen || md.copyMode
      || md.confirmMode || md.promptMode || md.registerPopupMode
      || md.freeConfigTitleEditMode || md.terminalMode;
}

// v0.6.3 Phase C1 — mouse-routing registry mirroring keyboard's
// `_modeHandlers` in dispatch.js. Each handler takes
// `(kind, mx, my, model)` and returns `true` if it consumed the
// event (caller stops cascade). Walked by `_dispatchActiveModeMouse`
// in CHAIN_MODES order — first active claiming handler wins.
//
// Handlers OWN their render() call — most dispatch a Msg and paint,
// but some consume-no-render paths exist (panel-list header/footer
// click, motion without an in-flight drag) and skip paint
// deliberately as a perf optimization (P5.10).
//
// Handlers that DON'T consume (e.g. tabListMode on motion/release)
// return false; the dispatcher falls through, and the subsequent
// `isChainActive(model.modes) return;` guard catches the event so it
// doesn't leak into normal-mode click/wheel routing.

/** tab-list overlay — wheel scrolls cursor, press picks a row or
 *  closes when clicked outside. Motion/release fall through. */
function _mouseHandleTabListMode(kind, mx, my, model) {
  const tabOverlay = require('../overlay/tab-list');
  const layoutSlice = getInstanceSlice('layout');
  const ownerPaneId = (layoutSlice && layoutSlice.tabListOwnerPaneId) || 'detail';
  if (kind === 'wheel-up' || kind === 'wheel-down') {
    dispatchMsg(wrap(ownerPaneId, {
      type: 'tab_list_nav',
      dir: kind === 'wheel-up' ? -1 : +1,
      vh: tabOverlay.viewportRows(),
      tabCount: tabOverlay._flatTabs().length,
    }));
    render();
    return true;
  }
  if (kind === 'press') {
    const hit = tabOverlay.hitTest(mx, my);
    if (hit) {
      dispatchMsg(wrap('layout', { type: 'focus_set', focus: ownerPaneId }));
      const pt = require('../leaves/pane-tabs');
      const slice = getInstanceSlice(ownerPaneId);
      dispatchMsg(wrap(ownerPaneId, {
        type: 'tab_switch', idx: hit.tabIdx,
        targetKey: pt.resolveTabKey(hit.tabIdx, { ...slice, tab: hit.tabIdx }, model),
        currentGroup: model.currentGroup,
      }));
      dispatchMsg(wrap(ownerPaneId, { type: 'tab_list_close' }));
    } else {
      dispatchMsg(wrap(ownerPaneId, { type: 'tab_list_close' }));
    }
    render();
    return true;
  }
  return false;
}

/** pane-select overlay — wheel scrolls cursor, press picks a target
 *  or closes when clicked outside. */
function _mouseHandlePaneSelectMode(kind, mx, my, _model) {
  const psOverlay = require('../overlay/pane-select');
  if (kind === 'wheel-up' || kind === 'wheel-down') {
    const all = psOverlay.items();
    dispatchMsg(wrap('layout', {
      type: 'pane_select_nav',
      dir: kind === 'wheel-up' ? -1 : +1,
      n: all.length,
      vh: psOverlay.viewportRows(),
    }));
    render();
    return true;
  }
  if (kind === 'press') {
    const hit = psOverlay.hitTest(mx, my);
    const layoutSlice = getInstanceSlice('layout');
    const ps = layoutSlice && layoutSlice.paneSelect;
    if (hit && ps) {
      dispatchMsg(wrap('layout', {
        type: 'pool_swap_by_id',
        targetPaneId: ps.targetPaneId,
        pickedId: hit.item.id,
      }));
    } else {
      dispatchMsg(wrap('layout', { type: 'pane_select_close' }));
    }
    render();
    return true;
  }
  return false;
}

/** free-config — owns the entire mouse pipeline. Routes pool-drag /
 *  tab-drag / tab-bar press / panel-list overlay / free-config drag,
 *  each via dispatchMsg into the layout slice. Always consumes (the
 *  mode owns the mouse), so non-press/motion/release just short-circuit
 *  to true. */
function _mouseHandleFreeConfigMode(kind, mx, my, model) {
  const slice = getInstanceSlice('layout');
  const drag = slice && slice.freeConfig && slice.freeConfig.drag;
  const isPoolDrag = drag && (drag.kind === 'pool-armed' || drag.kind === 'pool-dragging');
  const isTabDrag = drag && (drag.kind === 'tab-armed' || drag.kind === 'tab-dragging');

  if (isPoolDrag) {
    if (kind === 'motion')       dispatchMsg(wrap('layout', { type: 'pool_drag_motion', mx, my, cols: cols() }));
    else if (kind === 'release') dispatchMsg(wrap('layout', { type: 'pool_drag_release' }));
    render();
    return true;
  }

  if (isTabDrag) {
    if (kind === 'motion') {
      const pt = require('../leaves/pane-tabs');
      const groupName = model.currentGroup;
      const targetKind = require('../panel/route').resolveTarget('viewer') || 'detail';
      const detailSlice = getInstanceSlice(targetKind);
      const tabBounds = detailSlice && Array.isArray(detailSlice.tabBounds) ? detailSlice.tabBounds : null;
      dispatchMsg(wrap('layout', {
        type: 'tab_drag_motion', mx, my,
        modelBundle: pt.modelBundle(model, groupName),
        tabBounds,
      }));
    } else if (kind === 'release') {
      dispatchMsg(wrap('layout', { type: 'tab_drag_release' }));
    }
    render();
    return true;
  }

  // Tab-bar press detection — click on a content tab arms a tab-drag.
  // v0.6.4 Theme A Phase 3 (was N13) — bounds + slice both resolve via
  // resolveTarget('viewer') so the FOCUSED viewer's tab strip wins under
  // multi-viewer. No-op under singleton (resolveTarget → the one viewer's
  // paneId, which paneBounds dual-keys).
  const viewerId = route.resolveTarget('viewer') || 'detail';
  const db = require('../render/layout').boundsFor(viewerId);
  const detailSlice = getInstanceSlice(viewerId);
  const detailTabBounds = detailSlice && Array.isArray(detailSlice.tabBounds) ? detailSlice.tabBounds : null;
  if (kind === 'press' && db && detailTabBounds) {
    if (my === db.y) {
      const localX = mx - db.x;
      let contentIdx = 0;
      for (const t of detailTabBounds) {
        if (t.closeKey == null) continue;
        if (localX >= t.x && localX < t.x + t.w) {
          dispatchMsg(wrap('layout', {
            type: 'tab_drag_start',
            sourceKey: t.closeKey, fromIdx: contentIdx,
            mx, my,
          }));
          render();
          return true;
        }
        contentIdx++;
      }
    }
  }

  if (kind === 'press' && slice && slice.panelList && slice.panelList.open) {
    const { hitTest } = require('../overlay/panel-list');
    const mpool = require('../leaves/pool');
    const hit = hitTest(mx, my);
    if (hit) {
      let cursor = slice.panelList.cursor;
      if (hit.itemIdx !== null) cursor = hit.itemIdx;
      const items = mpool.panelListItems(slice.arrange);
      const item = items[cursor];
      if (item && item.status !== 'essential') {
        if (hit.itemIdx !== null && hit.itemIdx !== slice.panelList.cursor) {
          dispatchMsg(wrap('layout', { type: 'panel_list_open', cursor }));
        }
        dispatchMsg(wrap('layout', { type: 'pool_drag_start', id: item.id, mx, my }));
        render();
        return true;
      }
      // Header/footer / essential row — swallow without dispatch.
      // No state change → no render needed (mirrors prior bare
      // `return;` here). Returns true so dispatcher stops the cascade.
      return true;
    }
    // Click outside overlay: close it, then fall through to free-config drag.
    dispatchMsg(wrap('layout', { type: 'panel_list_close' }));
  }

  // Motion without an in-flight drag is a no-op in the leaf — skip
  // dispatch AND render entirely (P5.10). Press / release always fire.
  if (kind === 'motion' && !drag) return true;
  if (kind === 'press')        dispatchMsg(wrap('layout', { type: 'free_config_mouse_press',  mx, my, cols: cols() }));
  else if (kind === 'motion')  dispatchMsg(wrap('layout', { type: 'free_config_mouse_motion', mx, my, cols: cols() }));
  else if (kind === 'release') dispatchMsg(wrap('layout', { type: 'free_config_mouse_release' }));
  render();
  return true;
}

const _modeMouseHandlers = {
  tabListMode:     _mouseHandleTabListMode,
  paneSelectMode:  _mouseHandlePaneSelectMode,
  freeConfigMode:  _mouseHandleFreeConfigMode,
};

// Mouse mode precedence — DERIVED from the keyboard chain (CHAIN_MODES,
// the single source of mode ordering in `./modes`), filtered to the
// modes with a mouse handler. Pre-C1 this was a hand-pinned array
// (tabList → paneSelect → freeConfig); deriving it keeps the mouse side
// from silently disagreeing with the keyboard side — exactly what a
// second hardcoded list risked. The three modes are mutually exclusive
// by invariant today (mode_set/clear flips one at a time; free-config
// disables the [≡] trigger), so the order is observationally moot; if
// that invariant ever relaxes, mouse now resolves the SAME winner as
// keyboard (freeConfig first) instead of the opposite.
const _MOUSE_MODE_PRECEDENCE = CHAIN_MODES.filter(f => f in _modeMouseHandlers);

/** Walks _MOUSE_MODE_PRECEDENCE in order, fires the first active
 *  handler. Returns true when a handler claimed the event (caller
 *  stops). Wedge-guarded like `_dispatchActiveMode` for keyboard —
 *  a throwing handler clears its flag so subsequent clicks don't
 *  trap in the throwing path. */
function _dispatchActiveModeMouse(kind, mx, my, model) {
  for (const flag of _MOUSE_MODE_PRECEDENCE) {
    if (!model.modes[flag]) continue;
    const handler = _modeMouseHandlers[flag];
    if (!handler) continue;
    try {
      if (handler(kind, mx, my, model)) return true;
    } catch (e) {
      console.error('[mode-mouse]', flag, e && e.message);
      try {
        require('./event-log').record('error', {
          where: 'mouse_handler', flag, kind, mx, my,
          message: e && e.message, stack: e && e.stack,
        });
      } catch (_) { /* event-log unavailable */ }
      // Clear the wedged flag via update so single-writer holds.
      try { applyMsg({ type: 'mode_clear', flag }); } catch (_) {}
      return false;
    }
  }
  return false;
}

function handleMouse(kind, x, y) {
  // Phase 4 — runtime.update returns NEW model objects; read getModel()
  // at entry so post-Msg state is what subsequent reads see.
  const model = getModel();
  // x, y are 1-based from SGR; convert to 0-based
  const mx = x - 1;
  const my = y - 1;

  // Panel-chrome glyph clicks — single early hit-test site for both
  // [_]/[+] (collapse, always-on) and [X] (close, free-config-only).
  // The close-button paint is itself gated on free-config in render(),
  // so its hit-test no-ops in normal mode (no glyph there to click).
  // Suppression predicate is narrower than isChainActive: free-config
  // and the in-grid modes (filter/search/prefix/listSelect) still let
  // chrome clicks through; only input-owning modes block them.
  if (kind === 'press' && !_suppressesChromeClicks(model.modes)) {
    const { hitTestCollapseButton, hitTestCloseButton } = require('../render/decor');
    const collapseId = hitTestCollapseButton(mx, my);
    if (collapseId) {
      dispatchMsg(wrap('layout', { type: 'panel_collapse_toggle', id: collapseId }));
      render();
      return;
    }
    if (model.modes.freeConfigMode) {
      const hideId = hitTestCloseButton(mx, my);
      if (hideId) {
        dispatchMsg(wrap('layout', { type: 'pool_hide', id: hideId }));
        render();
        return;
      }
    }
    // Tab-list `[≡]` trigger at the viewer pane's top-left. Toggles
    // the overlay. Trigger's own suppression (free-config + modals)
    // lives inside `isTriggerHit` so the click silently misses there.
    // v0.6.1 Phase 8 — target the focused-or-sticky viewer (the pane
    // whose trigger glyph the user can see); null = no viewer, drop.
    const tabOverlay = require('../overlay/tab-list');
    if (tabOverlay.isTriggerHit(mx, my)) {
      const target = route.resolveTarget('viewer');
      // No viewer → click is a no-op; nothing changed, skip the render.
      if (!target) return;
      if (model.modes.tabListMode) {
        dispatchMsg(wrap(target, { type: 'tab_list_close' }));
      } else {
        dispatchMsg(wrap(target, {
          type: 'tab_list_open',
          vh: tabOverlay.viewportRows(),
          tabCount: tabOverlay._flatTabs().length,
        }));
      }
      render();
      return;
    }
    // v0.6.3 D1 — pane-select [≡] trigger on any non-detail pane.
    // Same glyph position as detail's tab-list trigger; click semantic
    // differs by pane.type (input dispatches the right Msg). Toggles
    // the overlay when clicked on the open target's own glyph.
    const paneSelectOverlay = require('../overlay/pane-select');
    const psTargetId = paneSelectOverlay.hitTestTrigger(mx, my);
    if (psTargetId) {
      if (model.modes.paneSelectMode) {
        dispatchMsg(wrap('layout', { type: 'pane_select_close' }));
      } else {
        dispatchMsg(wrap('layout', { type: 'pane_select_open', paneId: psTargetId }));
      }
      render();
      return;
    }
  }

  // v0.6.3 Phase C1 — modal mouse routing through the
  // `_modeMouseHandlers` registry (mirrors keyboard's `_modeHandlers`
  // in dispatch.js). Walks CHAIN_MODES in precedence order; the first
  // active claiming handler wins. Handlers own their render() call so
  // consume-no-render paths (panel-list header click, motion without
  // drag) can skip paint as a perf optimization. Handlers that don't
  // claim (e.g. tabList on motion/release) return false and fall
  // through to the `isChainActive` guard below.
  if (_dispatchActiveModeMouse(kind, mx, my, model)) return;

  // T13 — mirror keyboard modal gating: while any chain mode claims
  // keystrokes via the modeChain, mouse events must not cascade into
  // focus changes / selection / scroll that the user can't see through
  // the overlay (or that would silently mutate state behind a modal —
  // notably the wheel-over-groups path, which fires reset_group_context
  // and leaves modal sub-models bound to the OLD group). The free-
  // config mode special-case above runs first because free-config owns
  // the mouse pipeline. terminalMode is non-chain by design.
  if (isChainActive(model.modes)) return;

  // Mouse wheel — scrolls the panel under the cursor without changing
  // focus. Detail adjusts the detail scroll; list panels move their own
  // selection. No-op when the wheel landed outside any panel bounds.
  if (kind === 'wheel-up' || kind === 'wheel-down') {
    if (_handleWheel(mx, my, kind === 'wheel-down' ? +1 : -1)) render();
    return;
  }

  // Detail-panel text selection. press → begin; motion (with button
  // held) → extend; release → commit + push to register. Runs ahead
  // of the focus+select loop so dragging across panels can extend a
  // selection that started in detail rather than losing it to a focus
  // change.
  const sel = require('../panel/viewer/select');
  if (kind === 'motion' && sel.isActive()) {
    // v0.6.4 Phase 3 — focused viewer's bounds (see tab-drag site above).
    const db = require('../render/layout').boundsFor(route.resolveTarget('viewer') || 'detail');
    if (db) {
      const visibleLine = Math.max(0, Math.min(db.h - 3, my - db.y - 1));
      const col = Math.max(0, mx - db.x - 1);
      sel.extendTo((_detail()?.scroll || 0) + visibleLine, col);
      render();
    }
    return;
  }
  if (kind === 'release') {
    if (sel.isActive()) {
      sel.commit();
      render();
    }
    return;
  }

  // From here on: press only.
  if (kind !== 'press') return;

  let mutated = false;

  // Same reason as _handleWheel above: hit-test against ACTUALLY-
  // VISIBLE pane bounds. In half view, paneBounds carries only
  // halfLeftPanel + detail; boundsFor's _currentLayout fallback
  // would return phantom normal-view coords for off-screen panes
  // (containers/groups/files would all "exist" at their normal-
  // view positions, and a click on the visible left half would
  // dispatch focus_set to the first non-detail pane instead of to
  // the actually-visible halfLeftPanel — silently reverting the
  // user's right-arrow selection).
  const { visibleBoundsFor } = require('../render/layout');
  for (const p of allPanels()) {
    const b = visibleBoundsFor(p.paneId);  // v0.6.4 Phase 2 — paneId, not type (two same-kind panes share a type key)
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w || my < b.y || my >= b.y + b.h) continue;

    // Top-border tab-strip — gated on a tabBounds list on the panel's
    // own Component slice (v0.6.3 P4.1: moved off layoutSlice.paneBounds.
    // .tabs). ANY pane whose Component publishes slice.tabBounds gets
    // click routing — currently only detail; multi-viewer would have
    // sibling viewers publish their own.
    const compSlice = getInstanceSlice(p.type);
    const paneTabs = compSlice && Array.isArray(compSlice.tabBounds) ? compSlice.tabBounds : null;
    if (my === b.y && paneTabs && paneTabs.length > 0) {
      const localX = mx - b.x;
      for (const tab of paneTabs) {
        if (localX >= tab.x && localX < tab.x + tab.w) {
          // Close-zone hit (content tabs only — the tab-strip builder
          // stamps `closeKey` on those entries). Wins over a tab-
          // switch click since the close glyph sits inside the tab's
          // outer rect.
          if (tab.closeKey != null && localX >= tab.closeX && localX < tab.closeX + tab.closeW) {
            // Thread the model bundle so the reducer + leaf stay pure
            // of getModel(). v0.6.3 TEA Phase 3c.
            const mForBundle = getModel();
            const groupName = mForBundle.currentGroup;
            dispatchMsg(wrap(p.type, {
              type: 'viewer_remove_content_tab',
              groupName,
              key: tab.closeKey,
              ...require('../leaves/pane-tabs').modelBundle(mForBundle, groupName),
            }));
          } else {
            dispatchMsg(wrap('layout', { type: 'focus_set', focus: p.type }));
            // Phase 3d: thread targetKey + currentGroup so the tab_switch
            // reducer arm stays pure of getModel().
            {
              const pt = require('../leaves/pane-tabs');
              const slice = getInstanceSlice(p.type);
              dispatchMsg(wrap(p.type, {
                type: 'tab_switch', idx: tab.tabIdx,
                targetKey: pt.resolveTabKey(tab.tabIdx, { ...slice, tab: tab.tabIdx }, getModel()),
                currentGroup: getModel().currentGroup,
              }));
            }
          }
          mutated = true;
          break;
        }
      }
      if (mutated) break;
    }

    // Detail panel content area — text selection on a click inside the
    // body. Stays detail-specific until Phase 4 lifts the selection
    // machinery onto a per-pane basis.
    if (require('../leaves/pool').isDetailPane(p)) {
      dispatchMsg(wrap('layout', { type: 'focus_set', focus: 'detail' }));
      // Begin a selection iff the click landed in the content rows
      // and this tab actually has scrollable text content (skip
      // terminal tabs — the PTY handles its own input).
      const inContent = my > b.y && my < b.y + b.h - 1;
      const d = _detail();
      if (inContent && !isTerminalTab() && d && d.lines.length > 0) {
        const visibleLine = my - b.y - 1;
        const col = Math.max(0, mx - b.x - 1);
        sel.beginAt((d.scroll || 0) + visibleLine, col, 'char');
      } else {
        sel.cancel();
      }
      mutated = true;
      break;
    }

    // Other panels — focus + select clicked item. A press anywhere
    // outside the detail content area cancels any pending selection
    // (starting a new gesture here).
    sel.cancel();
    // Resolve whether this click lands on a selectable row BEFORE the
    // focus_set: if it does, navSelect (below) sets the cursor and fires
    // show_selected_info against the NEW selection, so focus_set skips
    // its own cascade (skipInfo) to avoid a double-fire — the first
    // against the pre-cursor-write (stale) item. Off-row clicks keep
    // focus_set's show_selected_info so Info still refreshes on focus.
    const itemRow = my - b.y - 1;  // -1 for top border
    let navIdx = -1;
    if (itemRow >= 0) {
      const def = getPanelDef(p.type);
      if (def && typeof def.getItems === 'function') {
        const idx = itemRow + getScroll(p.type);
        if (idx < getItems(p.type).length) navIdx = idx;
      }
    }
    dispatchMsg(wrap('layout', { type: 'focus_set', focus: p.type, skipInfo: navIdx >= 0 }));
    if (navIdx >= 0) {
      // v0.6.2 — single navSelect path. Sets cursor, fires the
      // auto-yank-or-show_info cascade, and runs groups_selected
      // cascade for groups. Replaces the prior setSel/selectGroup
      // split that left non-groups clicks without auto-yank parity.
      navSelect(p.type, navIdx);
    }
    mutated = true;
    break;
  }

  // Single paint at end — same contract as dispatch.handleKey. Diff
  // render makes a no-op paint cheap when click missed every panel.
  if (mutated) render();
}

// --- Terminal-mode keystroke handling ---

/**
 * Handle a raw stdin chunk while getModel().modes.terminalMode is true. Extracted
 * from the stdin closure so tests can drive it directly.
 *
 * Returns true if the chunk was consumed (caller should skip the
 * rest of the input pipeline). Never returns false today — terminal
 * mode swallows everything until Ctrl+\ flips us out. Still returns
 * a bool so future expansion (e.g., chord prefixes) has a contract.
 *
 * Side effects:
 *  - `\x1c` (Ctrl+\) → terminalMode=false. If viewMode was 'full'
 *    (auto-zoom from a `type: spawn`), drops it to 'normal' and
 *    forceFullRepaints so the chrome reclaims the screen. The PTY
 *    child keeps running; the user can navigate back via tabs.
 *  - Session already dead (id missing or isSessionDead) → same
 *    flip + zoom-drop, plus the keystroke is dropped on the floor.
 *  - Live session → writeToSession forwards the bytes to the PTY.
 */
function _handleTerminalModeData(data) {
  // Ctrl+\ exits terminal mode; a dead/missing session exits too (and drops
  // the keystroke). Both flow through the terminal_exit Msg, which clears the
  // flag, drops a 'full' auto-zoom to 'normal', and emits a force_full_repaint
  // Cmd when it did so. render() paints the result.
  if (data === '\x1c') {
    applyMsg({ type: 'terminal_exit' });
    render();
    return true;
  }
  const id = activeTerminalId();
  if (!id || isSessionDead(id)) {
    applyMsg({ type: 'terminal_exit' });
    render();
    return true;
  }
  writeToSession(id, data);
  return true;
}

// --- Stdin setup ---

// T25 — bracketed paste accumulator (B13). A large paste can split
// across multiple stdin chunks (Node's 64KB highWaterMark). The
// pre-fix `startsWith(...200~) && endsWith(...201~)` check failed on
// multi-chunk pastes, falling through to the \x1b defensive fallback
// which fired Esc (closing any open modal); subsequent chunks
// silently dropped.
//
// Residual gap (not fixed): if the 6-byte OPEN marker itself splits
// across chunks (e.g. chunk-1 ends with `\x1b[20`, chunk-2 starts
// with `0~content...`), the first chunk doesn't satisfy
// `startsWith(_PASTE_OPEN)` and falls through to the unknown-escape
// drop path. The paste content gets fed back through `stdin.emit`
// retry but without the open-marker context, so it dispatches as
// individual chars. Practically rare — TTY pastes typically arrive
// with the open marker intact in the first chunk (markers are 6
// bytes, the splits are large-content-driven) — but the gap exists.
// A more robust accumulator would also detect prefixes-of-OPEN at
// chunk boundaries, which adds latency to every \x1b-prefixed key.
let _pasteBuffer = '';
const _PASTE_MAX = 256 * 1024;   // 256 KB cap (R16)
const _PASTE_OPEN = '\x1b[200~';
const _PASTE_CLOSE = '\x1b[201~';

// T25 — multi-event SGR mouse parser (R15). Pre-fix used a single
// .match() which dispatched only the first event in a chunk; fast
// drag motion that coalesced multiple events per chunk silently
// dropped all but the first. matchAll iterates every event.
const _MOUSE_RE_G = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

function setupKeyListener() {
  // Phase 4 — the stdin closure used to capture `model` and thread it
  // into handleMouse / handleKey / render(model). Post-pure-TEA the
  // captured ref would freeze at boot state; every reader now re-reads
  // getModel() at the entry point that needs it. The function takes
  // no model arg.
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  enableMouse();             // SGR-mode mouse click reporting
  enableFocusEvents();       // \e[I on focus gain, \e[O on focus loss
  enableBracketedPaste();    // \e[200~ ... \e[201~ wraps pasted blocks

  stdin.on('data', (data) => {
    // Terminal mode: forward raw bytes to PTY (Ctrl+\ exits)
    if (getModel().modes.terminalMode && _handleTerminalModeData(data)) return;

    // T25 — bracketed paste accumulator (B13). If we're mid-paste OR
    // this chunk starts with the open marker, route to the accumulator
    // until we see the close marker (or hit the size cap).
    if (_pasteBuffer || data.startsWith(_PASTE_OPEN)) {
      _pasteBuffer += data;
      if (_pasteBuffer.length > _PASTE_MAX) {
        console.error(`[input] bracketed paste exceeded ${_PASTE_MAX} bytes — dropped`);
        require('./event-log').record('input', { kind: 'paste_oversize', size: _pasteBuffer.length });
        _pasteBuffer = '';
        return;
      }
      // The close marker doesn't have to be at the END of the chunk —
      // a fast sender can fire the next event in the same chunk as the
      // paste close. Look for the FIRST close marker after the OPEN
      // and dispatch what's between; stash any trailing bytes back for
      // the next iteration.
      const closeIdx = _pasteBuffer.indexOf(_PASTE_CLOSE);
      if (closeIdx >= 0) {
        const text = _pasteBuffer.slice(_PASTE_OPEN.length, closeIdx);
        const tail = _pasteBuffer.slice(closeIdx + _PASTE_CLOSE.length);
        _pasteBuffer = '';
        handleKey('paste', text);
        if (tail) { _pasteBuffer = ''; stdin.emit('data', tail); }
      }
      return;
    }

    // Terminal focus events (DEC 1004). On blur, the periodic
    // refresh loop in tui.js pauses; on focus return, we fire one
    // catch-up refresh immediately so stale data doesn't show.
    if (data === '\x1b[I') {
      const wasUnfocused = !getModel().focused;
      applyMsg({ type: 'focus_event', focused: true });
      if (wasUnfocused) require('../render/render-queue').scheduleRender();
      return;
    }
    if (data === '\x1b[O') {
      applyMsg({ type: 'focus_event', focused: false });
      return;
    }

    // SGR mouse events: \x1b[<button;x;yM (press / motion) or m (release).
    // T25 / R15 — matchAll loop: fast drag can coalesce multiple events
    // per chunk. The pre-fix single .match() dispatched only the first.
    let sawMouse = false;
    for (const mm of data.matchAll(_MOUSE_RE_G)) {
      sawMouse = true;
      const btn      = parseInt(mm[1]);
      const x        = parseInt(mm[2]);
      const y        = parseInt(mm[3]);
      const released = mm[4] === 'm';
      if ((btn & 0x40) !== 0) {
        if (released) continue;
        const kind = (btn & 1) ? 'wheel-down' : 'wheel-up';
        handleMouse(kind, x, y);
        continue;
      }
      const motion = (btn & 0x20) !== 0;
      const button = btn & 3;
      if (button !== 0) continue;  // left button only for non-wheel events
      const kind = released ? 'release' : motion ? 'motion' : 'press';
      handleMouse(kind, x, y);
    }
    if (sawMouse) return;

    if (data === '\x1b[A') return handleKey('up');
    if (data === '\x1b[B') return handleKey('down');
    if (data === '\x1b[C') return handleKey('right');
    if (data === '\x1b[D') return handleKey('left');
    if (data === '\x1b[5~') return handleKey('pageup');
    if (data === '\x1b[6~') return handleKey('pagedown');
    if (data === '\x1b' || data === '\x1b\x1b') return handleKey('escape');
    if (data === '\r' || data === '\n') return handleKey('return');
    if (data === '\x03') { cleanup(); process.exit(0); }
    if (data === '\x12') return handleKey('ctrl-r');  // Ctrl+R → free-config redo

    // T25 / B14 — was: ANY chunk starting with \x1b fired handleKey
    // ('escape'). That treated F-keys (\x1bOP), Alt-modified keys
    // (\x1b[1;3A), Home/End (\x1b[H, \x1b[F), Shift-Tab (\x1b[Z) etc.
    // as Esc — silently canceling any open modal. Now: only fire Esc
    // when the chunk IS exactly Esc (caught above) or \x1b\x1b (caught
    // above); other escape-prefixed chunks log + drop. Logged to
    // event-log so a maintainer reading a recorded session can see
    // what unknown sequences fired.
    if (data.charCodeAt(0) === 0x1b) {
      require('./event-log').record('input', {
        kind: 'unknown_escape',
        bytes: data.length > 64 ? data.slice(0, 64) + '...' : data,
      });
      return;
    }

    // T25 / B16 — bursty plain chunk (no escape prefix). Node TTY in
    // raw mode usually fires one 'data' per keystroke, but under high
    // CPU load or terminal autorepeat or piped-keystroke playback,
    // chunks can batch — `data === 'jjjjj'`. Each handler downstream
    // (handleNormalKey's switch, modal text input's length===1 gate)
    // expects single-char keys. Split per-char so `100j` style
    // autorepeat doesn't silently drop. Skip if length 1 (common path).
    if (data.length > 1) {
      for (const ch of data) handleKey(ch, ch);
      return;
    }

    handleKey(data, data);
  });
}

module.exports = {
  setupKeyListener,
  _handleTerminalModeData,  // exported for tests
  _handleWheel,             // exported for tests
  handleMouse,              // exported for tests (T13 modal-gate regression)
};
