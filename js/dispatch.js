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

const { esc } = require('./ansi');
const { allPanels, setDetail, getSel } = require('./state');
const { render } = require('./layout');
const { showSelectedInfo } = require('./viewer');
const { runAction } = require('./actions');
const { refreshAll, getPanelDef, getItems, idOf, getGroupActions, getComponentSlice, dispatchMsg, wrap } = require('./plugins/api');
const copy = require('./copy');
const registerPopup = require('./register-popup');
const { isTerminalTab, activeTerminalId, findEphemeralByid,
        removeEphemeralTab, isContentTab, activeContentTab,
        removeContentTab } = require('./tabs');
const { isSessionDead, restartSession } = require('./terminal');
const { execSync } = require('child_process');
const keybindings = require('./keybindings');
const modes = require('./modes');
const runtime = require('./runtime');
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
 * Generic selection move via plugin API. Resolves the clamped target
 * index (getItems is view-side derivation) then hands it to the update
 * spine as a nav_select Msg — the reducer stores a plain panel's
 * selection and runs the groups cascade inline.
 */
function moveSel(model, delta) {
  const def = getPanelDef(getComponentSlice("layout").focus);
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(getComponentSlice("layout").focus);
  const sel = getSel(getComponentSlice("layout").focus);
  const newSel = sel + delta;
  if (newSel < 0 || newSel >= items.length) return;
  applyMsg(model, { type: 'nav_select', panel: getComponentSlice("layout").focus, index: newSel });
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
function _pageInListPanel(model, delta) {
  const def = getPanelDef(getComponentSlice("layout").focus);
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(getComponentSlice("layout").focus);
  if (!items.length) return;
  const sel = getSel(getComponentSlice("layout").focus);
  const next = Math.max(0, Math.min(items.length - 1, sel + delta));
  if (next === sel) return;
  applyMsg(model, { type: 'nav_select', panel: getComponentSlice("layout").focus, index: next });
}

function _jumpInListPanel(model, target) {
  const def = getPanelDef(getComponentSlice("layout").focus);
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(getComponentSlice("layout").focus);
  if (!items.length) return;
  const next = target === 'top' ? 0 : items.length - 1;
  const sel = getSel(getComponentSlice("layout").focus);
  if (next === sel) return;
  applyMsg(model, { type: 'nav_select', panel: getComponentSlice("layout").focus, index: next });
}

function _halfPageStep(panelType) {
  const slice = require('./plugins/api').getComponentSlice('layout');
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
    const slice = require('./plugins/api').getComponentSlice('layout');
    const bounds = slice && slice.panelBounds.detail;
    if (bounds) restartSession(id, bounds.w - 2, bounds.h - 2);
  }
  applyMsg(getModel(), { type: 'terminal_enter' });
}

function startDesignMode() {
  // Design mode folded onto update: entry is the design_enter Msg (resets the
  // editor state + flips the flag). Save stays decoupled (:save-layout); exit
  // emits a show_selected_info Cmd in place of the old onDone callback.
  applyMsg(getModel(), { type: 'design_enter' });
}

/**
 * Toggle multi-select on the focused panel's currently focused row.
 * No-op if the panel doesn't support `getItems` or has no items.
 */
