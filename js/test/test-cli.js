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

const TUI = path.resolve(__dirname, '..', 'app', 'tui.js');

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

describe('[10] --spec — Component authoring spec bundle', () => {
  it('reads docs/ at the repo root and prints the bundle to stdout', () => {
    // Regression: tui.js moved from `js/` to `js/app/` in the v0.5
    // reorg but printSpec() still resolved `..` once from __dirname,
    // landing in `js/docs/` (which doesn't exist). The fix resolves
    // up two levels to the repo root. Guard the file-resolution path
    // here so a future tui.js relocation can't silently break --spec.
    const r = spawnSync(process.execPath, [TUI, '--spec'], {
      encoding: 'utf8', timeout: 5000,
    });
    eq(r.status, 0, 'rc 0');
    assert(r.stdout.length > 0, 'stdout non-empty');
    assert(
      r.stdout.includes('Component Authoring Spec'),
      'starts with SPEC.md heading'
    );
    // Every SPEC_DOCS file should land in the bundled output. A path
    // regression would surface here as a missing-doc stderr + rc 1.
    assert(!r.stderr.includes('missing doc'), 'no "missing doc" stderr');
  });
});

describe('[env-shadow] parser warns + runtime refuses on shadow-prone port names (two-layer defense)', () => {
  // Round 5 downgraded S1/S2 from throw-at-load to warn-and-keep so a
  // pre-existing YAML with a quietly-broken shadow port still loads. The
  // runtime shadow guard is the actual defense (asserted at the --exec
  // layer here); the parser warning is UX for the author.
  const SHADOW_PATH = path.join(TMP, 'shadow-path.yml');
  fs.writeFileSync(SHADOW_PATH, `project_dir: .

groups:
  g:
    label: G
    actions:
      shadow_path:
        script: 'printf "%s" "$PATH"'
        type: run
        label: Shadow PATH
        ports:
          in:
            PATH:
              type: string
              required: true
`);

  function runWith(fixture, ...args) {
    return spawnSync(process.execPath, [TUI, fixture, '--exec', ...args], {
      encoding: 'utf8', timeout: 5000,
    });
  }

  it('runs the action and the runtime guard refuses the PATH override', () => {
    const r = runWith(SHADOW_PATH, 'g:shadow_path', '/attacker/bin:/tmp');
    eq(r.status, 0, `rc 0 — action still runs, got ${r.status}, stderr=${r.stderr}`);
    eq(r.stdout, process.env.PATH, 'child PATH inherited from parent (round-2 runtime guard still fires)');
    assert(r.stderr.includes('shadowing env — PATH'),
      `runtime guard emits stderr for PATH refusal, got: ${JSON.stringify(r.stderr)}`);
  });
});

