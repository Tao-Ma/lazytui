/**
 * Key/action dispatch — modal key handlers + handleAction switch.
 *
 * Mode handlers (one per modal state) are selected via modeChain; the
 * first mode whose `active()` predicate returns true claims the key.
 * Add a new mode by appending an entry — never edit handleKey directly.
 *
 * Render contract: handleKey() / handleMouse() (the input pump) own
 * the trailing paint. Effect handlers (handleAction arms, mode key
 * handlers, helper fns like moveSel / startDesignMode / activateTerminal)
 * just mutate state; the diff-render layer below makes a per-key paint
 * cheap, and a single emission point eliminates the "forgot to render"
 * bug class.
 *
 * Sync paint at end of dispatch is the right cadence for the steady
 * state — keystroke echo wants ~16ms, not 50ms. Async producers
 * (streamed action output, docker events, refresh ticks) keep using
 * `scheduleRender` (50ms debounce) to coalesce bursts.
 */
'use strict';

const { esc } = require('../io/ansi');
const { allPanels, setDetail, getSel } = require('../app/state');
const { render } = require('../render/layout');
const { runAction } = require('./action-runner');
const {refreshAll, getPanelDef, getItems, idOf, getGroupActions, getComponentSlice,
       getComponentOwningPanel, dispatchMsg, dispatchKeyToFocused, wrap, getFocus } = require('../panel/api');
const copy = require('../overlay/copy');
const registerPopup = require('../overlay/register-popup');
const { isTerminalTab, activeTerminalId, findEphemeralByid,
        removeEphemeralTab, isContentTab, activeContentTab,
        removeContentTab } = require('../panel/viewer/tabs');
const { isSessionDead, restartSession } = require('../io/terminal');
const { execSync } = require('child_process');
const keybindings = require('./keybindings');
const modes = require('./modes');
const runtime = require('../app/runtime');
const { getModel } = runtime;

/**
 * Synchronously evaluate an action's `default_cmd` to pre-fill its
 * prompt input. Bounded by a short timeout so a misbehaving snippet
 * can't freeze the UI; a failure (non-zero rc, timeout, missing file)
 * silently falls back to empty — the prompt opens as it would have
 * without `default_cmd:`. Stderr is dropped; we don't want grep noise
 * spilling onto the screen between frames.
 */
