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
const { S, allPanels, selectGroup, setDetail, getSel, setSel,
        toggleMultiSel, isMultiSel, clearMultiSel, multiSelCount,
        expandGroup, collapseGroup, switchGroupsTab } = require('./state');
const { render } = require('./layout');
const { showSelectedInfo, runTab } = require('./detail');
const { runAction } = require('./actions');
const { openMenu, closeMenu, navMenu, activateMenu } = require('./menu');
const { enterDesign, handleDesignKey } = require('./design');
const { refreshAll, getPanelDef, getItems, idOf } = require('./plugins/api');
const { showHelp } = require('./help-text');
const { enterFilter, exitFilter, keystroke: filterKeystroke } = require('./filter');
const { enterCopy, exitCopy, navCopy } = require('./copy');
const { enterCmdline, handleCmdlineKey } = require('./cmdline');
const { handleConfirmKey } = require('./confirm');
const { enterPrompt, handlePromptKey } = require('./prompt');
const { isTerminalTab, activeTerminalId, findEphemeralByid,
        removeEphemeralTab } = require('./tabs');
const { isSessionDead, restartSession } = require('./terminal');
const { cleanup } = require('./cleanup');
const { execSync } = require('child_process');

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
      cwd: S.projectDir,
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
 * Generic selection move via plugin API. Calls selectGroup() for the
 * groups panel (which has cascading side effects); plain setSel for others.
 */
function moveSel(delta) {
  const def = getPanelDef(S.focus);
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(S.focus, S);
  const sel = getSel(S.focus);
  const newSel = sel + delta;
  if (newSel < 0 || newSel >= items.length) return;
  if (S.focus === 'groups') selectGroup(newSel);
  else setSel(S.focus, newSel);
  showSelectedInfo();
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
  const def = getPanelDef(S.focus);
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(S.focus, S);
  if (!items.length) return;
  const sel = getSel(S.focus);
  const next = Math.max(0, Math.min(items.length - 1, sel + delta));
  if (next === sel) return;
  if (S.focus === 'groups') selectGroup(next);
  else setSel(S.focus, next);
  showSelectedInfo();
}

function _jumpInListPanel(target) {
  const def = getPanelDef(S.focus);
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(S.focus, S);
  if (!items.length) return;
  const next = target === 'top' ? 0 : items.length - 1;
  const sel = getSel(S.focus);
  if (next === sel) return;
  if (S.focus === 'groups') selectGroup(next);
  else setSel(S.focus, next);
  showSelectedInfo();
}

function _halfPageStep(panelType) {
  const h = S.panelHeights[panelType] || 4;
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
    const bounds = S.panelBounds.detail;
    if (bounds) restartSession(id, bounds.w - 2, bounds.h - 2);
  }
  S.terminalMode = true;
}

function startDesignMode() {
  // Save is decoupled — design mode just mutates S.layout. The
  // :save-layout cmdline command writes to YAML. The onDone callback
  // fires outside the input pump's normal paint cadence (from inside
  // handleDesignKey on exit), so we render here. showSelectedInfo
  // first to refresh detail with info for the newly-active panel.
  enterDesign(S.layout, S.configPath, () => {
    showSelectedInfo();
    render();
  });
}

/**
 * Toggle multi-select on the focused panel's currently focused row.
 * No-op if the panel doesn't support `getItems` or has no items.
 */
function toggleMultiSelOnFocused() {
  const def = getPanelDef(S.focus);
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(S.focus, S);
  const item = items[getSel(S.focus)];
  if (item == null) return;
  toggleMultiSel(S.focus, idOf(S.focus, item));
}

/**
 * Add every visible row in the focused panel to multi-selection.
 * Idempotent — already-selected rows stay selected.
 */
function selectAllVisible() {
  const def = getPanelDef(S.focus);
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(S.focus, S);
  for (const item of items) {
    const id = idOf(S.focus, item);
    if (!isMultiSel(S.focus, id)) toggleMultiSel(S.focus, id);
  }
}

/**
 * True when at least one group declares `quick: true`. Used to gate the
 * panel-aware [ / ] handler — without any pinned groups, the tab UI
 * isn't shown and we let [ / ] fall through to detail-tab cycling.
 */
