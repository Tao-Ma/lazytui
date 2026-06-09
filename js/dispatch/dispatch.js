/**
 * Key/action dispatch — input pump + modal key handlers + leader-chord
 * registry + the applyMsg reducer bridge. The handleAction switch and
 * its action-runner helpers live in ./actions (carved out 2026-05-31);
 * this module re-exports `handleAction` for back-compat.
 *
 * Mode handlers (one per modal state) are selected via modeChain; the
 * first mode whose `active()` predicate returns true claims the key.
 * Add a new mode by appending an entry — never edit handleKey directly.
 *
 * Render contract: handleKey() (the input pump) owns the trailing paint.
 * Effect handlers (handleAction arms in ./actions, mode key handlers,
 * helper fns like startFreeConfig) just mutate state; the diff-render
 * layer below makes a per-key paint cheap, and a single emission point
 * eliminates the "forgot to render" bug class.
 *
 * Sync paint at end of dispatch is the right cadence for the steady
 * state — keystroke echo wants ~16ms, not 50ms. Async producers
 * (streamed action output, docker events, refresh ticks) keep using
 * `scheduleRender` (50ms debounce) to coalesce bursts.
 */
'use strict';

const { allPanels, getSel, switchGroupsTab } = require('../app/state');
const { render } = require('../render/layout');
const { getPanelDef, getItems, idOf, getInstanceSlice,
       getComponentOwningPanel, dispatchMsg, dispatchKeyToFocused, wrap, getFocus,
       instanceKind } = require('../panel/api');
const copy = require('../overlay/copy');
const registerPopup = require('../overlay/register-popup');
const { isTerminalTab, activeTerminalId, findEphemeralByid,
        removeEphemeralTab, isContentTab, activeContentTab,
        removeContentTab } = require('../panel/viewer/tabs');
const { isSessionDead } = require('../io/terminal');
const keybindings = require('./keybindings');
const modes = require('./modes');
const runtime = require('../app/runtime');
const route = require('../leaves/route');
const mpane = require('../leaves/pane');
const { getModel } = runtime;
// handleAction + _runActionByKey live in ./actions (carved out 2026-05-31).
// Cycle-safe: actions.js lazy-requires this module's applyMsg/navSelect
// inline at call sites, so by the time it reads them this module's exports
// are complete.
const { handleAction, _runActionByKey } = require('./actions');

/**
 * Move the focused Navigator's cursor to `index`. Phase 4b — the uniform
 * `nav_select` Msg retires; cursor writes go straight to the owning
 * Component (single-writer for its own nav slice), the body refresh
 * fires as a `show_selected_info` effect, and the groups cascade rides
 * on a wrapped `groups_selected` Msg into the groups Component.
 *
 * Centralized here so every call site (j/k, page nav, goto top/bottom,
 * mouse click, `state.selectGroup`) goes through the same routing.
 * Exported so actions.js's moveSel / _pageInListPanel / _jumpInListPanel
 * (in the carved-out handleAction module) can reach it without a
 * destructure-at-load-time hazard.
 */
// v0.6.1 Phase 6 — producer-side viewer body refresh resolves through
// resolveTarget so multi-viewer (Phase 6+) hits the focused/sticky one.
// null result drops the dispatch silently. Single source of truth:
// the `show_selected_info` Cmd handler in effects.js delegates here,
// and input.js imports this via the dispatch.js exports below.
function showSelectedInfo() {
  const target = route.resolveTarget('viewer');
  if (target) dispatchMsg(wrap(target, { type: 'viewer_show_info' }));
}

function navSelect(panelType, index) {
  // v0.6.2 R6 — single Msg, reducer-emitted cascade. Pre-R6 this
  // handler imperatively dispatched 2-3 Msgs (set_cursor →
  // viewer_show_info → conditional groups_selected); the orchestration
  // was invisible from the reducer's view. The nav_select arm in
  // runtime.update emits the same Cmds in one return, keeping the
  // TEA contract (handler stays a one-liner, reducer cascades).
  applyMsg({ type: 'nav_select', panelType, index });
}

/**
 * Toggle multi-select on the focused panel's currently focused row.
 * No-op if the panel doesn't support `getItems` or has no items.
 */
function toggleMultiSelOnFocused() {
  const focus = getFocus();
  const def = getPanelDef(focus);
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(focus);
  const item = items[getSel(focus)];
  if (item == null) return;
  // Phase 4b — write through the owning Component's nav slice; each
  // Component is the single writer for its own multiSel Set.
  const compName = getComponentOwningPanel(focus);
  if (!compName) return;
  // v0.6.3 post-arch-arc — `focus` is a paneId; nav.apply's multi-panel
  // branch indexes slice.nav by panel-type. Translate so the files /
  // file-browser Components find their entry. Mirrors runtime.js arms
  // (escape / list_select / nav_select).
  const panelType = route.paneTypeOf(focus) || focus;
  dispatchMsg(wrap(compName, { type: 'multisel_toggle', panel: panelType, id: idOf(focus, item) }));
}

/**
 * True when the focused panel is a navigable list (containers / groups
 * / files / actions / …) — i.e. it exposes getItems and isn't the
 * detail panel. Used to gate `v` (enter list-select mode) and `*`.
 */
function _isListPanel(focus) {
  if (instanceKind(focus) === 'detail') return false;
  const def = getPanelDef(focus);
  return !!(def && typeof def.getItems === 'function');
}

/**
 * Add every visible row in the focused panel to multi-selection.
 * Idempotent — already-selected rows stay selected.
 */
