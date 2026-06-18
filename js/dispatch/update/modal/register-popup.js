/**
 * Register-history popup sub-reducer (`"`, #D12). The reducer owns the
 * cursor/scroll (model.modal.registerPopup) + the mode flag AND the history
 * mutation (via the leaves/register leaf); OSC52 is the only effect, emitted as
 * an emit_osc52 Cmd. `vh` (viewport height) is caller-resolved since it reads
 * the terminal size. Also hosts `register_push` (any app yank → register).
 * `update(model, msg) → [model, cmds]`.
 */
'use strict';

const { withModes: _withModes, withModal: _withModal } = require('../model-ops');
// Pure yank-register transforms (leaf) — push/promote/drop taking the register;
// OSC52 is an emit_osc52 Cmd.
const mreg = require('../../../leaves/register');

const TYPES = [
  'register_popup_enter', 'register_popup_nav', 'register_popup_drop',
  'register_popup_commit', 'register_push', 'register_popup_cancel',
];

/**
 * Clamp the register-popup cursor + scroll into bounds against the history
 * length `n` and the viewport height `vh` (resolved by the caller, since it
 * reads the terminal size — view-derived, not reducer state). Returns a new
 * `{idx, scroll}` value.
 */
function _clampRegisterPopup(rp, n, vh) {
  if (n === 0) {
    if (rp.idx === 0 && rp.scroll === 0) return rp;
    return { idx: 0, scroll: 0 };
  }
  let idx = rp.idx;
  let scroll = rp.scroll;
  if (idx < 0) idx = 0;
  if (idx >= n) idx = n - 1;
  if (idx < scroll) scroll = idx;
  if (idx >= scroll + vh) scroll = idx - vh + 1;
  if (scroll < 0) scroll = 0;
  if (idx === rp.idx && scroll === rp.scroll) return rp;
  return { idx, scroll };
}

function update(model, msg) {
  switch (msg.type) {
    case 'register_popup_enter':
      return [{
        ..._withModes(model, { registerPopupMode: true }),
        modal: { ...model.modal, registerPopup: { idx: 0, scroll: 0 } },
      }, []];
    case 'register_popup_nav': {
      const rp = model.modal.registerPopup;
      const n = model.register.history.length;
      let idx = rp.idx;
      if (msg.to === 'top')         idx = 0;
      else if (msg.to === 'bottom') idx = n - 1;
      // Number.isInteger guard instead of `msg.dir || 0` — same arithmetic
      // result today (no caller passes 0), but the integer-typed contract
      // is explicit and a malformed call with `dir: 'up'` falls through
      // to 0 (a no-op) rather than producing NaN.
      else                          idx = rp.idx + (Number.isInteger(msg.dir) ? msg.dir : 0);
      const clamped = _clampRegisterPopup({ idx, scroll: rp.scroll }, n, msg.vh);
      // Value-equal clamps preserve the original ref (callers can still
      // distinguish "nothing changed" from "no-op").
      if (clamped.idx === rp.idx && clamped.scroll === rp.scroll) return [model, []];
      return [_withModal(model, { registerPopup: clamped }), []];
    }
    case 'register_popup_drop': {
      if (!model.modes.registerPopupMode) return [model, []];
      const rp = model.modal.registerPopup;
      if (model.register.history.length === 0) return [model, []];
      // The leaf returns `[newRegister, removed]`; clamp against the new
      // length (idx stays on the row the next-older entry slides into).
      const [nextReg] = mreg.drop(model.register, rp.idx);
      const nextRp = _clampRegisterPopup(rp, nextReg.history.length, msg.vh);
      const modes = nextReg.history.length === 0
        ? { ...model.modes, registerPopupMode: false }
        : model.modes;
      const next = {
        ...model,
        modes,
        register: nextReg,
        modal: { ...model.modal, registerPopup: nextRp },
      };
      // force_full_repaint reclaims the row the shrunk overlay no longer
      // covers (the main diff can't see the overlay geometry).
      return [next, [{ type: 'force_full_repaint' }]];
    }
    case 'register_popup_commit': {
      if (!model.modes.registerPopupMode) return [model, []];
      const idx = model.modal.registerPopup.idx;
      const n = model.register.history.length;
      const baseNext = {
        ..._withModes(model, { registerPopupMode: false }),
        modal: { ...model.modal, registerPopup: { idx: 0, scroll: 0 } },
      };
      if (n === 0) return [baseNext, []];
      // idx>0 promotes the entry to top; idx===0 re-emits the current top so
      // opening the popup just to copy it still refreshes the OS clipboard.
      let nextReg = model.register;
      let v;
      if (idx > 0) {
        const [r, val] = mreg.promote(model.register, idx);
        nextReg = r;
        v = val;
      } else {
        v = model.register.history[0] || '';
      }
      return [{ ...baseNext, register: nextReg }, v ? [{ type: 'emit_osc52', text: v }] : []];
    }
    // --- yank-register push (folded into update). select.commit + any other
    // app yank emits this; the leaf does the dedup/cap, OSC52 rides out as a
    // Cmd. register.js keeps direct wrappers over the leaf for the test API.
    case 'register_push': {
      const [nextReg, v] = mreg.push(model.register, msg.text);
      if (nextReg === model.register && !v) return [model, []];
      return [{ ...model, register: nextReg }, v ? [{ type: 'emit_osc52', text: v }] : []];
    }
    case 'register_popup_cancel':
      if (!model.modes.registerPopupMode) return [model, []];
      return [{
        ..._withModes(model, { registerPopupMode: false }),
        modal: { ...model.modal, registerPopup: { idx: 0, scroll: 0 } },
      }, []];
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
