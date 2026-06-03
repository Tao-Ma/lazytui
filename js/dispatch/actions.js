/**
 * `handleAction` switch + the action-runner helpers behind it.
 *
 * `handleAction(verb, arg)` is the central name→effect switch for verbs
 * that fire from multiple input sources — bare-key normal mode (j/k/r/?),
 * leader chords (`g g` → goto_top, `c` → toggle_collapse), `:` cmdline
 * (`:refresh`, `:free-config`), and the menu (Enter → menu_action effect →
 * `dispatch.handleAction`). Each arm mutates state via applyMsg /
 * dispatchMsg / wrap; the caller owns the trailing paint.
 *
 * `_runResolvedAction` / `_runActionByKey` are the actions-panel + leader-
 * bound action runners — they apply `args:` / `confirm:` consistently
 * across entry points (actions-panel Enter + YAML `keys: { foo: { action:
 * 'bar' } }` bindings + future callers).
 *
 * Carved out of dispatch.js (which still owns applyMsg + navSelect +
 * _enterFilterMode + the mode-key handlers). Cycle break: this module
 * lazy-requires dispatch.js inline at call sites — never destructure
 * `applyMsg` / `navSelect` at module-load time, since dispatch.js is mid-
 * load when we run. Matches the existing dispatch↔effects / dispatch↔state
 * cycle pattern in the codebase.
 */
'use strict';

const { allPanels, getSel } = require('../app/state');
const { runAction } = require('./action-runner');
const { getPanelDef, getItems, getGroupActions, getInstanceSlice,
        dispatchMsg, wrap, getFocus, instanceKind } = require('../panel/api');
const { isTerminalTab, activeTerminalId } = require('../panel/viewer/tabs');
const { isSessionDead, restartSession } = require('../io/terminal');
const { execSync } = require('child_process');
const { getModel } = require('../app/runtime');
const route = require('../leaves/route');

// Lazy stub for the dispatch back-edge. Each invocation looks up the
// cached module — Node caches require, so this is essentially free.
// Stable shape lets handleAction arms read like the original.
function applyMsg(msg) { return require('./dispatch').applyMsg(msg); }

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
 * index (getItems is view-side derivation) then hands it to dispatch.navSelect.
 */
function moveSel(delta) {
  const def = getPanelDef(getFocus());
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(getFocus());
  const sel = getSel(getFocus());
  const newSel = sel + delta;
  if (newSel < 0 || newSel >= items.length) return;
  require('./dispatch').navSelect(getFocus(), newSel);
}

/**
 * Jump-set the focused list panel's selection to `next` (clamped to
 * [0, len-1]). Used by page_up / page_down / goto_top / goto_bottom on
 * any list-mode panel.
 */
function _pageInListPanel(delta) {
  const def = getPanelDef(getFocus());
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(getFocus());
  if (!items.length) return;
  const sel = getSel(getFocus());
  const next = Math.max(0, Math.min(items.length - 1, sel + delta));
  if (next === sel) return;
  require('./dispatch').navSelect(getFocus(), next);
}

function _jumpInListPanel(target) {
  const def = getPanelDef(getFocus());
  if (!def || typeof def.getItems !== 'function') return;
  const items = getItems(getFocus());
  if (!items.length) return;
  const next = target === 'top' ? 0 : items.length - 1;
  const sel = getSel(getFocus());
  if (next === sel) return;
  require('./dispatch').navSelect(getFocus(), next);
}

function _pageStep(panelType) {
  // Single source of truth for view-mode-aware viewport rows.
  // panelHeights[type] is the normal-view column-share regardless of
  // viewMode; the API guards against reading it directly here.
  return require('../render/layout').getPanelViewportH(panelType);
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
    const slice = getInstanceSlice('layout');
    const bounds = slice && slice.panelBounds.detail;
    if (bounds) restartSession(id, bounds.w - 2, bounds.h - 2);
  }
  applyMsg({ type: 'terminal_enter' });
}

// --- action runners ---

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