function selectAllVisible() {
  const focus = getFocus();
  const def = getPanelDef(focus);
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(focus);
  // Phase 4b — write through the owning Component's nav slice
  // (idempotent on already-selected ids).
  const ids = items.map(item => idOf(focus, item));
  const compName = getComponentOwningPanel(focus);
  if (!compName) return;
  // Translate paneId → panel-type (see toggleMultiSelOnFocused).
  const panelType = route.paneTypeOf(focus) || focus;
  dispatchMsg(wrap(compName, { type: 'multisel_select_all', panel: panelType, ids }));
}

/**
 * True when at least one group declares `quick: true`. Used to gate the
 * panel-aware [ / ] handler — without any pinned groups, the tab UI
 * isn't shown and we let [ / ] fall through to detail-tab cycling.
 */
function _groupsHasQuick() {
  const all = (getModel().config && getModel().config.groups) || {};
  for (const path of Object.keys(all)) {
    if (all[path].quick) return true;
  }
  return false;
}


// --- Mode handlers (one per modal state) ---
//
// Mode handlers mutate state and return; the trailing render() in
// handleKey paints. Order in modeChain is precedence: first matching
// mode handles the key, others don't see it.

function handleMenuKey(key, seq) {
  // Menu lives in the reducer now (menu_open/nav/activate/close);
  // activate emits a menu_action Cmd that routes the verb through handleAction.
  if (key === 'escape') { applyMsg({ type: 'menu_close' }); return; }
  if (key === 'up' || seq === 'k') { applyMsg({ type: 'menu_nav', dir: -1 }); return; }
  if (key === 'down' || seq === 'j') { applyMsg({ type: 'menu_nav', dir: +1 }); return; }
  if (key === 'return') { applyMsg({ type: 'menu_activate' }); }
}

/**
 * Enter `/`-filter mode for the focused panel. The filterable gate is
 * plugin-API (can't live in the reducer), so it's resolved here; then the
 * filter_enter Msg seeds the draft from the committed value. No-op (returns
 * false) when the focused panel isn't filterable.
 */
function _enterFilterMode() {
  const focus = getFocus();
  const def = getPanelDef(focus);
  if (!def || !def.filterable) return false;
  // v0.6.3 post-arch-arc — seed modal.filter.panel as a panel-type so the
  // downstream filter_key / filter_exit arms (which thread msg.panel to
  // wrap(comp, set_cursor/set_filter/clear_filter)) reach nav.apply's
  // multi-panel branch correctly. getFocus() returns a paneId post-Phase-B1.
  // Phase 4c — committed filter text lives on the panel's nav slice;
  // `filter.getFilter()` resolves it via the helper.
  const panelType = route.paneTypeOf(focus) || focus;
  applyMsg({ type: 'filter_enter', panel: panelType, text: require('../panel/api').getFilter(focus) });
  return true;
}

function handleFilterKey(key, seq) {
  if (key === 'escape') { applyMsg({ type: 'filter_exit', keep: false }); showSelectedInfo(); return; }
  if (key === 'return') { applyMsg({ type: 'filter_exit', keep: true  }); showSelectedInfo(); return; }
  if (key === 'up'   || seq === 'k') { handleAction('nav_up');   return; }
  if (key === 'down' || seq === 'j') { handleAction('nav_down'); return; }
  // T26 — thread `key` through so the reducer can detect paste
  // (key='paste', seq=<content>).
  applyMsg({ type: 'filter_key', key, seq });
}

/**
 * `y` entry: collect options (plugin facade — effectful, stays here). 0 → no-op;
 * 1 → copy directly; many → stage the copy menu through update.
 */
function enterCopyMode() {
  const opts = copy.collectOptions();
  if (!opts.length) return;
  if (opts.length === 1) { copy.copyOption(opts[0]); copy.clearOptions(); return; }
  applyMsg({ type: 'copy_enter', options: opts.map(o => ({ label: o.label, cancel: !!o.cancel })) });
}

function handleCopyKey(key, seq) {
  if (key === 'escape') { applyMsg({ type: 'copy_cancel' }); return; }
  if (key === 'return') { applyMsg({ type: 'copy_select' }); return; }
  if (key === 'up' || seq === 'k') { applyMsg({ type: 'copy_nav', dir: -1 }); return; }
  if (key === 'down' || seq === 'j') { applyMsg({ type: 'copy_nav', dir: +1 }); return; }
}

