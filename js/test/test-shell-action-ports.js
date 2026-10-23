/**
 * Shell actions (type: run, script:) resolve `ports.in` the same way fabric
 * (type: run, run:) does — the first step of the args→ports convergence
 * (docs/ports-and-wires.md P1, plus the args surface).
 *
 * Legacy `args: '<string hint>'` and `$1/$@` positional substitution are being
 * retired in favor of named typed input ports. A shell action with `ports.in:`
 * resolves its inputs via wires / sticky injects and binds the resolved values
 * as environment variables when the child shell spawns — the script references
 * `$file` instead of `$1`. No shell-level string substitution → the kernel
 * delivers the port value as a literal env value regardless of its bytes.
 *
 * Pins the resolve step via the exported `_resolvePortsForAction` helper. The
 * spawn wiring (opts.env → child_process.spawn) is pinned by integration tests
 * elsewhere; here we test the pure resolution.
 *
 * Run: node js/test/test-shell-action-ports.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const { getModel } = require('../model/store');
const runner = require('../dispatch/runtime/action-runner');
const { wireFabricHost } = require('../dispatch/runtime/host-wiring');

// The fabric host must be wired before `fabricPorts.listWires()` is called
// (tui.js:322 does this at boot; the smoke harness doesn't). _resolvePortsForAction
// reads wires through the host, same as doRunFabric, so it needs it live for
// unit-level resolution too. Idempotent — safe to call once per test file.
wireFabricHost();

const SHELL_ACTION = {
  type: 'run',
  label: 'Verify',
  desc: 'Validate an archive against its .sha256 sidecar',
  script: '$SUM -c "$file.sha256"',
  ports: {
    in: {
      file: { type: 'string', required: true, desc: 'archive to verify' },
    },
  },
};

const SHELL_ACTION_OPTIONAL = {
  type: 'run',
  script: 'echo "${verbose:-quiet}"',
  ports: { in: { verbose: { type: 'string', required: false } } },
};

function setConfigWithAction(action) {
  sm.bootFresh({
    groups: {
      g: {
        name: 'g', label: 'G', containers: [], children: [], parent: null, depth: 0, quick: false,
        actions: { verify: action },
      },
    },
  });
}

function inject(group, actionAndPort, value) {
  // Hand-write the fabric inject the way port_inject's reducer arm would, so
  // the test exercises the resolver without the UI path. (ctx:'cli' kept for
  // debuggability; the resolver only reads .value.)
  const m = getModel();
  m.fabric = m.fabric || {};
  m.fabric.injects = m.fabric.injects || {};
  m.fabric.injects[group] = m.fabric.injects[group] || {};
  m.fabric.injects[group][actionAndPort] = { value, ctx: 'test' };
}

describe('[shell-action-ports] a type:run shell action resolves ports.in', () => {
  it('exposes _resolvePortsForAction from action-runner', () => {
    assert(typeof runner._resolvePortsForAction === 'function',
      '_resolvePortsForAction is exported for the shell-ports resolve path');
  });

  it('reports not-ready when a required port has no wire/inject', () => {
    setConfigWithAction(SHELL_ACTION);
    const { ready, missing } = runner._resolvePortsForAction('verify', SHELL_ACTION, getModel());
    assert(!ready, 'required input unresolved → not ready');
    eq(missing.map((m) => m.port), ['file'], 'the single missing port is named in `missing`');
  });

  it('resolves an injected value → ready + values map keyed by port name', () => {
    setConfigWithAction(SHELL_ACTION);
    inject('g', 'verify.file', 'archive.tar.xz');
    const { ready, values, missing } = runner._resolvePortsForAction('verify', SHELL_ACTION, getModel());
    assert(ready, 'required input injected → ready');
    eq(values, { file: 'archive.tar.xz' }, 'values map keyed by port name — used as the child-process env');
    eq(missing, [], 'no missing inputs');
  });

  it('an action without `ports.in` resolves ready with an empty values map', () => {
    setConfigWithAction({ type: 'run', script: 'echo hello' });
    const r = runner._resolvePortsForAction('plain', { type: 'run', script: 'echo hello' }, getModel());
    assert(r.ready, 'no declared ports → ready immediately (no inputs to resolve)');
    eq(r.values, {}, 'values is an empty map (nothing to bind as env)');
  });

  it('an optional unset port is omitted from values (not injected as "" / undefined)', () => {
    setConfigWithAction(SHELL_ACTION_OPTIONAL);
    const { ready, values } = runner._resolvePortsForAction('v', SHELL_ACTION_OPTIONAL, getModel());
    assert(ready, 'optional unset → ready');
    eq(values, {}, 'unset optional does not land in the env map — shell `${verbose:-quiet}` default kicks in');
  });
});

report();
