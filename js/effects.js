/**
 * The unified effect/Cmd channel — the side-effect half of every
 * `update(... , msg) → [..., cmds]` path in the system.
 *
 * One registry, two emitters:
 *   - Root reducer (`runtime.update`) returns Cmd descriptors;
 *     `dispatch.applyMsg` runs them via `runEffects` here.
 *   - Component `update(msg, slice)` returns effect descriptors;
 *     `plugins/api.dispatchMsg` runs them via `runEffects` here.
 *
 * Cmds and effects are the same thing — plain descriptors
 * (`{ type: 'setDetail', lines: [...] }`). Handlers register by type;
 * the vocabulary grows as Components register their own (e.g.
 * config-status' cfgStatusCompute). Unknown types are logged, not
 * thrown — a misconfigured Component shouldn't wedge dispatch.
 *
 * The handlers route framework writes back through the reducer
 * (`viewer_set_content` / `focus_set` Msgs) so even effect-driven
 * writes go through update — single writer per layer.
 */
'use strict';

const _handlers = Object.create(null);

function registerEffect(type, fn) {
  if (typeof type !== 'string' || typeof fn !== 'function') {
    throw new Error('registerEffect(type, fn) requires a string type and a function');
  }
  _handlers[type] = fn;
}

function runEffects(effects) {
  if (!Array.isArray(effects)) return;
  for (const eff of effects) {
    if (!eff || typeof eff.type !== 'string') continue;
    const fn = _handlers[eff.type];
    if (!fn) { console.error(`[effects] no handler for '${eff.type}'`); continue; }
    try { fn(eff); }
    catch (e) { console.error(`[effects] '${eff.type}' failed: ${e && e.message}`); }
  }
}

/** Clear all handlers — test isolation only. */
function clearEffects() { for (const k of Object.keys(_handlers)) delete _handlers[k]; }

/**
 * Register the framework's built-in effect handlers. Called once at boot
 * (tui.js). Lazy-requires the core modules so this file stays dependency-
 * light + importable from tests. The writes go through the reducer so update
 * stays the single writer.
 */
