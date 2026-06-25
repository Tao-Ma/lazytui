/**
 * The root reducer (`update`) — nav / chrome / lifecycle arms + Cmd descriptors.
 *
 * `update(model, msg) → [newModel, cmds]` is the single writer for the chrome /
 * modal / config / framework layers; Component slices are written by each
 * Component's own `update`. Cross-layer ops route through `apply_msg` /
 * `dispatch_msg` Cmds (see docs/v0.5-layering.md).
 *
 * #D12 (2026-06-18) — the modal sub-machines (confirm / prompt / copy /
 * register-popup / cmdline / jobs / diag-log / menu / filter) were carved into
 * per-modal sub-reducers under `./modal/`, each `(model, msg) → [model, cmds]`
 * over its own `model.modal.<name>` + mode flag. This file keeps the
 * nav/chrome/lifecycle arms and DELEGATES modal Msgs via the `_MODAL_BY_TYPE`
 * map below. The shared write helpers (`withModes` / `withModal`)
 * live in `./model-ops` so both this reducer and the modal modules import them
 * without a cycle (reducer → modal/* → model-ops; the modals never import back).
 *
 * Lives in `dispatch/` (F3 — docs/reducer-cleanup-relocation.md): the reducer
 * reads `panel/route` + `model/store` (both DOWN from dispatch) and is invoked
 * by `dispatch.applyMsg` (intra-layer), so this is its natural home. The model
 * object + accessors live in `model/store.js` (v0.6.5 §1); `app/runtime.js` is
 * now a thin back-compat shim re-exporting this module.
 *
 * Contract:
 *   - Readers use `getModel()` (no global imports).
 *   - All writes to root-model fields flow through `update` (or a delegated
 *     modal sub-reducer), which returns a NEW model object on state change.
 *     Reducer-leaves (leaves/register / leaves/text/cmdline-split / etc.) are
 *     pure return-new transforms. Freeze-test coverage in test-immutable-*.js.
 *   - The reducer performs no I/O; effects are Cmd DESCRIPTORS the effects layer
 *     (effects.runEffects, called from dispatch.applyMsg) interprets.
 *   - A pure function of (model, msg). The focus-routing arms (escape /
 *     list_select / nav_select / next_tab / prev_tab / filter_*) read no route
 *     topology: the handler stamps the resolved bundle (`route.bundle(id)` →
 *     {compName, panelType, target}, or `msg.target` for the viewer-tab arms)
 *     onto the Msg, and the arm reads `msg.route` (blessed-exception A
 *     elimination — docs/reducer-route-purity.md). `set_config` reads
 *     `msg.csOwner` and `reset_group_context` reads `msg.owners` (#D9), both
 *     resolved by the impure-shell dispatcher. `route.wrap` (a pure Msg ctor) is
 *     not a topology read. See docs/blessed-exceptions.md.
 *   - Modal-close arms (in the ./modal/* sub-reducers) guard on their mode flag
 *     — a stale double-fire after the modal closed is a no-op, not a re-execution
 *     of the staged Cmd.
 */
'use strict';

// keybindings is a dependency-free leaf (the leader-chord registry tree), so
// the reducer can read it to walk the prefix tree without a require cycle.
const kb = require('../../leaves/input/keybindings');
// Panel routing leaf — `wrap` for routed Msgs; the cross-layer dispatches in
// escape / nav_select / reset_group_context / etc. read it. Direct import
// (zero deps) — no cycle.
const route = require('../../panel/route');
// The root-model store (the model object + init + getModel/setModel) lives in
// model/store.js (v0.6.5 §1) so panel/ and dispatch/ depend *down* on it. The
// three are re-exported below for back-compat (the app/runtime shim + tests).
const { init, getModel, setModel } = require('../../model/store');
// Shared root-model write helpers (#D12) — also used by the modal sub-reducers.
const { withModes: _withModes } = require('./model-ops');