function handleFreeConfigKey(key, seq) {
  // Post-Phase-6 single-writer cleanup: free-config state lives on
  // layout's slice; each key wraps a `free_config_*` Msg into layout.
  // q/Esc/Enter all exit. The leaves/free-config leaf still does the
  // pure layout transform — layout.update calls it on each Msg arrival.
  //
  // v0.6 Phase 4 — the panel-list overlay nests inside free-config:
  // when slice.panelList.open, keys route to the list (nav / pick /
  // close) instead of free-config. Outer Esc/q still exits the whole mode.
  const dispatch = (m) => dispatchMsg(wrap('layout', m));
  const { getInstanceSlice } = require('../panel/api');
  const layoutSlice = getInstanceSlice('layout');
  if (layoutSlice && layoutSlice.panelList && layoutSlice.panelList.open) {
    switch (key) {
      case 'up':    case 'k': dispatch({ type: 'panel_list_nav', dir: -1 }); return;
      case 'down':  case 'j': dispatch({ type: 'panel_list_nav', dir: +1 }); return;
      case 'return':          dispatch({ type: 'panel_list_pick' }); return;
      case 'w': case 'escape': dispatch({ type: 'panel_list_close' }); return;
      case 'q':                dispatch({ type: 'free_config_exit' }); return;
    }
    return;  // swallow other keys while the overlay is open
  }
  switch (key) {
    case 'up':    case 'k': dispatch({ type: 'free_config_nav', dir: -1 }); break;
    case 'down':  case 'j': dispatch({ type: 'free_config_nav', dir: +1 }); break;
    case 'K':               dispatch({ type: 'free_config_reorder', dir: -1 }); break;
    case 'J':               dispatch({ type: 'free_config_reorder', dir: +1 }); break;
    case 'left':  case 'h': dispatch({ type: 'free_config_move_col', dir: -1 }); break;
    case 'right': case 'l': dispatch({ type: 'free_config_move_col', dir: +1 }); break;
    case '+':     case '=': dispatch({ type: 'free_config_resize', delta: +1 }); break;
    case '-':               dispatch({ type: 'free_config_resize', delta: -1 }); break;
    case ']':               dispatch({ type: 'free_config_panel_height', delta: +5 }); break;
    case '[':               dispatch({ type: 'free_config_panel_height', delta: -5 }); break;
    case 't':               dispatch({ type: 'free_config_title_enter' }); break;
    case 'u':               dispatch({ type: 'free_config_undo' }); break;
    case 'ctrl-r':          dispatch({ type: 'free_config_redo' }); break;
    case 'w':               dispatch({ type: 'panel_list_open' }); break;
    case ' ': {
      // v0.6 — collapse-toggle on the FOCUSED placement (the panel
      // under the green focus border). detail is rejected by the
      // reducer; other invariants (drag in flight) are out of band
      // here since handleFreeConfigKey only runs on idle key input.
      const all = layoutSlice ? require('../leaves/pool').allPanesInColumns(layoutSlice.arrange) : [];
      const sel = all.find(p => mpane.paneMatchesFocus(p, layoutSlice && layoutSlice.focus));
      if (sel) dispatch({ type: 'panel_collapse_toggle', id: sel.id });
      break;
    }
    case 'return': case 'q': case 'escape': dispatch({ type: 'free_config_exit' }); break;
  }
}

function handleFreeConfigTitleEditKey(key, seq) {
  if (key === 'escape') { dispatchMsg(wrap('layout', { type: 'free_config_title_cancel' })); return; }
  if (key === 'return') {
    // Thread the active freeConfigTitleEditMode flag through the Msg
    // so the reducer doesn't have to read getModel() (TEA: reducers
    // pure of model.modes). The chain handler fires only when the
    // flag is on, so this is always true here — but the reducer's
    // gate uses it to preserve slice identity in the R1.4 no-panel
    // case (see panel/layout.js comment).
    dispatchMsg(wrap('layout', { type: 'free_config_title_submit', freeConfigTitleEditMode: true }));
    return;
  }
  dispatchMsg(wrap('layout', { type: 'free_config_title_key', key, seq }));
}

function handleCmdlineKey(key, seq) {
  // Folded into update: each key becomes a cmdline_* Msg. Text changes emit a
  // cmdline_rebuild Cmd (the effects layer re-queries the plugin facade — see
  // effects.js). Arrow-key raw escape sequences are kept as fallbacks for
  // callers that don't pre-normalize them to 'up'/'down'.
  if (key === 'escape')                      { applyMsg({ type: 'cmdline_cancel' }); return; }
  if (key === 'return')                      { applyMsg({ type: 'cmdline_submit' }); return; }
  if (key === 'up'   || seq === '\x1b[A')    { applyMsg({ type: 'cmdline_nav', dir: +1 }); return; }
  if (key === 'down' || seq === '\x1b[B')    { applyMsg({ type: 'cmdline_nav', dir: -1 }); return; }
  // T26 — thread `key` so the reducer detects paste (key='paste').
  applyMsg({ type: 'cmdline_key', key, seq });
}

function handleRegisterPopupKey(key, seq) {
  // Folded into update: each key becomes a register_popup_* Msg. `vh` (the
  // viewport height) is resolved here — it reads the terminal size, which is
  // view-derived and must not enter the reducer.
  const vh = registerPopup.viewportRows();
  if (key === 'escape')              { applyMsg({ type: 'register_popup_cancel' }); return; }
  if (key === 'return')              { applyMsg({ type: 'register_popup_commit' }); return; }
  if (key === 'down' || seq === 'j') { applyMsg({ type: 'register_popup_nav', dir: +1, vh }); return; }
  if (key === 'up'   || seq === 'k') { applyMsg({ type: 'register_popup_nav', dir: -1, vh }); return; }
  if (seq === 'g')                   { applyMsg({ type: 'register_popup_nav', to: 'top', vh }); return; }
  if (seq === 'G')                   { applyMsg({ type: 'register_popup_nav', to: 'bottom', vh }); return; }
  if (seq === 'd')                   { applyMsg({ type: 'register_popup_drop', vh }); return; }
}