function _groupsHasQuick() {
  const all = (S.config && S.config.groups) || {};
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
  const def = getPanelDef(S.focus);
  if (!def || typeof def.onKey !== 'function') return false;
  let item = null;
  if (typeof def.getItems === 'function') {
    const items = getItems(S.focus, S);
    item = items[getSel(S.focus)] || null;
  }
  return def.onKey(key, item, S) === true;
}

// --- Mode handlers (one per modal state) ---
//
// Mode handlers mutate state and return; the trailing render() in
// handleKey paints. Order in modeChain is precedence: first matching
// mode handles the key, others don't see it.

function handleMenuKey(key, seq) {
  if (key === 'escape') { closeMenu(); return; }
  if (key === 'up' || seq === 'k') { navMenu(-1); return; }
  if (key === 'down' || seq === 'j') { navMenu(+1); return; }
  if (key === 'return') {
    const actionStr = activateMenu();
    if (!actionStr) return;
    if (actionStr.startsWith('focus_panel:')) {
      handleAction('focus_panel', actionStr.split(':')[1]);
    } else {
      handleAction(actionStr);
    }
  }
}

function handleFilterKey(key, seq) {
  if (key === 'escape') { exitFilter(false); showSelectedInfo(); return; }
  if (key === 'return') { exitFilter(true);  showSelectedInfo(); return; }
  if (key === 'up' || seq === 'k') { handleAction('nav_up'); return; }
  if (key === 'down' || seq === 'j') { handleAction('nav_down'); return; }
  filterKeystroke(seq);
}

function handleCopyKey(key, seq) {
  if (key === 'escape') { exitCopy(false); return; }
  if (key === 'return') { exitCopy(true); return; }
  if (key === 'up' || seq === 'k') { navCopy(-1); return; }
  if (key === 'down' || seq === 'j') { navCopy(1); return; }
}

function handleNormalKey(key, seq) {
  // [ / ] are panel-aware tab switchers: if the focused panel owns sub-tabs
  // (today: groups → All/Quick), they cycle those. Otherwise the keys fall
  // through to the global detail-tab cycle below — preserving the prior
  // behavior for users hitting [ / ] from any other panel.
  if ((key === '[' || key === ']') && S.focus === 'groups' && _groupsHasQuick()) {
    switchGroupsTab(S.groupsTab === 'quick' ? 'all' : 'quick');
    showSelectedInfo();
    return;
  }
  switch (key) {
    case 'q': cleanup(); process.exit(0); break;
    case 'escape':
      // Esc clears multi-selection on the focused panel if any. (When no
      // multi-select is active, Esc is a no-op — reserved for future
      // "back to groups" behavior from the handoff thread.)
      if (multiSelCount(S.focus) > 0) clearMultiSel(S.focus);
      break;
    case ' ':              toggleMultiSelOnFocused(); break;
    case '*':              selectAllVisible(); break;
    case 'up': case 'k':   handleAction('nav_up'); break;
    case 'down': case 'j': handleAction('nav_down'); break;
    case 'left': case 'h': handleAction('focus_left'); break;
    case 'right': case 'l':handleAction('focus_right'); break;
    case 'return':
      // Plugins get first crack at Enter — config-status uses it to
      // expand a "... N more" row, future plugins may bind it for
      // their own per-row activation. If the plugin doesn't claim,
      // fall through to the framework default (run the selected
      // action / drill into the selected group).
      if (dispatchPluginKey('return')) break;
      handleAction('run_selected');
      break;
    case 'r':              handleAction('refresh'); break;
    case 'x': {
      // On a dead ephemeral terminal tab, `x` closes it instead of
      // opening the menu. Lets the user dismiss a non-zero exit
      // (clean exits auto-close from the PTY onExit handler).
      if (S.focus === 'detail' && isTerminalTab()) {
        const id = activeTerminalId();
        if (id && isSessionDead(id)) {
          const eph = findEphemeralByid(id);
          if (eph) { removeEphemeralTab(eph.group, eph.key); break; }
        }
      }
      openMenu();
      break;
    }
    case '?':              handleAction('show_help'); break;
    // Tab keys are panel-aware: a focused plugin panel that wants its
    // own ]/[ behavior (config-status's tab cycle, future tabbed
    // plugins) gets first crack via dispatchPluginKey. If the plugin
    // doesn't claim (returns false), fall through to the framework
    // default — cycling detail tabs.
    case ']':
      if (dispatchPluginKey(']')) break;
      handleAction('next_tab');
      break;
    case '[':
      if (dispatchPluginKey('[')) break;
      handleAction('prev_tab');
      break;
    case 'pageup': case ',': handleAction('page_up'); break;
    case 'pagedown': case '.': handleAction('page_down'); break;
    case '<':              handleAction('goto_top'); break;
    case '>':              handleAction('goto_bottom'); break;
    case '+':              handleAction('view_expand'); break;
    case '_':              handleAction('view_shrink'); break;
    case '/':              enterFilter(); break;
    case 'y':              enterCopy(); break;
    case ':':              enterCmdline(); break;
    default:
      if (allPanels().some(p => p.hotkey === key)) {
        handleAction('focus_panel', key);
      } else {
        dispatchPluginKey(key);
      }
  }
}

