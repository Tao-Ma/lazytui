/**
 * Core Component — layout (chrome-only, no panelTypes).
 *
 * The frame surrounding the panel grid. Owns:
 *   - arrange        — { columns: [{width?, panels}], detailHeightPct, pool }
 *   - focus          — currently focused paneId (Phase B3; v0.7-faithful).
 *                       `_withFocus` normalizes incoming type/id/kind to
 *                       paneId; `mpane.paneMatchesFocus` is the transitional
 *                       read-side comparator (paneId-first, type/id fallback)
 *                       for pre-migration callers.
 *   - viewMode       — normal / half / full
 *   - dirty          — layout has unsaved changes (drives `:save-layout` hint)
 *   - freeConfig     — free-config working state (drag, undo/redo, titleEdit)
 *   - panelList      — `w` overlay state (open, cursor)
 *
 * No `paneBounds` field — pane geometry is a pure derived value (see the
 * `getInstanceSlice` init note + geometry.boundsFor/visibleBoundsFor).
 *
 * No `panelTypes` — this Component renders chrome, not panel content. Spec:
 * docs/v0.5-layout-component.md.
 */
'use strict';

// Pure leaves — take this Component's slice and return a new one.
// No in-place writes, no panel/api reach-around. Called from this
// Component's update, preserving single-writer-per-slice.
const mfc = require('../leaves/free-config');
const mfcCore = require('../leaves/free-config-core');
const mfcMouse = require('../leaves/free-config-mouse');
const mpoolDrag = require('../leaves/free-config-pool-drag');
const mtabDrag = require('../leaves/tab-drag');
const mpool = require('../leaves/pool');
const mpane = require('../leaves/pane');
const { halfProjection, visibleBoundsFor } = require('../leaves/geometry');
const route = require('../panel/route');
const { getInstanceSlice } = require('./api');


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
  const withUndo = skipUndo ? slice : mfcCore.pushUndo(slice);
  const committed = { ...withUndo, arrange: nextArrange, dirty: true };
  // v0.6.4 — an arrange mutation (pool hide/show/swap, column ops, drag)
  // can orphan a half-view projection slot pointing at a now-removed pane.
  // Clear stale slots here, the shared commit point, so the persistent
  // selection stays self-consistent across every arrange-mutating arm
  // (halfProjection also falls back at read time, but this is authoritative).
  return _clearStaleHalfView(committed);
}

/** Null out any halfView slot whose paneId is no longer placed in arrange.
 *  Returns the slice unchanged (same ref) when both slots are still valid. */