function handleTabListKey(key, seq) {
  // Routes overlay keys into the tabList reducer on the detail slice.
  // `vh` (viewport rows of the overlay) and `tabCount` are view-derived
  // — resolved here off the overlay module so the reducer can stay pure.
  const overlay = require('../overlay/tab-list');
  const flat = overlay._flatTabs();
  const vh = overlay.viewportRows();
  const tabCount = flat.length;
  // v0.6.1 Phase 8 — tab-list overlay key handler targets the pane that
  // owns the open overlay (layout.tabListOwnerPaneId), not the singleton
  // 'detail' kind. Fallback 'detail' covers the pre-init boot edge.
  const layoutSlice = getInstanceSlice('layout');
  const ownerPaneId = (layoutSlice && layoutSlice.tabListOwnerPaneId) || 'detail';
  const send = (m) => dispatchMsg(wrap(ownerPaneId, m));
  if (key === 'escape' || seq === 'T' || key === 'T') { send({ type: 'tab_list_close' }); return; }
  if (key === 'return') {
    // v0.6.3 Phase 3f: thread targetKey + currentGroup so the leaf's
    // tab_list_pick arm doesn't need ctx.getModel to resolve them.
    const pt = require('../leaves/pane-tabs');
    const ownerSlice = getInstanceSlice(ownerPaneId);
    const idx = (ownerSlice && ownerSlice.tabList && (ownerSlice.tabList.cursor | 0)) || 0;
    const m = getModel();
    send({
      type: 'tab_list_pick',
      targetKey: pt.resolveTabKey(idx, { ...ownerSlice, tab: idx }, m),
      currentGroup: m.currentGroup,
    });
    return;
  }
  if (key === 'up' || seq === 'k')   { send({ type: 'tab_list_nav', dir: -1, vh, tabCount }); return; }
  if (key === 'down' || seq === 'j') { send({ type: 'tab_list_nav', dir: +1, vh, tabCount }); return; }
  if (seq === 'g')                   { send({ type: 'tab_list_nav', to: 'top',      vh, tabCount }); return; }
  if (seq === 'G')                   { send({ type: 'tab_list_nav', to: 'bottom',   vh, tabCount }); return; }
  if (seq === ',' || key === 'pageup')   { send({ type: 'tab_list_nav', to: 'pageup',   vh, tabCount }); return; }
  if (seq === '.' || key === 'pagedown') { send({ type: 'tab_list_nav', to: 'pagedown', vh, tabCount }); return; }
  if (seq === 'x') {
    const slice = getInstanceSlice(ownerPaneId);
    const tl = slice && slice.tabList;
    if (!tl || !tl.open) return;
    const row = flat[tl.cursor];
    if (!row || !row.closeable) return;  // Info / action / yaml-term: silent no-op
    // Thread currentGroup so the reducer arm builds Cmd payloads
    // (viewer_remove_content_tab / viewer_remove_ephemeral_terminal)
    // without reading getModel() (TEA: pure of model state).
    send({ type: 'tab_list_close_selected', closeKind: row.closeKind, closeKey: row.closeKey, currentGroup: getModel().currentGroup });
  }
}

// v0.6.3 D2 — pane-select overlay key handler. Mirrors tab-list:
// up/down/Enter/Esc + page nav. D3 wires pick semantics; for now
// pick simply closes (no-op acknowledgement) until pool_swap_by_id
// lands.
function handlePaneSelectKey(key, seq) {
  if (key === 'escape') {
    applyMsg(wrap('layout', { type: 'pane_select_close' }));
    return;
  }
  const overlay = require('../overlay/pane-select');
  const all = overlay.items();
  const n = all.length;
  const vh = overlay.viewportRows();
  if (key === 'up'   || seq === 'k') { applyMsg(wrap('layout', { type: 'pane_select_nav', dir: -1, n, vh })); return; }
  if (key === 'down' || seq === 'j') { applyMsg(wrap('layout', { type: 'pane_select_nav', dir: +1, n, vh })); return; }
  if (seq === 'g')                   { applyMsg(wrap('layout', { type: 'pane_select_nav', to: 'top',      n, vh })); return; }
  if (seq === 'G')                   { applyMsg(wrap('layout', { type: 'pane_select_nav', to: 'bottom',   n, vh })); return; }
  if (key === 'pageup'   || seq === ',') { applyMsg(wrap('layout', { type: 'pane_select_nav', to: 'pageup',   n, vh })); return; }
  if (key === 'pagedown' || seq === '.') { applyMsg(wrap('layout', { type: 'pane_select_nav', to: 'pagedown', n, vh })); return; }
  if (key === 'return') {
    // v0.6.3 D3 — pick semantics. pool_swap_by_id handles SWAP /
    // REPLACE / no-op + invariant guards; its arm also emits the
    // close Cmd so Enter always exits the overlay (even on refused
    // picks — the user can't tell "invalid" from "unchanged"
    // without leaving).
    const layoutSlice = require('../leaves/route').getInstanceSlice('layout');
    const ps = layoutSlice && layoutSlice.paneSelect;
    if (!ps) { applyMsg(wrap('layout', { type: 'pane_select_close' })); return; }
    const item = all[ps.cursor || 0];
    if (!item) { applyMsg(wrap('layout', { type: 'pane_select_close' })); return; }
    applyMsg(wrap('layout', {
      type: 'pool_swap_by_id',
      targetPaneId: ps.targetPaneId,
      pickedId: item.id,
    }));
    return;
  }
}

function handleJobsKey(key, seq) {
  // View-derived data (count + vh) is computed here and threaded into
  // the Msg payload — reducer stays pure. Return → jobs_activate is a
  // single Msg; the reducer expands it into the Cmd cascade (close +
  // optional group switch + tab_switch + focus + terminal_enter / info
  // card). msg.now feeds the background/tmux age display.
  const overlay = require('../overlay/jobs');
  const count = require('../feature/jobs').list().length;
  const vh = overlay.viewportRows();
  // Close via Esc only — `j` is used for nav inside the overlay so it
  // can't double as the toggle-close gesture the way 'J' did pre-rebind.
  if (key === 'escape') { applyMsg({ type: 'jobs_close' }); return; }
  if (key === 'up'   || seq === 'k') { applyMsg({ type: 'jobs_nav', dir: -1, count, vh }); return; }
  if (key === 'down' || seq === 'j') { applyMsg({ type: 'jobs_nav', dir: +1, count, vh }); return; }
  if (seq === 'g')                   { applyMsg({ type: 'jobs_nav', to: 'top',      count, vh }); return; }
  if (seq === 'G')                   { applyMsg({ type: 'jobs_nav', to: 'bottom',   count, vh }); return; }
  if (seq === ',' || key === 'pageup')   { applyMsg({ type: 'jobs_nav', to: 'pageup',   count, vh }); return; }
  if (seq === '.' || key === 'pagedown') { applyMsg({ type: 'jobs_nav', to: 'pagedown', count, vh }); return; }
  if (key === 'return') {
    // R2 — resolve the cursor's job entry HERE (out-of-TEA store read
    // is handler-side). Reducer at runtime.update#jobs_activate uses
    // msg.job directly — stays pure, no require('feature/jobs').list()
    // call from inside the reducer body.
    const m = require('../app/runtime').getModel();
    const cursor = (m.modal.jobs && m.modal.jobs.cursor | 0) || 0;
    const job = require('../feature/jobs').list()[cursor] || null;
    applyMsg({ type: 'jobs_activate', now: Date.now(), job });
    return;
  }
}

