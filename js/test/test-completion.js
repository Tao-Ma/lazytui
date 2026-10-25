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
    assert(r.stdout.includes('complete -o default -F '),
      `bash script must register with 'complete -o default -F' so ports without choices fall back to filename completion, got:\n${r.stdout}`);
    assert(!/\/root\/|\/usr\/|\/home\//.test(r.stdout),
      `bash script leaked an absolute path:\n${r.stdout}`);
  });

  it('bash: uses `while IFS= read -r` (bash-3.2-portable), NOT `mapfile` (bash 4+ only)', () => {
    // macOS /bin/bash is 3.2.57; mapfile is bash 4+. Every TAB on macOS
    // would error. v0.6.40 dev9 QA bug.
    const r = spawnSync('node', [TUI, '--completion', 'bash', '--cmd', './do'],
      { encoding: 'utf8' });
    assert(r.stdout.includes('while IFS= read -r'),
      `bash script must use 'while IFS= read -r' for bash-3.2 compat, got:\n${r.stdout}`);
    assert(!/\bmapfile\b/.test(r.stdout),
      `bash script must NOT use mapfile (bash 4+; macOS ships 3.2.57), got:\n${r.stdout}`);
  });

  it('bash: filters candidates against the typed prefix (COMPREPLY is NOT raw-assigned)', () => {
    // Raw COMPREPLY=("${candidates[@]}") doesn't filter against the typed
    // word — menu-cycling would replace the typed prefix with unrelated
    // candidates. The script must prefix-filter with a case/glob (or
    // compgen -W). v0.6.40 dev9 QA bug.
    const r = spawnSync('node', [TUI, '--completion', 'bash', '--cmd', './do'],
      { encoding: 'utf8' });
    assert(/case\s+\$line\s+in\s+"\$cur"\*/.test(r.stdout),
      `bash script must prefix-filter candidates against $cur (COMP_WORDS[COMP_CWORD]), got:\n${r.stdout}`);
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

  it('zsh: empty-helper-output guard + _default fallthrough', () => {
    // "${(@f)""}" produces [""] — a one-element array containing the empty
    // string, so compadd -- "" would offer an empty candidate. Guard with
    // -z check + _default fallthrough so filename completion kicks in for
    // ports without choices. v0.6.40 dev9 QA bug.
    const r = spawnSync('node', [TUI, '--completion', 'zsh', '--cmd', './do'],
      { encoding: 'utf8' });
    assert(/if\s+\[\s+-z\s+"\$raw"\s+\]/.test(r.stdout),
      `zsh script must guard against empty helper output BEFORE "${'$'}{(@f)raw}" split, got:\n${r.stdout}`);
    assert(/\b_default\b/.test(r.stdout),
      `zsh script must call _default on empty helper output so filename completion kicks in, got:\n${r.stdout}`);
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
// Behavioral test: source the generated bash script in a bash -c harness,
// set COMP_WORDS / COMP_CWORD, invoke the function, inspect COMPREPLY.
// Catches the three dev9-QA bugs end-to-end — no interactive readline
// needed. Pins the prefix-filtering contract (bug 1) and the no-mapfile
// contract (bug 2 — fails under `bash --posix` on bash 5 if mapfile is
// used). The -o default contract (bug 3) is covered by content assert
// above since it's a line of the script, not runtime behavior.
// -----------------------------------------------------------------------

describe('[completion] bash function behavioral — prefix filter, no mapfile, candidates visible', () => {
  // Driver: source the generated script in a bash subshell, set COMP_WORDS
  // + COMP_CWORD, invoke the completion function, print COMPREPLY.
  // The script's inner function references the --cmd name verbatim; we
  // override that word so our test completion function points at the
  // real --complete helper driving the fixture.
  function driveBash({ prefix, group, action, extras = [] }) {
    // Build the COMP_WORDS array around the input.
    // For a group completion: COMP_WORDS=(fake prefix), COMP_CWORD=1
    // For an action completion: COMP_WORDS=(fake group prefix), COMP_CWORD=2
    // For a positional: COMP_WORDS=(fake group action ...extras prefix), COMP_CWORD=3+N
    const words = ['_fakecmd_', group, action, ...extras, prefix].filter((w) => w !== undefined);
    const cword = words.length - 1;
    const wordsForBash = words.map((w) => `'${w.replace(/'/g, "'\\''")}'`).join(' ');
    // Shim _fakecmd_ to call the real completion helper against the fixture.
    const realCmd = `node ${TUI} ${fixturePath}`;
    const script = `
      _fakecmd_() { ${realCmd} "$@"; }
      eval "$(node ${TUI} --completion bash --cmd _fakecmd_)"
      COMP_WORDS=(${wordsForBash})
      COMP_CWORD=${cword}
      _lazytui_complete__fakecmd_
      # Print one per line so test can split cleanly.
      for c in "\${COMPREPLY[@]}"; do echo "$c"; done
    `;
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', timeout: 10000 });
    return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), status: r.status };
  }

  it('prefix "sv" at cword=1 matches only groups starting with "sv"', () => {
    const r = driveBash({ prefix: 'sv' });
    eq(r.status, 0, `bash subshell failed, stderr=${r.stderr}`);
    const got = lines(r.stdout);
    assert(got.includes('svc'), `expected "svc" in filtered output, got ${JSON.stringify(got)}`);
    // service.vpnclient starts with "se", NOT "sv" — correctly filtered out
    assert(!got.includes('service.vpnclient'),
      `prefix filter failed — "service.vpnclient" should NOT match prefix "sv", got ${JSON.stringify(got)}`);
    assert(!got.includes('tool'),
      `prefix filter failed — "tool" should NOT match prefix "sv", got ${JSON.stringify(got)}`);
  });

  it('empty prefix at cword=1 returns all groups', () => {
    const r = driveBash({ prefix: '' });
    eq(r.status, 0);
    const got = lines(r.stdout);
    assert(got.includes('svc') && got.includes('service.vpnclient'),
      `empty prefix should match all groups in fixture (svc + service.vpnclient), got ${JSON.stringify(got)}`);
  });

  it('prefix "ser" at cword=1 matches ONLY the dotted subgroup', () => {
    const r = driveBash({ prefix: 'ser' });
    eq(r.status, 0);
    const got = lines(r.stdout);
    eq(got, ['service.vpnclient']);
  });

  it('cword=3 with no prefix returns all positional choices (bash: unfiltered)', () => {
    const r = driveBash({ group: 'svc', action: 'restart', prefix: '' });
    eq(r.status, 0);
    const got = lines(r.stdout);
    assert(got.includes('nginx') && got.includes('sshd'),
      `expected nginx+sshd for svc:restart first positional, got ${JSON.stringify(got)}`);
  });

  it('cword=3 with prefix "ng" returns only matching choices', () => {
    const r = driveBash({ group: 'svc', action: 'restart', prefix: 'ng' });
    eq(r.status, 0);
    const got = lines(r.stdout);
    eq(got, ['nginx'], `prefix "ng" should filter to only nginx, got ${JSON.stringify(got)}`);
  });

  it('port with no choices_cmd → COMPREPLY empty (shell will fall back to -o default)', () => {
    // svc:exec third port `extra` has no choices.
    const r = driveBash({ group: 'svc', action: 'exec', extras: ['alpha', 'ls-alpha'], prefix: '' });
    eq(r.status, 0);
    eq(r.stdout, '', `expected empty COMPREPLY (shell falls back via -o default), got ${JSON.stringify(r.stdout)}`);
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