// Mode → activation predicate + handler. Order is precedence: design
// wins over menu, menu over filter, etc. Add a new mode here, not in
// handleKey. Each handler is mutation-only — handleKey paints once
// after the entire dispatch chain completes.
const modeChain = [
  // confirm is highest precedence — y/N must resolve before anything
  // else. Cannot coexist with other modes in practice (only entered
  // from runAction → only fires from normal-mode Enter / cmdline run).
  { active: () => S.confirmMode, handler: handleConfirmKey },
  // prompt — collects positional args from the user when an action has
  // `args:` declared and was invoked from the actions panel (not via
  // `:` cmdline, which carries args inline). Mutually exclusive with
  // confirm in practice (prompt fires first, runAction may then enter
  // confirm with the collected args captured in the closure).
  { active: () => S.promptMode,  handler: handlePromptKey },
  { active: () => S.designMode, handler: handleDesignKey },
  { active: () => S.menuOpen,   handler: handleMenuKey },
  { active: () => S.filterMode, handler: handleFilterKey },
  { active: () => S.copyMode,   handler: handleCopyKey },
  // cmd mode runs whatever the user typed (a `:focus <panel>` mutates
  // S.focus; a plugin command might mutate detail/group/etc). Refresh
  // the focused panel's info into detail so the trailing paint reflects
  // any focus change.
  { active: () => S.cmdMode,    handler: (key, seq) => { handleCmdlineKey(key, seq); showSelectedInfo(); } },
];

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
  // Component Msg dispatch (v0.3.0). Same hook point as the event log
  // — every key event also fans out to every registered Component's
  // update(). Plugins are unaffected.
  require('./plugins/api').dispatchMsg({ type: 'key', key, seq });
  for (const m of modeChain) {
    if (m.active()) { m.handler(key, seq); render(); return; }
  }
  handleNormalKey(key, seq);
  render();
}

// --- handleAction: name → effect ---
//
// Effect arms are mutation-only. Caller (handleKey, handleMouse, the
// menu Enter path) owns the trailing paint.