function handleDetailSearchKey(key, seq) {
  // viewer_search_* Msgs are handled by the viewer Component's update —
  // route via the Component fan-out, not the root reducer. v0.6.1 Phase
  // 8 — search mode lives on the focused viewer; target by tab id so
  // multi-viewer is correct (each viewer can have its own search).
  const focus = getFocus();
  if (key === 'escape') { dispatchMsg(wrap(focus, { type: 'viewer_search_cancel' })); return; }
  if (key === 'return') { dispatchMsg(wrap(focus, { type: 'viewer_search_commit' })); return; }
  if (key === 'up')   { dispatchMsg(wrap(focus, { type: 'viewer_search_nav', dir: -1 })); return; }
  if (key === 'down') { dispatchMsg(wrap(focus, { type: 'viewer_search_nav', dir: +1 })); return; }
  dispatchMsg(wrap(focus, { type: 'viewer_search_key', seq }));
}

function handleNormalKey(key, seq) {
  // Phase 4 / T7 — no captured root-model local. Every read goes
  // through getModel() AT the read site so post-dispatch reads (e.g.
  // model.currentGroup after a removeEphemeralTab cascade) see the
  // current snapshot. Same hazard class as 2be348a / action-runner.
  // `dispatchKeyToFocused` (the call site that invokes us) already gave
  // the focused Component first dibs and returned only if the Component
  // didn't claim the keystroke. So no per-key Component-claim check is
  // needed here — every claim, including the detail panel's visual-mode
  // hijack, is folded into the owning Component's `update`.

  // [ / ] are panel-aware tab switchers: if the focused panel owns sub-tabs
  // (today: groups → All/Quick), they cycle those. Otherwise the keys fall
  // through to the global detail-tab cycle below — preserving the prior
  // behavior for users hitting [ / ] from any other panel.
  if ((key === '[' || key === ']') && instanceKind(getFocus()) === 'groups' && _groupsHasQuick()) {
    // toggle_groups_tab moved to groups.update in Phase C — route via
    // the Component fan-out, not the root reducer. state.switchGroupsTab
    // threads the groupsBundle ctx that the reducer arm reads (without
    // it, _msgCtx defaults to an empty groups map → recomputeList
    // returns [] → cursor falls to idx 0 / currentGroup '').
    switchGroupsTab();
    return;
  }
  switch (key) {
    case 'q': { require('../app/cleanup').cleanup(); process.exit(0); break; }
    case 'escape':
      // Esc exits list-select mode (and clears the selection). Outside
      // select mode it clears any lingering multi-selection. When
      // neither applies it's a no-op. (All pure model writes — reducer.)
      applyMsg({ type: 'escape' });
      break;
    case 'v':
      // `v` enters list-select mode on a list panel (mirrors the detail
      // panel's visual mode, which the detail Component claims via its
      // own update when focus=detail). A second `v` exits.
      if (_isListPanel(getFocus())) applyMsg({ type: 'list_select', mode: 'toggle' });
      break;
    case ' ':
      // Space is the leader EXCEPT inside list-select mode on a list
      // panel, where it toggles the focused row (the v0.3 multi-select
      // gesture). Gating on _isListPanel keeps the leader reachable if
      // the flag is still armed but focus has moved to a non-list panel
      // (e.g. detail) — otherwise space would be a dead no-op there.
      // The mode chain already suppresses the leader inside
      // detail-visual / terminal / text modes.
      if (getModel().modes.listSelectMode && _isListPanel(getFocus())) toggleMultiSelOnFocused();
      else                                                         applyMsg({ type: 'enter_prefix' });
      break;
    case '*':
      // Select-all implies select mode so the user can then space-toggle
      // individual rows off. (selectAllVisible reads items via the plugin
      // API — an effect — so it stays a direct call.)
      if (_isListPanel(getFocus())) applyMsg({ type: 'list_select', mode: 'on' });
      selectAllVisible();
      break;
    case 'up': case 'k':   handleAction('nav_up'); break;
    case 'down': case 'j': handleAction('nav_down'); break;
    case 'left': case 'h': handleAction('focus_left'); break;
    case 'right': case 'l':handleAction('focus_right'); break;
    case 'return':
      // Framework default — Component claims for Enter (e.g. config-status
      // expanding a "... N more" row) already returned `_claimed` from
      // their update and short-circuited dispatchKeyToFocused.
      handleAction('run_selected');
      break;
    case 'r':              handleAction('refresh'); break;
    case 'T': {
      // Open the tab-list overlay anchored to the focused-or-sticky
      // viewer's `[≡]` trigger. vh + tabCount are view-derived (read
      // off overlay/tab-list); the reducer clamps cursor at the active
      // tab + computes initial scroll. v0.6.1 Phase 8 — resolveTarget
      // picks the destination pane; null = no viewer, drop.
      const target = route.resolveTarget('viewer');
      if (!target) break;
      const overlay = require('../overlay/tab-list');
      dispatchMsg(wrap(target, {
        type: 'tab_list_open',
        vh: overlay.viewportRows(),
        tabCount: overlay._flatTabs().length,
      }));
      break;
    }
    case 'x': {
      // On a dead ephemeral terminal tab, `x` closes it instead of
      // opening the menu. Lets the user dismiss a non-zero exit
      // (clean exits auto-close from the PTY onExit handler).
      if (instanceKind(getFocus()) === 'detail' && isTerminalTab()) {
        const id = activeTerminalId();
        if (id && isSessionDead(id)) {
          const eph = findEphemeralByid(id);
          if (eph) { removeEphemeralTab(eph.group, eph.key); break; }
        }
      }
      // Content tabs (e.g. file-browser opens) close on `x` from
      // detail focus — no liveness concept like PTYs; users want a
      // close gesture, and `x` mirrors the dead-terminal flow.
      if (instanceKind(getFocus()) === 'detail' && isContentTab()) {
        const ct = activeContentTab();
        if (ct) { removeContentTab(getModel().currentGroup, ct[0]); break; }
      }
      applyMsg({ type: 'menu_open' });
      break;
    }
    case '?':              handleAction('show_help'); break;
    // Tab keys: framework default cycles detail tabs. Panels that own
    // their own ]/[ behavior (config-status's tab cycle) return the
    // `_claimed` sentinel from their update and short-circuit before
    // we reach this switch.
    case ']':              handleAction('next_tab'); break;
    case '[':              handleAction('prev_tab'); break;
    case 'pageup': case ',': handleAction('page_up'); break;
    case 'pagedown': case '.': handleAction('page_down'); break;
    case '<':              handleAction('goto_top'); break;
    case '>':              handleAction('goto_bottom'); break;
    case '+':              handleAction('view_expand'); break;
    case '_':              handleAction('view_shrink'); break;
    case '/':
      // Filter doesn't apply to the (non-list) detail panel — overload
      // `/` there as vim/less-style search instead. Same key, different
      // mode based on focus.
      if (instanceKind(getFocus()) === 'detail') dispatchMsg(wrap(getFocus(), { type: 'viewer_search_enter' }));
      else                                        _enterFilterMode();
      break;
    case 'y':              enterCopyMode(); break;
    case '"':              applyMsg({ type: 'register_popup_enter' }); break;
    case ':':              applyMsg({ type: 'cmdline_enter' }); break;
    default:
      // Numeric hotkey → focus the corresponding panel. Anything else
      // is a no-op at the framework level; the focused Component
      // already saw it via the key Msg broadcast.
      if (allPanels().some(p => p.hotkey === key)) {
        handleAction('focus_panel', key);
      }
  }
}