// Per-modal sub-reducers (#D12). Each exports { TYPES, update(model,msg) }.
const confirm = require('./modal/confirm');
const prompt = require('./modal/prompt');
const copy = require('./modal/copy');
const registerPopup = require('./modal/register-popup');
const cmdline = require('./modal/cmdline');
const jobs = require('./modal/jobs');
const diagLog = require('./modal/diag-log');
const menu = require('./modal/menu');
const filter = require('./modal/filter');

// Build the Msg-type → modal-sub-reducer routing table once. The root `update`
// checks it first; a hit delegates the whole arm to that modal's `update`.
const _MODAL_BY_TYPE = new Map();
for (const m of [confirm, prompt, copy, registerPopup, cmdline, jobs, diagLog, menu, filter]) {
  for (const t of m.TYPES) _MODAL_BY_TYPE.set(t, m);
}

// blessed-exception A elimination (docs/reducer-route-purity.md) — the
// focus-routing arms (escape / list_select / nav_select / filter_*) no longer
// resolve a pane address inline. The HANDLER stamps `route.bundle(id)` (the
// `{ compName, panelType, target }` triple) onto the Msg; the arm reads it.

// `]`/`[` cycle the focused-or-sticky viewer's tab list. The next_tab/prev_tab
// handler (`actions._viewerTabBundle`) stamps `msg.target` + the tab info, so
// the arm keeps only the pure cycle math + reads no route topology.
function _cycleViewerTab(model, msg, dir) {
  const target = msg.target;
  if (!target) return [model, []];
  const total = msg.total | 0;
  if (total <= 1) return [model, []];
  const next = (((msg.curTab | 0) + (dir | 0)) % total + total) % total;
  const targetKey = (msg.tabKeys || [])[next] || null;
  return [model, [{ type: 'msg', msg: route.wrap(target, {
    type: 'tab_switch', idx: next,
    targetKey, currentGroup: msg.currentGroup || (model.currentGroup || ''),
  }) }]];
}

/**
 * The reducer — `(model, msg) → [nextModel, cmds]`.
 *
 * Two rules:
 *   1. Root-model writes happen HERE (or in a delegated ./modal/* sub-reducer).
 *      The reducer is the single writer for every chrome / modal / config /
 *      framework field; Component slices are written by each Component's own
 *      `update`.
 *   2. No effects. `update` stays free of effectful imports so it has no require
 *      cycle and is trivially unit-testable. Side effects go out as Cmd
 *      DESCRIPTORS (`{ type, ... }`) the effects layer interprets.
 *
 * Every branch returns a NEW model object; no in-place writes. Identity-preserve
 * on no-ops (skip alloc).
 */
