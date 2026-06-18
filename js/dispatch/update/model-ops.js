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

// Frame-clock cadence (model.now / tick arc — docs/model-now-tick.md).
// 1s matches the human-visible age resolution of the jobs/diag overlays.
const CLOCK_MS = 1000;

// Arm the gated frame-clock loop if it isn't already running. Returns the
// [model, cmds] pair so an *_open arm can `return armClock(opened)`. The
// `arm_clock` effect reads the wall clock in the impure shell (blessed
// exception C) and dispatches `clock_tick` carrying the fresh `now`; the
// clock_tick arm re-emits this Cmd while an age overlay stays open and lets
// it lapse (clockArmed→false) otherwise. Idempotent: a second open while
// armed adds no Cmd, so jobs+diag open together never double-arm.
function armClock(model) {
  if (model.clockArmed) return [model, []];
  return [{ ...model, clockArmed: true }, [{ type: 'arm_clock', ms: CLOCK_MS }]];
}

module.exports = { withModes, withModal, armClock, CLOCK_MS };
