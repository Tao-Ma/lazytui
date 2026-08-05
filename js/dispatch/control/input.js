/**
 * Input layer — raw stdin → key events; SGR mouse parsing → click events.
 *
 * A chunk is first TOKENIZED into complete input events (leaves/input/
 * tokenize — network-lag fix, 2026-08-05: over SSH one chunk can batch
 * many events, and TCP can split one sequence across chunks). Each token
 * then dispatches through one ladder:
 *   - SGR mouse: \x1b[<button;x;yM (press) / m (release), left clicks only
 *   - Arrow keys, PgUp/Dn, Esc, Enter, Ctrl+C — into named keys
 *   - Anything else — passed through as both `key` and `seq` to handleKey
 * A multi-token chunk paints ONCE (render-queue beginBatch/endBatch); a
 * single-token chunk keeps the synchronous per-key paint.
 *
 * Terminal mode bypasses parsing: bytes go straight to the active PTY,
 * except Ctrl+\ which exits terminal mode.
 */
'use strict';

const { allPanels, setSel, getSel, getScroll } = require('../../panel/nav-state');
const { visibleBoundsFor, getPanelViewportH } = require('../../leaves/wm/geometry');
const { paintNow: render, beginBatch, endBatch } = require('../../leaves/infra/render-queue');
const { getModel } = require('../../model/store');
const { enableMouse, enableFocusEvents, enableBracketedPaste, cols } = require('../../io/term');
const { focusedTerminalId } = require('../../panel/terminal-surfaces');
const { writeToSession, isSessionDead } = require('../../io/terminal');
const {getPanelDef, getItems, getInstanceSlice, wrap, getFocus, instanceKind } = require('../../panel/api');
const { dispatchMsg } = require('../runtime/loop');
const route = require('../../panel/route');
const mpane = require('../../leaves/wm/pane');
const { isChainActive, CHAIN_MODES, suppressesChromeClicks } = require('../../leaves/input/modes');
const { tokenizeInput } = require('../../leaves/input/tokenize');
const { kkpToLegacy } = require('../../leaves/input/kkp-decode');
// v0.6.4 Theme F Phase 2 — mouse gestures route through the shared intent
// layer (the keyboard side joined in Phase 1). intent.js executes no
// requires at load time, so this top-level require is load-order-safe
// despite the intent↔input cycle (its `scroll` arm lazy-calls _handleWheel).
const intent = require('./intent');
// v0.6.4 Theme F Phase 4 — the gesture→intent map + tunable double-click
// window. Dependency-free leaf, so this top-level require is cycle-safe.
const mouseBindings = require('./mouse-bindings');

const { handleKey, applyMsg, showSelectedInfo, navSelect } = require('./dispatch');
const { cleanup } = require('../runtime/cleanup');

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
  // absent from the derived visible-bounds map; boundsFor would fall back to
  // their normal-view rects in _currentLayout and we'd scroll a phantom
  // pane whose coords overlap with the visible half-view rect.
  const layoutSlice = getInstanceSlice('layout');
  for (const p of allPanels()) {
    const b = visibleBoundsFor(layoutSlice, p.paneId, route.resolveViewerPaneId());  // v0.6.4 Phase 2 — paneId, not type (two same-kind panes share a type key)
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w || my < b.y || my >= b.y + b.h) continue;

    if (instanceKind(p.paneId) === 'terminal') {
      // U2d P2b / v0.6.5 §5(a) — the wheel over a `terminal` pane scrolls the
      // PTY scrollback (xterm's own viewport), not any viewer slice. delta is
      // -1 (wheel-up = back into history) / +1 (wheel-down = toward live
      // bottom), which maps straight onto scrollSession's sign. A 3-line step
      // matches the typical wheel notch. Returns whether the viewport moved so
      // the caller's paint gating is unchanged.
      const termId = route.activeInstanceOf(p.paneId);
      if (termId) return require('../../io/terminal').scrollSession(termId, delta * 3);
      continue;
    }
    if (instanceKind(p.paneId) === 'agent') {
      // Wheel over an agent pane scrolls the transcript through the shared
      // reducer (clamped against the stamped innerH, which already reserves
      // the 2 bottom rows). Pre-check against the pane's own slice so a
      // no-move wheel skips the repaint (the viewer-branch posture).
      const inst = route.getInstance(route.activeInstanceOf(p.paneId));
      const a = inst && inst.slice;
      const lines = (a && Array.isArray(a.transcript)) ? a.transcript : [];
      const innerH = (a && a.innerH > 0) ? a.innerH : 1;
      const cur = (a && a.scroll) || 0;
      const next = Math.max(0, Math.min(Math.max(0, lines.length - innerH), cur + delta));
      if (next === cur) return false;
      dispatchMsg(wrap(p.paneId, { type: 'viewer_scroll', delta }));
      return true;
    }
    if (route.isViewerKind(p.paneId)) {   // U2e P1b — content-viewer kinds (detail/info/text-view)
      // v0.6.4 multi-viewer — clamp against the wheeled pane's OWN slice
      // (not the focused viewer's), so wheeling an unfocused second
      // viewer scrolls itself. sliceForPane resolves the pane's active instance.
      const d = route.sliceForPane(p.paneId, 'detail');
      // U2e P1b — the active instance (info / text-view) stores its buffer on
      // slice.lines directly; fall back to the viewer's derived lines for the
      // content instance's slice.lines. Used only for the scroll-clamp pre-check;
      // the viewer_scroll dispatch below re-clamps in the instance's own reducer.
      const lines = (d && Array.isArray(d.lines)) ? d.lines : [];
      const curScroll = d?.scroll || 0;
      // Single source of truth for the view-mode-aware viewport (P5
      // arc fix follow-up — panelHeights[type] would have given the
      // small normal-view share even in half/full view).
      const innerH = getPanelViewportH(
        layoutSlice, p.paneId, layoutSlice.dims, null, route.resolveViewerPaneId());  // v0.6.4 Phase 3b — paneId; resize-as-Msg P1 — model dims
      const maxScroll = Math.max(0, lines.length - innerH);
      const next = Math.max(0, Math.min(maxScroll, curScroll + delta));
      if (next === curScroll) return false;
      // v0.6.1 Phase 8 — scroll the specific viewer the wheel landed on.
      // v0.6.4 multi-viewer — address by paneId (was p.type, which collapsed
      // two same-kind viewers onto the kind primary).
      dispatchMsg(wrap(p.paneId, { type: 'viewer_scroll', delta }));
      return true;
    }

    const def = getPanelDef(p.type);
    if (def && typeof def.getItems === 'function') {
      // v0.6.4 Theme A Phase 5 — items + cursor for THIS pane (p.paneId),
      // so wheel-over a same-kind pane reads/moves its own selection.
      const items = getItems(p.paneId);
      if (!items.length) return false;
      const sel = getSel(p.paneId);
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
        navSelect(p.paneId, next);
      } else if (p.type === 'groups') {
        // selectGroup(next) inlined — it was just navSelect('groups', …)
        // (v0.6.5 §1 Phase 2; navSelect already imported above).
        navSelect('groups', next);
      } else {
        setSel(p.paneId, next);
      }
      return true;
    }
    return false;
  }
  return false;
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
// Handlers that DON'T consume (e.g. paneMenuMode on motion/release)
// return false; the dispatcher falls through, and the subsequent
// `isChainActive(model.modes) return;` guard catches the event so it
// doesn't leak into normal-mode click/wheel routing.

