/**
 * Fabric multi-field FORM — `choices_cmd:` reducer arms (args→ports slice 3).
 *
 * Mirrors test-fabric-form-choices.js but for the shell-backed sibling of
 * `choices_fn:`. Pins:
 *   - A field with choicesCmd gets an idle computed slot (same as fn path)
 *   - fabric_form_choices_request on a choicesCmd field emits a
 *     `fetch_choices_cmd` Cmd with the right key prefix (`choices_cmd:…`),
 *     cmd, labeled, timeout, env, port, requestId, actionKey, group
 *   - fabric_form_choices_resolved updates the same arm uniformly (same Msg
 *     shape, no channel discriminator in the arm)
 *   - fabric_form_choices_open is permitted for choicesCmd fields
 *   - Submit / cancel emit cancel_effect with the `choices_cmd:` key prefix
 *     (not `choices_fn:`) for a pending choicesCmd field
 *   - Dep-blur refetch emits a new fetch_choices_cmd Cmd (not fetch_choices)
 *   - Initial-request on enter fires for choicesCmd fields too
 *
 * Run: node js/test/test-fabric-form-choices-cmd.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');

function freshModel() {
  const m = runtime.init();
  m.currentGroup = 'g';
  m.register = { history: [], cap: 10 };
  return m;
}

// Action with ONE choices_cmd port that depends on a sibling text port.
// Shape mirrors the brief's `worktree branch` recipe.
const ACTION = {
  label: 'Add worktree',
  type: 'run',
  script: 'wtadd "$repo" "$branch"',
  ports: {
    in: {
      repo:   { type: 'path',   required: true, desc: 'repo path' },
      branch: { type: 'string', required: true, desc: 'branch',
                choices_cmd: 'git -C "$repo" branch --format=%(refname:short)',
                choices_labeled: false,
                choices_timeout: 3000,
                depends_on: ['repo'] },
    },
  },
};

function fieldsFor() {
  return [
    { port: 'repo',   text: '', required: true, default: null, desc: 'repo path' },
    { port: 'branch', text: '', required: true, default: null, desc: 'branch',
      choicesCmd: 'git -C "$repo" branch --format=%(refname:short)',
      choicesLabeled: false,
      choicesTimeout: 3000,
      dependsOn: ['repo'] },
  ];
}
const PENDING = { actionKey: 'worktree-add', action: ACTION };

function openForm() {
  const m = freshModel();
  const [next] = runtime.update(m, {
    type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING,
  });
  return next;
}

describe('[fabric-form-choices-cmd] enter — computed slot seeded idle for choicesCmd', () => {
  it('branch has choicesCmd + idle computed slot; repo has null slot', () => {
    const m = openForm();
    const f = m.modal.fabricForm;
    const map = Object.fromEntries(f.fields.map((x) => [x.port, x]));
    eq(map.repo.choicesCmd, null, 'repo has no choices_cmd');
    eq(map.repo.computed, null);
    eq(map.branch.choicesCmd, 'git -C "$repo" branch --format=%(refname:short)');
    eq(map.branch.choicesLabeled, false);
    eq(map.branch.choicesTimeout, 3000);
    eq(map.branch.computed.state, 'idle');
    eq(map.branch.computed.requestId, 0);
    eq(map.branch.dependsOn, ['repo']);
  });

  it('deps unresolved on enter → NO initial fetch_choices_cmd emitted', () => {
    const m = freshModel();
    const [, cmds] = runtime.update(m, {
      type: 'fabric_form_enter', fields: fieldsFor(), pendingAction: PENDING,
    });
    const fetches = cmds.filter((c) => c.type === 'msg' && c.msg && c.msg.type === 'fabric_form_choices_request');
    eq(fetches.length, 0, 'no initial request — repo is empty');
  });

  it('deps resolved on enter → initial fetch request for the choices_cmd field', () => {
    const m = freshModel();
    const fields = fieldsFor();
    fields[0].text = '/some/repo';                                  // dep is populated
    const [, cmds] = runtime.update(m, {
      type: 'fabric_form_enter', fields, pendingAction: PENDING,
    });
    const requests = cmds.filter((c) => c.type === 'msg' && c.msg && c.msg.type === 'fabric_form_choices_request' && c.msg.port === 'branch');
    eq(requests.length, 1, 'one initial request for branch');
  });
});

describe('[fabric-form-choices-cmd] fabric_form_choices_request — emits fetch_choices_cmd', () => {
  it('on a choicesCmd field: emits Cmd with choices_cmd key, cmd, env, timeout, labeled', () => {
    const m = openForm();
    const [next, cmds] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'branch',
      depValues: { repo: '/some/repo' }, requestId: 7, inputsHash: 'h7',
    });
    const branch = next.modal.fabricForm.fields.find((x) => x.port === 'branch');
    eq(branch.computed.state, 'pending');
    eq(branch.computed.requestId, 7);
    eq(cmds.length, 1);
    const c = cmds[0];
    eq(c.type, 'fetch_choices_cmd');
    eq(c.key, 'choices_cmd:worktree-add.branch');
    eq(c.cmd, 'git -C "$repo" branch --format=%(refname:short)');
    eq(c.labeled, false);
    eq(c.timeout, 3000);
    eq(c.env, { repo: '/some/repo' });
    eq(c.cwd, '.', 'cwd stamped from model.projectDir — parity with script:');
    eq(c.port, 'branch');
    eq(c.requestId, 7);
    eq(c.actionKey, 'worktree-add');
    eq(c.group, 'g');
    assert(!('ref' in c), 'no `ref` field — this is the cmd channel');
  });

  it('cwd tracks model.projectDir (parity with script: spawnOpts)', () => {
    const m = openForm();
    m.projectDir = '/opt/project';
    const [, cmds] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'branch',
      depValues: { repo: '/x' }, requestId: 1, inputsHash: 'h',
    });
    eq(cmds[0].cwd, '/opt/project');
  });

  it('fn-channel effect payload has NO cwd key (channel-asymmetric)', () => {
    // Set up a fn-channel sibling form inline so we assert the branching
    // reducer's fn arm is unchanged by this fix. The fn Cmd has `ref`, not
    // `cwd` — choices_fn runs in-process and resolves paths via require/fs
    // from the component author's perspective, not from projectDir.
    const m = freshModel();
    const fnFields = [
      { port: 'file', text: '/tmp/x.md', required: true, default: null, desc: 'file' },
      { port: 'section', text: '', required: true, default: null, desc: 'section',
        choicesFnRef: 'edit.sections_of', dependsOn: ['file'] },
    ];
    const [withForm] = runtime.update(m, {
      type: 'fabric_form_enter', fields: fnFields,
      pendingAction: { actionKey: 'edit-section', action: { label: 'Edit', type: 'run' } },
    });
    const [, cmds] = runtime.update(withForm, {
      type: 'fabric_form_choices_request', port: 'section',
      depValues: { file: '/tmp/x.md' }, requestId: 1, inputsHash: 'h',
    });
    eq(cmds[0].type, 'fetch_choices');
    assert(!('cwd' in cmds[0]), 'fn channel does NOT carry cwd — in-process, not spawned');
  });

  it('a port with no choicesCmd AND no choicesFnRef is invisible to request', () => {
    const m = openForm();
    const [next, cmds] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'repo', requestId: 99,
    });
    eq(cmds.length, 0, 'no Cmd — repo has no choices');
    eq(next, m, 'model unchanged');
  });
});

describe('[fabric-form-choices-cmd] fabric_form_choices_resolved — same arm, cmd channel', () => {
  it('reply with items populates the branch field', () => {
    let m = openForm();
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'branch',
      depValues: { repo: '/some/repo' }, requestId: 1, inputsHash: 'h1',
    });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved',
      port: 'branch', actionKey: 'worktree-add', requestId: 1,
      items: ['main', 'dev', 'feature-x'], labels: null, error: null,
    });
    const b = m.modal.fabricForm.fields.find((x) => x.port === 'branch');
    eq(b.computed.state, 'ok');
    eq(b.computed.items, ['main', 'dev', 'feature-x']);
    eq(b.computed.error, null);
  });

  it('reply with labels (choices_labeled: true path) populates labels alongside items', () => {
    let m = openForm();
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'branch', requestId: 2,
    });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved',
      port: 'branch', actionKey: 'worktree-add', requestId: 2,
      items: ['v1', 'v2'], labels: ['Label 1', 'Label 2'], error: null,
    });
    const b = m.modal.fabricForm.fields.find((x) => x.port === 'branch');
    eq(b.computed.items, ['v1', 'v2']);
    eq(b.computed.labels, ['Label 1', 'Label 2']);
  });

  it('error payload lands as state:error', () => {
    let m = openForm();
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'branch', requestId: 3,
    });
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_resolved',
      port: 'branch', actionKey: 'worktree-add', requestId: 3,
      items: [], labels: null, error: 'choices_cmd timed out after 3000ms',
    });
    const b = m.modal.fabricForm.fields.find((x) => x.port === 'branch');
    eq(b.computed.state, 'error');
    assert(/timed out/.test(b.computed.error), `error text preserved, got: ${b.computed.error}`);
  });
});

describe('[fabric-form-choices-cmd] cancel_effect uses the choices_cmd: prefix', () => {
  it('on form cancel: pending choicesCmd field emits choices_cmd:… key', () => {
    let m = openForm();
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'branch', requestId: 1,
    });
    const [, cmds] = runtime.update(m, { type: 'fabric_form_cancel' });
    const cancels = cmds.filter((c) => c.type === 'cancel_effect');
    eq(cancels.length, 1);
    eq(cancels[0].key, 'choices_cmd:worktree-add.branch');
    assert(!/choices_fn/.test(cancels[0].key), 'MUST NOT use the fn prefix');
  });

  it('on submit: cancel_effect fires with the choices_cmd: key, then do_run', () => {
    let m = openForm();
    // Need to put a value in both required fields so submit emits do_run.
    [m] = runtime.update(m, { type: 'fabric_form_focus_next' });   // focus=1 (branch)
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: 'm' });
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: 'a' });
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: 'i' });
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: 'n' });
    [m] = runtime.update(m, { type: 'fabric_form_focus_prev' });   // focus=0 (repo)
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '/' });
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: 'r' });
    // Simulate a pending fetch on branch (user tabs back + hits enter mid-fetch).
    [m] = runtime.update(m, {
      type: 'fabric_form_choices_request', port: 'branch', requestId: 1,
    });
    const [, cmds] = runtime.update(m, { type: 'fabric_form_submit' });
    const cancels = cmds.filter((c) => c.type === 'cancel_effect');
    eq(cancels.length, 1);
    eq(cancels[0].key, 'choices_cmd:worktree-add.branch');
    const run = cmds.find((c) => c.type === 'do_run');
    assert(run, 'do_run emitted');
  });
});

describe('[fabric-form-choices-cmd] fabric_form_choices_open — permitted for choicesCmd', () => {
  it('opens the picker on a choicesCmd field', () => {
    let m = openForm();
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'branch' });
    const f = m.modal.fabricForm;
    eq(f.picking && f.picking.port, 'branch');
  });

  it('does NOT open on a field with neither choicesCmd nor choicesFnRef', () => {
    let m = openForm();
    const before = m.modal.fabricForm.picking;
    [m] = runtime.update(m, { type: 'fabric_form_choices_open', port: 'repo' });
    eq(m.modal.fabricForm.picking, before, 'picker unchanged');
  });
});

describe('[fabric-form-choices-cmd] dep-blur refetch emits fetch_choices_cmd', () => {
  it('editing repo then tabbing away triggers a fetch_choices_cmd refetch for branch', () => {
    let m = openForm();
    // Simulate: user types in repo (focus 0), then tabs to branch (focus 1).
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: '/' });
    [m] = runtime.update(m, { type: 'fabric_form_key', seq: 'r' });
    const [, cmds] = runtime.update(m, { type: 'fabric_form_focus_next' });
    const requests = cmds.filter((c) => c.type === 'msg' && c.msg && c.msg.type === 'fabric_form_choices_request' && c.msg.port === 'branch');
    eq(requests.length, 1, 'one refetch emitted for branch');
  });
});

report();
