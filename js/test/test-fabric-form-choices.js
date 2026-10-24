/**
 * Fabric multi-field FORM — `choices_fn:` computed-choices reducer arms
 * (args→ports slice 2, commit 3).
 *
 * Pins the three new arms:
 *   - fabric_form_choices_request  → marks the field pending + emits
 *                                    fetch_choices Cmd (payload-sanity + port-
 *                                    name resolution + stale-field drop)
 *   - fabric_form_choices_resolved → writes items/labels/error IF requestId
 *                                    still matches; stale replies are dropped
 *                                    before touching the field
 *   - fabric_form_choices_pick     → writes value into the field's text,
 *                                    flipping isDefault/isModified via the
 *                                    existing _editCurrent path
 *
 * A field without `choicesFnRef:` is invisible to all three arms (an idle port
 * can't be dragged into the computed-choices state machine by a mis-addressed
 * msg). The computed slot is a pure extension of the per-field state; no
 * side-channel storage, so replay reproduces frames identically from the
 * recorded msg stream.
 *
 * Run: node js/test/test-fabric-form-choices.js
 */
'use strict';

const { describe, it, eq, assert, expectNoMutation, report } = require('./test-runner');
const runtime = require('../app/runtime');

function freshModel() {
  const m = runtime.init();
  m.currentGroup = 'g';
  m.register = { history: [], cap: 10 };
  return m;
}

// An action with ONE port that carries a choices_fn + depends_on. The reducer
// receives fields pre-sorted required-first; here the computed port is the
// only required field.
const ACTION = {
  label: 'Edit section',
  type: 'run',
  script: 'edit "$file" "$section"',
  ports: {
    in: {
      file:    { type: 'path',   required: true, desc: 'target file' },
      section: { type: 'string', required: true, desc: 'section',
                 choices_fn: 'edit.sections_of', depends_on: ['file'] },
    },
  },
};

function fieldsFor() {
  return [
    { port: 'file',    text: '', required: true, default: null, desc: 'target file' },
    { port: 'section', text: '', required: true, default: null, desc: 'section',
      choicesFnRef: 'edit.sections_of', dependsOn: ['file'] },
  ];
}
const PENDING = { actionKey: 'edit-section', action: ACTION };

function openForm() {
  const m = freshModel();
  const [next] = runtime.update(m, {
    type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING,
  });
  return next;
}

describe('[fabric-form-choices] enter — computed slot seeded idle', () => {
  it('a port with choicesFnRef gets an idle computed slot; a port without stays null', () => {
    const m = openForm();
    const f = m.modal.fabricForm;
    const map = Object.fromEntries(f.fields.map((x) => [x.port, x]));
    eq(map.file.choicesFnRef, null, 'file has no choices_fn');
    eq(map.file.computed, null, 'file has null computed slot');
    eq(map.section.choicesFnRef, 'edit.sections_of', 'section carries the ref');
    eq(map.section.computed.state, 'idle');
    eq(map.section.computed.requestId, 0);
    eq(map.section.computed.items, []);
    eq(map.section.dependsOn, ['file'], 'dependsOn preserved from decl');
  });
});

describe('[fabric-form-choices] fabric_form_choices_request', () => {
  it('flips state → pending + emits fetch_choices Cmd with correct key + ref', () => {
    const m = openForm();
    const [next, cmds] = runtime.update(m, {
      type: 'fabric_form_choices_request',
      port: 'section', requestId: 1, inputsHash: 'h1',
      depValues: { file: '/tmp/x.md' },
    });
    const section = next.modal.fabricForm.fields.find((x) => x.port === 'section');
    eq(section.computed.state, 'pending');
    eq(section.computed.requestId, 1);
    eq(section.computed.inputsHash, 'h1');
    eq(cmds.length, 1, 'one Cmd emitted');
    eq(cmds[0].type, 'fetch_choices');
    eq(cmds[0].key, 'choices_fn:edit-section.section');
    eq(cmds[0].ref, 'edit.sections_of');
    eq(cmds[0].port, 'section');
    eq(cmds[0].values, { file: '/tmp/x.md' });
    eq(cmds[0].requestId, 1);
    eq(cmds[0].actionKey, 'edit-section');
  });

  it('request targeting a port WITHOUT choicesFnRef is a no-op', () => {
    const m = openForm();
    const [next, cmds] = expectNoMutation(
      'request against a non-computed port leaves the model intact',
      () => runtime.update(m, {
        type: 'fabric_form_choices_request', port: 'file', requestId: 1,
      }),
      m,
    );
    eq(cmds, [], 'no Cmd emitted');
    eq(next, m, 'model identity preserved');
  });

  it('request against an unknown port is a no-op', () => {
    const m = openForm();
    const [, cmds] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'ghost', requestId: 1,
    });
    eq(cmds, []);
  });

  it('fires only when the form is open', () => {
    const m = freshModel();
    const [next, cmds] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'section', requestId: 1,
    });
    eq(next, m, 'closed form → identity');
    eq(cmds, []);
  });
});

