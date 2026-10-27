/**
 * Render-time port resolver — the SHARED resolver between the spawn path
 * (`action-runner._resolvePortsForAction`) and preview surfaces. Both must
 * agree on "what value will the port actually bind at run time" so a
 * preview can't lie about what Enter will submit.
 *
 * **Why this leaf exists (v0.6.46 bug fix).** v0.6.44's confirm overlay
 * preview inlined a mini-resolver that read `model.fabric.injects[addr]`
 * at the top level — but injects are GROUP-KEYED (`{[group]: {[addr]:
 * {value, at, oneShot?}}}`), so the top-level read missed every inject,
 * always → every port showed `<pending>` even when the form just
 * collected a value. The gate-fix in v0.6.45 made the surface reachable
 * after a submit, which exposed the latent bug. Fix: route both the
 * spawn path and the preview path through the SAME resolver (this leaf)
 * so the two can't drift again. See [[project_v0645_edit_args_confirm_gate_fix]]
 * for the gate-fix context + the brief that triggered this follow-up.
 *
 * **The group arg is explicit, not read from model.currentGroup.**
 * A staged confirm overlay must preview the group the action was staged
 * from, not whatever group the user has navigated to mid-confirm. The
 * caller (`runAction` → `confirm_enter`'s cmd) stamps the group onto
 * the continuation so the overlay reads a stable value. If a future
 * caller forgets to stamp (empty-string group), the resolver falls
 * through to defaults and emits `<pending>` for every inject — a safe
 * failure mode (the preview under-reports, which is less bad than
 * over-reporting).
 *
 * Pure: takes (actionKey, action, model, group), returns the
 * `{values, sources, ready, missing}` shape `resolveInputs` emits. The
 * caller filters to render concerns (overlay/confirm.js builds
 * boundPorts from values + sources).
 *
 * **TEST-AUTHOR NOTE**: `fabricPorts.listWires()` throws
 * "fabric: host not wired" when no fabric host is registered. The
 * production boot path (`js/app/tui.js`) wires it before any UI could
 * trigger a confirm. In tests, require `js/dispatch/runtime/host-wiring`
 * and call `wireFabricHost()` ONCE at module load — see
 * `js/test/test-submit-preview.js` for the pattern.
 */
'use strict';

const { resolveInputs } = require('../../fabric/resolve');
const fabricPorts = require('../../fabric/ports');

function resolveForRender(actionKey, action, model, group) {
  const inputs = (action && action.ports && action.ports.in) || {};
  const g = typeof group === 'string' ? group : '';
  const injects = ((model && model.fabric && model.fabric.injects) || {})[g] || {};
  return resolveInputs(actionKey, inputs, {
    injects,
    wires: fabricPorts.listWires(),
    portValue: fabricPorts.portValue,
  });
}

module.exports = { resolveForRender };
