/**
 * Shell tab-completion generated from the port schema (--completion /
 * --complete). See docs/shell-completion.md and js/app/completion.js.
 *
 * Each case spawns a child node process so the framework's heavy modules
 * don't infect the test process — matches the test-cli.js pattern. All
 * assertions run against stdout/stderr captures of real CLI invocations
 * against a temporary fixture YAML.
 *
 * Covers the brief's 7 test scopes:
 *   1) cword 1 → groups incl. dotted subgroup paths; cword 2 → actions.
 *   2) cword 3+ → choices lines for the right positional; legacy "$@"
 *      → empty; port without choices → empty.
 *   3) Dep binding: typed positional binds to its port name, visible to
 *      the subsequent port's choices_cmd via $portname.
 *   4) Labeled → values only; >32 lines → capped.
 *   5) Timeout: `sleep 10` → empty output, exit 0, no leaked child.
 *   6) Script generation: bash + zsh contain --complete via --cmd name,
 *      no absolute paths, byte-stable across two invocations.
 *   7) Env-shadow: a port named PATH binds nothing (silently dropped).
 *
 * Run: node js/test/test-completion.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, execSync } = require('child_process');
const { describe, it, eq, assert, report } = require('./test-runner');

const TUI = path.resolve(__dirname, '..', 'app', 'tui.js');

// Fixture: a nested subgroup path (`service.vpnclient`), a 3-port action
// where port 2's choices_cmd references port 1 via depends_on, a labeled
// port, a legacy "$@" action, an un-choiced port, and a port named PATH
// (shadow-named).
const FIXTURE = `groups:
  svc:
    label: Services
    actions:
      restart:
        label: Restart
        type: run
        script: echo "$name"
        ports:
          in:
            name:
              type: string
              required: true
              choices_cmd: "printf 'nginx\\\\nsshd\\\\n'"
      exec:
        label: Exec
        type: run
        script: 'echo "$container $cmd $extra"'
        ports:
          in:
            container:
              type: string
              required: true
              choices_cmd: "printf 'alpha\\\\nbravo\\\\n'"
            cmd:
              type: string
              required: true
              choices_cmd: 'printf "%s\\\\n" "ls-$container" "ps-$container"'
              depends_on: [container]
            extra:
              type: string
              required: false
      labeled:
        label: Labeled
        type: run
        script: echo "$kind"
        ports:
          in:
            kind:
              type: string
              required: true
              choices_cmd: "printf 'alpha\\\\tAlpha Label\\\\nbravo\\\\tBravo Label\\\\n'"
              choices_labeled: true
      big:
        label: Big list
        type: run
        script: echo "$x"
        ports:
          in:
            x:
              type: string
              required: true
              choices_cmd: "for i in $(seq 1 50); do printf 'item%d\\\\n' $i; done"
      slow:
        label: Slow (should timeout)
        type: run
        script: echo "$x"
        ports:
          in:
            x:
              type: string
              required: true
              choices_cmd: "sleep 10 && printf 'never\\\\n'"
              choices_timeout: 500
      shadow:
        label: Shadow (PATH binding)
        type: run
        script: 'echo "$x"'
        ports:
          in:
            PATH:
              type: string
              required: true
              choices_cmd: "printf 'first\\\\nsecond\\\\n'"
            x:
              type: string
              required: true
              choices_cmd: "printf '%s\\\\n' \\"path=$PATH\\""
              depends_on: [PATH]
      noport:
        label: No ports
        type: run
        script: echo "$@"
  service.vpnclient:
    label: VPN client (subgroup)
    actions:
      cert-use:
        label: Use cert
        type: run
        script: echo "$cert"
        ports:
          in:
            cert:
              type: string
              required: true
              choices_cmd: "printf 'client-a\\\\nclient-b\\\\n'"
`;

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'completion-'));
const fixturePath = path.join(tmpDir, 'actions.yml');
fs.writeFileSync(fixturePath, FIXTURE);

function runComplete(cword, ...words) {
  const r = spawnSync('node', [TUI, fixturePath, '--complete', String(cword), '--', ...words],
    { encoding: 'utf8' });
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), status: r.status };
}

function lines(s) { return s ? s.split('\n') : []; }

// -----------------------------------------------------------------------
// 1. cword 1 → groups (incl. dotted subgroup)
// -----------------------------------------------------------------------

describe('[completion] cword=1 → group paths (incl. dotted subgroup)', () => {
  it('lists all group paths that contain actions', () => {
    const r = runComplete(1, 'do', '');
    eq(r.status, 0, 'exit 0');
    eq(r.stderr, '', 'no stderr');
    const got = lines(r.stdout);
    assert(got.includes('svc'), `expected svc, got ${JSON.stringify(got)}`);
    assert(got.includes('service.vpnclient'),
      `expected dotted subgroup "service.vpnclient", got ${JSON.stringify(got)}`);
  });
});

// -----------------------------------------------------------------------
// 2. cword 2 → actions in the group path
// -----------------------------------------------------------------------

describe('[completion] cword=2 → actions in the group', () => {
  it('lists action keys for the group at words[1]', () => {
    const r = runComplete(2, 'do', 'svc', '');
    eq(r.status, 0);
    const got = lines(r.stdout);
    for (const k of ['restart', 'exec', 'labeled', 'big', 'slow', 'shadow', 'noport']) {
      assert(got.includes(k), `expected action "${k}" in svc, got ${JSON.stringify(got)}`);
    }
  });

  it('lists action keys for the dotted subgroup', () => {
    const r = runComplete(2, 'do', 'service.vpnclient', '');
    eq(r.status, 0);
    eq(lines(r.stdout), ['cert-use']);
  });

  it('unknown group → empty, exit 0', () => {
    const r = runComplete(2, 'do', 'not-a-group', '');
    eq(r.status, 0);
    eq(r.stdout, '');
  });
});

// -----------------------------------------------------------------------
// 3. cword 3+ → positional choices + dep binding + legacy
// -----------------------------------------------------------------------

describe('[completion] cword=3+ → positional port choices_cmd', () => {
  it('first positional runs choices_cmd for the first port', () => {
    const r = runComplete(3, 'do', 'svc', 'restart', '');
    eq(r.status, 0);
    eq(lines(r.stdout), ['nginx', 'sshd']);
  });

  it('legacy "$@" action (no ports.in) → empty', () => {
    const r = runComplete(3, 'do', 'svc', 'noport', '');
    eq(r.status, 0);
    eq(r.stdout, '');
  });

  it('positional index past declared ports → empty', () => {
    // svc:restart has one port; cword=4 asks for the second positional.
    const r = runComplete(4, 'do', 'svc', 'restart', 'nginx', '');
    eq(r.status, 0);
    eq(r.stdout, '');
  });

  it('port with no choices_cmd → empty (shell falls back to file completion)', () => {
    // svc:exec third port `extra` has no choices.
    const r = runComplete(5, 'do', 'svc', 'exec', 'alpha', 'ls-alpha', '');
    eq(r.status, 0);
    eq(r.stdout, '');
  });

  it('dep binding: earlier positional binds to its port name in the child env', () => {
    // svc:exec `cmd` references $container; the typed positional should bind.
    const r = runComplete(4, 'do', 'svc', 'exec', 'alpha', '');
    eq(r.status, 0);
    eq(lines(r.stdout), ['ls-alpha', 'ps-alpha']);
  });
});

// -----------------------------------------------------------------------
// 4. Labeled → values only; cap at 32
// -----------------------------------------------------------------------

describe('[completion] labeled + >32 items', () => {
  it('choices_labeled: true → values only (labels are popover UX, not completion)', () => {
    const r = runComplete(3, 'do', 'svc', 'labeled', '');
    eq(r.status, 0);
    eq(lines(r.stdout), ['alpha', 'bravo']);
  });

  it('50-item result → capped to 32', () => {
    const r = runComplete(3, 'do', 'svc', 'big', '');
    eq(r.status, 0);
    const got = lines(r.stdout);
    eq(got.length, 32, `expected 32 items, got ${got.length}`);
    eq(got[0], 'item1');
    eq(got[31], 'item32');
  });
});

// -----------------------------------------------------------------------
// 5. Timeout: empty + exit 0; no leaked child
// -----------------------------------------------------------------------

describe('[completion] timeout', () => {
  it('sleep 10 with 500ms per-port timeout → empty, exit 0, kills child quickly', () => {
    const start = Date.now();
    const r = runComplete(3, 'do', 'svc', 'slow', '');
    const elapsed = Date.now() - start;
    eq(r.status, 0, 'exit 0 even on timeout');
    eq(r.stdout, '', 'no candidates on timeout');
    assert(elapsed < 3500,
      `completion wall-time ${elapsed}ms exceeded 3.5s cap (500ms port timeout + node spawn overhead)`);
  });
});

// -----------------------------------------------------------------------
// 6. Script generation: bash + zsh — contain --cmd callback, no abs paths,
//    byte-stable across invocations
// -----------------------------------------------------------------------

describe('[completion] --completion script generation', () => {
  it('bash: contains --complete callback via --cmd name, no absolute paths', () => {
    const r = spawnSync('node', [TUI, '--completion', 'bash', '--cmd', './do'],
      { encoding: 'utf8' });
    eq(r.status, 0);
    assert(r.stdout.includes('./do --complete'), `bash script must call ./do --complete, got:\n${r.stdout}`);
    assert(r.stdout.includes('complete -F '), 'bash script must register with `complete -F`');
    assert(!/\/root\/|\/usr\/|\/home\//.test(r.stdout),
      `bash script leaked an absolute path:\n${r.stdout}`);
  });

  it('zsh: contains --complete callback via --cmd name, no absolute paths', () => {
    const r = spawnSync('node', [TUI, '--completion', 'zsh', '--cmd', './do'],
      { encoding: 'utf8' });
    eq(r.status, 0);
    assert(r.stdout.includes('./do --complete'), 'zsh script must call ./do --complete');
    assert(r.stdout.includes('compdef '), 'zsh script must register with `compdef`');
    assert(!/\/root\/|\/usr\/|\/home\//.test(r.stdout),
      `zsh script leaked an absolute path:\n${r.stdout}`);
  });

  it('byte-stable across two invocations (deterministic script)', () => {
    const r1 = spawnSync('node', [TUI, '--completion', 'bash', '--cmd', './do'], { encoding: 'utf8' }).stdout;
    const r2 = spawnSync('node', [TUI, '--completion', 'bash', '--cmd', './do'], { encoding: 'utf8' }).stdout;
    eq(r1, r2, 'two invocations produced different scripts (not deterministic)');
  });

  it('unknown shell → exit 1 with stderr', () => {
    const r = spawnSync('node', [TUI, '--completion', 'fish'], { encoding: 'utf8' });
    eq(r.status, 1);
    assert(/unsupported shell/.test(r.stderr), `expected "unsupported shell" in stderr, got: ${r.stderr}`);
  });
});

// -----------------------------------------------------------------------
// 7. Env-shadow: port named PATH does NOT override child's $PATH
// -----------------------------------------------------------------------

describe('[completion] env-shadow — PATH binding silently dropped', () => {
  it('typing a value for a PATH port does not override $PATH in the child env', () => {
    // svc:shadow has two ports: PATH (shadow-named), x (its choices_cmd
    // echoes $PATH). If PATH binding was NOT dropped, x's completion
    // would show `path=first` (the typed value); if dropped (correct),
    // $PATH stays the parent's PATH, so x's completion shows the parent's
    // PATH or whatever the shell's $PATH resolves to (which won't start
    // with "path=first").
    const r = runComplete(4, 'do', 'svc', 'shadow', 'first', '');
    eq(r.status, 0, 'exit 0');
    const got = lines(r.stdout);
    // The output line is "path=<whatever>"; it should NOT be "path=first"
    // because PATH binding is dropped.
    assert(!got.includes('path=first'),
      `env-shadow leak: typed PATH value "first" reached the child env, got ${JSON.stringify(got)}`);
  });
});

// -----------------------------------------------------------------------
// Teardown
// -----------------------------------------------------------------------

process.on('exit', () => {
  try { execSync(`rm -rf '${tmpDir}'`); } catch (_) { /* best-effort */ }
});

report();
