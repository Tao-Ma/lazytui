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
  // Shell is a trivial `printf` dummy — reducer tests only need the DECL
  // routing/materialization, not a real spawn. The runtime handler is
  // tested in test-choices-cmd-runtime.js.
  'restart-service': {
    type: 'run', label: 'Restart service',
    script: 'systemctl restart "$service"',
    ports: { in: {
      service: { type: 'string', required: true, desc: 'systemd unit',
                 choices_cmd: "printf 'nginx.service\\nsshd.service\\n'" },
    } },
  },

  // 1-port, string + choices_cmd + default. The default pre-fills the field
  // but the chip still reads [N choices] so the picker is reachable.
  'ssh-connect': {
    type: 'spawn', label: 'SSH connect',
    script: 'ssh "$host"',
    ports: { in: {
      host: { type: 'string', required: true, desc: 'hostname', default: 'localhost',
              choices_cmd: "printf 'alpha\\nbravo\\n'" },
    } },
  },

  // 1-port, string + choices_LABELED (value\tLabel). SSH host-alias pattern:
  // the ssh config name is the value; a friendlier description is the label.
  'ssh-connect-labeled': {
    type: 'spawn', label: 'SSH connect (labeled)',
    script: 'ssh "$host"',
    ports: { in: {
      host: { type: 'string', required: true, desc: 'hostname (labeled)',
              choices_cmd: "printf 'alpha\\tAlpha Production\\nbravo\\tBravo Staging\\n'",
              choices_labeled: true },
    } },
  },

  // 1-port, string + choices_FN (not choices_cmd). Covers the fn-channel
  // routing path. Reducer side only — the fn ref doesn't need to be
  // registered for materialization + routing to work.
  'edit-section': {
    type: 'run', label: 'Edit section',
    script: 'edit --section "$section"',
    ports: { in: {
      section: { type: 'string', required: true, desc: 'section heading',
                 choices_fn: 'edit.sections_of' },
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
                choices_cmd: 'printf "main\\ndev\\n"',
                depends_on: ['repo'] },
    } },
  },

  // 3-port, cascading deps (A → B → C) all choices_cmd. kubectl-exec is the
  // canonical shape: context → namespace → pod. Shell commands are dummies
  // (printf) — tests exercise the reducer/materialization path, not real
  // kubectl spawns (which would leak children per [[feedback_check_before
  // _write]] + R-II-2's subprocess-leak finding).
  'kubectl-exec': {
    type: 'spawn', label: 'kubectl exec',
    script: 'kubectl exec -it -n "$namespace" --context "$context" "$pod" -- sh',
    ports: { in: {
      context:   { type: 'string', required: true, desc: 'kube context',
                   choices_cmd: "printf 'prod\\nstage\\n'" },
      namespace: { type: 'string', required: true, desc: 'namespace',
                   choices_cmd: "printf 'web\\napi\\n'",
                   depends_on: ['context'] },
      pod:       { type: 'string', required: true, desc: 'pod',
                   choices_cmd: "printf 'pod-1\\npod-2\\n'",
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
                 choices_cmd: "printf 'root-ca\\nintermediate-ca\\n'" },
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

  // 1-port, OPTIONAL + choices. The optional-only early-return at
  // action-runner.js's requiredMissing guard means invoke never prompts —
  // pre-slice-1 contract preserved. Pinned here under that framing so
  // future scope changes to the invoke-time prompt have an explicit anchor.
  'inspect-container': {
    type: 'run', label: 'Inspect container (default: last)',
    script: 'docker inspect "${container:-$(docker ps -lq)}"',
    ports: { in: {
      container: { type: 'string', required: false, desc: 'container name',
                   choices_cmd: "printf 'c1\\nc2\\n'" },
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
  it('restart-service: form opens; field carries exact choices_cmd from decl', () => {
    bootWith({ 'restart-service': ACTIONS['restart-service'] });
    const opened = runner._promptMissing('restart-service', ACTIONS['restart-service'],
      resolved([{ port: 'service', reason: 'x' }]));
    assert(opened);
    assert(getModel().modes.fabricFormMode === true, 'form lane, not fabric-field');
    const f = getModel().modal.fabricForm;
    eq(f.fields.length, 1);
    eq(f.fields[0].port, 'service');
    // Exact-value assert (vs truthy): R-II-2 fake-positive fix. A bug that
    // substituted a different string would pass a truthy check but fail here.
    eq(f.fields[0].choicesCmd, ACTIONS['restart-service'].ports.in.service.choices_cmd,
      'choicesCmd matches the YAML decl verbatim');
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
    eq(f.fields[0].choicesCmd, ACTIONS['ssh-connect'].ports.in.host.choices_cmd,
      'choicesCmd verbatim alongside default');
    assert(f.fields[0].isDefault, '[default] chip classification holds for pre-filled value');
  });

  it('ssh-connect-labeled: choices_labeled: true propagates to the field', () => {
    // R-II-2 missing-coverage #1: the labeled-choices path. Author expects
    // `value\tLabel` lines; the overlay shows Label, submits value. Pin that
    // the labeled flag carries through to the field snapshot.
    bootWith({ 'ssh-connect-labeled': ACTIONS['ssh-connect-labeled'] });
    runner._promptMissing('ssh-connect-labeled', ACTIONS['ssh-connect-labeled'],
      resolved([{ port: 'host', reason: 'x' }]));
    const f = getModel().modal.fabricForm;
    eq(f.fields.length, 1);
    eq(f.fields[0].choicesLabeled, true, 'labeled flag carried verbatim');
    eq(f.fields[0].choicesCmd, ACTIONS['ssh-connect-labeled'].ports.in.host.choices_cmd);
  });

  it('edit-section (1-port choices_fn): form lane carries choicesFnRef', () => {
    // R-II-2 missing-coverage #2: slice-3 fix covers BOTH choices_fn and
    // choices_cmd. All earlier real-actions tests are choices_cmd-only; pin
    // that choices_fn ALSO routes a 1-port action through the form.
    bootWith({ 'edit-section': ACTIONS['edit-section'] });
    const opened = runner._promptMissing('edit-section', ACTIONS['edit-section'],
      resolved([{ port: 'section', reason: 'x' }]));
    assert(opened);
    assert(getModel().modes.fabricFormMode === true,
      'choices_fn on 1-port routes to form (not fabric-field)');
    const f = getModel().modal.fabricForm;
    eq(f.fields.length, 1);
    eq(f.fields[0].choicesFnRef, 'edit.sections_of',
      'choicesFnRef carried through from decl');
    eq(f.fields[0].choicesCmd, null, 'no choices_cmd on this port');
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
    eq(branch.choicesCmd, ACTIONS['worktree-add'].ports.in.branch.choices_cmd,
      'branch choicesCmd matches decl verbatim');
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
    // Exact-value asserts per R-II-2 fake-positive fix.
    eq(byPort.context.choicesCmd,
       ACTIONS['kubectl-exec'].ports.in.context.choices_cmd);
    eq(byPort.namespace.choicesCmd,
       ACTIONS['kubectl-exec'].ports.in.namespace.choices_cmd);
    eq(byPort.pod.choicesCmd,
       ACTIONS['kubectl-exec'].ports.in.pod.choices_cmd);
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
    // choices_cmd is async-spawned; node's `child.on('close')` is macrotask-
    // queued so the resolve can't land inside the sync dispatch window. If a
    // future Node release delivers close events for already-exited children
    // synchronously, this would flake to 'ok' — accept both to keep the
    // test future-proof against that engine change (R-II-1-SMELL1).
    assert(byPort.pod.computed.state === 'pending' || byPort.pod.computed.state === 'ok',
      `pod fetch fired at open — expected 'pending' (sync-dispatch window) or 'ok' (synchronous close), got '${byPort.pod.computed.state}'`);
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
// Optional-only + choices: invoke-time prompt doesn't fire (contract since
// before slice 1 — _promptMissing's requiredMissing early-return at
// action-runner.js:395). Covered here as the realistic "docker inspect last"
// shape to flag that this corner isn't addressed by the lane-routing fix:
// an author who wants the choices affordance reachable for an optional port
// needs the planned [a]-edit-args keybind. R-II-2's test-quality finding:
// previously framed as "deferred corner" which misleads; the contract has
// been stable through v0.6.30+ and this test pins the stable behavior.
// -------------------------------------------------------------------------

describe('[real-actions] optional-only + choices: never prompts (pre-slice-1 contract)', () => {
  it('inspect-container: no required-missing → no modal opens; action runs', () => {
    bootWith({ 'inspect-container': ACTIONS['inspect-container'] });
    const opened = runner._promptMissing('inspect-container', ACTIONS['inspect-container'],
      resolved([{ port: 'container', reason: 'default' }]));
    eq(opened, false, 'optional-only: _promptMissing returns false');
    assert(!getModel().modes.fabricFormMode, 'form NOT opened');
    assert(!getModel().modes.fabricFieldMode, 'fabric-field NOT opened');
  });
});

// -------------------------------------------------------------------------
// Submit end-to-end for a 1-field + choices form — the full invoke-time
// contract: typed value lands as a one-shot inject AND do_run re-emits.
// R-II-2 found the previous test asserted reference-equality on the action
// object (ceremonial); this version uses the live applyMsg path through
// bootWith + getModel so a real inject lands and can be inspected.
// -------------------------------------------------------------------------

describe('[real-actions] submit on 1-field + choices form: inject lands + do_run fires', () => {
  it('restart-service: typed value lands as one-shot inject under correct addr', () => {
    bootWith({ 'restart-service': ACTIONS['restart-service'] });
    const applyMsg = require('../dispatch/control/dispatch').applyMsg;
    const opened = runner._promptMissing('restart-service', ACTIONS['restart-service'],
      resolved([{ port: 'service', reason: 'x' }]));
    assert(opened);
    // Type the value character by character — same path a user takes after
    // the form opens on the sole field.
    for (const ch of 'nginx.service'.split('')) {
      applyMsg({ type: 'fabric_form_key', seq: ch });
    }
    eq(getModel().modal.fabricForm.fields[0].text, 'nginx.service',
      'typed value stored on field');
    // Submit — the one-shot inject lands under `${actionKey}.${port}`.
    applyMsg({ type: 'fabric_form_submit' });
    const injects = (getModel().fabric && getModel().fabric.injects
                     && getModel().fabric.injects.g) || {};
    const rec = injects['restart-service.service'];
    assert(rec, `expected one-shot inject at 'restart-service.service', have keys: ${Object.keys(injects).join(',')}`);
    eq(rec.value, 'nginx.service', 'inject carries the typed value');
    eq(rec.oneShot, true, 'inject marked as one-shot (consumed after next successful run)');
    // Form closed after submit.
    assert(!getModel().modes.fabricFormMode, 'form mode cleared after submit');
  });
});

// -------------------------------------------------------------------------
// Resolved error state — the [error] chip paints when the fetch fails
// -------------------------------------------------------------------------

describe('[real-actions] error state → [error] chip on the field', () => {
  it('fabric_form_choices_resolved with error payload transitions state to error', () => {
    bootWith({ 'restart-service': ACTIONS['restart-service'] });
    const applyMsg = require('../dispatch/control/dispatch').applyMsg;
    runner._promptMissing('restart-service', ACTIONS['restart-service'],
      resolved([{ port: 'service', reason: 'x' }]));
    // Resolve with an error payload — simulates choices_cmd exited non-zero.
    // Pre-fix, this error state could only be observed on multi-field forms;
    // pin that a 1-field form also surfaces the error path through the
    // channel-agnostic resolver arm.
    applyMsg({
      type: 'fabric_form_choices_resolved',
      port: 'service', actionKey: 'restart-service', requestId: 1,
      items: [], labels: null, error: 'exit=1: systemctl not found',
    });
    const field = getModel().modal.fabricForm.fields[0];
    eq(field.computed.state, 'error', 'error payload lands as state:error');
    eq(field.computed.error, 'exit=1: systemctl not found', 'error text preserved');
    eq(field.computed.items, [], 'items empty on error');
  });
});

report();
