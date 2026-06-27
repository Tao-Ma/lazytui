/**
 * Confirm modal sub-reducer (#D12 — carved out of the root reducer switch).
 * The caller stages a message + a Cmd DESCRIPTOR (the deferred effect as data);
 * `y` re-emits that Cmd, `n`/Esc clears. No closure in the model.
 * `update(model, msg) → [model, cmds]`; the root reducer delegates here by type.
 */
'use strict';

const { withModalMode: _withModalMode } = require('../model-ops');

const TYPES = ['confirm_enter', 'confirm_accept', 'confirm_reject'];

function update(model, msg) {
  switch (msg.type) {
    case 'confirm_enter':
      return [_withModalMode(model, { confirmMode: true },
        { confirm: { message: msg.message || 'Are you sure?', cmd: msg.cmd || null } }), []];
    case 'confirm_accept': {
      // Guard on the flag — a stale double-fire after the modal closed
      // would re-execute the staged Cmd against unstaged state. See
      // the modal-close contract in the reducer file header.
      if (!model.modes.confirmMode) return [model, []];
      const cmd = model.modal.confirm.cmd;
      const next = _withModalMode(model, { confirmMode: false }, { confirm: { message: '', cmd: null } });
      return [next, cmd ? [cmd] : []];
    }
    case 'confirm_reject':
      if (!model.modes.confirmMode) return [model, []];
      return [_withModalMode(model, { confirmMode: false }, { confirm: { message: '', cmd: null } }), []];
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