// --- prefix (leader) mode ---
//
// Enter from handleNormalKey when the leader (space) is pressed outside
// any selection / text mode. Once in prefix mode, each key walks the
// binding tree: a leaf runs + exits, a subtree descends + stays. Esc
// (or a second leader press) cancels. The which-key popup (stage 2)
// renders the available continuations from getModel().prefixNode.

// Prefix mode now lives in the reducer (runtime.update: enter_prefix /
// prefix_key → run_binding Cmd). These remain only as the test-facing entry
// points (and as the names the exports advertise), routing through applyMsg
// so they exercise the real update path. Production drives prefix via
// handleNormalKey's leader case + the modeChain prefix handler, both of
// which already applyMsg the owned model.
function enterPrefix() { applyMsg({ type: 'enter_prefix' }); }

function handlePrefixKey(key, seq) { applyMsg({ type: 'prefix_key', key, seq }); }

// Built-in starter chords. Single keys like `r` / `?` still work bare
// in normal mode; these leader variants are additive (and seed the
// nesting demo via `g g` / `g e`). YAML `keys:` + plugin bindings
// layer on top of the same registry (stages 3 / plugin API).
function _registerBuiltinChords() {
  const b = { builtin: true };
  // Leader chords fire outside the threaded key spine. handleAction now
  // resolves state via getModel() internally (T7), so chord closures
  // don't need to thread the model in themselves.
  keybindings.registerKeyBinding('?',  { label: 'help',    run: () => handleAction('show_help') }, b);
  keybindings.registerKeyBinding('r',  { label: 'refresh', run: () => handleAction('refresh') },   b);
  keybindings.registerKeyBinding('gg', { label: 'top',     run: () => handleAction('goto_top') },  b);
  keybindings.registerKeyBinding('ge', { label: 'bottom',  run: () => handleAction('goto_bottom') }, b);
  keybindings.registerKeyBinding('c',  { label: 'collapse', run: () => handleAction('toggle_collapse_focused') }, b);
  keybindings.registerKeyBinding('j',  { label: 'jobs (running)', run: () => applyMsg({ type: 'jobs_open' }) }, b);
  keybindings.labelSubtree('g', '+goto');
}
_registerBuiltinChords();

/** Build the run() closure for a YAML `keys:` binding spec. The verb
 *  is resolved at INVOKE time so group-relative actions / commands see
 *  the current state, not whatever was current at registration. */
function _bindingRunner(spec) {
  if (spec.builtin) return () => handleAction(spec.builtin);
  if (spec.action)  return () => _runActionByKey(spec.action);
  if (spec.command) return () => require('./cmdline').runCommandString(spec.command);
  return null;
}

// T20 — single-char keys hardcoded into handleNormalKey's switch.
// A user `keys:` binding to any of these registers in the leader tree
// but NEVER fires in normal mode (handleNormalKey claims the keystroke
// first). The user sees "I bound `j` but it still does nav_down" with
// no diagnostic. Warn at registration time.
const _SHADOWED_NORMAL_KEYS = new Set([
  'q', 'v', 'r', 'x', 'y', '?', '/', ':', '"',
  'j', 'k', 'h', 'l', '*', '+', '_', '[', ']',
  ',', '.', '<', '>',
  // Multi-char names that also have hardcoded cases:
  'escape', 'return', 'up', 'down', 'left', 'right',
  'pageup', 'pagedown',
]);

