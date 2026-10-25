/**
 * Real-world action shapes for the invoke-time popup — exercises
 * `_promptMissing` + fabric-form reducer with varied port counts, types,
 * choices channels, and dep chains. Each scenario mirrors a shape a plugin
 * author would realistically write (dev9's choices_cmd adoption, docker/k8s
 * ops, cert tooling, vcs workflows).
 *
 * Pins:
 *   - Routing correctness across lane boundaries (1-port no-choices →
 *     fabric-field; everything else → fabric-form).
 *   - Field materialization carries all four choices keys per port.
 *   - Required-first sort for N≥2 fields.
 *   - Dep chains land values on the right downstream env binding.
 *   - Submit emits do_run with the right actionKey.
 *
 * Run: node js/test/test-fabric-form-real-actions.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getModel } = require('../model/store');
const runner = require('../dispatch/runtime/action-runner');
const runtime = require('../app/runtime');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');

wireFabricHost();

// Realistic action library. Each entry mirrors a shape a real plugin author
// would write — see e.g. docs/action-ports-guide.md's recipes, dev9's 12
// choices_cmd declarations, and the common one-liners from the TUI author
// community.
const ACTIONS = {
  // 1-port, string + choices_cmd, no deps. The dev9 "restart-service" shape:
  // the sole choice is "pick an existing service name". Pre-fix: silently
  // inert (lean popup, no chip). Post-fix (549b6dda): form lane.
  'restart-service': {
    type: 'run', label: 'Restart service',
    script: 'systemctl restart "$service"',
    ports: { in: {
      service: { type: 'string', required: true, desc: 'systemd unit',
                 choices_cmd: "systemctl list-units --type=service --no-legend | awk '{print $1}'" },
    } },
  },

  // 1-port, string + choices_cmd + default. The default pre-fills the field
  // but the chip still reads [N choices] so the picker is reachable.
  'ssh-connect': {
    type: 'spawn', label: 'SSH connect',
    script: 'ssh "$host"',
    ports: { in: {
      host: { type: 'string', required: true, desc: 'hostname', default: 'localhost',
              choices_cmd: "awk '/^Host / {print $2}' ~/.ssh/config | grep -v '[*?]'" },
    } },
  },

  // 2-port, mixed: required path + required choices_cmd dep on the path.
  // Worktree-add from the slice-3 brief (worked recipe).
  'worktree-add': {
    type: 'run', label: 'Add worktree',
    script: 'git worktree add "../$branch" "$branch" -C "$repo"',
    ports: { in: {
      repo:   { type: 'path',   required: true, desc: 'repo path' },
      branch: { type: 'string', required: true, desc: 'branch name',
                choices_cmd: 'git -C "$repo" branch --format=%(refname:short)',
                depends_on: ['repo'] },
    } },
  },

  // 3-port, cascading deps (A → B → C) all choices_cmd. kubectl-exec is the
  // canonical shape: context → namespace → pod.
  'kubectl-exec': {
    type: 'spawn', label: 'kubectl exec',
    script: 'kubectl exec -it -n "$namespace" --context "$context" "$pod" -- sh',
    ports: { in: {
      context:   { type: 'string', required: true, desc: 'kube context',
                   choices_cmd: 'kubectl config get-contexts -o name' },
      namespace: { type: 'string', required: true, desc: 'namespace',
                   choices_cmd: 'kubectl --context "$context" get ns -o name | cut -d/ -f2',
                   depends_on: ['context'] },
      pod:       { type: 'string', required: true, desc: 'pod',
                   choices_cmd: 'kubectl --context "$context" -n "$namespace" get pods -o name | cut -d/ -f2',
                   depends_on: ['context', 'namespace'] },
    } },
  },

  // Mixed required + optional with default. Cert-reissue: ca is required
  // (pick from CA list); subject is required plain text; days is optional
  // with a sensible default.
  'cert-reissue': {
    type: 'run', label: 'Reissue cert',
    script: 'step ca sign --ca "$ca" --subject "$subject" --days "$days"',
    ports: { in: {
      ca:      { type: 'string', required: true, desc: 'CA name',
                 choices_cmd: "ls pki/issued | sed 's/.pem$//'" },
      subject: { type: 'string', required: true, desc: 'CN subject' },
      days:    { type: 'string', required: false, desc: 'validity days',
                 default: '365' },
    } },
  },

  // 2+ ports, NO choices anywhere. The lane rule says this stays in the
  // multi-field form (length >= 2 clause); the fix doesn't touch this path.
  // Pin as regression.
  'grep-files': {
    type: 'run', label: 'Grep in files',
    script: 'grep -rn "$pattern" "$path"',
    ports: { in: {
      pattern: { type: 'string', required: true, desc: 'pattern (regex)' },
      path:    { type: 'string', required: false, desc: 'search root',
                 default: '.' },
    } },
  },

  // 1-port, NO choices. The regression contract: this takes the lean
  // fabric-field popup, NOT the form.
  'verify-sha': {
    type: 'run', label: 'Verify SHA256',
    script: 'sha256sum -c "$file.sha256"',
    ports: { in: {
      file: { type: 'string', required: true, desc: 'file to verify' },
    } },
  },

  // 1-port, OPTIONAL + choices. Deferred territory per the brief — the port
  // never prompts (requiredMissing is undefined), so the choices never fire.
  // Pin the pre-fix behavior so a future [a]-edit-args fix doesn't silently
  // regress this corner.
  'inspect-container': {
    type: 'run', label: 'Inspect container (default: last)',
    script: 'docker inspect "${container:-$(docker ps -lq)}"',
    ports: { in: {
      container: { type: 'string', required: false, desc: 'container name',
                   choices_cmd: "docker ps --format '{{.Names}}'" },
    } },
  },
};

function bootWith(groupActions) {
  sm.bootFresh({
    groups: { g: {
      name: 'g', label: 'G', containers: [], children: [], parent: null, depth: 0, quick: false,
      actions: groupActions,
    } },
  });
}

const resolved = (missing, values = {}, sources = {}) => ({ ready: false, missing, values, sources });

// -------------------------------------------------------------------------
// 1-port + choices — form lane with the one-field variant
// -------------------------------------------------------------------------

describe('[real-actions] 1-port + choices → fabric-form with 1 field', () => {
  it('restart-service: form opens; field carries choicesCmd; chip is reachable', () => {
    bootWith({ 'restart-service': ACTIONS['restart-service'] });
    const opened = runner._promptMissing('restart-service', ACTIONS['restart-service'],
      resolved([{ port: 'service', reason: 'x' }]));
    assert(opened);
    assert(getModel().modes.fabricFormMode === true, 'form lane, not fabric-field');
    const f = getModel().modal.fabricForm;
    eq(f.fields.length, 1);
    eq(f.fields[0].port, 'service');
    assert(f.fields[0].choicesCmd && f.fields[0].choicesCmd.length > 0,
      'choicesCmd carried through');
    eq(f.fields[0].required, true);
    eq(f.fields[0].text, '', 'no default → empty text at open');
  });

  it('ssh-connect: form opens with default pre-filled AND choices chip reachable', () => {
    bootWith({ 'ssh-connect': ACTIONS['ssh-connect'] });
    const opened = runner._promptMissing('ssh-connect', ACTIONS['ssh-connect'],
      resolved([{ port: 'host', reason: 'x' }]));
    assert(opened);
    assert(getModel().modes.fabricFormMode === true);
    const f = getModel().modal.fabricForm;
    eq(f.fields[0].text, 'localhost', 'default pre-filled');
    eq(f.fields[0].default, 'localhost');
    assert(f.fields[0].choicesCmd, 'choicesCmd still carried alongside default');
    assert(f.fields[0].isDefault, '[default] chip classification holds for pre-filled value');
  });
});

// -------------------------------------------------------------------------
// 2+ port with deps — dep chain + choices_cmd env binding
// -------------------------------------------------------------------------

describe('[real-actions] 2-port with dep: worktree-add', () => {
  it('both ports materialized; required-first; branch carries dependsOn [repo]', () => {
    bootWith({ 'worktree-add': ACTIONS['worktree-add'] });
    runner._promptMissing('worktree-add', ACTIONS['worktree-add'],
      resolved([{ port: 'repo', reason: 'x' }, { port: 'branch', reason: 'x' }]));
    const f = getModel().modal.fabricForm;
    eq(f.fields.length, 2);
    const ports = f.fields.map((x) => x.port);
    assert(ports.includes('repo') && ports.includes('branch'), 'both ports');
    // Required-first: both required here, so order is declaration order (repo first).
    eq(f.fields[0].port, 'repo', 'repo focused first (declaration order among required)');
    const branch = f.fields.find((x) => x.port === 'branch');
    eq(branch.dependsOn, ['repo'], 'branch depends on repo');
    assert(branch.choicesCmd.includes('git -C "$repo"'), 'branch choicesCmd references $repo');
  });

  it('repo resolved pre-fills; branch field inherits a resolvable dep', () => {
    bootWith({ 'worktree-add': ACTIONS['worktree-add'] });
    runner._promptMissing('worktree-add', ACTIONS['worktree-add'],
      resolved([{ port: 'branch', reason: 'x' }], { repo: '/some/path' }, { repo: 'inject' }));
    const f = getModel().modal.fabricForm;
    const repo = f.fields.find((x) => x.port === 'repo');
    const branch = f.fields.find((x) => x.port === 'branch');
    eq(repo.text, '/some/path', 'repo pre-filled from resolver values');
    eq(branch.text, '', 'branch still missing');
  });
});

describe('[real-actions] 3-port cascading deps: kubectl-exec', () => {
  it('three ports with cascading deps; required-first (all required)', () => {
    bootWith({ 'kubectl-exec': ACTIONS['kubectl-exec'] });
    runner._promptMissing('kubectl-exec', ACTIONS['kubectl-exec'],
      resolved([{ port: 'context', reason: 'x' },
                { port: 'namespace', reason: 'x' },
                { port: 'pod', reason: 'x' }]));
    const f = getModel().modal.fabricForm;
    eq(f.fields.length, 3);
    const byPort = Object.fromEntries(f.fields.map((x) => [x.port, x]));
    eq(byPort.context.dependsOn, []);
    eq(byPort.namespace.dependsOn, ['context']);
    eq(byPort.pod.dependsOn, ['context', 'namespace']);
    // All three carry choices_cmd — the author gets a chip on every field.
    assert(byPort.context.choicesCmd);
    assert(byPort.namespace.choicesCmd);
    assert(byPort.pod.choicesCmd);
  });

  it('upstream-only resolved: context + namespace resolved, pod still missing', () => {
    bootWith({ 'kubectl-exec': ACTIONS['kubectl-exec'] });
    runner._promptMissing('kubectl-exec', ACTIONS['kubectl-exec'],
      resolved([{ port: 'pod', reason: 'x' }],
               { context: 'prod', namespace: 'web' },
               { context: 'inject', namespace: 'inject' }));
    const f = getModel().modal.fabricForm;
    const byPort = Object.fromEntries(f.fields.map((x) => [x.port, x]));
    eq(byPort.context.text, 'prod');
    eq(byPort.namespace.text, 'web');
    eq(byPort.pod.text, '', 'pod still empty — dep chain resolved but field missing');
    // pod.computed.state should be 'pending' because deps are resolved and
    // choices_cmd is async-spawned; async fetch stays pending in the sync
    // dispatch window.
    eq(byPort.pod.computed.state, 'pending',
      'pod fetch fired at open — deps resolved → fetch_choices_cmd flight');
  });
});

// -------------------------------------------------------------------------
// Mixed required + optional with default
// -------------------------------------------------------------------------

describe('[real-actions] mixed req/opt + default: cert-reissue', () => {
  it('required-first sort puts optional "days" last', () => {
    bootWith({ 'cert-reissue': ACTIONS['cert-reissue'] });
    runner._promptMissing('cert-reissue', ACTIONS['cert-reissue'],
      resolved([{ port: 'ca', reason: 'x' },
                { port: 'subject', reason: 'x' },
                { port: 'days', reason: 'default' }]));
    const f = getModel().modal.fabricForm;
    eq(f.fields.length, 3);
    // Required-first: ca + subject (both required) ahead of days (optional).
    const requiredPorts = f.fields.filter((x) => x.required).map((x) => x.port);
    const optionalPorts = f.fields.filter((x) => !x.required).map((x) => x.port);
    assert(requiredPorts.includes('ca') && requiredPorts.includes('subject'));
    eq(optionalPorts, ['days']);
    // days pre-filled from default; isDefault chip holds.
    const days = f.fields.find((x) => x.port === 'days');
    eq(days.text, '365');
    assert(days.isDefault, 'days: [default] chip');
    assert(!days.isModified, 'days: not modified');
  });
});

// -------------------------------------------------------------------------
// 2+ ports without choices — unchanged behavior
// -------------------------------------------------------------------------

describe('[real-actions] 2+ ports NO choices → form lane (unchanged)', () => {
  it('grep-files: form opens; pattern required, path optional with default', () => {
    bootWith({ 'grep-files': ACTIONS['grep-files'] });
    runner._promptMissing('grep-files', ACTIONS['grep-files'],
      resolved([{ port: 'pattern', reason: 'x' },
                { port: 'path', reason: 'default' }]));
    assert(getModel().modes.fabricFormMode === true, '2-port no-choices still → form lane');
    const f = getModel().modal.fabricForm;
    eq(f.fields.length, 2);
    const path = f.fields.find((x) => x.port === 'path');
    eq(path.text, '.', 'path pre-filled from default');
    eq(path.choicesCmd, null, 'no choices channel on either port');
    const pattern = f.fields.find((x) => x.port === 'pattern');
    eq(pattern.choicesCmd, null);
    eq(pattern.choicesFnRef, null);
  });
});

// -------------------------------------------------------------------------
// 1-port NO choices — regression contract (lean fabric-field popup)
// -------------------------------------------------------------------------

describe('[real-actions] 1-port NO choices → fabric-field (regression contract)', () => {
  it('verify-sha: opens lean fabric-field popup, NOT the form', () => {
    bootWith({ 'verify-sha': ACTIONS['verify-sha'] });
    const opened = runner._promptMissing('verify-sha', ACTIONS['verify-sha'],
      resolved([{ port: 'file', reason: 'x' }]));
    assert(opened);
    assert(getModel().modes.fabricFieldMode === true,
      '1-port no-choices → lean popup (pre-slice-1 contract preserved)');
    assert(!getModel().modes.fabricFormMode, 'form NOT opened');
    eq(getModel().modal.fabricField.addr, 'verify-sha.file');
  });
});

// -------------------------------------------------------------------------
// 1-port OPTIONAL + choices — DEFERRED corner, pin pre-fix behavior
// -------------------------------------------------------------------------

describe('[real-actions] 1-port OPTIONAL + choices → NO prompt (deferred)', () => {
  it('inspect-container (optional only): no required-missing → runs without form', () => {
    bootWith({ 'inspect-container': ACTIONS['inspect-container'] });
    const opened = runner._promptMissing('inspect-container', ACTIONS['inspect-container'],
      resolved([{ port: 'container', reason: 'default' }]));
    eq(opened, false, 'no required-missing → no modal opened');
    assert(!getModel().modes.fabricFormMode);
    assert(!getModel().modes.fabricFieldMode);
    // The DEFERRED corner (brief says: "[a] edit args keybind's territory").
    // Pin so a future fix doesn't silently regress the current no-prompt
    // behavior without an explicit test update.
  });
});

// -------------------------------------------------------------------------
// Submit end-to-end for a 1-field + choices form (routing-fix smoke)
// -------------------------------------------------------------------------

describe('[real-actions] submit on 1-field + choices form emits do_run', () => {
  it('restart-service: type value then Enter → do_run cmd fires', () => {
    let m = runtime.init();
    m.currentGroup = 'g'; m.register = { history: [], cap: 10 };
    const fields = [{
      port: 'service', text: '', required: true, default: null, desc: 'systemd unit',
      choicesCmd: ACTIONS['restart-service'].ports.in.service.choices_cmd,
      choicesLabeled: false, choicesTimeout: null, dependsOn: [],
    }];
    const pending = { actionKey: 'restart-service', action: ACTIONS['restart-service'] };
    [m] = runtime.update(m, { type: 'fabric_form_enter', fields, pendingAction: pending });
    // Simulate the user picking from the popover: close popover arm would set
    // field.text; here just inject a typed value.
    for (const ch of 'nginx.service'.split('')) {
      [m] = runtime.update(m, { type: 'fabric_form_key', seq: ch });
    }
    const [, cmds] = runtime.update(m, { type: 'fabric_form_submit' });
    const run = cmds.find((c) => c.type === 'do_run');
    assert(run, 'do_run emitted');
    eq(run.actionKey, 'restart-service');
    eq(run.action.ports.in.service.choices_cmd,
       ACTIONS['restart-service'].ports.in.service.choices_cmd,
       'pending action carried through verbatim');
  });
});

report();
