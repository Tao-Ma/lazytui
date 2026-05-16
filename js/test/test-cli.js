/**
 * CLI mode regression — verifies tui.js --exec runs a YAML action,
 * propagates rc, forwards args, and refuses unsupported types.
 *
 * Each case spawns a child node process so the framework's heavy modules
 * (terminal, layout, render queue) don't infect the test process. The
 * --exec branch in tui.js is responsible for never loading them.
 *
 * Run: node js/test/test-cli.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { describe, it, eq, assert, report } = require('./test-runner');

const TUI = path.resolve(__dirname, '..', 'tui.js');

// Build a tiny throwaway YAML so test cases don't depend on test/test.yml's
// docker-fixture state. Lives in tmpdir, cleaned up at exit.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

const FIXTURE = path.join(TMP, 'fixture.yml');
fs.writeFileSync(FIXTURE, `project_dir: .

groups:
  echo:
    label: Echo
    actions:
      hello:
        script: echo hi
        type: run
        label: Hello
      args:
        script: 'printf "%s\\n" "$#" "$@"'
        type: run
        label: Args
      fail:
        script: 'exit 7'
        type: run
        label: Fail
      bg:
        script: echo bg
        type: background
        label: Bg
  nested:
    label: Nested
    children:
      deep:
        label: Deep
        actions:
          ping:
            script: echo nested-ping
            type: run
            label: Ping
  # compose: triggers the docker plugin's groupActions synthesis. The
  # fixture declares "explicit" (no synth equivalent) and "up" (whose
  # synthesized form gets overridden — YAML wins on conflict).
  composey:
    label: Composey
    compose: docker-compose.yml
    actions:
      explicit:
        script: echo from-yaml
        type: run
        label: Explicit
      up:
        script: echo yaml-wins
        type: run
        label: YAML Up
`);

function runCli(...args) {
  return spawnSync(process.execPath, [TUI, FIXTURE, '--exec', ...args], {
    encoding: 'utf8',
    timeout: 5000,
  });
}

describe('[1] basic run — script stdout + rc', () => {
  it('hello echoes and exits 0', () => {
    const r = runCli('echo:hello');
    eq(r.status, 0, 'rc 0');
    eq(r.stdout.trim(), 'hi', 'stdout from script');
  });
});

describe('[2] args — forwarded as positional params', () => {
  it('"args" sees "$#" and "$@"', () => {
    const r = runCli('echo:args', 'one', 'two three', 'four');
    eq(r.status, 0, 'rc 0');
    const lines = r.stdout.trim().split('\n');
    eq(lines[0], '3', 'three positional args');
    eq(lines[1], 'one', '$1');
    eq(lines[2], 'two three', '$2 — quoted multi-word arg preserved');
    eq(lines[3], 'four', '$3');
  });
});

describe('[3] subprocess rc propagates', () => {
  it('script exit 7 → cli exit 7', () => {
    const r = runCli('echo:fail');
    eq(r.status, 7, 'subprocess rc forwarded');
  });
});

describe('[4] resolution errors → rc 1, stderr message, action listing', () => {
  it('unknown group', () => {
    const r = runCli('nope:foo');
    eq(r.status, 1, 'rc 1');
    assert(r.stderr.includes('no group at "nope"'), 'stderr names the missing group');
    assert(r.stderr.includes('Available actions'), 'lists alternatives');
    assert(r.stderr.includes('echo:hello'), 'listing includes a real action');
  });
  it('unknown action key', () => {
    const r = runCli('echo:nonexistent');
    eq(r.status, 1, 'rc 1');
    assert(r.stderr.includes('has no action "nonexistent"'), 'stderr names the missing action');
  });
  it('malformed path (no colon)', () => {
    const r = runCli('echohello');
    eq(r.status, 1, 'rc 1');
    assert(r.stderr.includes('expected <group-path>:<action-key>'), 'stderr explains format');
  });
});

describe('[5] type other than run is refused', () => {
  it('background action errors out', () => {
    const r = runCli('echo:bg');
    eq(r.status, 1, 'rc 1');
    assert(
      r.stderr.includes('only "run" is supported'),
      'stderr explains why type=background is refused'
    );
  });
});

describe('[6] nested groups — children flatten to dotted paths', () => {
  it('nested.deep:ping resolves', () => {
    const r = runCli('nested.deep:ping');
    eq(r.status, 0, 'rc 0');
    eq(r.stdout.trim(), 'nested-ping', 'leaf action ran');
  });
});

describe('[7] --list — discovery', () => {
  it('lists every action with label and desc', () => {
    const r = spawnSync(process.execPath, [TUI, FIXTURE, '--list'], {
      encoding: 'utf8', timeout: 5000,
    });
    eq(r.status, 0, 'rc 0');
    assert(r.stdout.includes('echo:hello'), 'lists echo:hello');
    assert(r.stdout.includes('echo:args'), 'lists echo:args');
    assert(r.stdout.includes('nested.deep:ping'), 'lists nested action');
    assert(r.stdout.includes('Hello'), 'includes label');
    // Background action is also listed (--list shows all, --exec refuses run)
    assert(r.stdout.includes('echo:bg'), 'background action shown in list');
  });
  it('substring filter narrows the list', () => {
    const r = spawnSync(process.execPath, [TUI, FIXTURE, '--list', 'nested'], {
      encoding: 'utf8', timeout: 5000,
    });
    eq(r.status, 0, 'rc 0');
    assert(r.stdout.includes('nested.deep:ping'), 'matched action present');
    assert(!r.stdout.includes('echo:hello'), 'echo group filtered out');
  });
  it('no match yields a friendly notice and rc 0', () => {
    const r = spawnSync(process.execPath, [TUI, FIXTURE, '--list', 'zzznope'], {
      encoding: 'utf8', timeout: 5000,
    });
    eq(r.status, 0, 'rc 0');
    assert(r.stdout.includes('no actions matched'), 'tells user nothing matched');
  });
});

describe('[8] plugin-synthesized actions — docker groupActions for compose:', () => {
  it('--list includes synthesized status / down / logs / build / restart', () => {
    const r = spawnSync(process.execPath, [TUI, FIXTURE, '--list', 'composey'], {
      encoding: 'utf8', timeout: 5000,
    });
    eq(r.status, 0, 'rc 0');
    // Explicit YAML action listed
    assert(r.stdout.includes('composey:explicit'), 'YAML "explicit" action listed');
    // Synthesized lifecycle actions
    for (const k of ['status', 'down', 'logs', 'build', 'restart']) {
      assert(r.stdout.includes('composey:' + k), `synthesized "${k}" listed`);
    }
  });
  it('YAML wins on conflict — composey:up runs YAML script, not docker plugin\'s', () => {
    const r = runCli('composey:up');
    eq(r.status, 0, 'rc 0');
    eq(r.stdout.trim(), 'yaml-wins', 'YAML script ran (plugin would have done compose up -d --build)');
  });
  it('synthesized action resolves — no "no action" error', () => {
    // composey:logs is synthesized as type: spawn (opens a new window),
    // which the CLI runner refuses with rc 1 + a clear message. That
    // path proves the action was resolved (rather than not found at all).
    const r = runCli('composey:logs');
    eq(r.status, 1, 'rc 1 — type: spawn refused');
    assert(
      r.stderr.includes('only "run" is supported'),
      'refused for type, not for missing-action — proves resolution found it'
    );
  });
});

describe('[9] missing --exec value', () => {
  it('--exec with nothing after it is a usage error', () => {
    const r = spawnSync(process.execPath, [TUI, FIXTURE, '--exec'], {
      encoding: 'utf8', timeout: 5000,
    });
    eq(r.status, 2, 'rc 2 (usage)');
    assert(r.stderr.includes('--exec requires'), 'stderr names the flag');
  });
});

report();