function resolvePromptDefault(act) {
  if (!act || !act.default_cmd) return '';
  try {
    const out = execSync(act.default_cmd, {
      shell: '/bin/sh',
      cwd: getModel().projectDir,
      timeout: 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return (out || '').trim();
  } catch {
    return '';
  }
}

// --- Selection / focus helpers ---

/**
 * Move the focused Navigator's cursor to `index`. Phase 4b — the uniform
 * `nav_select` Msg retires; cursor writes go straight to the owning
 * Component (single-writer for its own nav slice), the body refresh
 * fires as a `show_selected_info` effect, and the groups cascade rides
 * on a wrapped `groups_selected` Msg into the groups Component.
 *
 * Centralized here so every call site (j/k, page nav, goto top/bottom,
 * mouse click, `state.selectGroup`) goes through the same routing.
 */
// T7: all of navSelect / moveSel / _pageInListPanel / _jumpInListPanel /
// _runResolvedAction / enterFilterMode / enterCopyMode / handleAction once
// took a leading `model` arg that they never read directly (they re-resolve
// via getFocus() / getItems() / getModel() internally). The arg was the
// captured-stale-ref hazard that bit us in 2be348a; dropping it removes
// the invitation to reintroduce that bug class.
function navSelect(panelType, index) {
  const compName = getComponentOwningPanel(panelType);
  if (!compName) return;
  dispatchMsg(wrap(compName, { type: 'set_cursor', panel: panelType, index }));
  dispatchMsg(wrap('detail', { type: 'viewer_show_info' }));
  if (panelType === 'groups') {
    dispatchMsg(wrap('groups', { type: 'groups_selected', index }));
  }
}

/**
 * Generic selection move via plugin API. Resolves the clamped target
 * index (getItems is view-side derivation) then hands it to `navSelect`.
 */
function moveSel(delta) {
  const def = getPanelDef(getFocus());
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(getFocus());
  const sel = getSel(getFocus());
  const newSel = sel + delta;
  if (newSel < 0 || newSel >= items.length) return;
  navSelect(getFocus(), newSel);
}

/**
 * Jump-set the focused list panel's selection to `next` (clamped to
 * [0, len-1]). Used by page_up / page_down / goto_top / goto_bottom on
 * any list-mode panel. No-op for content panels (they don't expose
 * getItems) — the caller branches separately for detail's scroll path.
 *
 * Half-page step matches the detail panel's scroll precedent so paging
 * has consistent rhythm across panels (j/k for one row, ,/. for ~half a
 * panel, </> for ends).
 */
function _pageInListPanel(delta) {
  const def = getPanelDef(getFocus());
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(getFocus());
  if (!items.length) return;
  const sel = getSel(getFocus());
  const next = Math.max(0, Math.min(items.length - 1, sel + delta));
  if (next === sel) return;
  navSelect(getFocus(), next);
}

function _jumpInListPanel(target) {
  const def = getPanelDef(getFocus());
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(getFocus());
  if (!items.length) return;
  const next = target === 'top' ? 0 : items.length - 1;
  const sel = getSel(getFocus());
  if (next === sel) return;
  navSelect(getFocus(), next);
}

function _halfPageStep(panelType) {
  const slice = getComponentSlice('layout');
  const h = (slice && slice.panelHeights[panelType]) || 4;
  return Math.max(1, Math.floor((h - 2) / 2));
}

/**
 * Activate the terminal in the active tab: restart if dead, then enter
 * terminal input mode. Caller should ensure focus is on detail and active
 * tab is a terminal tab.
 */
function activateTerminal() {
  const id = activeTerminalId();
  if (!id) return;
  if (isSessionDead(id)) {
    const slice = getComponentSlice('layout');
    const bounds = slice && slice.panelBounds.detail;
    if (bounds) restartSession(id, bounds.w - 2, bounds.h - 2);
  }
  applyMsg({ type: 'terminal_enter' });
}

function startDesignMode() {
  // Design mode is owned by the layout Component (post-Phase-6
  // single-writer cleanup): entry is a wrapped `design_enter` Msg that
  // resets the slice and emits a `mode_set` Cmd to flip
  // `model.modes.freeConfigMode`. Save stays decoupled (:save-layout); exit
  // emits a show_selected_info Cmd in place of the old onDone callback.
  dispatchMsg(wrap('layout', { type: 'design_enter' }));
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
  dispatchMsg(wrap(compName, { type: 'multisel_toggle', panel: focus, id: idOf(focus, item) }));
}

/**
 * True when the focused panel is a navigable list (containers / groups
 * / files / actions / …) — i.e. it exposes getItems and isn't the
 * detail panel. Used to gate `v` (enter list-select mode) and `*`.
 */
function _isListPanel(focus) {
  if (focus === 'detail') return false;
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
  dispatchMsg(wrap(compName, { type: 'multisel_select_all', panel: focus, ids }));
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
function enterFilterMode() {
  const def = getPanelDef(getFocus());
  if (!def || !def.filterable) return false;
  // Phase 4c — committed filter text lives on the panel's nav slice;
  // `filter.getFilter()` resolves it via the helper.
  applyMsg({ type: 'filter_enter', panel: getFocus(), text: require('../overlay/filter').getFilter(getFocus()) });
  return true;
}

function handleFilterKey(key, seq) {
  if (key === 'escape') { applyMsg({ type: 'filter_exit', keep: false }); dispatchMsg(wrap('detail', { type: 'viewer_show_info' })); return; }
  if (key === 'return') { applyMsg({ type: 'filter_exit', keep: true  }); dispatchMsg(wrap('detail', { type: 'viewer_show_info' })); return; }
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

function handleDesignKey(key, seq) {
  // Post-Phase-6 single-writer cleanup: design state lives on layout's
  // slice; each key wraps a `design_*` Msg into layout. q/Esc/Enter all
  // exit. The leaves/design leaf still does the pure layout transform —
  // layout.update calls it on each Msg arrival.
  const dispatch = (m) => dispatchMsg(wrap('layout', m));
  switch (key) {
    case 'up':    case 'k': dispatch({ type: 'design_nav', dir: -1 }); break;
    case 'down':  case 'j': dispatch({ type: 'design_nav', dir: +1 }); break;
    case 'K':               dispatch({ type: 'design_reorder', dir: -1 }); break;
    case 'J':               dispatch({ type: 'design_reorder', dir: +1 }); break;
    case 'left':  case 'h': dispatch({ type: 'design_move_col', col: 'left' }); break;
    case 'right': case 'l': dispatch({ type: 'design_move_col', col: 'right' }); break;
    case '+':     case '=': dispatch({ type: 'design_resize', delta: +1 }); break;
    case '-':               dispatch({ type: 'design_resize', delta: -1 }); break;
    case ']':               dispatch({ type: 'design_panel_height', delta: +5 }); break;
    case '[':               dispatch({ type: 'design_panel_height', delta: -5 }); break;
    case 't':               dispatch({ type: 'design_title_enter' }); break;
    case 'u':               dispatch({ type: 'design_undo' }); break;
    case 'ctrl-r':          dispatch({ type: 'design_redo' }); break;
    case 'return': case 'q': case 'escape': dispatch({ type: 'design_exit' }); break;
  }
}

function handleDesignTitleEditKey(key, seq) {
  if (key === 'escape') { dispatchMsg(wrap('layout', { type: 'design_title_cancel' })); return; }
  if (key === 'return') { dispatchMsg(wrap('layout', { type: 'design_title_submit' })); return; }
  dispatchMsg(wrap('layout', { type: 'design_title_key', key, seq }));
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

function handleDetailSearchKey(key, seq) {
  // viewer_search_* Msgs are handled by detail.update (Phase B) — route via
  // the Component fan-out, not the root reducer. Phase 2b will wrap these.
  if (key === 'escape') { dispatchMsg(wrap('detail', { type: 'viewer_search_cancel' })); return; }
  if (key === 'return') { dispatchMsg(wrap('detail', { type: 'viewer_search_commit' })); return; }
  if (key === 'up')   { dispatchMsg(wrap('detail', { type: 'viewer_search_nav', dir: -1 })); return; }
  if (key === 'down') { dispatchMsg(wrap('detail', { type: 'viewer_search_nav', dir: +1 })); return; }
  dispatchMsg(wrap('detail', { type: 'viewer_search_key', seq }));
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
  if ((key === '[' || key === ']') && getFocus() === 'groups' && _groupsHasQuick()) {
    // toggle_groups_tab moved to groups.update in Phase C — route via
    // the Component fan-out, not the root reducer.
    dispatchMsg(wrap('groups', { type: 'toggle_groups_tab' }));
    return;
  }
  switch (key) {
    case 'q': applyMsg({ type: 'quit' }); break;
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
    case 'x': {
      // On a dead ephemeral terminal tab, `x` closes it instead of
      // opening the menu. Lets the user dismiss a non-zero exit
      // (clean exits auto-close from the PTY onExit handler).
      if (getFocus() === 'detail' && isTerminalTab()) {
        const id = activeTerminalId();
        if (id && isSessionDead(id)) {
          const eph = findEphemeralByid(id);
          if (eph) { removeEphemeralTab(eph.group, eph.key); break; }
        }
      }
      // Content tabs (e.g. file-browser opens) close on `x` from
      // detail focus — no liveness concept like PTYs; users want a
      // close gesture, and `x` mirrors the dead-terminal flow.
      if (getFocus() === 'detail' && isContentTab()) {
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
      if (getFocus() === 'detail') dispatchMsg(wrap('detail', { type: 'viewer_search_enter' }));
      else                          enterFilterMode();
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
  keybindings.labelSubtree('g', '+goto');
}
_registerBuiltinChords();

/** Run a resolved action object, routing through the same args-prompt /
 *  confirm path the actions-panel Enter flow uses. Single definition so
 *  the panel, the leader bindings, and any future caller can't drift on
 *  how `args:` / `confirm:` are handled. */
function _runResolvedAction(key, act) {
  if (act.args) {
    const initial = resolvePromptDefault(act);
    // Seed the autosuggest ghost from the yank register's top (first line).
    const top = require('../feature/register').top();
    const ghost = String(top || '').split('\n')[0];
    // Stage the prompt through update with a base run_action Cmd — submit
    // parses args + re-enters runAction (so an action that's ALSO confirm:
    // still confirms after the prompt). The Cmd carries data, not a closure.
    applyMsg({
      type: 'prompt_enter',
      label: `Run: ${act.label}`, spec: act.args, text: initial,
      ghost: ghost && ghost !== initial ? ghost : '',
      cmd: { type: 'run_action', actionKey: key, action: act },
    });
  } else {
    runAction(key, act);
  }
}

/** Run a declared action by its key, searching every group. Resolves
 *  the SAME merged set the actions panel shows — plugin-synthesized
 *  actions (docker's `up`/`logs`/…) plus YAML `actions:` — so a leader
 *  binding to a plugin action isn't silently dead. First match wins. */
function _runActionByKey(key) {
  const groups = (getModel().config && getModel().config.groups) || {};
  for (const [gname, g] of Object.entries(groups)) {
    const merged = { ...getGroupActions(g, gname), ...(g.actions || {}) };
    const act = merged[key];
    if (!act) continue;
    _runResolvedAction(key, act);
    return true;
  }
  return false;
}

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
  const out = new Set();
  for (const g of Object.values((config && config.groups) || {})) {
    for (const k of Object.keys((g && g.actions) || {})) out.add(k);
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
// order: confirm > prompt > designTitleEdit > design > menu > filter >
// copy > detailSearch > registerPopup > prefix > cmd.
//
//   - confirm/prompt: y/N + arg collection, entered from runAction.
//   - designTitleEdit runs before freeConfigMode so title typing isn't
//     swallowed by design navigation.
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
  designTitleEditMode: (key, seq) => handleDesignTitleEditKey(key, seq),
  freeConfigMode:          (key, seq) => handleDesignKey(key, seq),
  menuOpen:            (key, seq) => handleMenuKey(key, seq),
  filterMode:          (key, seq) => handleFilterKey(key, seq),
  copyMode:            (key, seq) => handleCopyKey(key, seq),
  detailSearchMode:    (key, seq) => handleDetailSearchKey(key, seq),
  registerPopupMode:   (key, seq) => handleRegisterPopupKey(key, seq),
  prefixMode:          (key, seq) => applyMsg({ type: 'prefix_key', key, seq }),
  cmdMode:             (key, seq) => { handleCmdlineKey(key, seq); dispatchMsg(wrap('detail', { type: 'viewer_show_info' })); },
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

// --- handleAction: name → effect ---
//
// Effect arms are mutation-only. Caller (handleKey, handleMouse, the
// menu Enter path) owns the trailing paint. Arms resolve a Msg from the
// model and call applyMsg(msg) — the reducer is the writer.

function handleAction(action, arg) {
  switch (action) {
    case 'nav_up':       moveSel(-1); break;
    case 'nav_down':     moveSel(+1); break;
    case 'focus_left': {
      const order = allPanels().map(p => p.type);
      const idx = order.indexOf(getFocus());
      dispatchMsg(wrap('layout', { type: 'focus_set', focus: idx > 0 ? order[idx - 1] : getFocus() }));
      break;
    }
    case 'focus_right': {
      const order = allPanels().map(p => p.type);
      const idx = order.indexOf(getFocus());
      dispatchMsg(wrap('layout', { type: 'focus_set', focus: idx < order.length - 1 ? order[idx + 1] : getFocus() }));
      break;
    }
    case 'focus_panel': {
      let target = getFocus();
      for (const p of allPanels()) {
        if (p.hotkey === arg) { target = p.type; break; }
      }
      dispatchMsg(wrap('layout', { type: 'focus_set', focus: target }));
      break;
    }
    case 'run_selected': {
      // Enter on detail + terminal tab → activate terminal mode
      if (getFocus() === 'detail' && isTerminalTab()) {
        activateTerminal();
        break;
      }
      // Enter on groups: branches toggle expand/collapse one level;
      // leaves drill into the actions panel. This is the only tree-shape
      // keybinding — recursive expand/collapse have no dedicated key,
      // hammering Enter walks down levels (cursor stays put, the row
      // below opens or closes). Avoids the prior "drill to empty actions"
      // smell when a branch had no own actions.
      if (getFocus() === 'groups') {
        const items = getItems('groups');
        const row = items[getSel('groups')];
        if (row && row.children && row.children.length > 0) {
          // toggle_group moved to groups.update in Phase C — route via
          // the Component fan-out, not the root reducer.
          dispatchMsg(wrap('groups', { type: 'toggle_group', name: row.name }));
          break;
        }
        // Leaf: drill into the actions panel (a plain focus change).
        dispatchMsg(wrap('layout', { type: 'focus_set', focus: 'actions' }));
        break;
      }
      // Enter on actions → run selected action. If the action declares
      // `args:`, open the prompt overlay first to collect positional
      // params; submit then forwards them to runAction. Cmdline (`:`)
      // already carries args inline, so this only matters for the
      // actions-panel path.
      if (getFocus() === 'actions') {
        const items = getItems('actions');
        const item = items[getSel('actions')];
        if (item) {
          const [key, act] = item;
          _runResolvedAction(key, act);
        }
      } else {
        dispatchMsg(wrap('detail', { type: 'viewer_show_info' }));
      }
      break;
    }
    case 'refresh':
      // Async — refreshAll's resolve drives a scheduleRender via
      // changed-flag bookkeeping in the refresh loop. The trailing
      // sync paint here gives immediate feedback that "something
      // happened" even before refresh completes.
      applyMsg({ type: 'refresh' });
      break;
    case 'show_help':
      applyMsg({ type: 'show_help' });
      break;
    case 'next_tab': applyMsg({ type: 'next_tab' }); break;
    case 'prev_tab': applyMsg({ type: 'prev_tab' }); break;
    case 'page_up': {
      // Paging is focus-aware: detail scrolls its content; list panels
      // jump the cursor by half a panel (the nav_select cascade, now run
      // inline in the reducer). Other panel modes (e.g. stats content)
      // get no-op — they don't expose getItems().
      if (getFocus() === 'detail') dispatchMsg(wrap('detail', { type: 'viewer_scroll', delta: -_halfPageStep('detail') }));
      else                          _pageInListPanel(-_halfPageStep(getFocus()));
      break;
    }
    case 'page_down': {
      if (getFocus() === 'detail') dispatchMsg(wrap('detail', { type: 'viewer_scroll', delta: +_halfPageStep('detail') }));
      else                          _pageInListPanel(+_halfPageStep(getFocus()));
      break;
    }
    case 'goto_top':
      if (getFocus() === 'detail') dispatchMsg(wrap('detail', { type: 'viewer_scroll', to: 'top' }));
      else                          _jumpInListPanel('top');
      break;
    case 'goto_bottom':
      if (getFocus() === 'detail') dispatchMsg(wrap('detail', { type: 'viewer_scroll', to: 'bottom' }));
      else                          _jumpInListPanel('bottom');
      break;
    case 'view_expand':
      // Through the Component fan-out: layout's update flips viewMode and
      // returns a force_full_repaint effect on a real transition (a view
      // change re-exposes panels the diff cache can't tell changed). Phase
      // 1b moved viewMode out of the root reducer into layout's slice.
      dispatchMsg(wrap('layout', { type: 'view_expand' }));
      break;
    case 'view_shrink':
      dispatchMsg(wrap('layout', { type: 'view_shrink' }));
      break;
    case 'filter':
      // Reachable from the menu + `:filter`. Same filterable-gated enter.
      enterFilterMode();
      break;
    case 'design':
      // Reachable from menu entry and `:design` cmdline. The design-enabled
      // gate lives in the reducer (update emits the start_design Cmd only
      // when enabled) — same gate the cmdline command uses for visibility.
      applyMsg({ type: 'design' });
      break;
    case 'quit':
      applyMsg({ type: 'quit' });
      break;
  }
}

module.exports = {
  handleKey, handleAction, applyMsg, navSelect, startDesignMode,
  registerKeyFilter, clearKeyFilters,
  loadKeyBindings,
  // Exposed for tests
  _enterPrefix: enterPrefix,
  _handlePrefixKey: handlePrefixKey,
  _handleNormalKey: handleNormalKey,
  _dispatchActiveMode,
  _isListPanel,
};