function _collectActionKeys(config) {
  // Build a set of every action's short key for R14's resolution check.
  // v0.6.2 — read the merged (YAML + plugin-synth) set via the
  // canonical accessor so a leader bound to a plugin key (`status`,
  // `up`, …) doesn't false-trip the shadow warning.
  const out = new Set();
  const { getMergedActions } = require('../panel/api');
  for (const gname of Object.keys((config && config.groups) || {})) {
    for (const k of Object.keys(getMergedActions(gname))) out.add(k);
  }
  return out;
}

/**
 * Register every entry in the top-level `keys:` block into the leader
 * binding tree. Called once at boot after the config is loaded (and
 * after plugins, so a project binding can shadow nothing it shouldn't).
 * A conflicting sequence throws from registerKeyBinding — surfaced to
 * the user as a boot error, same as any other config mistake.
 *
 * T20 — also warns on two silent-failure classes that the agent audit
 * flagged: single-char bindings shadowed by handleNormalKey's hardcoded
 * switch, and `action:` bindings whose target doesn't resolve.
 */
function loadKeyBindings(config) {
  const keys = (config && config.keys) || {};
  const actionKeys = _collectActionKeys(config);
  for (const [seq, spec] of Object.entries(keys)) {
    const run = _bindingRunner(spec);
    if (!run) continue;
    // T20 / B12 — shadow warning: a single-key binding here is
    // unreachable in normal mode. The binding still registers (it'll
    // fire after the leader chord), but the user almost certainly
    // didn't intend that.
    if (_SHADOWED_NORMAL_KEYS.has(seq)) {
      console.error(`[keys] binding '${seq}' is shadowed by a built-in normal-mode handler — your binding won't fire on a bare '${seq}' press (only after the leader chord)`);
    }
    // T20 / R14 — `action:` resolves at invoke time via _runActionByKey,
    // which silently returns false for unknown keys. Pre-validate now so
    // a typo gets caught at boot instead of being a dead key forever.
    if (spec.action && !actionKeys.has(spec.action)) {
      console.error(`[keys] binding '${seq}' targets action '${spec.action}' but no action with that short key exists in config — binding will be a silent no-op`);
    }
    const label = spec.label || spec.desc
      || spec.action || spec.builtin || spec.command || seq;
    keybindings.registerKeyBinding(seq, { label, run });
  }
}

// Mode → handler map. The ORDER and the membership of the modal set
// live in js/modes.js (the single source of truth); here we only bind
// each chain mode to its key handler. Precedence is modes.CHAIN_MODES
// order: confirm > prompt > freeConfigTitleEdit > freeConfig > menu > filter >
// copy > detailSearch > registerPopup > prefix > cmd.
//
//   - confirm/prompt: y/N + arg collection, entered from runAction.
//   - freeConfigTitleEdit runs before freeConfigMode so title typing isn't
//     swallowed by free-config navigation.
//   - cmd refreshes the focused panel's info so a `:focus`/command that
//     changes focus is reflected in the trailing paint.
// Every handler routes its keystrokes through `applyMsg` — the reducer
// owns the slice/model writes (post-Phase-4 pure-TEA, the reducer
// returns a new model per Msg). Handlers take `(key, seq)`; the inner
// `handle*Key` helpers read `getModel()` directly where they need it.
// `active` reads through `getModel()` so the chain sees post-Msg state
// across a cascade.
const _modeHandlers = {
  confirmMode:         (key, seq) => {
    // y/Enter accepts (re-emits the staged Cmd), n/Esc rejects; anything
    // else is swallowed so stray keys don't leak to the panel below.
    if (key === 'escape' || seq === 'n' || seq === 'N') applyMsg({ type: 'confirm_reject' });
    else if (seq === 'y' || seq === 'Y' || key === 'return') applyMsg({ type: 'confirm_accept' });
  },
  promptMode:          (key, seq) => {
    if (key === 'escape') applyMsg({ type: 'prompt_cancel' });
    else if (key === 'return') applyMsg({ type: 'prompt_submit' });
    else applyMsg({ type: 'prompt_key', key, seq });
  },
  freeConfigTitleEditMode: (key, seq) => handleFreeConfigTitleEditKey(key, seq),
  freeConfigMode:          (key, seq) => handleFreeConfigKey(key, seq),
  menuOpen:            (key, seq) => handleMenuKey(key, seq),
  filterMode:          (key, seq) => handleFilterKey(key, seq),
  copyMode:            (key, seq) => handleCopyKey(key, seq),
  detailSearchMode:    (key, seq) => handleDetailSearchKey(key, seq),
  registerPopupMode:   (key, seq) => handleRegisterPopupKey(key, seq),
  prefixMode:          (key, seq) => applyMsg({ type: 'prefix_key', key, seq }),
  // Viewer body can't change mid-cmdline-edit; only `cmdline_submit` can
  // change focus, and the verbs that do (`:focus`, `:open`, …) already
  // route through `focus_set` → `show_selected_info`. No per-keystroke
  // refresh needed.
  cmdMode:             (key, seq) => handleCmdlineKey(key, seq),
  tabListMode:         (key, seq) => handleTabListKey(key, seq),
  paneSelectMode:      (key, seq) => handlePaneSelectKey(key, seq),
  jobsMode:            (key, seq) => handleJobsKey(key, seq),
};

const modeChain = modes.CHAIN_MODES.map(flag => {
  const handler = _modeHandlers[flag];
  if (!handler) throw new Error(`mode "${flag}" is in CHAIN_MODES but has no handler in dispatch.js`);
  return { flag, active: () => getModel().modes[flag], handler };
});

