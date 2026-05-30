/**
 * Effect channel for the Component (TEA) API — the side-effect half of
 * `update(msg, slice) → [newSlice, effects]`.
 *
 * A Component is a pure function of (msg, slice): it returns its next state
 * plus a list of EFFECTS describing framework actions it wants performed
 * (write the detail panel, switch focus, request a repaint, run an async
 * compute, …). It never writes the model itself. The framework executes
 * those effects here, keeping the component testable/replayable while still
 * able to drive the imperative core.
 *
 * Effects are plain descriptors: `{ type: 'setDetail', lines: [...] }`.
 * Handlers register by type; the vocabulary grows as plugins migrate and
 * need new effects (a component can registerEffect its own — e.g.
 * config-status' cfgStatusCompute). Unknown effect types are logged, not
 * thrown — a misconfigured component shouldn't wedge dispatch.
 *
 * v0.5 note: the built-in effects route through the reducer (viewer_set_content /
 * focus_set Msgs) so even a component's framework writes flow through update
 * — the single writer. The component never touches model state directly.
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
    // viewer_set_content is handled by the detail Component's update (Phase B);
    // route via the Component fan-out.
    require('./plugins/api').dispatchMsg({
      type: 'viewer_set_content', lines: Array.isArray(eff.lines) ? eff.lines.slice() : [],
    });
  });
  // focus: move panel focus (a component can't write model.focus itself).
  registerEffect('focus', (eff) => {
    if (typeof eff.panel === 'string') {
      require('./dispatch').applyMsg(getModel(), { type: 'focus_set', focus: eff.panel });
    }
  });
  // render: request a repaint (async effect results landing into a slice).
  registerEffect('render', () => {
    try { require('./render-queue').scheduleRender(); } catch (_) { /* no renderer */ }
  });
  // apply_msg: cross-layer Msg dispatch from a Component's update — same
  // semantics as the root reducer's apply_msg Cmd (dispatch.runCmd). Lets a
  // Component (e.g. detail) re-dispatch a Msg back to the root reducer
  // (focus_set / terminal_enter/exit / mode_set/clear) without owning that
  // layer's writes. Phase A/B.
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
    try { require('./detail').showSelectedInfo(require('./runtime').getModel()); }
    catch (_) { /* no renderer (test) */ }
  });
  // destroy_pty_session: PTY teardown from the viewer-tab lifecycle (closing
  // an ephemeral terminal tab — emitted by detail.update's
  // viewer_remove_ephemeral_terminal branch).
  registerEffect('destroy_pty_session', (eff) => {
    try { require('./terminal').destroySession(eff.id); } catch (_) {}
  });
  // tick: the recurring-timer primitive — the TEA self-re-arming-tick Cmd.
  // Waits `ms`, then re-dispatches `msg` as a Component Msg. A Component drives
  // a periodic loop
  // by RE-EMITTING this effect from the handler for its tick Msg (self-arming,
  // owned by the model — not a framework poll loop). `unref` so a pending tick
  // never keeps the process alive (clean teardown on quit + in tests).
  registerEffect('tick', (eff) => {
    if (!eff || typeof eff.ms !== 'number' || !eff.msg) return;
    const t = setTimeout(() => {
      try { require('./plugins/api').dispatchMsg(eff.msg); } catch (_) { /* registry gone */ }
    }, eff.ms);
    if (t && typeof t.unref === 'function') t.unref();
  });
}

module.exports = { registerEffect, runEffects, clearEffects, installBuiltins, _handlers };