/** v0.6.4 #1 Step 2 — the unified `[≡]` pane-menu overlay. Wheel scrolls
 *  the cursor; press picks a row (tab or pane, resolved by
 *  dispatch._paneMenuPick) or closes when clicked outside. Motion/release
 *  fall through. */
function _mouseHandlePaneMenuMode(kind, mx, my, _model) {
  const overlay = require('../../overlay/pane-menu');
  const layoutSlice = getInstanceSlice('layout');
  const target = (layoutSlice && layoutSlice.paneMenu && layoutSlice.paneMenu.targetPaneId) || null;
  if (!target) return false;
  if (kind === 'wheel-up' || kind === 'wheel-down') {
    const all = overlay.items(target);
    dispatchMsg(wrap('layout', {
      type: 'pane_menu_nav',
      dir: kind === 'wheel-up' ? -1 : +1,
      n: all.length,
      vh: overlay.viewportRows(target),
      sepIdx: all.indexOf(null),
    }));
    render();
    return true;
  }
  if (kind === 'press') {
    const hit = overlay.hitTest(mx, my);
    if (hit) {
      require('./dispatch')._paneMenuPick(target, hit.item);
    } else {
      dispatchMsg(wrap('layout', { type: 'pane_menu_close' }));
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

  if (isPoolDrag) {
    if (kind === 'motion')       dispatchMsg(wrap('layout', { type: 'pool_drag_motion', mx, my, cols: cols() }));
    else if (kind === 'release') dispatchMsg(wrap('layout', { type: 'pool_drag_release' }));
    render();
    return true;
  }

  // (U2f — the flat content-tab-strip press/drag path retired: content is
  // position-tabs now, so free-config tab-reorder is the position-tab drag, not
  // a flat viewer strip. The viewer.tabBoundsFor hit-test + tab_drag_* dispatch
  // are gone.)

  if (kind === 'press' && slice && slice.panelList && slice.panelList.open) {
    const { hitTest } = require('../../overlay/panel-list');
    const mpool = require('../../leaves/wm/pool');
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

/** menu overlay (command list `x` OR right-click context menu) — a click on
 *  a row activates it; a click OUTSIDE the box closes the menu (the missing
 *  dismiss); the wheel moves the highlight. Any button kind counts as a
 *  click (a second right-click while open also dismisses/activates). Motion/
 *  release fall through (caught by the isChainActive guard). */
function _mouseHandleMenuMode(kind, mx, my, _model) {
  if (kind === 'wheel-up' || kind === 'wheel-down') {
    applyMsg({ type: 'menu_nav', dir: kind === 'wheel-up' ? -1 : +1 });
    render();
    return true;
  }
  if (kind === 'press' || kind === 'double' || kind === 'right' || kind === 'middle') {
    const hit = require('../../overlay/menu').hitTest(mx, my);
    if (hit == null) applyMsg({ type: 'menu_close' });          // outside → dismiss
    else if (hit.itemIdx != null) applyMsg({ type: 'menu_activate', idx: hit.itemIdx });
    // else: inside the box on a border / separator — consume, no-op.
    render();
    return true;
  }
  return false;
}

const _modeMouseHandlers = {
  menuOpen:        _mouseHandleMenuMode,
  paneMenuMode:    _mouseHandlePaneMenuMode,
  freeConfigMode:  _mouseHandleFreeConfigMode,
  // agentMode is an in-grid typing mode, not an overlay: the transcript stays
  // fully visible, so the WHEEL passes through to the normal per-pane scroll
  // (the agent arm in _handleWheel). Clicks/drags still fall through to the
  // T13 chain gate below — a modal claims pointer gestures like keystrokes.
  agentMode: (kind, mx, my) => {
    if (kind === 'wheel-up' || kind === 'wheel-down') {
      if (_handleWheel(mx, my, kind === 'wheel-down' ? +1 : -1)) render();
      return true;
    }
    return false;
  },
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
        require('../../io/event-log').record('error', {
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

// v0.6.4 Theme F Phase 4 — side-effect-free hit resolution for a discrete
// button gesture: which pane + which row sits under the cursor. Mirrors the
// click body arm's geometry but WITHOUT its chrome/tab/detail/text-select
// pre-resolution — a button gesture on chrome / a tab / the border lands
// off-row (navIdx < 0) and is therefore inert for an `activate` mapping.
// Returns { paneId, navIdx } (navIdx >= 0 iff on a selectable row), or null
// when the cursor is outside every visible pane.
function _resolveBodyHit(mx, my) {
  const layoutSlice = getInstanceSlice('layout');
  for (const p of allPanels()) {
    const b = visibleBoundsFor(layoutSlice, p.paneId, route.resolveViewerPaneId());
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w || my < b.y || my >= b.y + b.h) continue;
    let navIdx = -1;
    const itemRow = my - b.y - 1;  // -1 for top border
    if (itemRow >= 0) {
      const def = getPanelDef(p.type);
      if (def && typeof def.getItems === 'function') {
        const idx = itemRow + getScroll(p.paneId);
        if (idx < getItems(p.paneId).length) navIdx = idx;
      }
    }
    return { paneId: p.paneId, navIdx };
  }
  return null;
}

// v0.6.4 Theme F follow-on — resolve the CONTEXT under a right-click for the
// context menu: which pane, and the text the "Copy …" entry would yank. For a
// viewer/detail pane that's the plain text of the line under the cursor; for a
// list pane it's the row label; plus the active text selection (if any). Side-
// effect-free (no focus/select change — a right-click only opens the menu).
// Returns { paneKind, lineText, itemLabel, selectionText } or null (outside
// every visible pane).
function _itemText(def, item) {
  if (item == null) return null;
  if (typeof item === 'string') return item;
  // Most navigators expose a filterText selector — the canonical "searchable
  // label" of a row, exactly the display text we want to copy.
  if (def && typeof def.filterText === 'function') {
    try { const t = def.filterText(item); if (t) return String(t); } catch (_) { /* fall through */ }
  }
  return item.label || item.name || item.title || item.text || null;
}

function _resolveContextAt(mx, my) {
  const { stripMarkup } = require('../../leaves/text/ansi');
  const layoutSlice = getInstanceSlice('layout');
  for (const p of allPanels()) {
    const b = visibleBoundsFor(layoutSlice, p.paneId, route.resolveViewerPaneId());
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w || my < b.y || my >= b.y + b.h) continue;
    // Active text selection (docs/pane-selection.md) — POINTER-scoped: the
    // pane under the cursor's own selection wins, so right-clicking a visible
    // highlight always copies THAT text (more than one pane can hold an active
    // selection; the focused-first global scan would pick the wrong one).
    // Falls back to the app-wide selection when the pointer pane owns none.
    // Feeds the context menu's "Copy selection" / "Send selection to port".
    const psel = require('../../panel/select-view');
    const selectionText = psel.selectedTextFor(p.paneId) || psel.selectedText() || null;
    const itemRow = my - b.y - 1;  // -1 for top border
    if (route.isViewerKind(p.paneId)) {   // U2f — content-viewer kinds (info / text-view)
      const d = getInstanceSlice(p.paneId);
      // The active content instance holds its displayed buffer on slice.lines.
      const lines = (d && Array.isArray(d.lines)) ? d.lines : [];
      const li = itemRow + ((d && d.scroll) || 0);
      const lineText = (itemRow >= 0 && li < lines.length) ? stripMarkup(lines[li]) : null;
      return { paneKind: 'detail', lineText, itemLabel: null, selectionText };
    }
    const def = getPanelDef(p.type);
    let itemLabel = null;
    if (itemRow >= 0 && def && typeof def.getItems === 'function') {
      const idx = itemRow + getScroll(p.paneId);
      const items = getItems(p.paneId);
      if (idx < items.length) itemLabel = _itemText(def, items[idx]);
    }
    return { paneKind: p.type, lineText: null, itemLabel, selectionText };
  }
  return null;
}

// Realize the intent a discrete button gesture is bound to (the gesture →
// intent map's right-hand side). The supported vocabulary mirrors
// parser/schema.js VALID_MOUSE_INTENTS. Each branch owns its render().
function _realizeButtonGesture(intentName, x, y, mx, my) {
  switch (intentName) {
    case 'noop':
      return;  // reserved-but-inert (the middle-click default)
    case 'context': {
      // Open the context menu anchored AT the cursor (1-based SGR {x,y}).
      // Resolve what's under the pointer → build the rows: contextual copy
      // entries when on a target, plus the always-present general section, so
      // a right-click on EMPTY space (null ctx) still opens a populated menu.
      const ctx = _resolveContextAt(mx, my) || {};
      const items = require('../../leaves/input/context-menu').buildContextItems(ctx);
      if (!items.length) return;  // safety — the general section keeps this non-empty
      intent.realize(intent.context({ x, y }, { items, title: 'Actions' }));
      render();
      return;
    }
    case 'activate': {
      // Focus + select + activate the row under the cursor — the click body
      // arm's path, gated on landing ON a row.
      const hit = _resolveBodyHit(mx, my);
      if (hit && hit.navIdx >= 0) {
        intent.realize(intent.focusPane(hit.paneId, { skipInfo: true }));
        intent.realize(intent.selectAt(hit.paneId, hit.navIdx));
        intent.realize(intent.activate());
        render();
      }
      return;
    }
    default:
      // Unknown intent — schema validation should make this unreachable;
      // be inert rather than throw on a hot input path.
      return;
  }
}

// ── Per-pane text selection (docs/pane-selection.md) ───────────────────────
// ONE mouse path for every pane — content panes (info / text-view / agent)
// included; their Components claim the wrapped select_* Msgs themselves, every
// other pane gets the loop's generic fallback. A left press ARMS a potential
// selection (records the anchor); the FIRST motion begins it — so a plain
// click still selects a row / focuses, and only a drag starts text selection.
// Module-local, transient (like the free-config drag).
let _armedSelect = null;   // { paneId, line, col } | null

// Is this pane a selection target? Not opted out via config (per-panel
// `select:` / global default — panel/select-config).
function _selectablePane(paneId) {
  if (!paneId) return false;
  const p = allPanels().find((x) => x.paneId === paneId);
  if (!p) return false;
  return require('../../panel/select-config').selectionEnabledFor(paneId);
}

// Map screen (mx,my) → { line (absolute content index), col (display) } inside a
// pane's content region. Absolute line folds in the pane's scroll (0 for the
// non-scrolling list panes) so the selection stays anchored to content, matching
// how the highlight decorates. `clamp` (the motion path) pins an out-of-bounds
// row to the nearest content row so a drag past the pane's edge extends to the
// first/last visible line; without it (the press path) border/outside rows
// return null — a press on the frame must not arm.
function _contentCoordsAt(paneId, mx, my, clamp) {
  const b = visibleBoundsFor(getInstanceSlice('layout'), paneId, route.resolveViewerPaneId());
  if (!b) return null;
  let row = my - b.y - 1;
  if (row < 0 || row > b.h - 3) {              // top/bottom border rows or beyond
    if (!clamp) return null;
    row = Math.max(0, Math.min(b.h - 3, row));
  }
  const cap = require('../../panel/select-view').contentFor(paneId);
  const scroll = cap ? cap.scroll : 0;
  // Selectable extent (docs/pane-selection.md §Interaction) — not every
  // interior row is selectable content. A windowed capture may carry
  // non-content rows after the real content (the agent pane's status/input
  // chrome + its provisional streaming preview — it declares
  // `selectableRows`); a full-content capture simply ends. A press beyond the
  // extent must not arm (the pointer isn't on selectable text); a drag pins to
  // the last selectable row, same as any past-the-edge motion.
  if (cap) {
    const rows = cap.windowed
      ? (cap.selectableRows != null ? cap.selectableRows : cap.lines.length)
      : cap.lines.length - scroll;
    if (rows <= 0) return null;                // nothing selectable this frame
    if (row > rows - 1) {
      if (!clamp) return null;
      row = rows - 1;
    }
  }
  return { line: scroll + row, col: Math.max(0, mx - b.x - 1) };
}

function handleMouse(kind, x, y) {
  // Phase 4 — runtime.update returns NEW model objects; read getModel()
  // at entry so post-Msg state is what subsequent reads see.
  const model = getModel();
  // x, y are 1-based from SGR; convert to 0-based
  const mx = x - 1;
  const my = y - 1;

  // v0.6.6 replay arc — while interactive replay is active it OWNS all mouse
  // input (the reconstructed app underneath is frozen). A press on the mini
  // bar's progress strip seeks to that position; every other mouse event is
  // consumed. Mirrors the keyboard early-route in dispatch.handleKey.
  const _rc = require('../runtime/replay-control');
  if (_rc.active()) {
    if (kind === 'press') {
      const f = require('../../overlay/replay-scrubber').hitTestSeek(mx, my, _rc.renderData());
      if (f != null) _rc.seekToFraction(f);
    }
    return;
  }

  // Panel-chrome glyph clicks — single early hit-test site for both
  // [_]/[+] (collapse, always-on) and [X] (close, free-config-only).
  // The close-button paint is itself gated on free-config in render(),
  // so its hit-test no-ops in normal mode (no glyph there to click).
  // Suppression predicate is narrower than isChainActive: free-config
  // and the in-grid modes (filter/search/prefix/listSelect) still let
  // chrome clicks through; only input-owning modes block them.
  if (kind === 'press' && !suppressesChromeClicks(model.modes)) {
    const { hitTestCollapseButton, hitTestCloseButton } = require('../../panel/chrome-hittest');
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
    // v0.6.4 #1 Step 2 — the unified `[≡]` pane-menu trigger on EVERY
    // pane's top-left. hitTestTrigger returns the SPECIFIC pane whose
    // glyph was clicked (each paints its own); suppression (free-config +
    // modals + nothing-to-show) lives inside it so the click silently
    // misses there. Opening focuses that pane and, for a viewer, seeds
    // the cursor at its active tab (navigators seed 0, and — preserving
    // the old pane-select behavior — don't move focus on open).
    const paneMenu = require('../../overlay/pane-menu');
    const triggerPaneId = paneMenu.hitTestTrigger(mx, my);
    if (triggerPaneId) {
      if (model.modes.paneMenuMode) {
        dispatchMsg(wrap('layout', { type: 'pane_menu_close' }));
      } else {
        let cursor = 0, scroll = 0;
        if (paneMenu._isViewer(triggerPaneId)) {
          const tabCount = paneMenu.items(triggerPaneId).length;
          const vh = paneMenu.viewportRows(triggerPaneId);
          const tab = (getInstanceSlice(triggerPaneId) || {}).tab | 0;
          cursor = Math.max(0, Math.min(tab, Math.max(0, tabCount - 1)));
          scroll = cursor >= vh ? Math.min(cursor - vh + 1, Math.max(0, tabCount - vh)) : 0;
          dispatchMsg(wrap('layout', { type: 'focus_set', focus: triggerPaneId }));
        }
        dispatchMsg(wrap('layout', { type: 'pane_menu_open', paneId: triggerPaneId, cursor, scroll }));
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

  // v0.6.4 Theme F Phase 3+4 — the discrete button gestures (double / right
  // / middle) resolve their intent from the YAML-overridable mouse map
  // (defaults: double→activate, right→context, middle→noop). Realization is
  // uniform (`_realizeButtonGesture`), so a config may remap any of the three
  // onto any supported intent. Chrome (press-only) already ran above; these
  // are gated by the same isChainActive guard, so nothing fires behind an
  // overlay. For a real double, the preceding single press already focused +
  // selected the row via the click body arm below; the `activate` path
  // re-runs focus+select idempotently (and makes a remapped button work too).
  if (kind === 'double' || kind === 'right' || kind === 'middle') {
    const gesture = kind === 'double' ? 'double-click'
                  : kind === 'right'  ? 'right-click'
                  : 'middle-click';
    _realizeButtonGesture(mouseBindings.intentFor(gesture), x, y, mx, my);
    return;
  }

  // Mouse wheel — scrolls the panel under the cursor without changing
  // focus. Detail adjusts the detail scroll; list panels move their own
  // selection. No-op when the wheel landed outside any panel bounds.
  if (kind === 'wheel-up' || kind === 'wheel-down') {
    // v0.6.4 Theme F Phase 2 — pointer scroll routes through the intent
    // layer; realize delegates to _handleWheel (the spatial + per-pane
    // resolution stays there) and returns whether anything changed, so the
    // paint gating is unchanged.
    if (intent.realize(intent.scrollAt(mx, my, kind === 'wheel-down' ? +1 : -1))) render();
    return;
  }

  // Text selection (docs/pane-selection.md) — ONE path for every pane. press
  // (body loop below) arms; the first motion begins; further motion extends;
  // release settles (auto-copy a real drag + keep it highlighted; cancel a
  // no-drag press so a plain click leaves no stray one-char selection). The
  // select_* Msgs ride wrapped to the pane's active instance — content panes
  // claim them in their own update (clamped against their buffer), every other
  // pane gets the loop's generic fallback. Runs ahead of the focus+select loop
  // so a drag extends rather than losing the selection to a focus change.
  // The gesture is scoped to the ARMED pane throughout — never resolved by an
  // ownership scan. More than one pane can hold an active selection by design
  // (a persisted mouse selection + a keyboard visual-mode one, or a hidden tab
  // re-owning on switch-back), and a scan-first pick would extend/settle the
  // WRONG pane's selection (copying stale text on release).
  const psel = require('../../panel/select-view');
  if (kind === 'motion') {
    if (_armedSelect) {
      const paneId = _armedSelect.paneId;
      // First motion after the press: begin at the armed anchor (the armed
      // pane's own selection isn't active yet — the press cancelled priors).
      if (!psel.selectionFor(paneId)) {
        dispatchMsg(wrap(paneId,
          { type: 'select_begin', line: _armedSelect.line, col: _armedSelect.col, kind: 'char' }));
      }
      const cc = _contentCoordsAt(paneId, mx, my, true);   // clamp: drag past the edge pins to the nearest row
      if (cc) dispatchMsg(wrap(paneId, { type: 'select_extend', line: cc.line, col: cc.col }));
      render();
    }
    return;
  }
  if (kind === 'release') {
    if (_armedSelect) {
      const own = psel.selectionFor(_armedSelect.paneId);
      if (own) {
        const s = own.sel;
        const dragged = !(s.anchor.line === s.cursor.line && s.anchor.col === s.cursor.col);
        const text = dragged ? psel.selectedTextFor(_armedSelect.paneId) : '';
        if (text) applyMsg({ type: 'register_push', text });
        else dispatchMsg(wrap(_armedSelect.paneId, { type: 'select_cancel' }));
        render();
      }
      _armedSelect = null;
    }
    return;
  }

  // From here on: press only. The discrete button gestures (double / right /
  // middle) are resolved above through the mouse-bindings map; only a plain
  // left press reaches the chrome/tab/detail pre-resolution + focus+select.
  if (kind !== 'press') return;

  // A new press starts a fresh gesture: disarm any prior selection-arm so a
  // press that lands on a NON-selectable target (viewer body, chrome) can't
  // leave a stale arm that a later motion would begin. The body loop's
  // "Other panels" arm re-sets it when the press lands on a selectable pane.
  _armedSelect = null;

  let mutated = false;

  // Same reason as _handleWheel above: hit-test against ACTUALLY-
  // VISIBLE pane bounds. In half view, the visible-bounds map carries only
  // halfLeftPanel + detail; boundsFor's _currentLayout fallback
  // would return phantom normal-view coords for off-screen panes
  // (containers/groups/files would all "exist" at their normal-
  // view positions, and a click on the visible left half would
  // dispatch focus_set to the first non-detail pane instead of to
  // the actually-visible halfLeftPanel — silently reverting the
  // user's right-arrow selection).
  const layoutSlice = getInstanceSlice('layout');
  for (const p of allPanels()) {
    const b = visibleBoundsFor(layoutSlice, p.paneId, route.resolveViewerPaneId());  // v0.6.4 Phase 2 — paneId, not type (two same-kind panes share a type key)
    if (!b) continue;
    if (mx < b.x || mx >= b.x + b.w || my < b.y || my >= b.y + b.h) continue;

    // Top-border tab-strip — a MULTI-tab slot (the content slot: Info / Transcript
    // / opened content tabs, or any pane with >1 position-tab) renders the unified
    // slot strip (panel/slot-strip). A strip click activates that position-tab.
    // (U2f — the viewer's flat Info/Transcript/content strip + its close-glyph /
    // tab_switch hit-test are gone; every entry is a real position-tab now.)
    if (my === b.y && Array.isArray(p.tabs) && p.tabs.length > 1) {
      const strip = require('../../panel/slot-strip').unifiedSlotStrip(p);
      const localX = mx - b.x;
      for (const tab of (strip ? strip.tabBounds : [])) {
        if (localX >= tab.x && localX < tab.x + tab.w) {
          dispatchMsg(wrap('layout', { type: 'focus_set', focus: p.paneId }));
          dispatchMsg(wrap('layout', { type: 'set_active_tab', paneId: p.paneId, tabPoolId: tab.poolId }));
          mutated = true;
          break;
        }
      }
      if (mutated) break;
    }

    // Focus + select clicked item. A fresh press clears EVERY prior visible
    // selection (more than one pane can hold one — see the gesture note above)
    // and ARMS a new one at the click's content coords; the first motion
    // begins it (so a plain click still selects the row / focuses, only a drag
    // selects text). Content panes (info / text-view / agent) ride the same
    // arm: their instances claim the wrapped select_* Msgs with buffer-clamped
    // coords.
    for (const _prior of psel.activeSelections()) {
      dispatchMsg(wrap(_prior.paneId, { type: 'select_cancel' }));
    }
    if (_selectablePane(p.paneId)) {
      const cc = _contentCoordsAt(p.paneId, mx, my);
      if (cc) _armedSelect = { paneId: p.paneId, line: cc.line, col: cc.col };  // else stays null (cleared above)
    }
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
        // v0.6.4 Theme A Phase 5 — scroll + items for THIS pane (p.paneId).
        const idx = itemRow + getScroll(p.paneId);
        if (idx < getItems(p.paneId).length) navIdx = idx;
      }
    }
    // v0.6.4 Theme F Phase 2 — the spatial resolution above stays here
    // (which pane, which row); the focus + select now route through the
    // shared intent layer instead of inline dispatch, mirroring keyboard.
    // focusPane carries skipInfo so, when a row is also selected, focus_set
    // skips its show_selected_info and navSelect's (against the new cursor)
    // wins — byte-identical to the prior inline focus_set.
    // (Theme A Phase 5 — focus THIS pane by paneId, so clicking a same-kind
    //  pane focuses the one clicked, not the kind's primary.)
    intent.realize(intent.focusPane(p.paneId, { skipInfo: navIdx >= 0 }));
    if (navIdx >= 0) {
      // v0.6.2 — single navSelect path (the `select` intent's absolute
      // form). Sets cursor + fires the auto-yank-or-show_info cascade +
      // the groups_selected cascade for groups.
      intent.realize(intent.selectAt(p.paneId, navIdx));
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
// v0.6.5 §5(a) Phase 3 — PURE classifier for a terminal-mode stdin chunk.
// Decides, given the chunk and the child's DEC mouse-tracking mode, what
// the impure handler should do. No I/O, no session access — unit-testable.
// Returns one of:
//   { kind:'scroll', pages?, toTop?, toBottom? } — a framework scrollback
//        gesture (Shift+Page/Home/End), intercepted regardless of mouseMode.
//   { kind:'forward', data, snap? } — forward raw to the PTY. `snap` asks
//        the caller to return to the live bottom first (a keystroke at the
//        prompt should leave scrollback).
//   { kind:'mouse', lines, residue } — mouseMode is 'none' and the chunk
//        carried SGR mouse bytes: `lines` is the net scrollback delta from
//        wheel events, `residue` is the non-mouse remainder to forward.
//        Non-wheel mouse is dropped (the child never enabled mouse reporting).
function _classifyTerminalChunk(data, mouseMode) {
  // Framework keyboard scrollback — Shift+Page/Home/End (xterm CSI `;2`
  // modifier form). Plain Page/Home/End (no Shift) fall through to the
  // child, which may use them (less / vim).
  if (data === '\x1b[5;2~') return { kind: 'scroll', pages: -1 };   // Shift+PageUp
  if (data === '\x1b[6;2~') return { kind: 'scroll', pages: +1 };   // Shift+PageDown
  if (data === '\x1b[1;2H') return { kind: 'scroll', toTop: true };    // Shift+Home
  if (data === '\x1b[1;2F') return { kind: 'scroll', toBottom: true }; // Shift+End

  // Child enabled mouse reporting → forward everything raw (incl. mouse).
  // Zero regression for mouse-aware children (vim, htop, less --mouse).
  if (mouseMode !== 'none') return { kind: 'forward', data };

  // mouseMode 'none', no mouse bytes → ordinary keystrokes: forward and
  // snap to the live bottom so the user types at the prompt.
  if (!data.includes('\x1b[<')) return { kind: 'forward', data, snap: true };

  // mouseMode 'none' WITH SGR mouse bytes → intercept. Wheels become
  // scrollback; non-wheel mouse drops; non-mouse residue forwards.
  const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
  let lines = 0, residue = '', last = 0, m;
  while ((m = re.exec(data)) !== null) {
    residue += data.slice(last, m.index);
    last = m.index + m[0].length;
    const btn = parseInt(m[1], 10);
    if ((btn & 0x42) === 0x40 && m[4] !== 'm') {  // vertical wheel press (bit6 set, bit1 clear); ignore release
      lines += (btn & 1) ? 3 : -3;                // bit0: down → +3, up → -3
    }
    // horizontal wheel (66/67) + non-wheel mouse (click/motion/release): dropped
  }
  residue += data.slice(last);
  return { kind: 'mouse', lines, residue };
}

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
  // U2d — route to the FOCUSED pane's terminal (a minted `terminal` pane or the
  // legacy viewer terminal). A null id also covers the multi-terminal edge where
  // focus moved onto a non-terminal pane while terminalMode lingered: exit the
  // mode (the key is dropped, as for a dead session — matches pre-U2d).
  const id = focusedTerminalId();
  if (!id || isSessionDead(id)) {
    applyMsg({ type: 'terminal_exit' });
    render();
    return true;
  }
  // v0.6.5 §5(a) Phase 3 — scrollback + smart mouse forwarding.
  const term = require('../../io/terminal');
  const plan = _classifyTerminalChunk(data, term.sessionMouseMode(id));
  if (plan.kind === 'scroll') {
    let moved;
    if (plan.toTop)            moved = term.scrollSessionToTop(id);
    else if (plan.toBottom)    moved = term.scrollSessionToBottom(id);
    else                       moved = term.scrollSessionPages(id, plan.pages);
    if (moved) render();      // skip the repaint when already at the edge
    return true;
  }
  if (plan.kind === 'mouse') {
    let moved = false;
    if (plan.lines) moved = term.scrollSession(id, plan.lines) || moved;
    if (plan.residue) {
      // A keystroke interleaved with the mouse bytes returns us to the
      // prompt before it's forwarded.
      term.scrollSessionToBottom(id);
      writeToSession(id, plan.residue);
      moved = true;
    }
    if (moved) render();
    return true;
  }
  // forward — snap to the live bottom first if a keystroke arrived while
  // scrolled back (only repaint when the snap actually moved the viewport;
  // the PTY's own onData → scheduleOverlay drives the echo otherwise).
  if (plan.snap && term.scrollSessionToBottom(id)) render();
  writeToSession(id, plan.data);
  return true;
}

// Terminal-mode control events the per-chunk exact matches encode: the
// mode-exit chord plus the framework scrollback keys (_classifyTerminalChunk
// / _handleTerminalModeData match these against a WHOLE chunk).
const _TERM_CONTROLS = new Set([
  '\x1c',                                          // Ctrl+\ — exit terminal mode
  '\x1b[5;2~', '\x1b[6;2~', '\x1b[1;2H', '\x1b[1;2F',  // Shift+Page/Home/End
]);

/**
 * Terminal-mode chunk walk (review 2026-08-05). The whole-chunk exact
 * matches above have the same SSH-batching hole the normal-mode ladder
 * had: autorepeat Shift+PageUp arrives as `\x1b[5;2~\x1b[5;2~` in ONE
 * chunk (matched nothing → forwarded to the child), and Ctrl+\ batched
 * behind other keys (`q\x1c`) was forwarded as a literal FS byte instead
 * of exiting — terminal mode WEDGED over a laggy link.
 *
 * Split the chunk into events; consecutive non-control events re-join
 * (tokens are exact contiguous slices, so the PTY receives byte-identical
 * data in ONE write) and each control event exact-matches as before. A
 * trailing partial is NEVER held back from the PTY — it joins the last
 * run (a control sequence split ACROSS chunks doesn't match, same as the
 * pre-tokenizer behavior). Any piece can exit the mode (Ctrl+\ or the
 * dead-session rule); the rest of the chunk then belongs to the
 * normal-mode pipeline and re-emits. A multi-piece walk batches paints
 * (scroll repaints + the exit's full repaint coalesce into one frame).
 */
function _handleTerminalChunk(data, reemit) {
  const { tokens, carry } = tokenizeInput(data);
  const parts = carry ? tokens.concat([carry]) : tokens;
  // Single event (the local per-keystroke case): the historical path.
  if (parts.length <= 1) { _handleTerminalModeData(data); return; }
  beginBatch();
  try {
    let i = 0;
    while (i < parts.length) {
      let piece;
      if (_TERM_CONTROLS.has(parts[i])) {
        piece = parts[i];
        i++;
      } else {
        let j = i;
        while (j < parts.length && !_TERM_CONTROLS.has(parts[j])) j++;
        piece = parts.slice(i, j).join('');
        i = j;
      }
      _handleTerminalModeData(piece);
      if (!getModel().modes.terminalMode) {
        const rest = parts.slice(i).join('');
        if (rest) reemit(rest);
        return;
      }
    }
  } finally { endBatch(); }
}

// --- Stdin setup ---

// T25 — bracketed paste accumulator (B13). A large paste can split
// across multiple stdin chunks (Node's 64KB highWaterMark). The
// pre-fix `startsWith(...200~) && endsWith(...201~)` check failed on
// multi-chunk pastes, falling through to the \x1b defensive fallback
// which fired Esc (closing any open modal); subsequent chunks
// silently dropped.
//
// The historical residual gap — the 6-byte OPEN marker itself splitting
// across chunks (chunk-1 ends `\x1b[20`, chunk-2 starts `0~content...`)
// — is closed by the tokenizer carry (2026-08-05): the trailing partial
// CSI is carried, rejoins the next chunk, and the completed paste-open
// token re-routes the rest of the chunk back through this accumulator
// (see the token loop's _PASTE_OPEN re-emit).
let _pasteBuffer = '';
const _PASTE_MAX = 256 * 1024;   // 256 KB cap (R16)
const _PASTE_OPEN = '\x1b[200~';
const _PASTE_CLOSE = '\x1b[201~';

// One SGR mouse event, anchored — the tokenizer hands us exactly one
// sequence per token. (T25/R15's multi-event-per-chunk handling — fast
// drags coalescing several events into one chunk — now falls out of the
// tokenizer: each event is its own token, and keys interleaved with the
// mouse bytes dispatch too instead of being dropped by the old
// `if (sawMouse) return`.)
const _MOUSE_RE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

// v0.6.4 Theme F Phase 3 — double-click derivation lives HERE, in the
// parser: it is the only layer that sees raw press timing, and a
// self-contained {lastX,lastY,lastTime} triple keeps the derivation off
// the reducer hot path and out of the model. A fresh left press emits the
// `double` gesture when it lands on the SAME 1-based cell as the previous
// press within the window; otherwise `press` (and the triple advances).
// Right (2) → `right`, middle (1) → `middle`; any other button → null
// (dropped, as before).
// v0.6.4 Phase 4 — the window is the YAML-tunable `mouse.double-click-ms`
// (read from the mouse-bindings registry, required at the top of this file;
// defaults to 250 ms).
let _lastClickX = -1, _lastClickY = -1, _lastClickTime = -Infinity;

function _classifyPress(button, x, y, now) {
  if (button === 0) {
    const isDouble = x === _lastClickX && y === _lastClickY
      && (now - _lastClickTime) <= mouseBindings.doubleClickMs();
    if (isDouble) {
      // Reset the triple after a double so a 3rd rapid same-cell click
      // starts a fresh press — otherwise it re-satisfies the window and
      // emits a second `double` (a triple-click → two activations).
      _lastClickX = -1; _lastClickY = -1; _lastClickTime = -Infinity;
      return 'double';
    }
    _lastClickX = x; _lastClickY = y; _lastClickTime = now;
    return 'press';
  }
  if (button === 2) return 'right';
  if (button === 1) return 'middle';
  return null;  // other buttons stay dropped
}

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

  stdin.on('data', _makeDataHandler(stdin));
}

// --- Chunk → token pipeline (network-lag fix, 2026-08-05) -----------------
//
// Locally raw mode fires one 'data' event per keystroke, so the historical
// whole-chunk exact matches (`data === '\x1b[B'`) worked. Over SSH they
// broke two ways:
//   1. Autorepeat BATCHES — one chunk carries `'jjjjj'` or
//      `'\x1b[B\x1b[B\x1b[B'`. The plain-char burst split per char but
//      PAINTED per key (N queued frames per chunk → the crawling-highlight
//      lag over a slow link), and a batched escape-prefixed chunk matched
//      nothing exact and was dropped WHOLE (held arrow-down over a laggy
//      link ate keystrokes).
//   2. TCP splits one sequence ACROSS chunks (`\x1b[` + `B`): the head
//      dropped as unknown-escape, the tail typed a stray plain 'B'.
// The tokenizer leaf splits a chunk into complete events; _dispatchToken
// runs the SAME per-event ladder the whole-chunk matches encoded. A
// multi-token chunk paints ONCE via render-queue beginBatch/endBatch
// (measured: a 5-key burst was 5 frames / 2,963 B per-key, 1 frame /
// 586 B batched); a single-token chunk keeps the synchronous paint, so
// local per-keystroke latency is untouched. An incomplete trailing
// sequence is CARRIED into the next chunk; a short flush timer logs +
// drops it if no continuation arrives (a deliberate Esc-then-`[` can't
// wedge the pipeline — flush equals the old incomplete-chunk treatment).
const _CARRY_FLUSH_MS = 50;
let _carry = '';
let _carryTimer = null;

function _clearCarryTimer() {
  if (_carryTimer) { clearTimeout(_carryTimer); _carryTimer = null; }
}

function _makeDataHandler(stdin) {
  // Re-emit raw bytes as a fresh 'data' event — used when a token flips
  // the input mode mid-chunk (terminal-mode entry routes the rest of the
  // chunk to the PTY; a paste-open routes it into the accumulator). The
  // pending carry belongs after `rest` in stream order, so it rides along.
  const reemit = (rest) => {
    const tail = rest + _carry;
    _carry = '';
    _clearCarryTimer();
    stdin.emit('data', tail);
  };

  return (data) => {
    // Terminal mode: forward to the PTY, matching control events per-EVENT
    // so batched chunks can't wedge the mode (Ctrl+\ exits).
    if (getModel().modes.terminalMode) { _handleTerminalChunk(data, reemit); return; }

    // T25 — bracketed paste accumulator (B13). If we're mid-paste OR
    // this chunk starts with the open marker, route to the accumulator
    // until we see the close marker (or hit the size cap).
    if (_pasteBuffer || data.startsWith(_PASTE_OPEN)) {
      _pasteBuffer += data;
      if (_pasteBuffer.length > _PASTE_MAX) {
        console.error(`[input] bracketed paste exceeded ${_PASTE_MAX} bytes — dropped`);
        require('../../io/event-log').record('input', { kind: 'paste_oversize', size: _pasteBuffer.length });
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

    // Tokenize, joining any partial sequence carried from the previous
    // chunk. A fresh chunk supersedes the pending carry flush.
    _clearCarryTimer();
    const { tokens, carry } = tokenizeInput(_carry + data);
    _carry = carry;
    if (_carry) {
      _carryTimer = setTimeout(() => {
        // No continuation arrived — the "incomplete sequence" was a
        // deliberate Esc-prefix keyboard chord after all. Log + drop,
        // exactly the pre-tokenizer treatment of an incomplete chunk.
        const c = _carry;
        _carry = '';
        _carryTimer = null;
        require('../../io/event-log').record('input', {
          kind: 'unknown_escape',
          bytes: c.length > 64 ? c.slice(0, 64) + '...' : c,
        });
      }, _CARRY_FLUSH_MS);
      if (_carryTimer.unref) _carryTimer.unref();
    }
    if (!tokens.length) return;

    // Multi-token chunk → one trailing paint (render-queue.beginBatch).
    const batch = tokens.length > 1;
    if (batch) beginBatch();
    try {
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        // A token can flip the input mode mid-chunk; the REST of the
        // chunk then belongs to the new mode's parser, not this ladder.
        if (i > 0 && getModel().modes.terminalMode) { reemit(tokens.slice(i).join('')); return; }
        // A paste-open reaching here came from a chunk-split OPEN marker
        // rejoined by the carry (a whole-chunk open hits the accumulator
        // branch above) — hand the rest back so the accumulator owns it.
        if (tok === _PASTE_OPEN) { reemit(tokens.slice(i).join('')); return; }
        _dispatchToken(tok);
      }
      // A terminal-mode flip on the FINAL token leaves no next iteration
      // to hand off through — but the pending carry belongs to the PTY
      // stream now, not the keyboard parser, so forward it the same way.
      if (_carry && getModel().modes.terminalMode) reemit('');
    } finally { if (batch) endBatch(); }
  };
}

// --- Kitty-keyboard detection handshake (docs/kitty-keyboard.md P2) --------
// beginKeyboardDetection() writes the query + DA1 fence (term.queryKKP) and
// arms the response arm below. A kitty-keyboard terminal answers the flags
// report `\x1b[?<flags>u` BEFORE the Primary-DA reply `\x1b[?...c`; a terminal
// without the protocol answers only DA1. On the DA1 fence we finalize: record
// the capability (kkp_detected Msg → model.caps.keyboard) and, on support,
// push our flags via enableKKP(). Both replies tokenize as ordinary CSI
// sequences, so they arrive here through the normal pipeline. The arm is armed
// only during the handshake window, so a stray private-mode CSI can't be
// mistaken for a response afterward.
let _kkpDetecting = false;
let _kkpSawReply = false;
const _KKP_REPLY_RE = /^\x1b\[\?[\d;:]*u$/;   // CSI ? flags u  (kitty flags report)
const _DA1_REPLY_RE = /^\x1b\[\?[\d;]*c$/;    // CSI ? ... c     (Primary DA — the fence)

// Generous safety-net window: a real terminal answers the query near-instantly
// (locally, or one SSH round-trip away). This only fires when a terminal
// answers NEITHER the flags query NOR the DA1 fence — rare — so erring long
// costs nothing but avoids a false "unsupported" on a laggy link.
const _KKP_DETECT_MS = 2000;
let _kkpDetectTimer = null;

function beginKeyboardDetection() {
  _kkpDetecting = true;
  _kkpSawReply = false;
  require('../../io/term').queryKKP();
  // Safety net: if the DA1 fence never comes back (a terminal that ignores the
  // query, or a lost reply), finalize after a short window so caps still
  // resolves and the leader-e hint is still written — rather than staying
  // armed for the session. Unref'd so it never holds the process open; cleared
  // the moment the fence arrives.
  if (_kkpDetectTimer) clearTimeout(_kkpDetectTimer);
  _kkpDetectTimer = setTimeout(_finalizeDetection, _KKP_DETECT_MS);
  if (_kkpDetectTimer.unref) _kkpDetectTimer.unref();
}

// Resolve the auto handshake: record caps ('kitty' iff we saw the flags report
// before the fence), push the flags on support, write the hint. Idempotent via
// the _kkpDetecting guard — the DA1 fence token and the timeout race to call
// this; first wins, the other becomes a no-op.
function _finalizeDetection() {
  if (_kkpDetectTimer) { clearTimeout(_kkpDetectTimer); _kkpDetectTimer = null; }
  if (!_kkpDetecting) return;
  _kkpDetecting = false;
  const supported = _kkpSawReply;
  applyMsg({ type: 'kkp_detected', supported });
  if (supported) require('../../io/term').enableKKP();
  _recordKbdDiag(null);
}

// The diagnostics hint for a failed detection. A multiplexer (tmux/screen/
// zellij) is the common reason a kitty-capable terminal reports "unsupported":
// it answers the DA1 fence itself but doesn't negotiate the protocol for the
// inner app. Name it so the user isn't left blaming their real terminal.
function _kkpUnsupportedMsg() {
  const mux = process.env.TMUX ? 'tmux'
    : process.env.STY ? 'screen'
    : process.env.ZELLIJ ? 'zellij'
    : null;
  return mux
    ? `legacy — kitty keyboard protocol not negotiated (running inside ${mux}; run outside it to enable)`
    : 'legacy — kitty keyboard protocol not supported by this terminal';
}

// Write the leader-e session fact, reading the EFFECTIVE protocol from
// model.caps.keyboard — the single source of truth just set by kkp_detected
// (so caps has a genuine reader, not just a writer). `ctx.forced`/`ctx.disabled`
// pick the explicit-config wording; a null ctx is the auto-detected path.
function _recordKbdDiag(ctx) {
  const diag = require('../../io/diag-log');
  if (getModel().caps.keyboard === 'kitty') {
    diag.info('keyboard', ctx && ctx.forced
      ? 'kitty keyboard protocol force-enabled (keyboard_protocol: kitty)'
      : 'kitty keyboard protocol enabled (CSI-u disambiguate)');
  } else {
    diag.info('keyboard', ctx && ctx.disabled
      ? 'legacy keyboard mode (kitty keyboard protocol disabled)'
      : _kkpUnsupportedMsg());
  }
}

// Apply the boot-resolved keyboard mode (tui.js, after the env/config gate).
// 'auto' runs the detection handshake; 'kitty' force-enables without it;
// 'legacy' stays on the tokenizer path. All three record caps + the hint.
function applyKeyboardMode(mode) {
  if (mode === 'kitty') {
    require('../../io/term').enableKKP();
    applyMsg({ type: 'kkp_detected', supported: true });
    _recordKbdDiag({ forced: true });
  } else if (mode === 'legacy') {
    require('../../io/term').disableKKP();   // authoritative off (a no-op at boot)
    applyMsg({ type: 'kkp_detected', supported: false });
    _recordKbdDiag({ disabled: true });
  } else {
    beginKeyboardDetection();
  }
}

// Consume a handshake response token. Returns true if `tok` was a response
// (so the ladder must not treat it as a key), false otherwise.
function _maybeKkpResponse(tok) {
  if (!_kkpDetecting) return false;
  if (_KKP_REPLY_RE.test(tok)) { _kkpSawReply = true; return true; }
  if (_DA1_REPLY_RE.test(tok)) { _finalizeDetection(); return true; }
  return false;
}

/**
 * One complete input event → the same ladder the whole-chunk handler used
 * to exact-match. Behavior is preserved event-for-event; the ladder now
 * also applies to events that arrive batched, which the exact matches
 * missed (a batched `\r` used to dispatch as a raw char instead of
 * `return`; a batched `\x03` didn't quit).
 */
function _dispatchToken(tok) {
  // Kitty-keyboard handshake replies (only while a detection is in flight).
  if (_maybeKkpResponse(tok)) return;

  // Terminal focus events (DEC 1004). On blur, the periodic
  // refresh loop in tui.js pauses; on focus return, we fire one
  // catch-up refresh immediately so stale data doesn't show.
  if (tok === '\x1b[I') {
    const wasUnfocused = !getModel().focused;
    applyMsg({ type: 'focus_event', focused: true });
    if (wasUnfocused) require('../../leaves/infra/render-queue').scheduleRender();
    return;
  }
  if (tok === '\x1b[O') {
    applyMsg({ type: 'focus_event', focused: false });
    return;
  }

  // SGR mouse event: \x1b[<button;x;yM (press / motion) or m (release).
  const mm = _MOUSE_RE.exec(tok);
  if (mm) return _dispatchMouseEvent(mm);

  if (tok === '\x1b[A') return handleKey('up');
  if (tok === '\x1b[B') return handleKey('down');
  if (tok === '\x1b[C') return handleKey('right');
  if (tok === '\x1b[D') return handleKey('left');
  if (tok === '\x1b[5~') return handleKey('pageup');
  if (tok === '\x1b[6~') return handleKey('pagedown');
  if (tok === '\x1b' || tok === '\x1b\x1b') return handleKey('escape');
  if (tok === '\r' || tok === '\n' || tok === '\r\n') return handleKey('return');
  if (tok === '\x03') { cleanup(); process.exit(0); }
  if (tok === '\x12') return handleKey('ctrl-r');  // Ctrl+R → free-config redo

  // Kitty-keyboard CSI-u key event (`\x1b[<code>;<mods>u`, only arrives once
  // the protocol is enabled). Normalize back to the legacy byte and re-run the
  // ladder (D4) — so Esc→\x1b, Ctrl+C→\x03 (quit), Ctrl+R→\x12 (redo). An event
  // with no legacy equivalent lazytui binds returns null and falls through to
  // the unknown-escape drop below, matching legacy mode.
  if (tok.charCodeAt(0) === 0x1b && tok.charCodeAt(tok.length - 1) === 0x75 /* 'u' */) {
    const legacy = kkpToLegacy(tok);
    if (legacy != null) return _dispatchToken(legacy);
  }

  // T25 / B14 — never fire Esc for an escape-PREFIXED event: F-keys
  // (\x1bOP), Alt-modified keys (\x1b[1;3A, \x1bj), Home/End (\x1b[H,
  // \x1b[F), Shift-Tab (\x1b[Z) etc. would silently cancel any open
  // modal. Esc fires only for the exact forms caught above; other
  // escape-initiated tokens log + drop (event-log, so a maintainer
  // reading a recorded session can see what unknown sequences fired).
  if (tok.charCodeAt(0) === 0x1b) {
    require('../../io/event-log').record('input', {
      kind: 'unknown_escape',
      bytes: tok.length > 64 ? tok.slice(0, 64) + '...' : tok,
    });
    return;
  }

  handleKey(tok, tok);
}

/** One SGR mouse event (an anchored _MOUSE_RE match). */
function _dispatchMouseEvent(mm) {
  const btn      = parseInt(mm[1]);
  const x        = parseInt(mm[2]);
  const y        = parseInt(mm[3]);
  const released = mm[4] === 'm';
  if ((btn & 0x40) !== 0) {
    if (released) return;
    // SGR wheel buttons: 64 = up, 65 = down (VERTICAL); 66 = left, 67 = right
    // (HORIZONTAL tilt-wheel / trackpad side-scroll). Only bit 0 tells up from
    // down, so the old `btn & 1` misread 66 as wheel-up and 67 as wheel-down —
    // a horizontal scroll injected spurious vertical steps, jittering the list
    // cursor during a slow scroll (66/67 interleaved with the real 65s). lazytui
    // has no horizontal axis, so drop 66/67 entirely.
    const low = btn & 0x03;
    if (low === 0)      handleMouse('wheel-up', x, y);
    else if (low === 1) handleMouse('wheel-down', x, y);
    // low === 2 (wheel-left) / 3 (wheel-right): horizontal — ignored.
    return;
  }
  const motion = (btn & 0x20) !== 0;
  const button = btn & 3;
  // Motion + release stay left-only — text-select extend/commit have no
  // right/middle analog, so a right/middle drag or release is dropped
  // exactly as before. Released is checked first (a release-during-drag
  // carries both the 'm' suffix and the motion bit).
  if (released) {
    if (button !== 0) return;
    return handleMouse('release', x, y);
  }
  if (motion) {
    if (button !== 0) return;
    return handleMouse('motion', x, y);
  }
  // Fresh press — classify into press/double (left) or right/middle.
  // v0.6.4 Theme F Phase 3 — was `if (button !== 0) return`, which
  // dropped every non-left button at the door.
  const gesture = _classifyPress(button, x, y, Date.now());
  if (gesture) handleMouse(gesture, x, y);
}

module.exports = {
  setupKeyListener,
  applyKeyboardMode,        // boot: apply the resolved keyboard mode (tui.js)
  beginKeyboardDetection,   // exported for tests (in-process handshake driving)
  _handleTerminalModeData,  // exported for tests
  _classifyTerminalChunk,   // exported for tests (v0.6.5 PTY scrollback classifier)
  _handleWheel,             // exported for tests
  handleMouse,              // exported for tests (T13 modal-gate regression)
  _classifyPress,           // exported for tests (Theme F Phase 3 double-click derivation)
  _makeDataHandler,         // exported for tests (input-burst smoke drives the real handler)
};