// R1F-BUG2 — slice-2 CLI parity. The resolver "stays stupid" claim is that
// `choices_fn:` is a FORM-time concern; CLI mode never opens the form, so a
// port that declares it must behave exactly like a plain port in `--exec` and
// `--list`. The parser carries the key through; the runtime registry is
// never installed; the fn is never called.
describe('[choices_fn] CLI parity — port with choices_fn behaves like a plain port in CLI mode', () => {
  const CF_PATH = path.join(TMP, 'choices-fn.yml');
  fs.writeFileSync(CF_PATH, `project_dir: .

groups:
  g:
    label: G
    actions:
      edit_section:
        script: 'printf "%s|%s" "$file" "$section"'
        type: run
        label: Edit section
        ports:
          in:
            file:
              type: string
              required: true
            section:
              type: string
              required: true
              choices_fn: edit.sections_of
              depends_on: [file]
`);

  function runWith(...args) {
    return spawnSync(process.execPath, [TUI, CF_PATH, '--exec', ...args], {
      encoding: 'utf8', timeout: 5000,
    });
  }

  it('--exec with positional values binds + runs, choices_fn never consulted', () => {
    const r = runWith('g:edit_section', '/tmp/x.md', 'body');
    eq(r.status, 0, `rc 0 (plain positional binding), got ${r.status}, stderr=${r.stderr}`);
    eq(r.stdout, '/tmp/x.md|body', 'positional args bound as $file / $section');
    // The fetch_choices effect handler is installed only by the TUI boot's
    // installBuiltins; CLI mode never installs it. Any attempt to invoke
    // choices_fn in CLI mode would print "unknown choices_fn" or similar —
    // this stderr check pins the "resolver stays stupid" claim.
    assert(!/choices_fn|fetch_choices|unknown choices/i.test(r.stderr),
      `CLI never consults choices_fn, got stderr: ${JSON.stringify(r.stderr)}`);
  });

  it('--exec with a missing required port errors cleanly (no choices_fn fallback attempt)', () => {
    const r = runWith('g:edit_section', '/tmp/x.md');   // missing section
    assert(r.status !== 0, 'non-zero rc on missing required');
    assert(/section/i.test(r.stderr), `stderr names the missing port, got: ${JSON.stringify(r.stderr)}`);
    assert(!/choices_fn|fetch_choices/i.test(r.stderr),
      `no mention of choices_fn in CLI error path, got: ${JSON.stringify(r.stderr)}`);
  });

  it('--list g includes the action without touching choices_fn', () => {
    const r = spawnSync(process.execPath, [TUI, CF_PATH, '--list', 'g'], {
      encoding: 'utf8', timeout: 5000,
    });
    eq(r.status, 0);
    assert(/edit_section/.test(r.stdout), '--list shows the action');
    assert(!/choices_fn|fetch_choices/i.test(r.stderr),
      `--list never consults choices_fn, got stderr: ${JSON.stringify(r.stderr)}`);
  });
});

// -----------------------------------------------------------------------
// Companion to the shell-completion feat: when the first missing required
// port has choices_cmd:, --exec appends `valid <port>: a, b, c` on an
// additional stderr line (purely additive — the existing two lines stay
// byte-identical).
// -----------------------------------------------------------------------

describe('[cli] --exec missing-required: appends `valid <port>: …` when choices_cmd exists', () => {
  const CHOICES_CF_PATH = path.join(os.tmpdir(), `test-cli-choices-${Date.now()}.yml`);
  fs.writeFileSync(CHOICES_CF_PATH, `
groups:
  g:
    label: G
    actions:
      pick:
        label: Pick
        type: run
        script: echo "$name"
        ports:
          in:
            name:
              type: string
              required: true
              choices_cmd: "printf 'alpha\\nbravo\\n'"
      plain:
        label: Plain
        type: run
        script: echo "$x"
        ports:
          in:
            x:
              type: string
              required: true
`);

  function runExec(...args) {
    return spawnSync(process.execPath, [TUI, CHOICES_CF_PATH, '--exec', ...args], {
      encoding: 'utf8', timeout: 5000,
    });
  }

  it('port with choices_cmd: appends `valid <port>: a, b` on an additional stderr line', () => {
    const r = runExec('g:pick');
    assert(r.status !== 0, 'non-zero rc');
    // Byte-identical existing lines are still present.
    assert(/^tui --exec: missing required port\(s\): name$/m.test(r.stderr),
      `original missing-required line preserved, got: ${JSON.stringify(r.stderr)}`);
    assert(/^  usage: --exec g:pick <name>$/m.test(r.stderr),
      `original usage line preserved, got: ${JSON.stringify(r.stderr)}`);
    // New additional line.
    assert(/^  valid name: alpha, bravo$/m.test(r.stderr),
      `expected 'valid name: alpha, bravo' additional line, got: ${JSON.stringify(r.stderr)}`);
  });

  it('port WITHOUT choices_cmd: no additional line (silent)', () => {
    const r = runExec('g:plain');
    assert(r.status !== 0, 'non-zero rc');
    assert(/missing required port\(s\): x/.test(r.stderr), 'original missing-required line present');
    assert(!/valid x:/.test(r.stderr),
      `no valid-choices line when the port has no choices_cmd, got: ${JSON.stringify(r.stderr)}`);
  });

  process.on('exit', () => {
    try { fs.unlinkSync(CHOICES_CF_PATH); } catch (_) { /* best-effort */ }
  });
});

report();