// Key-filter middleware (CHANGELOG v0.3.0). Registered callbacks run
// in order, each receiving the current {key, seq} event. A filter may
// return a modified event, return the event unchanged (no-op), or
// return null to suppress the key entirely.
//
// Use cases: keyboard remapping (translate hjkl→up/down/left/right
// in a vim-mode plugin), pre-dispatch logging beyond the event-log
// recording below, key throttling / debouncing, key-press analytics.
const _keyFilters = [];

function registerKeyFilter(fn) {
  if (typeof fn !== 'function') throw new Error('key filter must be a function');
  _keyFilters.push(fn);
}

function clearKeyFilters() {
  _keyFilters.length = 0;
}

// (key, seq) — no model param. 2be348a fixed the captured-stale-ref
// hazard at this layer (handleKey/handleMouse used to receive a `model`
// arg threaded down from setupKeyListener at boot; post-Phase-4 that
// ref froze on the first dispatch). Every downstream call resolves
// state via getModel() / getFocus() / getItems() fresh.
function handleKey(key, seq) {
  // Filter middleware runs first — before logging, before dispatch.
  // A filter that returns null wholly suppresses the event (no log
  // entry, no dispatch, no render).
  let evt = { key, seq };
  for (const f of _keyFilters) {
    evt = f(evt);
    if (evt == null) return;
  }
  ({ key, seq } = evt);

  // Event log (PRINCIPLES.md §11 + CHANGELOG v0.2.0). Recorded once
  // at the dispatch boundary so both modal and normal-key paths land
  // in the log identically. Silent + idempotent when the log is
  // disabled.
  require('./event-log').record('key', { key, seq });
  // A modal mode (filter / menu / cmdline / confirm / …) owns keyboard input
  // while active, so the focused Component must NOT also see the key — else
  // Enter-to-commit-a-/-filter would ALSO navigate a files panel, and typing
  // `i` into a container filter would fire `docker inspect`. The Component key
  // fan-out therefore happens ONLY when the modal gate declines (normal mode).
  // refresh/hub/action Msgs still fan unconditionally (dispatched elsewhere);
  // this gate is for KEY routing alone — see PRINCIPLES §12.
  if (_dispatchActiveMode(key, seq)) { render(); return; }
  // The focused Component sees the key; if its update returns the
  // `_claimed` sentinel effect, the framework default is suppressed
  // (panel claims the keystroke). Otherwise we fall through to the
  // global switch — handleNormalKey re-reads getModel() at entry so
  // the focused Component's apply_msg effects don't leave us with a
  // stale ref (same hazard class as the Phase 4 fix-up at 2be348a).
  const claimed = dispatchKeyToFocused(key, seq);
  if (!claimed) handleNormalKey(key, seq);
  render();
}

/**
 * Run the first active mode's handler, if any. Returns true when a mode
 * claimed the key (caller should paint and stop), false to fall through
 * to normal-mode dispatch.
 *
 * Wedge guard: a handler that throws before clearing its own flag would
 * otherwise trap every subsequent key (Esc included) in the same
 * throwing handler. We force-clear the flag on throw so the user returns
 * to normal-mode dispatch instead of a frozen modal. Painting is the
 * caller's job — this stays render-free so it's unit-testable.
 */
function _dispatchActiveMode(key, seq) {
  for (const m of modeChain) {
    if (m.active()) {
      try {
        m.handler(key, seq);
      } catch (e) {
        console.error('[mode]', m.flag, e && e.message);
        // Persist to the event log too — this is the wedge-guard that
        // hid handleFilterKey (T6) for who-knows-how-long. console.error
        // gets painted over by the next render; the event log file is
        // where future occurrences can be inspected post-mortem.
        try {
          require('./event-log').record('error', {
            where: 'mode_handler', flag: m.flag, key, seq,
            message: e && e.message, stack: e && e.stack,
          });
        } catch (_) { /* event-log unavailable */ }
        // Route the panic-recovery flag-clear through update so single-writer
        // holds even on this exceptional path (the alternative — a direct
        // model.modes[flag]=false here — was the last outside-writer in
        // dispatch.js per docs/v0.5-layering.md step 5).
        applyMsg({ type: 'mode_clear', flag: m.flag });
      }
      return true;
    }
  }
  return false;
}

// --- update spine ---
//
// The reducer (runtime.update) is pure and returns Cmd DESCRIPTORS — it
// performs no effects itself. The interpreter lives in `effects.js`
// (shared with Component `update` so both paths run through the same
// registry); `applyMsg` is the bridge handleAction arms call to feed a
// Msg through update + run the resulting Cmds.
function applyMsg(msg) {
  // Phase 4 — the reducer is pure; the natural source of truth is
  // `getModel()` (a stale captured ref would lose intermediate writes
  // across cascades), so callers pass only `msg`. setModel commits the
  // snapshot BEFORE runEffects so cross-layer Cmds (`apply_msg`,
  // `dispatch_msg`) re-entering the dispatch graph see post-Msg state.
  const [next, cmds] = runtime.update(getModel(), msg);
  runtime.setModel(next);
  require('./effects').runEffects(cmds);
}

module.exports = {
  handleKey, handleAction, applyMsg, navSelect,
  showSelectedInfo,
  registerKeyFilter, clearKeyFilters,
  loadKeyBindings,
  // Exposed so actions.js (the carved-out handleAction switch) can lazy-
  // require _enterFilterMode for its `:filter` arm — keeps the filterable
  // gate single-sourced.
  _enterFilterMode,
  // Exposed for tests
  _enterPrefix: enterPrefix,
  _handlePrefixKey: handlePrefixKey,
  _handleNormalKey: handleNormalKey,
  _dispatchActiveMode,
  _isListPanel,
};
