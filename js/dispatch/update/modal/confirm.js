/**
 * Confirm modal sub-reducer (#D12 — carved out of the root reducer switch).
 * The caller stages a message + a Cmd DESCRIPTOR (the deferred effect as data)
 * on `model.modal.continuation` (E14); `y` re-emits that Cmd, `n`/Esc clears.
 * No closure in the model.
 * `update(model, msg) → [model, cmds]`; the root reducer delegates here by type.
 */
'use strict';

const { withModalMode: _withModalMode } = require('../model-ops');
const { isChainActive } = require('../../../leaves/input/modes');

const TYPES = ['confirm_enter', 'confirm_accept', 'confirm_reject'];

function update(model, msg) {
  switch (msg.type) {
    case 'confirm_enter':
      // Modals are flat — one at a time (leaves/input/modes.js + the single
      // model.modal.continuation slot). confirm_enter is the only modal-opener
      // that can be dispatched ASYNCHRONOUSLY (the unrouted-stream preempt in
      // stream.js, an action.confirm from action-runner) rather than from a
      // keyboard gesture; opening it OVER an already-live modal would stomp that
      // modal's staged continuation. In normal use the keyboard can't reach a
      // confirm trigger while a modal owns input, so this guard only ever fires
      // defensively — when it does, the open modal wins and the confirm is dropped.
      if (isChainActive(model.modes)) return [model, []];
      // v0.6.45 — PRESERVE model.modal.onReject across confirm_enter. The
      // fabric-form submit arm stamps onReject in a reducer step BEFORE the
      // run_action Cmd fires setImmediate'd runAction → confirm_enter here, so
      // nullifying onReject in this arm would strand the rollback. See
      // model/store.js for the slot's full rationale.
      return [_withModalMode(model, { confirmMode: true },
        { confirm: { message: msg.message || 'Are you sure?' }, continuation: msg.cmd || null }), []];
    case 'confirm_accept': {
      // Guard on the flag — a stale double-fire after the modal closed
      // would re-execute the staged Cmd against unstaged state. See
      // the modal-close contract in the reducer file header.
      if (!model.modes.confirmMode) return [model, []];
      const cmd = model.modal.continuation;
      // v0.6.45 — clear onReject on accept WITHOUT firing it. The forward Cmd
      // path (do_run → doRun → _consumeOneShotInjects) consumes the one-shots
      // through its own channel when the spawn succeeds; firing onReject here
      // would double-consume (harmless, but noisy in the WAL).
      const next = _withModalMode(model, { confirmMode: false }, { confirm: { message: '' }, continuation: null, onReject: null });
      return [next, cmd ? [cmd] : []];
    }
    case 'confirm_reject': {
      if (!model.modes.confirmMode) return [model, []];
      // v0.6.45 — fire onReject on decline. Rolls back any model side-effect
      // the confirm's trigger wrote on the way in (specifically the fabric-
      // form submit's one-shot injects on the `[a]` → confirm-gated-action
      // lane). A null onReject (every pre-fix caller + every non-form-submit
      // confirm trigger) stays a no-op.
      const rollback = model.modal.onReject;
      const next = _withModalMode(model, { confirmMode: false }, { confirm: { message: '' }, continuation: null, onReject: null });
      return [next, rollback ? [rollback] : []];
    }
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
