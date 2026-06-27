/**
 * Shared root-model write helpers — used by BOTH the root reducer
 * (`./reducer`) and the per-modal sub-reducers (`./modal/*`). #D12.
 *
 * Lives in its own module so the modal sub-reducers and the root reducer can
 * each import these without a cycle (reducer → modal/* → model-ops; modal
 * modules never import the reducer back). Pure transforms, zero imports.
 *
 * Spread chains for nested model writes are readable but verbose; these
 * collapse the common cases. `withModes` flips one or more mode flags;
 * `withModal` patches one or more modal sub-models. Both preserve object
 * identity when nothing changes is NOT guaranteed here (callers spread fresh);
 * they simply build the next model.
 */
'use strict';

function withModes(model, patch) {
  return { ...model, modes: { ...model.modes, ...patch } };
}

function withModal(model, patch) {
  return { ...model, modal: { ...model.modal, ...patch } };
}

// A modal transition almost always does BOTH at once: flip a `model.modes` flag
// AND seed/clear its `model.modal` sub-state (the #D12 coupling — a modal can't be
// a clean nested sub-reducer over `model.modal.X` alone because it also owns a
// shared mode flag). `withModalMode` collapses that double-spread into one call so
// every modal enter/exit arm reads as a single intent. For the rare arm that also
// touches a third subtree (e.g. register-popup's `model.register`), keep it explicit.
function withModalMode(model, modeFlagPatch, modalPatch) {
  return {
    ...model,
    modes: { ...model.modes, ...modeFlagPatch },
    modal: { ...model.modal, ...modalPatch },
  };
}

// (FIX-3 Phase 6 — the gated frame-clock loop is no longer armed here. The
// `*_open` arms just set their mode + seed `now`; the clock ticks via the
// model-conditional `clock` interval Sub, declared while an age overlay is
// open — app/state.js#_appSubscriptions. The old `armClock`/`arm_clock`/
// `CLOCK_MS` self-re-arm is retired.)

module.exports = { withModes, withModal, withModalMode };