function handleAction(action, arg) {
  switch (action) {
    case 'nav_up':       moveSel(-1); break;
    case 'nav_down':     moveSel(+1); break;
    case 'focus_left': {
      const order = allPanels().map(p => p.type);
      const idx = order.indexOf(S.focus);
      if (idx > 0) S.focus = order[idx - 1];
      showSelectedInfo();
      break;
    }
    case 'focus_right': {
      const order = allPanels().map(p => p.type);
      const idx = order.indexOf(S.focus);
      if (idx < order.length - 1) S.focus = order[idx + 1];
      showSelectedInfo();
      break;
    }
    case 'focus_panel': {
      for (const p of allPanels()) {
        if (p.hotkey === arg) { S.focus = p.type; break; }
      }
      showSelectedInfo();
      break;
    }
    case 'run_selected': {
      // Enter on detail + terminal tab → activate terminal mode
      if (S.focus === 'detail' && isTerminalTab()) {
        activateTerminal();
        break;
      }
      // Enter on groups: branches toggle expand/collapse one level;
      // leaves drill into the actions panel. This is the only tree-shape
      // keybinding — recursive expand/collapse have no dedicated key,
      // hammering Enter walks down levels (cursor stays put, the row
      // below opens or closes). Avoids the prior "drill to empty actions"
      // smell when a branch had no own actions.
      if (S.focus === 'groups') {
        const items = getItems('groups', S);
        const row = items[getSel('groups')];
        if (row && row.children && row.children.length > 0) {
          if (S.expandedGroups.has(row.name)) collapseGroup(row.name, false);
          else expandGroup(row.name, false);
          showSelectedInfo();
          break;
        }
        // Leaf: drill to actions panel.
        S.focus = 'actions';
        showSelectedInfo();
        break;
      }
      // Enter on actions → run selected action. If the action declares
      // `args:`, open the prompt overlay first to collect positional
      // params; submit then forwards them to runAction. Cmdline (`:`)
      // already carries args inline, so this only matters for the
      // actions-panel path.
      if (S.focus === 'actions') {
        const items = getItems('actions', S);
        const item = items[getSel('actions')];
        if (item) {
          const [key, act] = item;
          if (act.args) {
            const initial = resolvePromptDefault(act);
            enterPrompt(`Run: ${act.label}`, act.args,
                        (args) => runAction(key, act, args), initial);
          } else {
            runAction(key, act);
          }
        }
      } else {
        showSelectedInfo();
      }
      break;
    }
    case 'refresh':
      // Async — refreshAll's resolve drives a scheduleRender via
      // changed-flag bookkeeping in the refresh loop. The trailing
      // sync paint here gives immediate feedback that "something
      // happened" even before refresh completes.
      refreshAll(S.config);
      break;
    case 'show_help':
      showHelp();
      break;
    case 'next_tab': runTab(1); break;
    case 'prev_tab': runTab(-1); break;
    case 'page_up': {
      // Paging is focus-aware: detail scrolls its content; list panels
      // jump the cursor by half a panel. Other panel modes (e.g. stats
      // content) get no-op — they don't expose getItems().
      if (S.focus === 'detail') {
        if (S.detailScroll > 0) {
          const step = _halfPageStep('detail');
          S.detailScroll = Math.max(0, S.detailScroll - step);
        }
      } else {
        _pageInListPanel(-_halfPageStep(S.focus));
      }
      break;
    }
    case 'page_down': {
      if (S.focus === 'detail') {
        const maxScroll = Math.max(0, S.detailLines.length - (S.panelHeights.detail - 2));
        if (S.detailScroll < maxScroll) {
          const step = _halfPageStep('detail');
          S.detailScroll = Math.min(maxScroll, S.detailScroll + step);
        }
      } else {
        _pageInListPanel(+_halfPageStep(S.focus));
      }
      break;
    }
    case 'goto_top':
      if (S.focus === 'detail') S.detailScroll = 0;
      else _jumpInListPanel('top');
      break;
    case 'goto_bottom': {
      if (S.focus === 'detail') {
        const maxScroll = Math.max(0, S.detailLines.length - (S.panelHeights.detail - 2));
        S.detailScroll = maxScroll;
      } else {
        _jumpInListPanel('bottom');
      }
      break;
    }
    case 'view_expand':
      if (S.viewMode === 'normal') S.viewMode = 'half';
      else if (S.viewMode === 'half') S.viewMode = 'full';
      break;
    case 'view_shrink':
      if (S.viewMode === 'full') S.viewMode = 'half';
      else if (S.viewMode === 'half') S.viewMode = 'normal';
      break;
    case 'filter':
      enterFilter();
      break;
    case 'design':
      // Reachable from menu entry and `:design` cmdline. Gated on
      // S.designEnabled so a user without the flag set sees nothing
      // happen — same gate the cmdline command uses for visibility.
      if (S.designEnabled) startDesignMode();
      break;
    case 'quit':
      cleanup();
      process.exit(0);
      break;
  }
}

module.exports = {
  handleKey, handleAction, startDesignMode,
  registerKeyFilter, clearKeyFilters,
  _dispatchPluginKey: dispatchPluginKey,
};
