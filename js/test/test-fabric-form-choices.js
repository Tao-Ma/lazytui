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

// R1F-SMELL3 — the "free-type still wins; choices_fn is not a hard constraint"
// claim in the docs is now pinned by a reducer-level test: a user types a
// value that ISN'T in the choices list and the form submits with that value
// as a one-shot inject, exactly like a plain port.
describe('[fabric-form-choices] R1F-SMELL3 — free-type still wins', () => {
  it('typing a non-choice value then submitting binds that value', () => {
    let m = openForm();
    // Simulate the request + resolved so items has ['intro','body'].
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section' });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: 1,
      items: ['intro', 'body'], labels: null, error: null,
    });
    // Fill the file field (required) + focus to section + type a NON-choice.
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '/' });
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: 't' });
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });   // → section
    for (const ch of 'off_menu') [m] = runtime.update(m, { type: 'fabric_form_key', seq: ch });
    // Submit.
    const [after, cmds] = runtime.update(m, { type: 'fabric_form_submit' });
    const injectAddr = `edit-section.section`;
    const injects = (after.fabric && after.fabric.injects && after.fabric.injects.g) || {};
    assert(injects[injectAddr], `inject written for section, got: ${JSON.stringify(Object.keys(injects))}`);
    eq(injects[injectAddr].value, 'off_menu', 'the free-typed value binds, not any choice');
    assert(cmds.some((c) => c.type === 'do_run'),
      `do_run emitted — form submits with the free-type, got: ${JSON.stringify(cmds)}`);
  });
});

// R1C — cross-form stale-reply via actionKey mismatch. Form-1 (actionKey='A')
// has an in-flight fetch at requestId=1. Form-1 cancels. Form-2 (actionKey=
// 'B') opens with a port of the same name; its requestSeq resets to 0, so
// its first request also lands at requestId=1. Form-1's resolved reply then
// arrives with actionKey='A' + requestId=1 — must be dropped.
describe('[fabric-form-choices] R1C — cross-form stale-reply dropped on actionKey mismatch', () => {
  it('a resolved reply with the wrong actionKey is dropped', () => {
    // Form-1 at actionKey='A': open, kick a request so requestId lands at 1.
    let m = openForm();   // openForm uses actionKey 'edit-section' as PENDING
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section' });
    // Cancel form-1.
    [m] = runtime.update(m, { type: 'fabric_form_cancel' });
    // Open form-2 with a DIFFERENT actionKey but a port of the same name.
    const form2Fields = [
      { port: 'section', text: '', required: true, default: null, desc: 'section',
        choicesFnRef: 'other.sections_of', dependsOn: [] },
    ];
    [m] = runtime.update(m, {
      type: 'fabric_form_enter', fields: form2Fields,
      pendingAction: { actionKey: 'OTHER_ACTION', action: {} },
    });
    // Form-2 fires its own initial request → requestId=1 (requestSeq reset
    // on enter), bumping to its own computed slot.
    // Simulate the stale resolved reply from form-1 (wrong actionKey).
    const before = m;
    const [after] = runtime.update(m, {
      type: 'fabric_form_choices_resolved',
      port: 'section', actionKey: 'edit-section',   // STALE — form-1's actionKey
      requestId: 1,
      items: ['stale'], labels: null, error: null,
    });
    eq(after, before, 'stale cross-form reply dropped — model identity preserved');
    const section = after.modal.fabricForm.fields.find((x) => x.port === 'section');
    assert(section.computed.state !== 'ok' || section.computed.items.length === 0,
      `section did NOT get populated by the stale reply, got: ${JSON.stringify(section.computed)}`);
  });

  it('a resolved reply WITHOUT actionKey still lands (back-compat with pre-R1C callers)', () => {
    // Tests built before R1C stamped actionKey; the arm tolerates omission.
    let m = openForm();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section' });
    const requestId = m.modal.fabricForm.fields.find((x) => x.port === 'section').computed.requestId;
    const [after] = runtime.update(m, {
      type: 'fabric_form_choices_resolved',
      port: 'section', requestId,
      items: ['intro'], labels: null, error: null,
      // actionKey intentionally absent
    });
    const section = after.modal.fabricForm.fields.find((x) => x.port === 'section');
    eq(section.computed.items, ['intro'], 'reply landed');
  });
});