function toggleMultiSelOnFocused() {
  const def = getPanelDef(getComponentSlice("layout").focus);
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(getComponentSlice("layout").focus);
  const item = items[getSel(getComponentSlice("layout").focus)];
  if (item == null) return;
  // Resolve the operand ID from the plugin facade (effect), then let the
  // reducer own the multiSel Set write.
  applyMsg(getModel(), { type: 'multisel_toggle', panel: getComponentSlice("layout").focus, id: idOf(getComponentSlice("layout").focus, item) });
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
  const def = getPanelDef(getComponentSlice("layout").focus);
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(getComponentSlice("layout").focus);
  // Resolve every visible row's ID from the plugin facade (effect); the
  // reducer adds them to the panel's multiSel Set (idempotent).
  const ids = items.map(item => idOf(getComponentSlice("layout").focus, item));
  applyMsg(getModel(), { type: 'multisel_select_all', panel: getComponentSlice("layout").focus, ids });
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

/**
 * Forward an unhandled key to the focused panel's plugin (if any).
 * Returns true if the plugin claimed the key.
 *
 * For list-mode panels (those with getItems) the focused item is
 * resolved and passed as the second arg. Content / stream / tree /
 * terminal panels have no item under the cursor — `item` is null and
 * the plugin handles the key based on panel-level state alone.
 */
function dispatchPluginKey(key) {
  const def = getPanelDef(getComponentSlice("layout").focus);
  if (!def) return false;
  // Component panels: the key was already handled in update() (routed there by
  // dispatchMsg to the focused component). Here we only honor the panel's
  // declared `claimsKeys` to SUPPRESS the framework default for keys the
  // component owns (e.g. config-status claiming ]/[/Enter so they don't also
  // trigger detail-tab-cycle / showSelectedInfo).
  if (Array.isArray(def.claimsKeys) && def.claimsKeys.includes(key)) return true;
  if (typeof def.onKey !== 'function') return false;
  let item = null;
  if (typeof def.getItems === 'function') {
    const items = getItems(getComponentSlice("layout").focus);
    item = items[getSel(getComponentSlice("layout").focus)] || null;
  }
  return def.onKey(key, item) === true;
}

// --- Mode handlers (one per modal state) ---
//
// Mode handlers mutate state and return; the trailing render() in
// handleKey paints. Order in modeChain is precedence: first matching
// mode handles the key, others don't see it.

function handleMenuKey(model, key, seq) {
  // Menu lives in the reducer now (menu_open/nav/activate/close);
  // activate emits a menu_action Cmd that routes the verb through handleAction.
  if (key === 'escape') { applyMsg(model, { type: 'menu_close' }); return; }
  if (key === 'up' || seq === 'k') { applyMsg(model, { type: 'menu_nav', dir: -1 }); return; }
  if (key === 'down' || seq === 'j') { applyMsg(model, { type: 'menu_nav', dir: +1 }); return; }
  if (key === 'return') { applyMsg(model, { type: 'menu_activate' }); }
}

/**
 * Enter `/`-filter mode for the focused panel. The filterable gate is
 * plugin-API (can't live in the reducer), so it's resolved here; then the
 * filter_enter Msg seeds the draft from the committed value. No-op (returns
 * false) when the focused panel isn't filterable.
 */
function enterFilterMode(model) {
  const def = getPanelDef(getComponentSlice("layout").focus);
  if (!def || !def.filterable) return false;
  applyMsg(model, { type: 'filter_enter', panel: getComponentSlice("layout").focus, text: model.ui.filters[getComponentSlice("layout").focus] || '' });
  return true;
}

function handleFilterKey(model, key, seq) {
  if (key === 'escape') { applyMsg(model, { type: 'filter_exit', keep: false }); showSelectedInfo(model); return; }
  if (key === 'return') { applyMsg(model, { type: 'filter_exit', keep: true  }); showSelectedInfo(model); return; }
  if (key === 'up' || seq === 'k') { handleAction(model, 'nav_up'); return; }
  if (key === 'down' || seq === 'j') { handleAction(model, 'nav_down'); return; }
  applyMsg(model, { type: 'filter_key', seq });
}

/**
 * `y` entry: collect options (plugin facade — effectful, stays here). 0 → no-op;
 * 1 → copy directly; many → stage the copy menu through update.
 */
function enterCopyMode(model) {
  const opts = copy.collectOptions();
  if (!opts.length) return;
  if (opts.length === 1) { copy.copyOption(opts[0]); copy.clearOptions(); return; }
  applyMsg(model, { type: 'copy_enter', options: opts.map(o => ({ label: o.label, cancel: !!o.cancel })) });
}

function handleCopyKey(model, key, seq) {
  if (key === 'escape') { applyMsg(model, { type: 'copy_cancel' }); return; }
  if (key === 'return') { applyMsg(model, { type: 'copy_select' }); return; }
  if (key === 'up' || seq === 'k') { applyMsg(model, { type: 'copy_nav', dir: -1 }); return; }
  if (key === 'down' || seq === 'j') { applyMsg(model, { type: 'copy_nav', dir: +1 }); return; }
}

function handleDesignKey(model, key, seq) {
  // Folded into update: each key maps to one design_* Msg; the model-design
  // leaf does the pure layout transform. q/Esc/Enter all exit.
  switch (key) {
    case 'up':    case 'k': applyMsg(model, { type: 'design_nav', dir: -1 }); break;
    case 'down':  case 'j': applyMsg(model, { type: 'design_nav', dir: +1 }); break;
    case 'K':               applyMsg(model, { type: 'design_reorder', dir: -1 }); break;
    case 'J':               applyMsg(model, { type: 'design_reorder', dir: +1 }); break;
    case 'left':  case 'h': applyMsg(model, { type: 'design_move_col', col: 'left' }); break;
    case 'right': case 'l': applyMsg(model, { type: 'design_move_col', col: 'right' }); break;
    case '+':     case '=': applyMsg(model, { type: 'design_resize', delta: +1 }); break;
    case '-':               applyMsg(model, { type: 'design_resize', delta: -1 }); break;
    case ']':               applyMsg(model, { type: 'design_panel_height', delta: +5 }); break;
    case '[':               applyMsg(model, { type: 'design_panel_height', delta: -5 }); break;
    case 't':               applyMsg(model, { type: 'design_title_enter' }); break;
    case 'u':               applyMsg(model, { type: 'design_undo' }); break;
    case 'ctrl-r':          applyMsg(model, { type: 'design_redo' }); break;
    case 'return': case 'q': case 'escape': applyMsg(model, { type: 'design_exit' }); break;
  }
}

function handleDesignTitleEditKey(model, key, seq) {
  if (key === 'escape') { applyMsg(model, { type: 'design_title_cancel' }); return; }
  if (key === 'return') { applyMsg(model, { type: 'design_title_submit' }); return; }
  applyMsg(model, { type: 'design_title_key', key, seq });
}

function handleCmdlineKey(model, key, seq) {
  // Folded into update: each key becomes a cmdline_* Msg. Text changes emit a
  // cmdline_rebuild Cmd (the effects layer re-queries the plugin facade — see
  // effects.js). Arrow-key raw escape sequences are kept as fallbacks for
  // callers that don't pre-normalize them to 'up'/'down'.
  if (key === 'escape')                      { applyMsg(model, { type: 'cmdline_cancel' }); return; }
  if (key === 'return')                      { applyMsg(model, { type: 'cmdline_submit' }); return; }
  if (key === 'up'   || seq === '\x1b[A')    { applyMsg(model, { type: 'cmdline_nav', dir: +1 }); return; }
  if (key === 'down' || seq === '\x1b[B')    { applyMsg(model, { type: 'cmdline_nav', dir: -1 }); return; }
  applyMsg(model, { type: 'cmdline_key', seq });
}

function handleRegisterPopupKey(model, key, seq) {
  // Folded into update: each key becomes a register_popup_* Msg. `vh` (the
  // viewport height) is resolved here — it reads the terminal size, which is
  // view-derived and must not enter the reducer.
  const vh = registerPopup.viewportRows();
  if (key === 'escape')              { applyMsg(model, { type: 'register_popup_cancel' }); return; }
  if (key === 'return')              { applyMsg(model, { type: 'register_popup_commit' }); return; }
  if (key === 'down' || seq === 'j') { applyMsg(model, { type: 'register_popup_nav', dir: +1, vh }); return; }
  if (key === 'up'   || seq === 'k') { applyMsg(model, { type: 'register_popup_nav', dir: -1, vh }); return; }
  if (seq === 'g')                   { applyMsg(model, { type: 'register_popup_nav', to: 'top', vh }); return; }
  if (seq === 'G')                   { applyMsg(model, { type: 'register_popup_nav', to: 'bottom', vh }); return; }
  if (seq === 'd')                   { applyMsg(model, { type: 'register_popup_drop', vh }); return; }
}

function handleDetailSearchKey(model, key, seq) {
  // viewer_search_* Msgs are handled by detail.update (Phase B) — route via
  // the Component fan-out, not the root reducer. Phase 2b will wrap these.
  if (key === 'escape') { dispatchMsg(wrap('detail', { type: 'viewer_search_cancel' })); return; }
  if (key === 'return') { dispatchMsg(wrap('detail', { type: 'viewer_search_commit' })); return; }
  if (key === 'up')   { dispatchMsg(wrap('detail', { type: 'viewer_search_nav', dir: -1 })); return; }
  if (key === 'down') { dispatchMsg(wrap('detail', { type: 'viewer_search_nav', dir: +1 })); return; }
  dispatchMsg(wrap('detail', { type: 'viewer_search_key', seq }));
}

function handleNormalKey(model, key, seq) {
  // Detail-panel keyboard visual-mode (v/V/y/Esc + cursor movement).
  // Claims keys ahead of the global switch so y commits a live selection
  // instead of opening the copy menu, and j/k move the detail cursor
  // instead of falling through to moveSel (which is a no-op for the
  // non-list detail panel anyway).
  if (getComponentSlice("layout").focus === 'detail' && require('./select').onDetailKey(key, seq)) return;

  // [ / ] are panel-aware tab switchers: if the focused panel owns sub-tabs
  // (today: groups → All/Quick), they cycle those. Otherwise the keys fall
  // through to the global detail-tab cycle below — preserving the prior
  // behavior for users hitting [ / ] from any other panel.
  if ((key === '[' || key === ']') && getComponentSlice("layout").focus === 'groups' && _groupsHasQuick()) {
    applyMsg(model, { type: 'toggle_groups_tab' });
    return;
  }
  switch (key) {
    case 'q': applyMsg(model, { type: 'quit' }); break;
    case 'escape':
      // Esc exits list-select mode (and clears the selection). Outside
      // select mode it clears any lingering multi-selection. When
      // neither applies it's a no-op. (All pure model writes — reducer.)
      applyMsg(model, { type: 'escape' });
      break;
    case 'v':
      // `v` enters list-select mode on a list panel (mirrors the detail
      // panel's visual mode, which onDetailKey already claimed above
      // when focus=detail). A second `v` exits.
      if (_isListPanel(getComponentSlice("layout").focus)) applyMsg(model, { type: 'list_select', mode: 'toggle' });
      break;
    case ' ':
      // Space is the leader EXCEPT inside list-select mode on a list
      // panel, where it toggles the focused row (the v0.3 multi-select
      // gesture). Gating on _isListPanel keeps the leader reachable if
      // the flag is still armed but focus has moved to a non-list panel
      // (e.g. detail) — otherwise space would be a dead no-op there.
      // The mode chain already suppresses the leader inside
      // detail-visual / terminal / text modes.
      if (model.modes.listSelectMode && _isListPanel(getComponentSlice("layout").focus)) toggleMultiSelOnFocused();
      else                                                         applyMsg(model, { type: 'enter_prefix' });
      break;
    case '*':
      // Select-all implies select mode so the user can then space-toggle
      // individual rows off. (selectAllVisible reads items via the plugin
      // API — an effect — so it stays a direct call.)
      if (_isListPanel(getComponentSlice("layout").focus)) applyMsg(model, { type: 'list_select', mode: 'on' });
      selectAllVisible();
      break;
    case 'up': case 'k':   handleAction(model, 'nav_up'); break;
    case 'down': case 'j': handleAction(model, 'nav_down'); break;
    case 'left': case 'h': handleAction(model, 'focus_left'); break;
    case 'right': case 'l':handleAction(model, 'focus_right'); break;
    case 'return':
      // Plugins get first crack at Enter — config-status uses it to
      // expand a "... N more" row, future plugins may bind it for
      // their own per-row activation. If the plugin doesn't claim,
      // fall through to the framework default (run the selected
      // action / drill into the selected group).
      if (dispatchPluginKey('return')) break;
      handleAction(model, 'run_selected');
      break;
    case 'r':              handleAction(model, 'refresh'); break;
    case 'x': {
      // On a dead ephemeral terminal tab, `x` closes it instead of
      // opening the menu. Lets the user dismiss a non-zero exit
      // (clean exits auto-close from the PTY onExit handler).
      if (getComponentSlice("layout").focus === 'detail' && isTerminalTab()) {
        const id = activeTerminalId();
        if (id && isSessionDead(id)) {
          const eph = findEphemeralByid(id);
          if (eph) { removeEphemeralTab(eph.group, eph.key); break; }
        }
      }
      // Content tabs (e.g. file-browser opens) close on `x` from
      // detail focus — no liveness concept like PTYs; users want a
      // close gesture, and `x` mirrors the dead-terminal flow.
      if (getComponentSlice("layout").focus === 'detail' && isContentTab()) {
        const ct = activeContentTab();
        if (ct) { removeContentTab(model.currentGroup, ct[0]); break; }
      }
      applyMsg(model, { type: 'menu_open' });
      break;
    }
    case '?':              handleAction(model, 'show_help'); break;
    // Tab keys are panel-aware: a focused plugin panel that wants its
    // own ]/[ behavior (config-status's tab cycle, future tabbed
    // plugins) gets first crack via dispatchPluginKey. If the plugin
    // doesn't claim (returns false), fall through to the framework
    // default — cycling detail tabs.
    case ']':
      if (dispatchPluginKey(']')) break;
      handleAction(model, 'next_tab');
      break;
    case '[':
      if (dispatchPluginKey('[')) break;
      handleAction(model, 'prev_tab');
      break;
    case 'pageup': case ',': handleAction(model, 'page_up'); break;
    case 'pagedown': case '.': handleAction(model, 'page_down'); break;
    case '<':              handleAction(model, 'goto_top'); break;
    case '>':              handleAction(model, 'goto_bottom'); break;
    case '+':              handleAction(model, 'view_expand'); break;
    case '_':              handleAction(model, 'view_shrink'); break;
    case '/':
      // Filter doesn't apply to the (non-list) detail panel — overload
      // `/` there as vim/less-style search instead. Same key, different
      // mode based on focus.
      if (getComponentSlice("layout").focus === 'detail') require('./plugins/api').dispatchMsg(require('./plugins/api').wrap('detail', { type: 'viewer_search_enter' }));
      else                          enterFilterMode(model);
      break;
    case 'y':              enterCopyMode(model); break;
    case '"':              applyMsg(model, { type: 'register_popup_enter' }); break;
    case ':':              applyMsg(model, { type: 'cmdline_enter' }); break;
    default:
      if (allPanels().some(p => p.hotkey === key)) {
        handleAction(model, 'focus_panel', key);
      } else {
        dispatchPluginKey(key);
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
function enterPrefix() { applyMsg(getModel(), { type: 'enter_prefix' }); }

function handlePrefixKey(key, seq) { applyMsg(getModel(), { type: 'prefix_key', key, seq }); }

// Built-in starter chords. Single keys like `r` / `?` still work bare
// in normal mode; these leader variants are additive (and seed the
// nesting demo via `g g` / `g e`). YAML `keys:` + plugin bindings
// layer on top of the same registry (stages 3 / plugin API).
function _registerBuiltinChords() {
  const b = { builtin: true };
  // Leader chords fire outside the threaded key spine, so each closure
  // reaches the owned model via getModel() at invoke time.
  const m = () => runtime.getModel();
  keybindings.registerKeyBinding('?',  { label: 'help',    run: () => handleAction(m(), 'show_help') },   b);
  keybindings.registerKeyBinding('r',  { label: 'refresh', run: () => handleAction(m(), 'refresh') },      b);
  keybindings.registerKeyBinding('gg', { label: 'top',     run: () => handleAction(m(), 'goto_top') },     b);
  keybindings.registerKeyBinding('ge', { label: 'bottom',  run: () => handleAction(m(), 'goto_bottom') },  b);
  keybindings.labelSubtree('g', '+goto');
}
_registerBuiltinChords();

/** Run a resolved action object, routing through the same args-prompt /
 *  confirm path the actions-panel Enter flow uses. Single definition so
 *  the panel, the leader bindings, and any future caller can't drift on
 *  how `args:` / `confirm:` are handled. */
function _runResolvedAction(model, key, act) {
  if (act.args) {
    const initial = resolvePromptDefault(act);
    // Seed the autosuggest ghost from the yank register's top (first line).
    const top = require('./register').top();
    const ghost = String(top || '').split('\n')[0];
    // Stage the prompt through update with a base run_action Cmd — submit
    // parses args + re-enters runAction (so an action that's ALSO confirm:
    // still confirms after the prompt). The Cmd carries data, not a closure.
    applyMsg(model, {
      type: 'prompt_enter',
      label: `Run: ${act.label}`, spec: act.args, text: initial,
      ghost: ghost && ghost !== initial ? ghost : '',
      cmd: { type: 'run_action', actionKey: key, action: act },
    });
  } else {
    runAction(model, key, act);
  }
}

/** Run a declared action by its key, searching every group. Resolves
 *  the SAME merged set the actions panel shows — plugin-synthesized
 *  actions (docker's `up`/`logs`/…) plus YAML `actions:` — so a leader
 *  binding to a plugin action isn't silently dead. First match wins. */
function _runActionByKey(model, key) {
  const groups = (model.config && model.config.groups) || {};
  for (const [gname, g] of Object.entries(groups)) {
    const merged = { ...getGroupActions(g, gname), ...(g.actions || {}) };
    const act = merged[key];
    if (!act) continue;
    _runResolvedAction(model, key, act);
    return true;
  }
  return false;
}

/** Build the run() closure for a YAML `keys:` binding spec. The verb
 *  is resolved at INVOKE time so group-relative actions / commands see
 *  the current state, not whatever was current at registration. */
function _bindingRunner(spec) {
  if (spec.builtin) return () => handleAction(runtime.getModel(), spec.builtin);
  if (spec.action)  return () => _runActionByKey(runtime.getModel(), spec.action);
  if (spec.command) return () => require('./cmdline').runCommandString(spec.command);
  return null;
}

/**
 * Register every entry in the top-level `keys:` block into the leader
 * binding tree. Called once at boot after the config is loaded (and
 * after plugins, so a project binding can shadow nothing it shouldn't).
 * A conflicting sequence throws from registerKeyBinding — surfaced to
 * the user as a boot error, same as any other config mistake.
 */
function loadKeyBindings(config) {
  const keys = (config && config.keys) || {};
  for (const [seq, spec] of Object.entries(keys)) {
    const run = _bindingRunner(spec);
    if (!run) continue;
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
//   - designTitleEdit runs before designMode so title typing isn't
//     swallowed by design navigation.
//   - cmd refreshes the focused panel's info so a `:focus`/command that
//     changes focus is reflected in the trailing paint.
// Every handler now takes the threaded model first. prefix is the first mode
// folded into update — it routes the keystroke as a Msg (applyMsg) instead of
// mutating directly. The rest still mutate inside their own modules for now
// (they accept + ignore `model`); converting each onto update is the
// remaining real-TEA work, mode by mode.
const _modeHandlers = {
  confirmMode:         (model, key, seq) => {
    // y/Enter accepts (re-emits the staged Cmd), n/Esc rejects; anything
    // else is swallowed so stray keys don't leak to the panel below.
    if (key === 'escape' || seq === 'n' || seq === 'N') applyMsg(model, { type: 'confirm_reject' });
    else if (seq === 'y' || seq === 'Y' || key === 'return') applyMsg(model, { type: 'confirm_accept' });
  },
  promptMode:          (model, key, seq) => {
    if (key === 'escape') applyMsg(model, { type: 'prompt_cancel' });
    else if (key === 'return') applyMsg(model, { type: 'prompt_submit' });
    else applyMsg(model, { type: 'prompt_key', key, seq });
  },
  designTitleEditMode: (model, key, seq) => handleDesignTitleEditKey(model, key, seq),
  designMode:          (model, key, seq) => handleDesignKey(model, key, seq),
  menuOpen:            (model, key, seq) => handleMenuKey(model, key, seq),
  filterMode:          (model, key, seq) => handleFilterKey(model, key, seq),
  copyMode:            (model, key, seq) => handleCopyKey(model, key, seq),
  detailSearchMode:    (model, key, seq) => handleDetailSearchKey(model, key, seq),
  registerPopupMode:   (model, key, seq) => handleRegisterPopupKey(model, key, seq),
  prefixMode:          (model, key, seq) => applyMsg(model, { type: 'prefix_key', key, seq }),
  cmdMode:             (model, key, seq) => { handleCmdlineKey(model, key, seq); showSelectedInfo(model); },
};

const modeChain = modes.CHAIN_MODES.map(flag => {
  const handler = _modeHandlers[flag];
  if (!handler) throw new Error(`mode "${flag}" is in CHAIN_MODES but has no handler in dispatch.js`);
  return { flag, active: (model) => model.modes[flag], handler };
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

// `model` is the owned root model, threaded in from the input pump
// (tui.js → setupKeyListener → here). The normal-key path carries it
// down to update; the modal path (_dispatchActiveMode) is not yet
// threaded and still reads the global via the shim. render(model) feeds
// the view the same threaded model.
function handleKey(model, key, seq) {
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
  if (_dispatchActiveMode(model, key, seq)) { render(model); return; }
  require('./plugins/api').dispatchMsg({ type: 'key', key, seq });
  handleNormalKey(model, key, seq);
  render(model);
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
function _dispatchActiveMode(model, key, seq) {
  for (const m of modeChain) {
    if (m.active(model)) {
      try {
        m.handler(model, key, seq);
      } catch (e) {
        console.error('[mode]', m.flag, e && e.message);
        // Route the panic-recovery flag-clear through update so single-writer
        // holds even on this exceptional path (the alternative — a direct
        // model.modes[flag]=false here — was the last outside-writer in
        // dispatch.js per docs/v0.5-layering.md step 5).
        applyMsg(model, { type: 'mode_clear', flag: m.flag });
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
function applyMsg(model, msg) {
  const [, cmds] = runtime.update(model, msg);
  require('./effects').runEffects(cmds);
}

// --- handleAction: name → effect ---
//
// Effect arms are mutation-only. Caller (handleKey, handleMouse, the
// menu Enter path) owns the trailing paint. Arms resolve a Msg from the
// model and call applyMsg(model, msg) — the reducer is the writer.

function handleAction(model, action, arg) {
  switch (action) {
    case 'nav_up':       moveSel(model, -1); break;
    case 'nav_down':     moveSel(model, +1); break;
    case 'focus_left': {
      const order = allPanels().map(p => p.type);
      const idx = order.indexOf(getComponentSlice("layout").focus);
      dispatchMsg(wrap('layout', { type: 'focus_set', focus: idx > 0 ? order[idx - 1] : getComponentSlice("layout").focus }));
      break;
    }
    case 'focus_right': {
      const order = allPanels().map(p => p.type);
      const idx = order.indexOf(getComponentSlice("layout").focus);
      dispatchMsg(wrap('layout', { type: 'focus_set', focus: idx < order.length - 1 ? order[idx + 1] : getComponentSlice("layout").focus }));
      break;
    }
    case 'focus_panel': {
      let target = getComponentSlice("layout").focus;
      for (const p of allPanels()) {
        if (p.hotkey === arg) { target = p.type; break; }
      }
      dispatchMsg(wrap('layout', { type: 'focus_set', focus: target }));
      break;
    }
    case 'run_selected': {
      // Enter on detail + terminal tab → activate terminal mode
      if (getComponentSlice("layout").focus === 'detail' && isTerminalTab()) {
        activateTerminal();
        break;
      }
      // Enter on groups: branches toggle expand/collapse one level;
      // leaves drill into the actions panel. This is the only tree-shape
      // keybinding — recursive expand/collapse have no dedicated key,
      // hammering Enter walks down levels (cursor stays put, the row
      // below opens or closes). Avoids the prior "drill to empty actions"
      // smell when a branch had no own actions.
      if (getComponentSlice("layout").focus === 'groups') {
        const items = getItems('groups');
        const row = items[getSel('groups')];
        if (row && row.children && row.children.length > 0) {
          applyMsg(model, { type: 'toggle_group', name: row.name });
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
      if (getComponentSlice("layout").focus === 'actions') {
        const items = getItems('actions');
        const item = items[getSel('actions')];
        if (item) {
          const [key, act] = item;
          _runResolvedAction(model, key, act);
        }
      } else {
        showSelectedInfo(model);
      }
      break;
    }
    case 'refresh':
      // Async — refreshAll's resolve drives a scheduleRender via
      // changed-flag bookkeeping in the refresh loop. The trailing
      // sync paint here gives immediate feedback that "something
      // happened" even before refresh completes.
      applyMsg(model, { type: 'refresh' });
      break;
    case 'show_help':
      applyMsg(model, { type: 'show_help' });
      break;
    case 'next_tab': applyMsg(model, { type: 'next_tab' }); break;
    case 'prev_tab': applyMsg(model, { type: 'prev_tab' }); break;
    case 'page_up': {
      // Paging is focus-aware: detail scrolls its content; list panels
      // jump the cursor by half a panel (the nav_select cascade, now run
      // inline in the reducer). Other panel modes (e.g. stats content)
      // get no-op — they don't expose getItems().
      if (getComponentSlice("layout").focus === 'detail') require('./plugins/api').dispatchMsg(require('./plugins/api').wrap('detail', { type: 'viewer_scroll', delta: -_halfPageStep('detail') }));
      else                          _pageInListPanel(model, -_halfPageStep(getComponentSlice("layout").focus));
      break;
    }
    case 'page_down': {
      if (getComponentSlice("layout").focus === 'detail') require('./plugins/api').dispatchMsg(require('./plugins/api').wrap('detail', { type: 'viewer_scroll', delta: +_halfPageStep('detail') }));
      else                          _pageInListPanel(model, +_halfPageStep(getComponentSlice("layout").focus));
      break;
    }
    case 'goto_top':
      if (getComponentSlice("layout").focus === 'detail') require('./plugins/api').dispatchMsg(require('./plugins/api').wrap('detail', { type: 'viewer_scroll', to: 'top' }));
      else                          _jumpInListPanel(model, 'top');
      break;
    case 'goto_bottom':
      if (getComponentSlice("layout").focus === 'detail') require('./plugins/api').dispatchMsg(require('./plugins/api').wrap('detail', { type: 'viewer_scroll', to: 'bottom' }));
      else                          _jumpInListPanel(model, 'bottom');
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
      enterFilterMode(model);
      break;
    case 'design':
      // Reachable from menu entry and `:design` cmdline. The design-enabled
      // gate lives in the reducer (update emits the start_design Cmd only
      // when enabled) — same gate the cmdline command uses for visibility.
      applyMsg(model, { type: 'design' });
      break;
    case 'quit':
      applyMsg(model, { type: 'quit' });
      break;
  }
}

module.exports = {
  handleKey, handleAction, applyMsg, startDesignMode,
  registerKeyFilter, clearKeyFilters,
  loadKeyBindings,
  _dispatchPluginKey: dispatchPluginKey,
  // Exposed for tests
  _enterPrefix: enterPrefix,
  _handlePrefixKey: handlePrefixKey,
  _handleNormalKey: handleNormalKey,
  _dispatchActiveMode,
  _isListPanel,
};
