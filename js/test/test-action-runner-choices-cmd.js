/**
 * action-runner → fabric-form `choices_cmd:` wiring (args→ports slice 3).
 *
 * Sibling of test-action-runner-choices.js — same handoff, different channel.
 * `_promptMissing` must carry four extra decl keys through to the fabric-form
 * field snapshot so the reducer can seed a computed slot + emit the right
 * `fetch_choices_cmd` Cmd on request:
 *
 *   choices_cmd:     → field.choicesCmd       (shell command string)
 *   choices_labeled: → field.choicesLabeled   (bool, default false)
 *   choices_timeout: → field.choicesTimeout   (ms, null → runtime default)
 *   depends_on:      → field.dependsOn        (sibling port names)
 *
 * Plus: enter arm fires an initial `fabric_form_choices_request` for a
 * choicesCmd field whose deps are already populated (same contract as the
 * fn path from slice 2).
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const runtime = require('../app/runtime');
const action = require('../dispatch/runtime/action-runner');
const store = require('../model/store');

function freshModel() {
  const m = runtime.init();
  m.currentGroup = 'g';
  m.register = { history: [], cap: 10 };
  store.setModel(m);
  return m;
}

// Worktree-add shape (brief §4.5 stretch recipe): `repo` is a plain required
// text port; `branch` is a choices_cmd port that depends on `repo`.
const WORKTREE_ACTION = {
  label: 'Add worktree', type: 'run', script: 'wtadd "$repo" "$branch"',
  ports: { in: {
    repo:   { type: 'path',   required: true, desc: 'repo path' },
    branch: { type: 'string', required: true, desc: 'branch',
              choices_cmd: 'git -C "$repo" branch --format=%(refname:short)',
              choices_labeled: true,
              choices_timeout: 2500,
              depends_on: ['repo'] },
  } },
};

function makeResolved({ repoValue } = {}) {
  const values = repoValue != null ? { repo: repoValue } : {};
  const missing = repoValue != null
    ? [{ port: 'branch', reason: 'no injects/wires/default' }]
    : [{ port: 'repo',   reason: 'no injects/wires/default' },
       { port: 'branch', reason: 'no injects/wires/default' }];
  return { ready: false, values, missing, sources: {} };
}

describe('[action-runner-choices-cmd] _promptMissing carries all four keys', () => {
  it('choicesCmd / choicesLabeled / choicesTimeout / dependsOn arrive on the field snapshot', () => {
    freshModel();
    const opened = action._promptMissing('worktree-add', WORKTREE_ACTION, makeResolved());
    assert(opened, 'modal opened');
    const f = store.getModel().modal.fabricForm;
    const branch = f.fields.find((x) => x.port === 'branch');
    assert(branch, 'branch field present');
    eq(branch.choicesCmd, 'git -C "$repo" branch --format=%(refname:short)');
    eq(branch.choicesLabeled, true);
    eq(branch.choicesTimeout, 2500);
    eq(branch.dependsOn, ['repo']);
    // choicesFnRef stays null on a cmd-only port (no cross-channel leak).
    eq(branch.choicesFnRef, null);
    // Plain port stays null across all four keys.
    const repo = f.fields.find((x) => x.port === 'repo');
    eq(repo.choicesCmd, null);
    eq(repo.choicesLabeled, false);
    eq(repo.choicesTimeout, null);
    eq(repo.dependsOn, []);
  });

  it('computed slot seeded on open — brand-new form opens quiet, not flashing "idle"', () => {
    freshModel();
    action._promptMissing('worktree-add', WORKTREE_ACTION, makeResolved());
    const branch = store.getModel().modal.fabricForm.fields.find((x) => x.port === 'branch');
    assert(branch.computed, 'computed slot allocated');
    eq(branch.computed.state, 'idle');
    eq(branch.computed.items, []);
  });
});

describe('[action-runner-choices-cmd] initial requests on fabric_form_enter', () => {
  it('deps already populated → one initial request for the choicesCmd field', () => {
    freshModel();
    action._promptMissing('worktree-add', WORKTREE_ACTION,
                          makeResolved({ repoValue: '/some/repo' }));
    // After _promptMissing, the model is open with repo pre-filled. The
    // initial request Cmd fires during fabric_form_enter — assertion is
    // post-dispatch: branch.computed.state === 'pending'.
    const branch = store.getModel().modal.fabricForm.fields.find((x) => x.port === 'branch');
    eq(branch.computed.state, 'pending', 'initial request fired → pending');
  });

  it('deps empty → no initial request; computed stays idle', () => {
    freshModel();
    action._promptMissing('worktree-add', WORKTREE_ACTION, makeResolved());
    const branch = store.getModel().modal.fabricForm.fields.find((x) => x.port === 'branch');
    eq(branch.computed.state, 'idle', 'no fetch — repo is empty');
  });
});

report();