describe('[fabric-form-choices] fabric_form_choices_resolved', () => {
  it('matching requestId writes items + flips state → ok', () => {
    let m = openForm();
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'section', requestId: 1, inputsHash: 'h1',
    });
    const [next] = runtime.update(m, {
      type: 'fabric_form_choices_resolved',
      port: 'section', requestId: 1,
      items: ['intro', 'body', 'outro'], labels: null, error: null,
    });
    const section = next.modal.fabricForm.fields.find((x) => x.port === 'section');
    eq(section.computed.state, 'ok');
    eq(section.computed.items, ['intro', 'body', 'outro']);
    eq(section.computed.error, null);
  });

  it('error payload flips state → error + items stays []', () => {
    let m = openForm();
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'section', requestId: 2,
    });
    const [next] = runtime.update(m, {
      type: 'fabric_form_choices_resolved',
      port: 'section', requestId: 2,
      items: [], labels: null, error: 'file not found',
    });
    const section = next.modal.fabricForm.fields.find((x) => x.port === 'section');
    eq(section.computed.state, 'error');
    eq(section.computed.error, 'file not found');
  });

  it('stale requestId is dropped — field untouched', () => {
    let m = openForm();
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'section', requestId: 3,
    });
    // Simulate a later request that bumped the id.
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'section', requestId: 4,
    });
    const [next] = expectNoMutation(
      'stale reply with the older requestId is dropped at the arm',
      () => runtime.update(m, {
        type: 'fabric_form_choices_resolved',
        port: 'section', requestId: 3,         // STALE — current is 4
        items: ['stale'], labels: null, error: null,
      }),
      m,
    );
    const section = next.modal.fabricForm.fields.find((x) => x.port === 'section');
    eq(section.computed.state, 'pending', 'still pending — the fresh request has not resolved');
    eq(section.computed.requestId, 4, 'latest requestId preserved');
    eq(section.computed.items, [], 'no stale items leaked in');
  });

  it('resolved against a port without computed slot is a no-op', () => {
    const m = openForm();
    const [next] = runtime.update(m, {
      type: 'fabric_form_choices_resolved',
      port: 'file', requestId: 1, items: ['x'], labels: null, error: null,
    });
    eq(next, m, 'identity preserved');
  });

  it('labels longer than items are clamped at the arm', () => {
    let m = openForm();
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'section', requestId: 5,
    });
    const [next] = runtime.update(m, {
      type: 'fabric_form_choices_resolved',
      port: 'section', requestId: 5,
      items: ['a', 'b'], labels: ['A', 'B', 'C', 'D'], error: null,
    });
    const section = next.modal.fabricForm.fields.find((x) => x.port === 'section');
    eq(section.computed.labels.length, 2, 'labels truncated to items.length');
  });
});

describe('[fabric-form-choices] fabric_form_choices_pick', () => {
  it('writes value into the field text + flips to isModified', () => {
    const m = openForm();
    const [next] = runtime.update(m, {
      type: 'fabric_form_choices_pick', port: 'section', value: 'body',
    });
    const section = next.modal.fabricForm.fields.find((x) => x.port === 'section');
    eq(section.text, 'body', 'text set to picked value');
    assert(section.isModified, 'isModified (no default → non-empty text => modified)');
  });

  it('a pick does NOT submit — pendingAction stays set, form stays open', () => {
    const m = openForm();
    const [next, cmds] = runtime.update(m, {
      type: 'fabric_form_choices_pick', port: 'section', value: 'intro',
    });
    assert(next.modes.fabricFormMode, 'form stays open after pick');
    assert(next.modal.fabricForm.pendingAction, 'pendingAction preserved');
    eq(cmds, [], 'no Cmd — user may tweak more fields before Enter');
  });

  it('pick on an unknown port is a no-op', () => {
    const m = openForm();
    const [next] = runtime.update(m, {
      type: 'fabric_form_choices_pick', port: 'ghost', value: 'x',
    });
    eq(next, m);
  });
});

report();
