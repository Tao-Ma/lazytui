/**
 * The unified effect/Cmd channel — the side-effect half of every
 * `update(... , msg) → [..., cmds]` path in the system.
 *
 * One registry, two emitters:
 *   - Root reducer (`runtime.update`) returns Cmd descriptors;
 *     `dispatch.applyMsg` runs them via `runEffects` here.
 *   - Component `update(msg, slice)` returns effect descriptors;
 *     `panel/api.dispatchMsg` runs them via `runEffects` here.
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
    if (!fn) {
      console.error(`[effects] no handler for '${eff.type}'`);
      _recordError({ where: 'effects', kind: 'no_handler', effectType: eff.type });
      continue;
    }
    try { fn(eff); }
    catch (e) {
      console.error(`[effects] '${eff.type}' failed: ${e && e.message}`);
      _recordError({ where: 'effects', kind: 'throw', effectType: eff.type,
        message: e && e.message, stack: e && e.stack });
    }
  }
}

// Persist the diagnostic to the event log too — console.error gets
// painted over by the next render, so without this a thrown effect
// (ReferenceError class, same as the T6 handleFilterKey bug) is
// invisible to anyone trying to debug from a recorded session.
// Lazy-require keeps effects.js dep-light + importable from tests.
function _recordError(payload) {
  try { require('./event-log').record('error', payload); }
  catch (_) { /* event-log unavailable — already logged to console */ }
}

// T28 — cyclic apply_msg / dispatch_msg recursion guard. Both effects
// synchronously re-enter the dispatch pipeline; two Components that
// emit cross-layer Msgs at each other would blow the JS stack without
// any depth bound. No in-tree Component does this today, but the
// contract permits it. Cap at 32 — deep enough for any legitimate
// fan-out cascade (the deepest observed is groups → groups_selected →
// reset_group_context → 3x set_cursor + multisel_clear + clear_filter,
// nesting ~4 deep), shallow enough to fail loudly on a runaway loop.
let _crossLayerDepth = 0;
const _CROSS_LAYER_MAX = 32;
function _enterCrossLayer(kind, eff) {
  if (_crossLayerDepth >= _CROSS_LAYER_MAX) {
    console.error(`[effects] ${kind} recursion depth ${_crossLayerDepth} exceeded ${_CROSS_LAYER_MAX} — dropping (cyclic dispatch_msg / apply_msg between Components?)`);
    _recordError({ where: 'effects', kind: 'recursion_cap', effectType: kind,
      depth: _crossLayerDepth, msgType: eff && eff.msg && eff.msg.type });
    return false;
  }
  _crossLayerDepth++;
  return true;
}
function _exitCrossLayer() { if (_crossLayerDepth > 0) _crossLayerDepth--; }

/** Clear all handlers — test isolation only. */
function clearEffects() { for (const k of Object.keys(_handlers)) delete _handlers[k]; }

/**
 * Register the framework's built-in effect handlers. Called once at boot
 * (tui.js). Module references are cached once here so the hot-path
 * handlers (`render` fires per streamed line via viewer_append; `refresh`
 * per refresh tick) don't re-traverse the require cache on each call.
 * Writes go through the reducer so update stays the single writer.
 */
