/**
 * End-to-end — invoke-time multi-field form for a 2+-port action.
 *
 * Parallel to `test-shell-action-prompt.js` (which covers the 1-port fabric-field
 * lane) + `test-fabric-form.js` (reducer only) + `test-action-runner-prompt.js`
 * (helper functions). This file ties the three together: a declared 2-port
 * action goes through `_promptMissing` → fabric-form opens → user types →
 * submit writes one-shot injects + emits `do_run` → the resolver sees the
 * injected values → the env-shadow guard produces the shell env the child
 * would see. Reducer-level + helper-level — no actual spawn, which matches
 * the 1-port precedent.
 *
 * Run: node js/test/test-shell-action-form.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getModel } = require('../model/store');
const { applyMsg } = require('../dispatch/runtime/loop');
const runner = require('../dispatch/runtime/action-runner');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');

wireFabricHost();

const PROVISION = {
  type: 'run',
  label: 'Provision node',
  script: 'provision "$host" --role "$role" --port "$port"',
  ports: {
    in: {
      host: { type: 'string', required: true, desc: 'target hostname' },
      role: { type: 'string', required: true, desc: 'node role', default: 'worker' },
      port: { type: 'string', required: false, default: '22', desc: 'SSH port' },
    },
  },
};

function boot() {
  sm.bootFresh({
    groups: { g: {
      name: 'g', label: 'G', containers: [], children: [], parent: null, depth: 0, quick: false,
      actions: { provision: PROVISION },
    } },
  });
}

const inj = () => (getModel().fabric.injects[getModel().currentGroup] || {});

describe('[shell-action-form] 2+-port invoke-time path, end-to-end', () => {
  it('_promptMissing opens the form, pre-fills defaults, flags user typing as modified', () => {
    boot();
    const resolved = runner._resolvePortsForAction('provision', PROVISION, getModel());
    assert(!resolved.ready, 'resolver reports host missing');
    const opened = runner._promptMissing('provision', PROVISION, resolved);
    assert(opened, 'form opened');
    assert(getModel().modes.fabricFormMode, 'fabricFormMode on');
    const map = Object.fromEntries(getModel().modal.fabricForm.fields.map((x) => [x.port, x]));
    eq(map.host.text, '',   'host pre-fill: empty');
    eq(map.role.text, 'worker', 'role pre-fill: declared default');
    eq(map.port.text, '22', 'port pre-fill: declared default');
    assert(map.role.isDefault && !map.role.isModified, 'role chip: [default]');
    assert(map.port.isDefault && !map.port.isModified, 'port chip: [default]');
    assert(!map.host.isDefault && !map.host.isModified, 'host chip: [unset]');
  });

  it('full invoke cycle: form opens → user types → submit → do_run emitted → re-resolve finds the injects', () => {
    boot();
    const resolved = runner._resolvePortsForAction('provision', PROVISION, getModel());
    runner._promptMissing('provision', PROVISION, resolved);
    // Drive form keys + submit through applyMsg (the real dispatch loop seam).
    for (const c of 'node-7.lan') applyMsg({ type: 'fabric_form_key', key: c, seq: c });
    applyMsg({ type: 'fabric_form_focus_next' });   // focus → role
    // Keep role at its default (do not modify) → NO inject.
    applyMsg({ type: 'fabric_form_focus_next' });   // focus → port
    applyMsg({ type: 'fabric_form_key', seq: '\x15' });   // Ctrl+U clear
    for (const c of '2222') applyMsg({ type: 'fabric_form_key', key: c, seq: c });
    // Submit — the reducer writes injects + emits do_run.
    applyMsg({ type: 'fabric_form_submit' });
    const injects = inj();
    eq(injects['provision.host'].value, 'node-7.lan', 'host inject written');
    assert(injects['provision.host'].oneShot === true, 'host is one-shot');
    eq(injects['provision.port'].value, '2222', 'port inject written');
    assert(injects['provision.port'].oneShot === true, 'port is one-shot');
    assert(!('provision.role' in injects), 'role at default → no inject');
    // Re-resolve: now ready with the user-provided values.
    const reResolved = runner._resolvePortsForAction('provision', PROVISION, getModel());
    assert(reResolved.ready, 'now ready');
    eq(reResolved.values.host, 'node-7.lan', 'host resolves from inject');
    eq(reResolved.values.role, 'worker', 'role resolves from declared default');
    eq(reResolved.values.port, '2222', 'port resolves from inject');
    // Env binding: _envWithShadowGuard uses the resolved values.
    const env = runner._envWithShadowGuard('provision', reResolved.values);
    eq(env.host, 'node-7.lan');
    eq(env.role, 'worker');
    eq(env.port, '2222');
  });

  it('user cancels the form — no injects written, no do_run emitted', () => {
    boot();
    // bootFresh doesn't nuke model.fabric.injects between scenarios (an
    // intentional smoke-helper choice — prior ports-pane edits can persist for
    // multi-step smoke flows); clear this group's slot explicitly so we assert
    // on NET effect of this test alone, not a leak from the prior one.
    if (getModel().fabric && getModel().fabric.injects) {
      getModel().fabric.injects[getModel().currentGroup] = {};
    }
    const resolved = runner._resolvePortsForAction('provision', PROVISION, getModel());
    runner._promptMissing('provision', PROVISION, resolved);
    for (const c of 'typed') applyMsg({ type: 'fabric_form_key', key: c, seq: c });
    applyMsg({ type: 'fabric_form_cancel' });
    const injects = inj();
    assert(!('provision.host' in injects), 'no inject written on cancel');
    assert(!getModel().modes.fabricFormMode, 'form closed');
  });
});

report();
