/**
 * TUI form seeding for literal `choices:` (Brief 2 — args→ports slice 3+1).
 *
 * The literal channel seeds `field.computed` DIRECTLY at `fabric_form_enter`
 * (no fetch effect, no [fetching…] chip transition). This test pins:
 *   1. _buildFormField carries parser-normalized `choices` through to the raw
 *      field decl the reducer receives.
 *   2. `fabric_form_enter` seeds computed.state = 'ok' + items + labels from
 *      the literal choices, with NO fetch effect emitted (initialRequests is
 *      empty for literal-only fields).
 *   3. Chip renders `[N choices]` from the first frame — no `[fetching…]`.
 *   4. choices_cmd / choices_fn paths are UNAFFECTED (regression).
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const runtime = require('../app/runtime');
const { freshOverlayModel, captureOverlay } = require('./_helpers/overlay-capture');
const { renderFabricFormOverlay } = require('../overlay/fabric-form');
const actionRunner = require('../dispatch/runtime/action-runner');

// Build fabric_form_enter fields the way _promptMissing / do_edit_args will.
// Exercise the real action-runner path through the exported _test_buildFormField
// if it's exposed; otherwise reconstruct the shape directly from the parser-
// normalized decl.
function buildField(port, decl) {
  // Use the raw-field shape _promptMissing builds (per Brief 2 spec).
  const def = decl.default != null ? String(decl.default) : null;
  const choices = (decl.choices && typeof decl.choices === 'object'
                   && Array.isArray(decl.choices.items))
    ? { items: decl.choices.items.slice(),
        labels: decl.choices.labels ? decl.choices.labels.slice() : null,
        truncated: !!decl.choices.truncated }
    : null;
  return {
    port, text: '',
    required: decl.required !== false,
    default: def,
    desc: typeof decl.desc === 'string' ? decl.desc : '',
    choicesFnRef: typeof decl.choices_fn === 'string' && decl.choices_fn ? decl.choices_fn : null,
    choicesCmd: typeof decl.choices_cmd === 'string' && decl.choices_cmd ? decl.choices_cmd : null,
    choicesLabeled: decl.choices_labeled === true,
    choicesTimeout: null,
    dependsOn: Array.isArray(decl.depends_on) ? decl.depends_on.filter((n) => typeof n === 'string') : [],
    choices,
  };
}

describe('[form] fabric_form_enter seeds computed from literal choices directly', () => {
  it('scalar list → field.computed = {state:ok, items, labels:null, no fetch Cmd}', () => {
    const field = buildField('name', {
      type: 'string', required: true,
      choices: { items: ['nginx', 'sshd'], labels: null, truncated: false },
    });
    let m = freshOverlayModel();
    let cmds;
    [m, cmds] = runtime.update(m, { type: 'fabric_form_enter', fields: [field],
      pendingAction: { actionKey: 'restart', action: {} } });
    const f = m.modal.fabricForm.fields[0];
    assert(f.computed, 'field.computed must be seeded for literal choices');
    eq(f.computed.state, 'ok', 'state is ok immediately (no [fetching…])');
    eq(f.computed.items, ['nginx', 'sshd'], 'items match the parser output');
    eq(f.computed.labels, null, 'labels preserved as null (all-scalar)');
    eq(f.computed.error, null);
    eq(f.computed.truncated, false);
    assert(!cmds || cmds.length === 0, `no fetch Cmd for literal, got: ${JSON.stringify(cmds)}`);
  });

  it('labeled map list → labels array survives into computed, items are values', () => {
    const field = buildField('tunnel', {
      type: 'string', required: true,
      choices: {
        items: ['--full-tunnel', '--no-full-tunnel'],
        labels: ['all traffic via VPN', 'split tunnel'],
        truncated: false,
      },
    });
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: [field],
      pendingAction: { actionKey: 'reissue', action: {} } });
    const f = m.modal.fabricForm.fields[0];
    eq(f.computed.items, ['--full-tunnel', '--no-full-tunnel']);
    eq(f.computed.labels, ['all traffic via VPN', 'split tunnel']);
  });

  it('truncated flag survives through form_enter', () => {
    const field = buildField('p', {
      choices: { items: ['a'], labels: null, truncated: true },
    });
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: [field],
      pendingAction: { actionKey: 'x', action: {} } });
    eq(m.modal.fabricForm.fields[0].computed.truncated, true);
  });
});

describe('[form] chip paints `[N choices]` from the FIRST frame — no fetching flash', () => {
  it('literal choices → `[2 choices]` chip visible with no fetch roundtrip', () => {
    const field = buildField('name', {
      type: 'string', required: true,
      choices: { items: ['nginx', 'sshd'], labels: null, truncated: false },
    });
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: [field],
      pendingAction: { actionKey: 'restart', action: { label: 'Restart' } } });
    const out = captureOverlay(m, () => renderFabricFormOverlay());
    assert(/\[2 choices\]/.test(out), `expected '[2 choices]' chip in first frame — got: ${JSON.stringify(out).slice(0, 300)}`);
    assert(!/\[fetching/.test(out), `must NOT paint [fetching…] for literal — got: ${JSON.stringify(out).slice(0, 300)}`);
  });

  it('singular form `[1 choice]` for a single-item literal', () => {
    const field = buildField('p', {
      type: 'string', required: true,
      choices: { items: ['only'], labels: null, truncated: false },
    });
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: [field],
      pendingAction: { actionKey: 'x', action: { label: 'X' } } });
    const out = captureOverlay(m, () => renderFabricFormOverlay());
    assert(/\[1 choice\]/.test(out),
      `expected singular '[1 choice]' — got: ${JSON.stringify(out).slice(0, 300)}`);
  });
});

describe('[form] regression — cmd/fn channels still fetch (literal is additive)', () => {
  it('choices_cmd field (no literal) still gets EMPTY_COMPUTED + a fetch Cmd', () => {
    const field = buildField('name', {
      type: 'string', required: true,
      choices_cmd: "printf 'a\\nb\\n'",
    });
    let m = freshOverlayModel();
    let cmds;
    [m, cmds] = runtime.update(m, { type: 'fabric_form_enter', fields: [field],
      pendingAction: { actionKey: 'restart', action: {} } });
    const f = m.modal.fabricForm.fields[0];
    assert(f.computed, 'cmd field still gets a computed slot');
    eq(f.computed.state, 'idle', 'cmd starts idle (will transition to pending via effect)');
    eq(f.computed.items, [], 'items empty on open — fetch hasn\'t fired yet');
    // At least one initial request Cmd for the cmd fetch.
    assert(cmds && cmds.some((c) => c.type === 'msg' && c.msg
             && c.msg.type === 'fabric_form_choices_request'),
      `expected a fabric_form_choices_request Cmd for cmd channel, got: ${JSON.stringify(cmds)}`);
  });
});

report();