// R1A-BUG1 regression — resolved arm clamps picking.idx when items shrinks.
describe('[fabric-form-choices] R1A-BUG1 — picking.idx clamped on items shrink', () => {
  it('refetch returning fewer items than idx clamps idx to last valid', () => {
    let m = openForm();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section' });
    const rid1 = m.modal.fabricForm.fields.find((x) => x.port === 'section').computed.requestId;
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved',
      port: 'section', requestId: rid1,
      items: ['a', 'b', 'c', 'd', 'e'], labels: null, error: null,
    });
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    // Nav to idx 4.
    for (let i = 0; i < 4; i++) {
      [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });
    }
    eq(m.modal.fabricForm.picking.idx, 4);
    // A refetch returns only 2 items.
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section' });
    const rid2 = m.modal.fabricForm.fields.find((x) => x.port === 'section').computed.requestId;
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved',
      port: 'section', requestId: rid2,
      items: ['x', 'y'], labels: null, error: null,
    });
    eq(m.modal.fabricForm.picking.idx, 1, 'clamped to items.length - 1');
  });

  it('refetch returning empty items clamps idx to 0', () => {
    let m = openForm();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section' });
    const rid1 = m.modal.fabricForm.fields.find((x) => x.port === 'section').computed.requestId;
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: rid1,
      items: ['a', 'b', 'c'], labels: null, error: null,
    });
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'section' });
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section' });
    const rid2 = m.modal.fabricForm.fields.find((x) => x.port === 'section').computed.requestId;
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved', port: 'section', requestId: rid2,
      items: [], labels: null, error: null,
    });
    eq(m.modal.fabricForm.picking.idx, 0);
  });
});

// R1A-BUG2 regression — focus arms reset a pending field whose deps got
// emptied + emit cancel_effect so the in-flight fetch is aborted.
describe('[fabric-form-choices] R1A-BUG2 — pending resets when deps get emptied', () => {
  it('tabbing away from an emptied dep resets pending + emits cancel_effect', () => {
    let m = openForm();
    // Fill file so initial request fires.
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '/' });
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: 'x' });
    // Simulate kicking a request + waiting.
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section' });
    const section = m.modal.fabricForm.fields.find((x) => x.port === 'section');
    eq(section.computed.state, 'pending');
    // Clear the file dep via Ctrl-U.
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '\x15' });
    // Tab away — pending should flip to idle + cancel_effect emitted.
    const [after, cmds] = runtime.update(m, { type: 'fabric_form_focus_next' });
    const next = after.modal.fabricForm.fields.find((x) => x.port === 'section');
    eq(next.computed.state, 'idle', 'pending reset to idle (chip no longer stuck [fetching…])');
    eq(next.computed.requestId, 0, 'requestId cleared → stale resolve dropped');
    assert(cmds.some((c) => c.type === 'cancel_effect' && /choices_fn:edit-section\.section$/.test(c.key)),
      `cancel_effect emitted, got: ${JSON.stringify(cmds)}`);
  });
});

// R1B-SMELL1 — cancel emits cancel_effect for every pending fetch.
describe('[fabric-form-choices] R1B-SMELL1 — cancel aborts in-flight fetches', () => {
  it('fabric_form_cancel emits cancel_effect per pending field', () => {
    let m = openForm();
    [m] = runtime.update(m, { type: 'fabric_form_choices_request', port: 'section' });
    const [, cmds] = runtime.update(m, { type: 'fabric_form_cancel' });
    assert(cmds.some((c) => c.type === 'cancel_effect' && /choices_fn:edit-section\.section$/.test(c.key)),
      `cancel_effect emitted on form cancel, got: ${JSON.stringify(cmds)}`);
  });
});

report();