function installBuiltins() {
  const { getModel } = require('./runtime');
  // setDetail: replace the detail panel content (config-status' Enter→diff,
  // any migrated plugin's detail write). Routes through viewer_set_content (no Cmds).
  registerEffect('setDetail', (eff) => {
    // viewer_set_content is handled by the detail Component's update (Phase B).
    // Phase 2b — wrapped routing.
    const api = require('./plugins/api');
    api.dispatchMsg(api.wrap('detail', {
      type: 'viewer_set_content', lines: Array.isArray(eff.lines) ? eff.lines.slice() : [],
    }));
  });
  // focus: move panel focus (a component can't write slice.focus itself).
  // Phase 1c — focus_set is owned by layout.update. Phase 2a — wrapped to
  // route directly to layout.
  registerEffect('focus', (eff) => {
    if (typeof eff.panel === 'string') {
      const api = require('./plugins/api');
      api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: eff.panel }));
    }
  });
  // render: request a repaint (async effect results landing into a slice).
  registerEffect('render', () => {
    try { require('./render-queue').scheduleRender(); } catch (_) { /* no renderer */ }
  });
  // apply_msg: cross-layer Msg dispatch — lets a Component (e.g. detail)
  // re-dispatch a Msg back to the root reducer (focus_set / terminal_enter
  // / mode_set/clear) without owning that layer's writes. Phase A/B.
  registerEffect('apply_msg', (eff) => {
    require('./dispatch').applyMsg(require('./runtime').getModel(), eff.msg);
  });
  // dispatch_msg: Component-fan-out companion (Phase C). Used by a Component
  // update when it needs to send a Msg to ANOTHER Component (e.g. groups →
  // viewer_reset_chrome → detail Component on a group cascade).
  registerEffect('dispatch_msg', (eff) => {
    require('./plugins/api').dispatchMsg(eff.msg);
  });
  // show_selected_info: Component-level access to the framework Cmd that
  // refreshes the focused panel's info into the viewer. detail.update emits
  // this when closing the last content tab so the body falls back to Info.
  registerEffect('show_selected_info', () => {
    try { require('./viewer').showSelectedInfo(require('./runtime').getModel()); }
    catch (_) { /* no renderer (test) */ }
  });
  // destroy_pty_session: PTY teardown from the viewer-tab lifecycle (closing
  // an ephemeral terminal tab — emitted by detail.update's
  // viewer_remove_ephemeral_terminal branch).
  registerEffect('destroy_pty_session', (eff) => {
    try { require('./terminal').destroySession(eff.id); } catch (_) {}
  });
  // tick: the recurring-timer primitive — the self-re-arming-tick Cmd.
  // Waits `ms`, then re-dispatches `msg` as a Component Msg. A Component drives
  // a periodic loop by RE-EMITTING this effect from the handler for its tick
  // Msg (self-arming, owned by the model — not a framework poll loop). `unref`
  // so a pending tick never keeps the process alive (clean teardown on quit +
  // in tests).
  registerEffect('tick', (eff) => {
    if (!eff || typeof eff.ms !== 'number' || !eff.msg) return;
    const t = setTimeout(() => {
      try { require('./plugins/api').dispatchMsg(eff.msg); } catch (_) { /* registry gone */ }
    }, eff.ms);
    if (t && typeof t.unref === 'function') t.unref();
  });

  // --- Root-reducer Cmds ---
  // Emitted by `runtime.update` branches; run from `dispatch.applyMsg` via
  // the same `runEffects` interpreter as Component effects.

  registerEffect('force_full_repaint', () => {
    try { require('./layout').forceFullRepaint(); } catch (_) {}
  });
  registerEffect('refresh', () => {
    require('./plugins/api').refreshAll(getModel().config);
  });
  registerEffect('show_help', () => { require('./help-text').showHelp(); });
  registerEffect('run_tab', (eff) => {
    require('./viewer').runTab(getModel(), eff.dir);
  });
  registerEffect('start_design', () => {
    require('./dispatch').startDesignMode();
  });
  registerEffect('quit', () => {
    require('./cleanup').cleanup();
    process.exit(0);
  });
  // do_run / run_action: deferred to the next tick so the input pump's
  // trailing render() paints the overlay-gone frame BEFORE spawn() blocks
  // (preserves the pre-TEA setImmediate-on-commit behavior).
  registerEffect('do_run', (eff) => {
    setImmediate(() => require('./actions').doRun(getModel(), eff.actionKey, eff.action, eff.args));
  });
  registerEffect('run_action', (eff) => {
    setImmediate(() => require('./actions').runAction(getModel(), eff.actionKey, eff.action, eff.args));
  });
  // copy_commit: resolve the selected copy option's (module-held) content
  // thunk → OSC52, then drop the module options. idx<0 = cancel (just clear).
  registerEffect('copy_commit', (eff) => {
    const copy = require('./copy');
    if (eff.idx >= 0) copy.copySelect(eff.idx);
    copy.clearOptions();
  });
  // emit_osc52: the register's only effect — mirror a value to the OS
  // clipboard. History mutation already happened in the reducer (model-
  // register leaf); this just writes the escape sequence.
  registerEffect('emit_osc52', (eff) => {
    require('./register').emitOSC52(eff.text);
  });
  // cmdline_rebuild: text changed — re-query the registry from the plugin
  // facade and feed the render-safe projection back through update. The
  // one Cmd that produces a Msg.
  registerEffect('cmdline_rebuild', () => {
    const m = getModel();
    const matches = require('./cmdline').rebuild(m.modal.cmdline.text);
    require('./dispatch').applyMsg(m, { type: 'cmdline_set_matches', matches });
  });
  // cmdline_run: invoke the held match at the selected index.
  registerEffect('cmdline_run', (eff) => {
    require('./cmdline').runAt(eff.sel, eff.args);
  });
  // cmdline_clear: drop the held registry + reset render residue (submit/cancel).
  registerEffect('cmdline_clear', () => { require('./cmdline').clear(); });
  // menu_action: the verb the user picked in the command menu. focus_panel
  // carries its hotkey as a suffix; everything else is a bare handleAction verb.
  registerEffect('menu_action', (eff) => {
    const dispatch = require('./dispatch');
    const m = getModel();
    if (eff.action.startsWith('focus_panel:')) dispatch.handleAction(m, 'focus_panel', eff.action.split(':')[1]);
    else dispatch.handleAction(m, eff.action);
  });
  // run_binding: a resolved leader leaf. Surface sync throws + async
  // rejections (mirrors the `:` cmdline path) rather than swallowing them.
  registerEffect('run_binding', (eff) => {
    try {
      Promise.resolve(eff.run()).catch(e => console.error('[leader]', e && e.message));
    } catch (e) {
      console.error('[leader]', e && e.message);
    }
  });
}

module.exports = { registerEffect, runEffects, clearEffects, installBuiltins, _handlers };