// --- handleAction: name → effect ---
//
// Effect arms are mutation-only. Caller (handleKey, handleMouse, the
// menu Enter path) owns the trailing paint. Arms resolve a Msg from the
// model and call applyMsg(msg) — the reducer is the writer.
//
// T7: arms here once took a leading `model` arg that they never read
// directly (they re-resolve via getFocus() / getItems() / getModel()
// internally). That arg was the captured-stale-ref hazard that bit
// us in 2be348a; dropping it removes the invitation to reintroduce
// that bug class.

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
      if (instanceKind(getFocus()) === 'detail' && isTerminalTab()) {
        activateTerminal();
        break;
      }
      // Enter on groups: branches toggle expand/collapse one level;
      // leaves drill into the actions panel. This is the only tree-shape
      // keybinding — recursive expand/collapse have no dedicated key,
      // hammering Enter walks down levels (cursor stays put, the row
      // below opens or closes). Avoids the prior "drill to empty actions"
      // smell when a branch had no own actions.
      if (instanceKind(getFocus()) === 'groups') {
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
      if (instanceKind(getFocus()) === 'actions') {
        const items = getItems('actions');
        const item = items[getSel('actions')];
        if (item) {
          const [key, act] = item;
          _runResolvedAction(key, act);
        }
      } else {
        // v0.6.1 Phase 5 — viewer body refresh routes through
        // resolveTarget so the right viewer pane wins under
        // multi-viewer. null when no viewer is registered (no-op).
        const target = route.resolveTarget('viewer');
        if (target) dispatchMsg(wrap(target, { type: 'viewer_show_info' }));
      }
      break;
    }
    case 'refresh':
      // Async — refreshAll's resolve drives a scheduleRender via
      // changed-flag bookkeeping in the refresh loop. The trailing
      // sync paint in handleKey gives immediate feedback that
      // "something happened" even before refresh completes. Direct
      // call (R4.5) — the older `applyMsg → Cmd → effects → refreshAll`
      // chain had no model side at the runtime arm (no-op + Cmd).
      require('../panel/api').refreshAll();
      break;
    case 'toggle_collapse_focused': {
      // v0.6 — `<leader> c` chord in normal mode. Toggles the focused
      // panel's collapsed state. detail / unrecognized focus = no-op
      // (reducer is the gatekeeper, but resolving the id early lets
      // the no-op skip the wrapped Msg entirely).
      const focus = getFocus();
      if (!focus || instanceKind(focus) === 'detail') break;
      const p = allPanels().find(x => x.type === focus);
      if (!p) break;
      dispatchMsg(wrap('layout', { type: 'panel_collapse_toggle', id: p.id }));
      break;
    }
    case 'show_help':
      require('./help-text').showHelp();
      break;
    case 'next_tab': applyMsg({ type: 'next_tab' }); break;
    case 'prev_tab': applyMsg({ type: 'prev_tab' }); break;
    case 'page_up': {
      // Paging is focus-aware: detail scrolls its content; list panels
      // jump the cursor by a full inner page (the nav_select cascade,
      // now run inline in the reducer). Other panel modes (e.g. stats
      // content) get no-op — they don't expose getItems(), so the
      // guard at the top of _pageInListPanel intentionally bails.
      const focus = getFocus();
      if (instanceKind(focus) === 'detail') dispatchMsg(wrap(focus, { type: 'viewer_scroll', delta: -_pageStep('detail') }));
      else                                  _pageInListPanel(-_pageStep(focus));
      break;
    }
    case 'page_down': {
      const focus = getFocus();
      if (instanceKind(focus) === 'detail') dispatchMsg(wrap(focus, { type: 'viewer_scroll', delta: +_pageStep('detail') }));
      else                                  _pageInListPanel(+_pageStep(focus));
      break;
    }
    case 'goto_top': {
      const focus = getFocus();
      if (instanceKind(focus) === 'detail') dispatchMsg(wrap(focus, { type: 'viewer_scroll', to: 'top' }));
      else                                  _jumpInListPanel('top');
      break;
    }
    case 'goto_bottom': {
      const focus = getFocus();
      if (instanceKind(focus) === 'detail') dispatchMsg(wrap(focus, { type: 'viewer_scroll', to: 'bottom' }));
      else                                  _jumpInListPanel('bottom');
      break;
    }
    case 'view_expand':
      // Through the Component fan-out: layout's update flips viewMode and
      // returns a force_full_repaint effect on a real transition (a view
      // change re-exposes panels the diff cache can't tell changed). Phase
      // 1b moved viewMode out of the root reducer into layout's slice —
      // hence wrap('layout', …) instead of the usual applyMsg here.
      dispatchMsg(wrap('layout', { type: 'view_expand' }));
      break;
    case 'view_shrink':
      dispatchMsg(wrap('layout', { type: 'view_shrink' }));
      break;
    case 'filter':
      // Reachable from the menu + `:filter`. The filterable gate lives in
      // dispatch._enterFilterMode (plugin-API check); lazy-require to cross
      // the dispatch↔actions cycle.
      require('./dispatch')._enterFilterMode();
      break;
    case 'free_config':
      // Reachable from menu entry and `:design` cmdline. The design-enabled
      // gate lives in the reducer (update emits the start_free_config Cmd only
      // when enabled) — same gate the cmdline command uses for visibility.
      applyMsg({ type: 'free_config' });
      break;
    case 'quit':
      require('../app/cleanup').cleanup();
      process.exit(0);
      break;
  }
}

module.exports = { handleAction, _runActionByKey };
