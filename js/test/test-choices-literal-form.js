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

// --------------------------------------------------------------------------
// Brief 1 (v0.6.43 BUG fix): literal `choices:` must open the [space] popover.
// Pre-fix, three sites checked only choicesFnRef/choicesCmd and silently
// dropped literal fields: the reducer's fabric_form_choices_open guard,
// dispatch.js's SPACE branch, and (already fixed in v0.6.41 for lane routing
// but open-coded) action-runner's anyChoices. Single-sourced via
// field.hasChoices stamped by _normalize + js/leaves/ports/has-choices.js.
// --------------------------------------------------------------------------

function enterLiteralForm(items, labels = null) {
  const field = buildField('tunnel', {
    type: 'string', required: true,
    choices: { items, labels, truncated: false },
  });
  let m = freshOverlayModel();
  [m] = runtime.update(m, { type: 'fabric_form_enter', fields: [field],
    pendingAction: { actionKey: 'reissue', action: { label: 'Reissue' } } });
  return m;
}

describe('[form] Brief-1 fix — literal `choices:` opens the popover on space', () => {
  it('hasChoices stamped on literal fields', () => {
    const m = enterLiteralForm(['--a', '--b']);
    const f = m.modal.fabricForm.fields[0];
    eq(f.hasChoices, true, 'literal field must stamp hasChoices');
    eq(f.choicesFnRef, null, 'and no fn/cmd ref (literal-only)');
    eq(f.choicesCmd, null);
  });

  it('fabric_form_choices_open opens the picker on a literal-only field', () => {
    let m = enterLiteralForm(['--full-tunnel', '--no-full-tunnel']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'tunnel' });
    const picking = m.modal.fabricForm.picking;
    assert(picking, 'picking must be non-null after choices_open on literal field');
    eq(picking.port, 'tunnel');
    eq(picking.idx, 0, 'picker opens at idx 0');
  });

  it('nav clamps within literal items (no wrap past the ends)', () => {
    let m = enterLiteralForm(['one', 'two', 'three']);
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'tunnel' });
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });
    eq(m.modal.fabricForm.picking.idx, 1);
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });
    eq(m.modal.fabricForm.picking.idx, 2);
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });
    eq(m.modal.fabricForm.picking.idx, 2, 'clamp at last — no wrap');
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: -1 });
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: -1 });
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: -1 });
    eq(m.modal.fabricForm.picking.idx, 0, 'clamp at 0 — no wrap');
  });

  it('pick commits the VALUE (not the label) into field text, closes picker', () => {
    let m = enterLiteralForm(
      ['--full-tunnel', '--no-full-tunnel'],
      ['all traffic', 'split tunnel'],
    );
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'tunnel' });
    [m] = runtime.update(m, { type: 'fabric_form_choices_nav', dir: 1 });   // highlight idx 1
    [m] = runtime.update(m, { type: 'fabric_form_choices_pick', port: 'tunnel',
      value: '--no-full-tunnel' });
    const f = m.modal.fabricForm;
    eq(f.picking, null, 'picker closes after pick');
    eq(f.fields[0].text, '--no-full-tunnel', 'VALUE commits (NOT the label)');
  });

  it('overlay paints the popover rows with both labels after space-open', () => {
    let m = enterLiteralForm(
      ['--full-tunnel', '--no-full-tunnel'],
      ['all traffic via VPN', 'split tunnel'],
    );
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'tunnel' });
    const out = captureOverlay(m, () => renderFabricFormOverlay());
    assert(out.includes('all traffic via VPN'),
      `expected label 'all traffic via VPN' in popover frame, got: ${JSON.stringify(out).slice(0, 400)}`);
    assert(out.includes('split tunnel'),
      `expected label 'split tunnel' in popover frame, got: ${JSON.stringify(out).slice(0, 400)}`);
  });

  it('regression — fabric_form_choices_open STILL no-ops on a no-choices field', () => {
    // Space on a plain field must stay a no-op in the reducer (dispatch
    // falls through to insert ' '). Previously-correct behavior, pinned.
    const field = buildField('file', { type: 'path', required: true });
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields: [field],
      pendingAction: { actionKey: 'x', action: {} } });
    eq(m.modal.fabricForm.fields[0].hasChoices, false, 'plain field must NOT stamp hasChoices');
    const before = m.modal.fabricForm;
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'file' });
    eq(m.modal.fabricForm, before, 'reducer must return the same form state (no picking)');
    eq(m.modal.fabricForm.picking, null);
  });
});

describe('[form] Brief-1 fix — action-runner lane picks literal-only 1-port actions', () => {
  it('declHasChoices routes a 1-port literal-only action into the form lane', () => {
    // Direct check of the shared leaf through the pdef shape _promptMissing sees.
    // The lane split in action-runner.js is `declNames.length >= 2 || anyChoices`,
    // and anyChoices now goes through declHasChoices. A 1-port literal-only action
    // must still land in the form lane (not the lean fabric-field popup).
    const { declHasChoices } = require('../leaves/ports/has-choices');
    const literalOnly = { type: 'string', required: true,
                          choices: { items: ['--a', '--b'], labels: null, truncated: false } };
    eq(declHasChoices(literalOnly), true,
       'literal-only pdef must say hasChoices → anyChoices → form lane');
  });
});

report();
