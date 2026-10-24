/**
 * action-runner → fabric-form choices wiring (args→ports slice 2 commit 5).
 *
 * The handoff: `_promptMissing` builds the field snapshots the fabric-form
 * modal reads on `fabric_form_enter`. For `choices_fn:` to work end to end,
 * the handoff has to carry two extra decl keys through:
 *
 *   choices_fn:  → field.choicesFnRef   (dotted ref the runtime looks up)
 *   depends_on:  → field.dependsOn      (sibling port names)
 *
 * AND the reducer's `fabric_form_enter` arm has to emit initial
 * `fabric_form_choices_request` Cmds for computed fields whose deps are
 * already resolved (so the user sees `[fetching…]` on open rather than
 * having to tab around to trigger it).
 *
 * This file pins both halves:
 *   - _promptMissing field materialization carries the two keys
 *   - enter arm emits initial requests ONLY for computed fields with every
 *     dep text non-empty
 *   - focus_next/_prev reactively refetches a dependent whose deps-hash
 *     changed since its last request (and does NOT refetch when the user
 *     tabs away from a dep they didn't edit)
 *
 * Run: node js/test/test-action-runner-choices.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const runtime = require('../app/runtime');
const action = require('../dispatch/runtime/action-runner');
const store = require('../model/store');
const applyMsgs = require('../dispatch/control/dispatch').applyMsg;

function freshModel() {
  const m = runtime.init();
  m.currentGroup = 'g';
  m.register = { history: [], cap: 10 };
  store.setModel(m);
  return m;
}

const EDIT_ACTION = {
  label: 'Edit section', type: 'run', script: 'edit "$file" "$section"',
  ports: { in: {
    file:    { type: 'path',   required: true,  desc: 'target file' },
    section: { type: 'string', required: true,  desc: 'section',
               choices_fn: 'edit.sections_of', depends_on: ['file'] },
  } },
};

// _promptMissing takes a `resolved` from _resolvePortsForAction. Build one
// that marks both ports missing (no injects, no wires, no defaults).
function makeResolved({ fileValue } = {}) {
  const values = fileValue != null ? { file: fileValue } : {};
  const missing = fileValue != null
    ? [{ port: 'section', reason: 'no injects/wires/default' }]
    : [{ port: 'file',    reason: 'no injects/wires/default' },
       { port: 'section', reason: 'no injects/wires/default' }];
  return { ready: false, values, missing, sources: {} };
}

describe('[action-runner-choices] _promptMissing carries choicesFnRef + dependsOn', () => {
  it('a port with choices_fn + depends_on hands the modal field the ref + deps array', () => {
    freshModel();
    const resolved = makeResolved();
    const opened = action._promptMissing('edit-section', EDIT_ACTION, resolved);
    assert(opened, 'modal opened');
    const f = store.getModel().modal.fabricForm;
    const section = f.fields.find((x) => x.port === 'section');
    assert(section, 'section field present');
    eq(section.choicesFnRef, 'edit.sections_of', 'ref carried through');
    eq(section.dependsOn, ['file'], 'deps array carried through');
    // Also: the file field should NOT get a stale choicesFnRef inherited
    // from somewhere — plain ports get null.
    const file = f.fields.find((x) => x.port === 'file');
    eq(file.choicesFnRef, null);
    eq(file.dependsOn, []);
  });
});

describe('[action-runner-choices] initial requests on fabric_form_enter', () => {
  it('ENTER with ALL deps resolved emits a request Cmd for the computed port', () => {
    const m = freshModel();
    const fields = [
      { port: 'file',    text: '/tmp/x.md', required: true, default: null, desc: 'target file' },
      { port: 'section', text: '',          required: true, default: null, desc: 'section',
        choicesFnRef: 'edit.sections_of', dependsOn: ['file'] },
    ];
    const [, cmds] = runtime.update(m, {
      type: 'fabric_form_enter', fields,
      pendingAction: { actionKey: 'edit-section', action: EDIT_ACTION },
    });
    // One `msg` Cmd wrapping the choices_request should be emitted.
    const requests = cmds.filter(
      (c) => c.type === 'msg' && c.msg && c.msg.type === 'fabric_form_choices_request'
    );
    eq(requests.length, 1, 'exactly one initial request emitted');
    eq(requests[0].msg.port, 'section');
  });

  it('ENTER with a dep still EMPTY emits NO request (fetch would be wasted)', () => {
    const m = freshModel();
    const fields = [
      { port: 'file',    text: '',          required: true, default: null, desc: 'target file' },
      { port: 'section', text: '',          required: true, default: null, desc: 'section',
        choicesFnRef: 'edit.sections_of', dependsOn: ['file'] },
    ];
    const [, cmds] = runtime.update(m, {
      type: 'fabric_form_enter', fields,
      pendingAction: { actionKey: 'edit-section', action: EDIT_ACTION },
    });
    const requests = cmds.filter(
      (c) => c.type === 'msg' && c.msg && c.msg.type === 'fabric_form_choices_request'
    );
    eq(requests.length, 0, 'no request — dep is empty');
  });

  it('a computed port with NO dependsOn fires immediately on open', () => {
    const m = freshModel();
    const fields = [
      { port: 'section', text: '', required: true, default: null, desc: 'section',
        choicesFnRef: 'edit.sections_of', dependsOn: [] },
    ];
    const [, cmds] = runtime.update(m, {
      type: 'fabric_form_enter', fields,
      pendingAction: { actionKey: 'edit-section', action: EDIT_ACTION },
    });
    const requests = cmds.filter(
      (c) => c.type === 'msg' && c.msg && c.msg.type === 'fabric_form_choices_request'
    );
    eq(requests.length, 1, 'no deps → fire on open');
  });
});

describe('[action-runner-choices] reactive refetch on focus change', () => {
  function openWithFileInput(fileValue) {
    const m = freshModel();
    const fields = [
      { port: 'file',    text: fileValue, required: true, default: null, desc: 'target file' },
      { port: 'section', text: '',        required: true, default: null, desc: 'section',
        choicesFnRef: 'edit.sections_of', dependsOn: ['file'] },
    ];
    const [m1] = runtime.update(m, {
      type: 'fabric_form_enter', fields,
      pendingAction: { actionKey: 'edit-section', action: EDIT_ACTION },
    });
    // Fire the initial request manually so section.computed.inputsHash is populated.
    const [m2] = runtime.update(m1, { type: 'fabric_form_choices_request', port: 'section' });
    // Simulate the resolved reply so the state is settled before focus-blur.
    const section = m2.modal.fabricForm.fields.find((x) => x.port === 'section');
    const [m3] = runtime.update(m2, {
      type: 'fabric_form_choices_resolved',
      port: 'section', requestId: section.computed.requestId,
      items: ['a', 'b'], labels: null, error: null,
    });
    return m3;
  }

  it('editing the dep then tabbing away triggers a refetch', () => {
    let m = openWithFileInput('/tmp/old.md');
    // Edit file field's text (focus is on file at idx 0).
    m = { ...m, modal: { ...m.modal, fabricForm: { ...m.modal.fabricForm,
      fields: m.modal.fabricForm.fields.map((x) =>
        x.port === 'file' ? { ...x, text: '/tmp/new.md' } : x) } } };
    const [, cmds] = runtime.update(m, { type: 'fabric_form_focus_next' });
    const refetches = cmds.filter(
      (c) => c.type === 'msg' && c.msg && c.msg.type === 'fabric_form_choices_request'
    );
    eq(refetches.length, 1, 'refetch emitted for section');
    eq(refetches[0].msg.port, 'section');
  });

  it('tabbing away without editing the dep does NOT trigger a refetch', () => {
    const m = openWithFileInput('/tmp/x.md');
    const [, cmds] = runtime.update(m, { type: 'fabric_form_focus_next' });
    const refetches = cmds.filter(
      (c) => c.type === 'msg' && c.msg && c.msg.type === 'fabric_form_choices_request'
    );
    eq(refetches.length, 0, 'no refetch — dep hash unchanged');
  });

  it('tabbing out of a non-dep field does NOT trigger a refetch', () => {
    // Add a third field that section does NOT depend on; focus on it, tab away.
    let m = freshModel();
    const fields = [
      { port: 'file',    text: '/tmp/x.md', required: true, default: null, desc: 'target file' },
      { port: 'extra',   text: 'anything',  required: false, default: null, desc: 'extra' },
      { port: 'section', text: '',          required: true, default: null, desc: 'section',
        choicesFnRef: 'edit.sections_of', dependsOn: ['file'] },
    ];
    const [m1] = runtime.update(m, {
      type: 'fabric_form_enter', fields,
      pendingAction: { actionKey: 'edit-section', action: EDIT_ACTION },
    });
    // Focus 'extra' (idx 1 after required-first sort: required=file,section first).
    // After re-sort: [file, section, extra]; focus_next→section, focus_next→extra.
    const [m2] = runtime.update(m1, { type: 'fabric_form_focus_next' });  // → section
    const [m3] = runtime.update(m2, { type: 'fabric_form_focus_next' });  // → extra
    // Prime: issue initial request + resolve so inputsHash is populated.
    const [m4] = runtime.update(m3, { type: 'fabric_form_choices_request', port: 'section' });
    const section = m4.modal.fabricForm.fields.find((x) => x.port === 'section');
    const [m5] = runtime.update(m4, {
      type: 'fabric_form_choices_resolved',
      port: 'section', requestId: section.computed.requestId,
      items: ['x'], labels: null, error: null,
    });
    // Now tab out of 'extra' (idx 2) → focus wraps to idx 0 (file). Section
    // does not depend on 'extra', so no refetch should be emitted.
    const [, cmds] = runtime.update(m5, { type: 'fabric_form_focus_next' });
    const refetches = cmds.filter(
      (c) => c.type === 'msg' && c.msg && c.msg.type === 'fabric_form_choices_request'
    );
    eq(refetches.length, 0, 'no refetch — the blurred port was not a dep');
  });
});

report();