function installBuiltins() {
  const { getModel } = require('../app/runtime');
  const api = require('../panel/api');
  const renderQueue = require('../render/render-queue');
  // setDetail: replace the detail panel content (config-status' Enter→diff,
  // any migrated plugin's detail write). Routes through viewer_set_content (no Cmds).
  registerEffect('setDetail', (eff) => {
    api.dispatchMsg(api.wrap('detail', {
      type: 'viewer_set_content', lines: Array.isArray(eff.lines) ? eff.lines.slice() : [],
    }));
  });
  // focus: move panel focus (a component can't write slice.focus itself).
  // focus_set is owned by layout.update.
  registerEffect('focus', (eff) => {
    if (typeof eff.panel === 'string') {
      api.dispatchMsg(api.wrap('layout', { type: 'focus_set', focus: eff.panel }));
    }
  });
  // render: request a repaint (async effect results landing into a slice).
  registerEffect('render', () => {
    try { renderQueue.scheduleRender(); } catch (_) { /* no renderer */ }
  });
  // apply_msg: cross-layer Msg dispatch — lets a Component (e.g. detail)
  // re-dispatch a Msg back to the root reducer (focus_set / terminal_enter
  // / mode_set/clear) without owning that layer's writes. Phase A/B.
  registerEffect('apply_msg', (eff) => {
    if (!_enterCrossLayer('apply_msg', eff)) return;
    try { require('./dispatch').applyMsg(eff.msg); }
    finally { _exitCrossLayer(); }
  });
  // dispatch_msg: Component-fan-out companion (Phase C). Used by a Component
  // update when it needs to send a Msg to ANOTHER Component (e.g. groups →
  // viewer_reset_chrome → detail Component on a group cascade).
  registerEffect('dispatch_msg', (eff) => {
    if (!_enterCrossLayer('dispatch_msg', eff)) return;
    try { api.dispatchMsg(eff.msg); }
    finally { _exitCrossLayer(); }
  });
  // show_selected_info: Component-level access to the framework Cmd that
  // refreshes the focused panel's info into the viewer. detail.update emits
  // this when closing the last content tab so the body falls back to Info.
  // Routes to detail.update's viewer_show_info case — single-writer for the
  // viewer slice through the Component fan-out.
  registerEffect('show_selected_info', () => {
    try {
      api.dispatchMsg(api.wrap('detail', { type: 'viewer_show_info' }));
    } catch (_) { /* no renderer (test) */ }
  });
  // destroy_pty_session: PTY teardown from the viewer-tab lifecycle (closing
  // an ephemeral terminal tab — emitted by detail.update's
  // viewer_remove_ephemeral_terminal branch).
  registerEffect('destroy_pty_session', (eff) => {
    try { require('../io/terminal').destroySession(eff.id); } catch (_) {}
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
      try { api.dispatchMsg(eff.msg); } catch (_) { /* registry gone */ }
    }, eff.ms);
    if (t && typeof t.unref === 'function') t.unref();
  });

  // --- Root-reducer Cmds ---
  // Emitted by `runtime.update` branches; run from `dispatch.applyMsg` via
  // the same `runEffects` interpreter as Component effects.

  registerEffect('force_full_repaint', () => {
    try { require('../render/layout').forceFullRepaint(); } catch (_) {}
  });
  registerEffect('refresh', () => {
    api.refreshAll(getModel().config);
  });
  registerEffect('show_help', () => { require('./help-text').showHelp(); });
  registerEffect('start_design', () => {
    require('./dispatch').startDesignMode();
  });
  // `_claimed` is the framework-internal sentinel a Component returns from
  // its `key` update to suppress the framework default. The normal path
  // consumes + filters it inside `dispatchKeyToFocused` before runEffects
  // sees it; the no-op here covers tests that call `runEffects` on a raw
  // update return without going through the dispatch entry point.
  registerEffect('_claimed', () => {});
  registerEffect('quit', () => {
    require('../app/cleanup').cleanup();
    process.exit(0);
  });
  // do_run / run_action: deferred to the next tick so the input pump's
  // trailing render() paints the overlay-gone frame BEFORE spawn() blocks
  // (preserves the pre-TEA setImmediate-on-commit behavior).
  registerEffect('do_run', (eff) => {
    setImmediate(() => require('./action-runner').doRun(eff.actionKey, eff.action, eff.args));
  });
  registerEffect('run_action', (eff) => {
    setImmediate(() => require('./action-runner').runAction(eff.actionKey, eff.action, eff.args));
  });
  // kill_proc / stream_action: emitted by detail.update's tab_switch case.
  // Killing a streaming run-action stops bleed-through when the user
  // switches to a different tab; stream_action restarts the action's
  // output flow when the user re-selects an action tab.
  registerEffect('kill_proc', () => {
    try { require('./action-runner').killCurrentProc(); } catch (_) {}
  });
  registerEffect('stream_action', (eff) => {
    try { require('./action-runner').streamCommand(eff.actionKey, eff.script); } catch (_) {}
  });
  // copy_commit: resolve the selected copy option's (module-held) content
  // thunk → OSC52, then drop the module options. idx<0 = cancel (just clear).
  registerEffect('copy_commit', (eff) => {
    const copy = require('../overlay/copy');
    if (eff.idx >= 0) copy.copySelect(eff.idx);
    copy.clearOptions();
  });
  // emit_osc52: the register's only effect — mirror a value to the OS
  // clipboard. History mutation already happened in the reducer (model-
  // register leaf); this just writes the escape sequence.
  registerEffect('emit_osc52', (eff) => {
    require('../feature/register').emitOSC52(eff.text);
  });
  // cmdline_rebuild: text changed — re-query the registry from the plugin
  // facade and feed the render-safe projection back through update. The
  // one Cmd that produces a Msg.
  registerEffect('cmdline_rebuild', () => {
    const m = getModel();
    const matches = require('./cmdline').rebuild(m.modal.cmdline.text);
    require('./dispatch').applyMsg({ type: 'cmdline_set_matches', matches });
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
    if (eff.action.startsWith('focus_panel:')) dispatch.handleAction('focus_panel', eff.action.split(':')[1]);
    else dispatch.handleAction(eff.action);
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