function _clearStaleHalfView(slice) {
  const hv = slice.halfView;
  if (!hv || (!hv.left && !hv.right)) return slice;
  const stillPlaced = (id) => !!id && !!mpool.findPaneLocation(slice.arrange, p => p.paneId === id);
  const left = stillPlaced(hv.left) ? hv.left : null;
  const right = stillPlaced(hv.right) ? hv.right : null;
  if (left === hv.left && right === hv.right) return slice;
  return { ...slice, halfView: { left, right } };
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
// v0.6.3 Phase B3 — normalize incoming focus to paneId. Producers
// historically passed a mix of paneId / panel-type / Component
// kind; consumers compared via `p.type === slice.focus` which
// worked by accident of singleton coincidence (type === paneId
// === kind for one-pane-per-kind setups). Multi-instance breaks
// that. Storing paneId is the v0.7-faithful contract; this helper
// looks up the paneId when given a non-paneId value.
function _resolvePaneIdForFocus(slice, focus) {
  if (!focus || !slice || !slice.arrange) return focus;
  const panes = mpool.allPanesInColumns(slice.arrange);
  // Already a paneId? Pass through.
  if (panes.some(p => p.paneId === focus)) return focus;
  // Panel-type / kind / active-tab-id → first matching pane's paneId.
  // Multi-panel Components: returns whichever pane's type matches
  // first (singleton today — deterministic).
  let match = panes.find(p => p.type === focus || p.id === focus);
  // Inactive-tab pool id in a multi-tab pane: pane.id/type mirror the
  // ACTIVE tab; an inactive tab's pool id sits in pane.tabs[].id /
  // .poolId. Scan tabs to map the pool id back to its host pane.
  if (!match) {
    match = panes.find(p =>
      Array.isArray(p.tabs) && p.tabs.some(t => t.id === focus || t.poolId === focus));
  }
  return match ? match.paneId : focus;
}

function _withFocus(slice, focus) {
  if (focus == null) return slice;
  const paneId = _resolvePaneIdForFocus(slice, focus);
  // halfLeftPanel / lastViewerTab — store paneId too. Classify the focused
  // pane from layout's OWN slice.arrange (its `.type`, which mirrors the
  // active tab) rather than reaching into the global route/_instances
  // registry. _resolvePaneIdForFocus already normalized `focus` to a column
  // pane's paneId, so mpool.paneTypeIn resolves it purely. Equivalent to the
  // old route.instanceKind for the singleton case, and MORE correct mid-
  // placement (the in-flight arrange has the just-placed pane before its
  // instance is minted by the post-dispatch reconcile). VIEWER_KIND is a
  // constant, not a topology read. (#1 — layout.update is now pure of route.)
  const kind = mpool.paneTypeIn(slice.arrange, paneId);
  const halfLeftPanel = kind !== route.VIEWER_KIND ? paneId : slice.halfLeftPanel;
  const lastViewerTab = kind === route.VIEWER_KIND ? paneId : slice.lastViewerTab;
  return { ...slice, focus: paneId, halfLeftPanel, lastViewerTab };
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
    // Default focus = the `groups` panel by historical convention
    // (most demo layouts want the user landing on the group tree at
    // startup). state.js initState dispatches set_arrange which
    // normalizes this type-form seed → paneId (`pane-groups`) via
    // `_resolvePaneIdForFocus`. If `groups` isn't placed in the
    // arrange, set_arrange clamps to the first placed pane.
    focus: 'groups',
    viewMode: 'normal',
    dirty: false,
    // Terminal dimensions — the model's copy of the screen size
    // (resize-as-Msg, docs/resize-as-msg.md). Single writer: the
    // `term_resized` arm below. Seeded with a sane default here;
    // state.js initState dispatches the real size at boot, and the
    // tui.js stdout 'resize' listener dispatches every change. All
    // geometry reads go through THIS field, not io/term — one clock.
    dims: { cols: 80, rows: 24 },
    // Free-config working state — the reducer's drag/undo/title-edit
    // sub-state. The active panel (formerly `selectedIdx` here) is
    // derived from `slice.focus` via `mfcCore.selectedIdx(slice)` — single
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
    // NOTE: no `paneBounds` field. Pane geometry is a pure DERIVED value —
    // geometry.boundsFor/visibleBoundsFor compute it from arrange + dims via a
    // memoized selector. (#D7 2026-06-18 retired BOTH the old render-side write
    // — already gone since blessed-exceptions A.2 — AND this production slice
    // field.) Per-panel heights likewise live in geometry, not the slice — see
    // `getPanelViewportH` for the view-mode-aware accessor. The geometry
    // accessors still honor a `slice.paneBounds` OVERRIDE when present, but ONLY
    // unit fixtures set it (injecting known bounds to keep hit-test-math tests
    // decoupled from layout-math); production leaves it unset.
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
    // v0.6.4 — explicit, ephemeral half-view PROJECTION selection: which
    // pane occupies the left / right slot. An override layer over the
    // historical derivation (focused non-detail + major viewer) — when a
    // slot is null the projection falls back to that default, so an
    // untouched config is a strict no-op. Either slot may hold ANY pane,
    // including a viewer (two viewers side-by-side). Set by `view_place_pane`;
    // resolved by leaves/geometry halfProjection. NOT serialized (view mode is
    // runtime focus-state fine-tuning, not a declared layout); slots are
    // cleared when their pane leaves `arrange` (set_arrange / pool_hide).
    halfView: { left: null, right: null },
    // v0.6.4 #1 Step 2 — the unified `[≡]` pane-menu overlay state.
    // Companion to model.modes.paneMenuMode: the mode flag says "a menu
    // is open" (chain-mode keyboard routing, the canonical open-bit);
    // this object says "THIS pane's menu is open and the cursor sits at
    // row N / scrolled to S". null-target when closed. Pane-type-
    // agnostic: subsumes the former `layout.paneSelect` (navigator pool
    // picker) + `layout.tabListOwnerPaneId` (viewer tab switcher) + the
    // viewer slice's `tabList` nav state. Written by the layout
    // reducer's pane_menu_open / _close / _nav arms; resolved by
    // overlay/pane-menu.js.
    paneMenu: { targetPaneId: null, cursor: 0, scroll: 0 },
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
    ((t === 'view_expand' || t === 'view_shrink') && msg.freeConfigMode) ||
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
      //
      // freeConfigMode arrives via the Msg payload — handleAction reads
      // it once at dispatch time and threads it in (msg.freeConfigMode).
      // Pure reducer; no getModel() read here.
      const isUserInput = msg.type === 'view_expand' || msg.type === 'view_shrink';
      if (msg.freeConfigMode && isUserInput) {
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
    // v0.6.4 — half-view PROJECTION selection. Sets which pane occupies the
    // left / right slot (an ephemeral override of the default derivation;
    // see slice.halfView + leaves/geometry halfProjection). Any placed pane is
    // valid in either slot — no detail/viewer exclusion — so two viewers can
    // sit side-by-side. Pure: never mutates arrange. The seam the step-2
    // tab/pane dropdown targets.
    case 'view_place_pane': {
      const slot = msg.slot;
      if (slot !== 'left' && slot !== 'right') return slice;
      // The paneId must be a currently-placed pane.
      if (!mpool.findPaneLocation(slice.arrange, p => p.paneId === msg.paneId)) return slice;
      if (slice.halfView[slot] === msg.paneId) return slice;  // no-op (preserve ref)
      const halfView = { ...slice.halfView, [slot]: msg.paneId };
      // Focus the just-placed pane: it's now guaranteed visible, so chrome
      // focus-border + getPanelViewportH agree, and it seeds the sticky
      // defaults the OTHER (unset) slot falls back to.
      const placed = _withFocus({ ...slice, halfView }, msg.paneId);
      return [placed, [{ type: 'force_full_repaint' }]];
    }
    // v0.6.4 #1 Step 2 — half-view slot placement FROM the pane-menu (the
    // dropdown pick). Sets halfView[slot] = paneId; if the picked pane
    // already occupies the OTHER slot, SWAP: the pane currently in `slot`
    // moves to the other slot so both stay visible (rather than collapsing
    // via halfProjection's right===left rule). Focuses the placed pane.
    // The half-view projection is read via halfProjection (registry-aware,
    // same read renderHalf uses) so the swap matches what's on screen.
    case 'pane_menu_place': {
      const slot = msg.slot;
      if (slot !== 'left' && slot !== 'right') return slice;
      if (!mpool.findPaneLocation(slice.arrange, p => p.paneId === msg.paneId)) return slice;
      const other = slot === 'left' ? 'right' : 'left';
      // viewerPaneId threaded by the dispatching handler (dispatch.js, the
      // impure shell that already resolves it for its own halfProjection) so
      // this arm reads no route topology. (#1)
      const proj = halfProjection(slice, msg.viewerPaneId);
      if (proj[slot] === msg.paneId) return slice;  // already in this slot — no-op
      const halfView = { ...slice.halfView, [slot]: msg.paneId };
      if (proj[other] === msg.paneId) halfView[other] = proj[slot] || null;  // SWAP
      const placed = _withFocus({ ...slice, halfView }, msg.paneId);
      return [placed, [{ type: 'force_full_repaint' }]];
    }
    // Terminal resized (resize-as-Msg P1). Payload from the stdout
    // 'resize' listener (tui.js) or initState's boot seed. Identity-
    // preserving on no-change so resize-event bursts that settle on
    // the same size don't churn the slice ref. No repaint effect —
    // the listener schedules the (debounced) render itself.
    case 'term_resized': {
      const cols = msg.cols | 0, rows = msg.rows | 0;
      if (!cols || !rows) return slice;
      if (slice.dims && slice.dims.cols === cols && slice.dims.rows === rows) return slice;
      return { ...slice, dims: { cols, rows } };
    }
    // focus. Stores the focused panel; refresh of the detail body for
    // the newly-focused panel is an effect (Cmd). msg.focus == null
    // leaves the value put.
    case 'focus_set': {
      // _withFocus stamps focus + sticky halfLeftPanel + sticky
      // lastViewerTab. show_selected_info follows the focus change —
      // UNLESS msg.skipInfo: the caller will fire it itself against a
      // freshly-written cursor (a row-click that follows with navSelect),
      // so cascading here too would double-fire it against the stale
      // pre-write item.
      const next = msg.focus != null ? msg.focus : slice.focus;
      return [_withFocus(slice, next), msg.skipInfo ? [] : [{ type: 'show_selected_info' }]];
    }
    // v0.6.4 #1 Step 2 — unified `[≡]` pane-menu open. Sets the target
    // paneId (the pane whose `[≡]` was clicked / `T` focused) + arms
    // paneMenuMode via an apply_msg Cmd (root chrome flag; single-writer
    // per layer). Initial cursor/scroll arrive on the Msg — for a viewer
    // the caller seeds cursor at the active tab (mirrors the retired
    // tab_list_open's at-active-tab positioning); navigators seed 0.
    case 'pane_menu_open': {
      const paneId = msg.paneId;
      if (!paneId) return slice;
      // Idempotent: re-opening on the same target preserves cursor /
      // scroll (a stray repeat dispatch from the toggle path mustn't
      // reset nav state).
      if (slice.paneMenu && slice.paneMenu.targetPaneId === paneId) return slice;
      const next = { ...slice, paneMenu: {
        targetPaneId: paneId,
        cursor: Math.max(0, msg.cursor | 0),
        scroll: Math.max(0, msg.scroll | 0),
      } };
      return [next, [{ type: 'msg', msg: { type: 'mode_set', flag: 'paneMenuMode' } }]];
    }
    case 'pane_menu_close': {
      // Pure reducer. If already clear (double-close), preserve the
      // target identity but still re-emit mode_clear (idempotent at the
      // runtime layer, runtime.js:885) + force_full_repaint to wipe the
      // dropdown pixels — the overlay is a slice sub-field, not its own
      // diff-tracked surface (same reasoning as panel_list_close).
      const next = (slice.paneMenu && slice.paneMenu.targetPaneId)
        ? { ...slice, paneMenu: { targetPaneId: null, cursor: 0, scroll: 0 } }
        : slice;
      return [next, [
        { type: 'msg', msg: { type: 'mode_clear', flag: 'paneMenuMode' } },
        { type: 'force_full_repaint' },
      ]];
    }
    // cursor/scroll nav inside the open pane-menu. dir ±1 OR
    // to ∈ { top, bottom, pageup, pagedown }. Viewport height (vh) +
    // item count (n) are threaded in by the caller (handler / wheel) so
    // the reducer stays a pure function of (slice, msg).
    case 'pane_menu_nav': {
      if (!slice.paneMenu || !slice.paneMenu.targetPaneId) return slice;
      const pm = slice.paneMenu;
      const n = Math.max(0, msg.n | 0);
      if (n === 0) return slice;
      const vh = Math.max(1, msg.vh | 0);
      let cursor = pm.cursor || 0;
      if      (msg.to === 'top')      cursor = 0;
      else if (msg.to === 'bottom')   cursor = n - 1;
      else if (msg.to === 'pageup')   cursor = Math.max(0, cursor - vh);
      else if (msg.to === 'pagedown') cursor = Math.min(n - 1, cursor + vh);
      else                            cursor = Math.max(0, Math.min(n - 1, cursor + (msg.dir || 0)));
      // Skip the section separator (a non-selectable divider row) — step
      // off it in the direction of travel so the cursor never rests there.
      const sep = Number.isInteger(msg.sepIdx) ? msg.sepIdx : -1;
      if (cursor === sep && sep >= 0) {
        const goingUp = msg.to === 'top' || msg.to === 'pageup' || (msg.dir || 0) < 0;
        cursor = goingUp ? Math.max(0, sep - 1) : Math.min(n - 1, sep + 1);
      }
      let scroll = pm.scroll || 0;
      if (cursor < scroll) scroll = cursor;
      else if (cursor >= scroll + vh) scroll = cursor - vh + 1;
      if (cursor === (pm.cursor || 0) && scroll === (pm.scroll || 0)) return slice;
      return { ...slice, paneMenu: { ...pm, cursor, scroll } };
    }
    // v0.6.3 D3 — atomic pool-swap-by-id. Compound op: validates
    // invariants → swaps OR replaces → closes the pane-select overlay.
    //
    // Semantics by pickedId state:
    //   - pickedId === target's current occupant → no-op (close only).
    //   - pickedId is HIDDEN in pool → REPLACE: target's old occupant
    //     becomes hidden; picked is placed at target's slot.
    //   - pickedId is PLACED elsewhere → SWAP: target's old occupant
    //     moves to where picked was; picked moves to target's slot.
    //
    // Invariant guards (spec § Pane-select dropdown):
    //   - detail can't be picked anywhere — picker excludes it; this
    //     guard is defense-in-depth.
    //   - detail / actions can't be replaced — if the target's
    //     current occupant is reserved, refuse the swap (close still
    //     fires so the user gets feedback the gesture was consumed).
    //   - actions can't end up in non-last column — if picked is
    //     actions AND target's column is not the last, refuse.
    //
    // The close + mode_clear Cmds always fire (even on no-op /
    // refused) so Enter always closes the overlay — the user can't
    // tell the difference between "your pick is invalid" and
    // "your pick is unchanged" without leaving the overlay.
    case 'pool_swap_by_id': {
      const arrange = slice.arrange;
      const { targetPaneId, pickedId } = msg;
      const closeCmds = [
        { type: 'msg', msg: { kind: 'layout', msg: { type: 'pane_menu_close' } } },
      ];
      if (!targetPaneId || !pickedId) return [slice, closeCmds];
      const targetLoc = mpool.findPaneLocation(arrange, p => p.paneId === targetPaneId);
      if (!targetLoc) return [slice, closeCmds];
      // actions can't be replaced; a detail occupant can be replaced only
      // when another viewer remains (v0.6.4 multi-viewer — refuse only the
      // last detail). Detail panes aren't pane-select targets via the UI
      // (they carry the [≡] tab-list trigger, not pane-select), so the
      // detail arm is largely defensive.
      if (mpool.isActionsPane(targetLoc.pane)) return [slice, closeCmds];
      if (mpool.isDetailPane(targetLoc.pane) && mpool.detailPaneCount(arrange) <= 1) return [slice, closeCmds];
      const pickedEntry = (arrange.pool || {})[pickedId];
      if (!pickedEntry) return [slice, closeCmds];
      if (mpool.isDetailPane(pickedEntry)) return [slice, closeCmds];  // defensive: detail isn't a pane-select item
      const lastIdx = mpool.lastColumnIndex(arrange);
      if (mpool.isActionsPane(pickedEntry) && targetLoc.columnIndex !== lastIdx) {
        return [slice, closeCmds];
      }
      // No-op: picked is already the target's occupant.
      if (pickedId === targetLoc.pane.id) return [slice, closeCmds];

      const targetOldEntry = (arrange.pool || {})[targetLoc.pane.id];
      if (!targetOldEntry) return [slice, closeCmds];  // pool inconsistent — bail
      const pickedLoc = mpool.findPaneLocation(arrange, p => p.id === pickedId);
      let nextArrange;
      if (pickedLoc) {
        // SWAP — both placed. Splice the existing pane objects between
        // slots (restamping only columnIndex) so multi-tab panes keep
        // their tabs[] / paneId / activeTabId / collapsed. Re-minting
        // via placementFromPoolEntry would collapse a multi-tab pane
        // to single-tab (wrapAsPane hardcodes tabs:[{single}]) and
        // reset the custom paneId.
        //
        // heightPct is column-local share — strip it on cross-column
        // SWAP so we don't carry col-A's share into col-B (would
        // distort both columns' panel ratios). Same-column SWAP keeps
        // heightPct (pure rearrangement within one column).
        const crossColumn = targetLoc.columnIndex !== pickedLoc.columnIndex;
        const newAtTarget = { ...pickedLoc.pane, columnIndex: targetLoc.columnIndex };
        const newAtPicked = { ...targetLoc.pane, columnIndex: pickedLoc.columnIndex };
        if (crossColumn) {
          delete newAtTarget.heightPct;
          delete newAtPicked.heightPct;
        }
        let mid = arrange;
        if (targetLoc.columnIndex === pickedLoc.columnIndex) {
          mid = mpool.updateColumn(mid, targetLoc.columnIndex, panels => {
            const out = panels.slice();
            out[targetLoc.paneIndex] = newAtTarget;
            out[pickedLoc.paneIndex] = newAtPicked;
            return out;
          });
        } else {
          mid = mpool.updateColumn(mid, targetLoc.columnIndex, panels => {
            const out = panels.slice();
            out[targetLoc.paneIndex] = newAtTarget;
            return out;
          });
          mid = mpool.updateColumn(mid, pickedLoc.columnIndex, panels => {
            const out = panels.slice();
            out[pickedLoc.paneIndex] = newAtPicked;
            return out;
          });
        }
        nextArrange = mfcCore.reassignHotkeys(mid);
      } else {
        // REPLACE — picked is hidden; place it at target's slot.
        // Refuse when target is multi-tab: REPLACE would silently
        // decompose the multi-tab pane into separate hidden pool
        // entries, losing the tabs[] grouping (and any
        // user-customized paneId / activeTabId). User must drop a
        // tab first via tab-list, then REPLACE can fire. Symmetric
        // with the detail/actions reserved-pane refusal above.
        if (Array.isArray(targetLoc.pane.tabs) && targetLoc.pane.tabs.length > 1) {
          return [slice, closeCmds];
        }
        // target's old occupant remains in arrange.pool (now hidden).
        const newAtTarget = mpool.placementFromPoolEntry(pickedEntry, targetLoc.columnIndex);
        const mid = mpool.updateColumn(arrange, targetLoc.columnIndex, panels => {
          const out = panels.slice();
          out[targetLoc.paneIndex] = newAtTarget;
          return out;
        });
        nextArrange = mfcCore.reassignHotkeys(mid);
      }
      const committed = _commitArrange(slice, nextArrange);
      // Focus follows the newly-shown entry at target's slot, matching
      // panel_list_pick's "surface as active" UX. If focus moved, emit
      // show_selected_info so the detail body refreshes.
      const focused = _withFocus(committed, pickedEntry.type);
      const focusCmds = focused.focus !== slice.focus ? [{ type: 'show_selected_info' }] : [];
      return [focused, [...focusCmds, ...closeCmds]];
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
      let hadPaneSelect = false;
      if (msg.arrange !== undefined) {
        // Reject malformed arrange (missing `columns` array) — accepting
        // it would replace a valid layout with a corrupt one and crash
        // the next render. `:restore-layout` always passes a rebuilt
        // valid arrange; direct programmatic dispatches that don't are
        // a bug and should no-op rather than break the live layout.
        if (!msg.arrange || !Array.isArray(msg.arrange.columns)) return slice;
        // v0.6.3 post-arch-arc T3.5 — auto-mint paneId for any pane
        // that's missing one. Production paths use `mpane.wrapAsPane`
        // in the parser; tests + ad-hoc dispatchers that build arrange
        // directly may skip that step. Promoting here means downstream
        // comparators / lookups can collapse to strict paneId form
        // without each fixture having to remember the paneId field.
        // Spread to preserve pool / detailHeightPct / any other top-
        // level arrange fields; replace `columns` with paneId-stamped
        // copies (auto-mint helper above).
        next.arrange = { ...msg.arrange,
          columns: msg.arrange.columns.map(col => ({
            ...col,
            panels: (col.panels || []).map(p =>
              (p && !p.paneId && p.id) ? { ...p, paneId: mpane.newPaneId(p.id) } : p),
          })),
        };
        // An arrange swap orphans every cross-arrange pointer on the
        // slice. Clear them so :restore-layout / set_arrange leaves a
        // self-consistent slice:
        //   - drag: sourceType / target.columnIndex may name panes
        //     and columns that no longer exist.
        //   - panelList.open + cursor: overlay geometry (computed
        //     from arrange) is stale; close defensively.
        //   - paneMenu.targetPaneId: paneId may no longer be placed
        //     (cleared below, with mode_clear, to keep the flag/slice pair
        //     consistent).
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
        // v0.6.4 #1 Step 2 — the unified pane-menu target paneId may name
        // a pane that's no longer placed; defensive close. Emit mode_clear
        // so the flag/slice pair stays consistent (leaving paneMenuMode
        // set after clearing the target = a ghost chain mode that
        // self-heals on next keypress but spends a window inconsistent).
        hadPaneSelect = !!(next.paneMenu && next.paneMenu.targetPaneId);
        if (hadPaneSelect) next.paneMenu = { targetPaneId: null, cursor: 0, scroll: 0 };
        const allPanes = mpool.allPanesInColumns(next.arrange);
        // v0.6.3 Phase B3 — focus is a paneId post-_withFocus normalization.
        // `paneMatchesFocus` tolerates pre-migration callers that still
        // direct-set focus to a panel type or pool id; the resolver
        // below normalizes the survivor to paneId so post-set_arrange
        // slice.focus is always paneId-form (closes the boot-default
        // type-form leak — init's `focus: 'groups'` placeholder gets
        // promoted to `pane-groups` here).
        // Resolve type/id/paneId-form focus → paneId first; THEN check
        // whether it names a placed pane. Without the upfront resolve,
        // a type-form boot default like 'groups' would never match the
        // strict paneMatchesFocus comparator and we'd clamp to the
        // arrange's first pane (containers) instead of honoring the
        // declared default.
        const resolvedFocus = _resolvePaneIdForFocus(next, next.focus);
        const focusStillPlaced = allPanes.some(p => p.paneId === resolvedFocus);
        if (focusStillPlaced) {
          next.focus = resolvedFocus;
        } else if (allPanes.length > 0) {
          next.focus = allPanes[0].paneId || allPanes[0].type;
        }
        // v0.6.4 — half-view projection slots may name a pane the new
        // arrange dropped; clear stale slots so the persistent selection
        // stays self-consistent (set_arrange builds `next` directly rather
        // than via _commitArrange, so apply the same clear here).
        next.halfView = _clearStaleHalfView(next).halfView;
      }
      if (msg.dirty   !== undefined) next.dirty   = !!msg.dirty;
      if (hadPaneSelect) {
        return [next, [{ type: 'msg', msg: { type: 'mode_clear', flag: 'paneMenuMode' } }]];
      }
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
      // (mfcCore.selectedIdx derives the index); fall back to the first
      // placed panel when current focus isn't in the layout (hidden in
      // the pool, or never set).
      const hasHidden = mpool.hiddenIds(slice.arrange).length > 0;
      const all = mpool.allPanesInColumns(slice.arrange);
      const focusedIsPlaced = all.some(p => mpane.paneMatchesFocus(p, slice.focus));
      const focus = focusedIsPlaced ? slice.focus : (all[0] ? (all[0].paneId || all[0].type) : slice.focus);
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
    case 'free_config_reorder':      return mfcCore.clampSelected(mfc.reorderWithin(slice, msg.dir));
    case 'free_config_move_col':     return mfcCore.clampSelected(mfc.moveColumn(slice, msg.dir));
    case 'free_config_resize':       return mfc.resizeWidthOrDetail(slice, msg.delta);
    case 'free_config_panel_height': return mfc.resizeFocusedPanelHeight(slice, msg.delta);
    case 'free_config_undo':         return mfcCore.clampSelected(mfcCore.undo(slice));
    case 'free_config_redo':         return mfcCore.clampSelected(mfcCore.redo(slice));
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
      // Title-edit "is currently open" arrives via msg.freeConfigTitleEditMode
      // — the dispatcher (handleFreeConfigTitleEditKey) reads the flag
      // and threads it. Pure reducer; no getModel() read here.
      if (msg.freeConfigTitleEditMode) {
        next = { ...next, freeConfig: { ...next.freeConfig, titleEdit: { text: '' } } };
      }
      return [next, [{ type: 'msg', msg: { type: 'mode_clear', flag: 'freeConfigTitleEditMode' } }]];
    }
    case 'free_config_mouse_press':  return mfcMouse.mousePress(slice, msg.mx, msg.my, msg.cols);
    case 'free_config_mouse_motion': {
      // Diff-painter trap: between targets, panel content is frozen but
      // the layout reshuffles in the preview render — paintColumns can't
      // tell anything changed, so force a full repaint when the target
      // shifts. Same-zone motion no-ops.
      const next = mfcMouse.mouseMotion(slice, msg.mx, msg.my, msg.cols);
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
      const previewArrange = mfcMouse.computeDragPreviewArrange(next);
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
      const next = mfcMouse.mouseRelease(slice);
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
      // viewerTarget (the reorder dispatch's instance id) + viewerPaneId (the
      // container pane for the drag geometry) are resolved by the dispatching
      // handler (input.js, the impure shell) and threaded on the Msg, so this
      // arm reads no route topology. Today viewer is singleton (viewerTarget
      // == 'detail'); v0.7 multi-viewer changes only the handler's resolution.
      // (#1 — layout.update is now pure of route.)
      const targetKind = msg.viewerTarget || route.VIEWER_KIND;
      // v0.6.3 P4.1: tabBounds moved off layoutSlice.paneBounds.detail.tabs
      // onto the viewer's own slice.
      // v0.6.3 Phase D4 — tabBounds threaded via msg.tabBounds from
      // the input.js tab-drag dispatcher (which has the slice in
      // scope). Reducer no longer cross-reads detail's slice.
      return mtabDrag.tabDragMotion(
        slice, msg.mx, msg.my,
        // v0.6.4 — focused viewer's CONTAINER pane bounds for the drag
        // geometry. visibleBoundsFor (not boundsFor): an off-screen viewer
        // in half/full yields null (tabDragMotion no-ops) instead of a
        // phantom normal-view rect. Single-viewer: the dragged viewer is
        // always on-screen → byte-identical. Reads from `slice` — this
        // reducer's own layout slice (wm-geo P1.2 made the accessor take
        // it explicitly; the old global fetch resolved to the same object).
        // viewerPaneId threaded from the handler (impure shell) — no route read.
        visibleBoundsFor(slice, msg.viewerPaneId, msg.viewerPaneId),
        msg.tabBounds || null,
        msg.modelBundle,
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
      return mfcCore.clearUndoStacks(slice);
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
      const wasFocused = mpane.paneMatchesFocus(pane, slice.focus);
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
      // v0.6.4 multi-viewer — hiding a detail pane is allowed as long as
      // another viewer remains; refuse only when it's the LAST one (the
      // layout must always keep a viewer to route to).
      if (mpool.isDetailPane(entry) && mpool.detailPaneCount(arrange) <= 1) return slice;
      const loc = mpool.findPaneLocation(arrange, p => p.id === id);
      if (!loc) return slice;  // already hidden
      // Strip the pane, then reassign hotkeys across all columns via
      // the leaf's `_reassignHotkeys` — same path used by drag/reorder
      // / new-column-spawn / addColumn / removeColumn. Inline rekey
      // here used to lose actions's '0' / detail's 'o' anchors when
      // the hidden pane shared a column with them.
      const stripped = mpool.updateColumn(arrange, loc.columnIndex, panels =>
        panels.filter((_, i) => i !== loc.paneIndex));
      const nextArrange = mfcCore.reassignHotkeys(stripped);
      const next = _commitArrange(slice, nextArrange);
      // If the hidden panel was focused, focus is now stale (points at
      // a no-longer-placed type). clampSelected snaps it back to a
      // valid panel. When the snap actually moves focus, route through
      // _withFocus so halfLeftPanel + lastViewerTab + show_selected_info
      // stay in lockstep with the focus_set semantics.
      const clamped = mfcCore.clampSelected(next);
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
      // v0.6.4 multi-viewer — a SECOND detail is allowed now; only actions
      // stays capped at one.
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
      // v0.6.4 multi-viewer — only ACTIONS is last-column-only. Pool-drag's
      // validateInsert already refuses to propose other columns for it;
      // this is the defense-in-depth guard for any caller that emits
      // pool_show with a non-last columnIndex directly. Detail places
      // anywhere.
      if (columnIndex !== lastIdx && mpool.isActionsPane(entry)) return slice;
      // Column caps are SOFT — exceeded at parse time emits a warning;
      // runtime placement just allows. The renderer's MIN_PANEL_H +
      // terminal-row floor is the only physical limit.
      const target = mpool.columnPanels(arrange, columnIndex);
      const placement = mpool.placementFromPoolEntry(entry, columnIndex);
      // v0.6.4 multi-viewer — detail is an ordinary pane: insert at the
      // requested index (pool-drag drop) or append (no index). The old
      // "clamp before the last-column detail" rule is gone.
      let idx;
      if (typeof msg.index === 'number') {
        idx = Math.max(0, Math.min(msg.index, target.length));
      } else {
        idx = target.length;
      }
      const inserted = target.slice(0, idx).concat([placement], target.slice(idx));
      // Compound ops (e.g., pool_drag replace = pool_hide + pool_show)
      // set `_skipUndo: true` on the second hop so only the first
      // pushes — otherwise one user gesture bloats the undo stack by 2
      // and `u` lands on a half-state.
      // _skipUndo carried by compound ops (pool_drag replace) so only
      // the first hop pushes — see R2.1.
      const spliced = mpool.updateColumn(slice.arrange, columnIndex, () => inserted);
      const nextArrange = mfcCore.reassignHotkeys(spliced);
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
    // the new column's only pane. v0.6.4 multi-viewer — only ACTIONS is
    // refused (detail spawns a new column freely, including a new last
    // column); the validator enforces the same, this is defense-in-depth.
    case 'pool_show_new_column': {
      const arrange = slice.arrange;
      const id = msg.id;
      const entry = (arrange.pool || {})[id];
      if (!entry) return slice;
      if (mpool.placedIdSet(arrange).has(id)) return slice;  // already placed
      if (mpool.isActionsPane(entry)) return slice;
      const N = mpool.columnCount(arrange);
      const position = msg.position;
      if (typeof position !== 'number' || position < 0 || position > N) return slice;
      const placement = mpool.placementFromPoolEntry(entry, position);
      // Reuse the leaf's pure transform so live preview + commit match.
      const spawned = mpoolDrag.spawnNewColumnArrange(arrange, position, placement);
      // Reassign hotkeys + stamp columnIndex across all columns —
      // splicing in shifts columns at index >= position by +1, so
      // every pane's columnIndex needs to be re-stamped.
      const nextArrange = mfcCore.reassignHotkeys(spawned);
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
      const clamped = mfcCore.clampSelected(next);
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