function update(model, msg) {
  // Modal Msgs delegate to their per-modal sub-reducer (#D12).
  const modal = _MODAL_BY_TYPE.get(msg.type);
  if (modal) return modal.update(model, msg);

  switch (msg.type) {
    case 'escape': {
      // Esc exits list-select mode (clearing the focused panel's
      // selection), else clears any lingering multi-selection; otherwise
      // a no-op. The multiSel clear dispatches into the focused
      // Navigator's update (each panel owns its own Set). `hadMultiSel` +
      // the routing triple (`msg.route = route.bundle(getFocus())`) are
      // threaded by the escape handler; the arm reads no route.
      const had = !!msg.hadMultiSel;
      const r = msg.route;
      const clearCmd = () => (r
        ? [{ type: 'msg', msg: route.wrap(r.target, { type: 'multisel_clear', panel: r.panelType }) }]
        : []);
      if (model.modes.listSelectMode) {
        return [_withModes(model, { listSelectMode: false }), clearCmd()];
      } else if (had) {
        return [model, clearCmd()];
      }
      return [model, []];
    }
    case 'list_select': {
      // `mode:'toggle'` (v) flips list-select; turning it off drops the
      // operand selection. `mode:'on'` (*) forces it on (the caller then
      // fires selectAllVisible as an effect).
      if (msg.mode === 'on') return [_withModes(model, { listSelectMode: true }), []];
      const nextOn = !model.modes.listSelectMode;
      const next = _withModes(model, { listSelectMode: nextOn });
      if (!nextOn) {
        // Turning select mode OFF clears the operand selection. The toggle
        // handler stamps `msg.route` (focus bundle); clear THIS pane's
        // instance, keyed by its panel-type (see escape).
        const r = msg.route;
        if (r) return [next, [{ type: 'msg', msg: route.wrap(r.target, { type: 'multisel_clear', panel: r.panelType }) }]];
      }
      return [next, []];
    }
    case 'enter_prefix':
      // Leader pressed — arm prefix mode at the binding-tree root. All of
      // prefixMode/prefixNode/prefixSeq are model-resident.
      return [{ ..._withModes(model, { prefixMode: true }), prefixNode: kb.rootNode(), prefixSeq: [] }, []];
    case 'prefix_key': {
      // Walk the leader tree. Esc / a second leader press cancels. An
      // unbound token silently drops out. A subtree descends (stay armed);
      // a leaf exits + emits a run_binding Cmd carrying the thunk. kb.resolve
      // is a pure read of the leaf registry.
      const cancelled = () =>
        ({ ..._withModes(model, { prefixMode: false }), prefixNode: null, prefixSeq: [] });
      if (msg.key === 'escape' || msg.seq === ' ' || msg.key === ' ') return [cancelled(), []];
      const tok = kb.tokenForEvent(msg.key, msg.seq);
      const nextNode = kb.resolve(model.prefixNode, tok);
      if (!nextNode) return [cancelled(), []];
      const seq = model.prefixSeq.concat(tok);
      // Descend: which-key popup re-renders with the subtree's
      // continuations. If the subtree shrinks, prior overlay border rows
      // are exposed under-content the diff cache treats as unchanged
      // (panels are frozen during prefix mode), so prior pixels stick.
      // Force a full repaint on every descend.
      if (nextNode.children) return [{ ...model, prefixNode: nextNode, prefixSeq: seq }, [{ type: 'force_full_repaint' }]];
      // leaf — exit prefix mode and emit the binding
      return [{ ..._withModes(model, { prefixMode: false }), prefixNode: null, prefixSeq: [] },
              [{ type: 'run_binding', run: nextNode.run }]];
    }
    // --- Cmd-only verbs: no model change, the reducer just routes the
    // Msg to a Cmd the effects layer runs. Centralizing the Msg→Cmd
    // mapping here is what lets handleAction's arms collapse into update.
    case 'next_tab':    return _cycleViewerTab(model, msg, +1);
    case 'prev_tab':    return _cycleViewerTab(model, msg, -1);
    case 'nav_select': {
      // R6 — single-Msg cascade for "user selects row N in panel P,"
      // formerly orchestrated by dispatch.navSelect's 2-3 imperative
      // dispatches (set_cursor → showSelectedInfo → conditional
      // groups_selected). Collapsing to one Msg + multi-Cmd return makes
      // the cascade visible in the reducer (feedback_tea_reducer_discipline).
      const { index } = msg;
      // blessed-A — the navSelect handler stamps `msg.route =
      // route.bundle(panelType)` ({compName, panelType, target}); null when
      // the address owns no Component. r.panelType is the canonical
      // panel-type; r.target routes to THIS pane's instance vs the kind
      // primary; both no-op under single-pane configs.
      const r = msg.route;
      if (!r) return [model, []];
      const kindForNav = r.panelType;
      const cmds = [
        { type: 'msg', msg: route.wrap(r.target, { type: 'set_cursor', panel: kindForNav, index }) },
        { type: 'show_selected_info' },
      ];
      if (kindForNav === 'groups') {
        // Phase D1: thread the groups ctx so the reducer arm stays pure of
        // getModel(). viewerTarget + resetOwners ride in on msg (stamped by
        // the navSelect handler) so neither the reducer nor groups.update
        // reads route topology / the ownership registry — #D10 / #D9.
        const groupsComp = require('../../panel/navigator/groups');
        const ctx = { ...groupsComp.groupsBundle(model), paneMenuMode: !!model.modes.paneMenuMode,
                      viewerTarget: msg.viewerTarget, resetOwners: msg.resetOwners };
        cmds.push({ type: 'msg', msg: route.wrap('groups', { type: 'groups_selected', index, ctx }) });
      }
      return [model, cmds];
    }
    // --- terminal mode enter/exit. The PTY restart (on a dead session)
    // stays an effect in dispatch.activateTerminal; only the flag write is
    // the Msg here. Exit also asks layout to drop a 'full' auto-zoom back to
    // 'normal' (cross-layer dispatch_msg) + a full repaint so the chrome
    // reclaims the cells the PTY painted (the diff cache can't see those).
    case 'terminal_enter':
      if (model.modes.terminalMode) return [model, []];
      return [_withModes(model, { terminalMode: true }), []];
    case 'terminal_exit':
      // Guard on the flag so the per-frame setImmediate from a dead-PTY
      // overlay paint doesn't re-emit view_drop_full_to_normal each frame
      // once terminalMode is already off.
      if (!model.modes.terminalMode) return [model, []];
      return [_withModes(model, { terminalMode: false }),
              [{ type: 'msg', msg: route.wrap('layout', { type: 'view_drop_full_to_normal' }) }]];
    // --- terminal focus events (DEC 1004). Pauses/resumes the refresh loop
    // via model.focused; the focus-regain catch-up scheduleRender stays in
    // input.js (an effect decision the caller owns).
    case 'focus_event': {
      const focused = !!msg.focused;
      if (focused === model.focused) return [model, []];
      return [{ ...model, focused }, []];
    }
    // Frame-clock tick (docs/model-now-tick.md). Advance model.now from the
    // shell-stamped msg.now. FIX-3 Phase 6: the cadence is the model-conditional
    // `clock` interval Sub (app/state.js#_appSubscriptions — declared while an
    // age overlay is open, torn down when it closes), so this arm no longer
    // self-re-arms or tracks a clockArmed latch.
    case 'clock_tick':
      return [{ ...model, now: msg.now || model.now }, []];
    // v0.6.6 FIX-1 — the history ring mirrors itself into the model via the
    // store-mirror Sub (app/state.js#_appSubscriptions). Whole-snapshot; render
    // reads model.history (frame = f(model), #D5). No identity-preserve guard:
    // snapshot() is a fresh array each fire, and the store fires only on real
    // list-shape changes (start/end), so every dispatch IS a change.
    case 'history_synced':
      return [{ ...model, history: msg.history }, []];
    // v0.6.6 FIX-1 stage 2 — the diagnostics ring (io/diag-log) mirrors itself
    // into the model via the store-mirror Sub. Whole-snapshot; the diag overlay
    // reads model.diagLog. Fires on every diag mutation (low-frequency).
    case 'diag_synced':
      return [{ ...model, diagLog: msg.diagLog }, []];
    // v0.6.6 FIX-1 stage 3 — the live-jobs registry (feature/jobs) mirrors
    // itself into the model via the store-mirror Sub. Whole-snapshot; the
    // Running overlay + the viewer tab-strip running-glyph read model.jobs. The
    // jobs_activate cursor lookup still threads msg.job (handler-side, exc. C).
    case 'jobs_synced':
      return [{ ...model, jobs: msg.jobs }, []];
    case 'set_theme': {
      // Theme selection flows through update like any other state change.
      // model.theme is the SINGLE source of truth; the palette cache the pure
      // render leaves read is projected from it at the render entry (#D8 —
      // paint.js render(model) → themes.setTheme), so no Cmd/effect is needed
      // and the frame is replay-safe of the theme. No-op identity-preserve when
      // unchanged so a redundant `:theme X` while already on X doesn't churn.
      if (msg.name === model.theme) return [model, []];
      return [{ ...model, theme: msg.name }, []];
    }
    case 'mode_clear':
      // Defensive: clear a single mode flag. Used by dispatch's wedge-guard
      // when a mode handler throws — without this, the failing modal traps
      // every subsequent key (Esc included) in the same throwing handler.
      // Routed through update so even the panic-recovery path stays single-
      // writer; falls back to no-op if the flag isn't a registered mode.
      if (!msg.flag || !(msg.flag in model.modes) || model.modes[msg.flag] === false) return [model, []];
      return [_withModes(model, { [msg.flag]: false }), []];
    case 'mode_set':
      // Companion to mode_clear: set a mode flag to true via Msg. Used by
      // the viewer Component's search-enter handler to flip detailSearchMode
      // without writing across layers (the search slice is the viewer's; the
      // mode flag is root chrome).
      if (!msg.flag || !(msg.flag in model.modes) || model.modes[msg.flag] === true) return [model, []];
      return [_withModes(model, { [msg.flag]: true }), []];
    case 'set_current_group': {
      // Cross-layer Msg emitted by the groups Component when its tree cascade
      // changes the active group. currentGroup is APP-WIDE chrome (read by
      // actions / docker / files / tabs / etc.) — written through update so
      // every reader sees the same source.
      const name = typeof msg.name === 'string' ? msg.name : '';
      if (name === model.currentGroup) return [model, []];
      return [{ ...model, currentGroup: name }, []];
    }
    // v0.6.3 Phase D3 — boot-time root writes routed through Msgs. loadConfig
    // parses + dispatches set_config; initState dispatches set_register.
    case 'set_config': {
      const next = {
        ...model,
        config: msg.config,
        projectDir: (msg.config && msg.config.project_dir) || '.',
        configPath: msg.configPath || model.configPath,
      };
      // Fan set_config out to config-status, the only Component that snapshots
      // config (files / projectDir) onto its slice for reducer-pure reads.
      // #D9 — the owner is resolved by the dispatcher (impure shell,
      // app/state.loadConfig) and stamped on msg.csOwner, so the reducer reads
      // no ownership registry. null owner (Component unregistered) drops the
      // fan-out.
      return [next, msg.csOwner
        ? [{ type: 'msg', msg: route.wrap(msg.csOwner, { type: 'set_config', config: msg.config }) }]
        : []];
    }
    case 'set_register': {
      return [{ ...model, register: msg.register }, []];
    }
    case 'reset_group_context': {
      // Cross-layer Msg emitted by the groups Component on a group switch —
      // the ROOT chrome half of resetGroupContext (mode flags off + per-group
      // sel / filters / multiSel reset). The viewer-slice half rides on
      // viewer_reset_chrome → detail Component.
      const next = _withModes(model, { terminalMode: false, listSelectMode: false });
      // #D9 — the panel→owner map is resolved by the dispatcher (impure shell)
      // and stamped on msg.owners (`{ <panelType>: <ownerComponentName> }`), so
      // the reducer reads no ownership registry. The map's KEYS are WHICH
      // panels reset (route.resetGroupOwners is the single source); null owner
      // skips that panel. Routing by Component NAME so the fanout resolves to
      // the kind's primary instance (containers → docker).
      const cmds = [];
      for (const [panel, compName] of Object.entries(msg.owners || {})) {
        if (!compName) continue;
        cmds.push({ type: 'msg', msg: route.wrap(compName, { type: 'set_cursor', panel, index: 0 }) });
        cmds.push({ type: 'msg', msg: route.wrap(compName, { type: 'multisel_clear', panel }) });
        cmds.push({ type: 'msg', msg: route.wrap(compName, { type: 'clear_filter', panel }) });
      }
      return [next, cmds];
    }
    case 'free_config': {
      // Free-config is always available; the verb forwards a wrapped
      // free_config_enter Msg into the layout Component.
      return [model, [{ type: 'msg', msg: route.wrap('layout', { type: 'free_config_enter' }) }]];
    }
    default:
      return [model, []];
  }
}

// `init`/`getModel`/`setModel` re-exported for back-compat (the app/runtime
// shim + tests); new code imports them from model/store. `update` is the
// reducer this module owns.
module.exports = { init, getModel, setModel, update };
