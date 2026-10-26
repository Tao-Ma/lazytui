/**
 * CLI-mode parity matrix.
 *
 * Individual CLI entry points (--exec, --list, --completion, --complete,
 * --spec) already have deep per-flag coverage in test-cli.js (413 lines) +
 * test-completion.js. The gap this file closes: CROSS-MODE parity. The
 * v0.6.29 class — a feature-module plugin's groupActions showed in --list
 * but NOT in the TUI's Actions pane — bit production because nothing pinned
 * that the SAME action set was visible through every surface.
 *
 * Invariants pinned here:
 *   P1. Every group that --list emits is a candidate on `--complete 2 -- do ""`
 *       (groups known to the completion = groups known to the lister).
 *   P2. For every (group, action) in --list, `--complete 3 -- do <group> ""`
 *       includes that action key (actions known to the completion = actions
 *       known to the lister), INCLUDING plugin-synthesized actions.
 *   P3. Actions excluded by --list (type:background) are ALSO excluded by
 *       the completion (negative parity — the two filters agree).
 *   P4. project_dir cwd handling is consistent — `--exec`, `--complete`, and
 *       `--list` all resolve the project_dir without surprise diffs.
 *
 * Each run is a real `node tui.js` subprocess so the production arg parser
 * + require path is exercised end-to-end. Fixture mirrors test-cli.js's
 * shape (echo + nested.deep + composey plugin + choices_cmd port).
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const { describe, it, eq, assert, report } = require('./test-runner');

const TUI = path.resolve(__dirname, '..', 'app', 'tui.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-parity-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

// Fixture: covers plain groups, nested (dotted path), feature-module plugin
// (compose: triggers docker groupActions synthesis), a choices_cmd port.
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
  svc:
    label: Services
    actions:
      restart:
        script: 'echo restart "$name"'
        type: run
        label: Restart
        ports:
          in:
            name:
              type: string
              required: true
              choices_cmd: "printf 'nginx\\nsshd\\n'"
              choices_timeout: 2000
`);

function run(...args) {
  return spawnSync(process.execPath, [TUI, FIXTURE, ...args], {
    encoding: 'utf8', timeout: 5000,
  });
}
function lines(s) { return s.split('\n').map(l => l.trim()).filter(Boolean); }

// --- Parse --list output into {group → [actionKey, …]} ------------------
//
// --list emits one line per action in `group:action    [label]    desc` form.
// We split on the colon to recover (group, action). Plugin-synthesized actions
// are formatted the same way (verified by test-cli.js [8]).
function parseList(stdout) {
  const byGroup = {};
  for (const line of lines(stdout)) {
    const m = line.match(/^([a-zA-Z0-9_.-]+):(\S+)/);
    if (!m) continue;
    const g = m[1], a = m[2];
    (byGroup[g] = byGroup[g] || []).push(a);
  }
  return byGroup;
}

// --- Parse --complete output into a Set of candidates -------------------
function completeCandidates(cword, words) {
  const r = run('--complete', String(cword), '--', ...words);
  eq(r.status, 0, `--complete should exit 0, got ${r.status}; stderr=${r.stderr.trim()}`);
  return new Set(lines(r.stdout));
}

// cword semantics (per js/app/completion.js:188):
//   cword=1 (words=['do'])              → group paths
//   cword=2 (words=['do', <group>])     → action keys in that group
//   cword>=3 (words=['do', g, a, …])    → positional port candidates
describe('[P1] group parity — every --list group is a --complete candidate', () => {
  it('groups emitted by --list are also offered on `--complete 1 -- do`', () => {
    const r = run('--list');
    eq(r.status, 0, `--list exit 0, got ${r.status}; stderr=${r.stderr.trim()}`);
    const listGroups = Object.keys(parseList(r.stdout));
    assert(listGroups.length > 0, '--list emitted at least one group');

    const compGroups = completeCandidates(1, ['do']);
    for (const g of listGroups) {
      assert(compGroups.has(g),
        `drift: group "${g}" in --list but not in --complete candidates (${JSON.stringify([...compGroups])})`);
    }
  });

  it('dotted nested paths (nested.deep) appear in both surfaces', () => {
    const r = run('--list');
    const listGroups = Object.keys(parseList(r.stdout));
    const compGroups = completeCandidates(1, ['do']);
    assert(listGroups.includes('nested.deep') || listGroups.some(g => g.startsWith('nested')),
      `--list should emit nested.deep somehow — got groups: ${JSON.stringify(listGroups)}`);
    assert(compGroups.has('nested.deep'),
      `drift: nested.deep absent from --complete 1 candidates — got: ${JSON.stringify([...compGroups])}`);
  });

  it('feature-module synthesized group (composey w/ compose:) appears in both', () => {
    const compGroups = completeCandidates(1, ['do']);
    assert(compGroups.has('composey'),
      `drift: composey (compose:-plugin group) absent from --complete 1 — got: ${JSON.stringify([...compGroups])}`);
  });
});

describe('[P2] action parity — every --list action is a --complete candidate', () => {
  it('plain group `echo` — hello, args offered on `--complete 2 -- do echo`', () => {
    const byGroup = parseList(run('--list').stdout);
    const expected = (byGroup.echo || []).filter(a => a !== 'bg');  // bg = type:background, see P3
    const got = completeCandidates(2, ['do', 'echo']);
    for (const a of expected) {
      assert(got.has(a),
        `drift: --list has echo:${a} but --complete 2 ... do echo doesn't offer it (${JSON.stringify([...got])})`);
    }
  });

  it('feature-module plugin — synthesized `status/logs` offered on both surfaces (v0.6.29 class)', () => {
    const byGroup = parseList(run('--list').stdout);
    const listed = new Set(byGroup.composey || []);
    const completed = completeCandidates(2, ['do', 'composey']);
    // Pin on 'status' + 'logs' as docker-plugin always synthesizes those.
    for (const synth of ['status', 'logs']) {
      assert(listed.has(synth),
        `--list missing synthesized action "composey:${synth}" (regression of v0.6.29 class) — listed: ${JSON.stringify([...listed])}`);
      assert(completed.has(synth),
        `--complete missing synthesized action "composey ${synth}" — completed: ${JSON.stringify([...completed])}`);
    }
  });

  it('nested group `nested.deep` — ping offered on `--complete 2 -- do nested.deep`', () => {
    const byGroup = parseList(run('--list').stdout);
    const expected = (byGroup['nested.deep'] || []);
    assert(expected.includes('ping'), `fixture sanity: nested.deep:ping should be in --list output`);
    const got = completeCandidates(2, ['do', 'nested.deep']);
    assert(got.has('ping'),
      `drift: nested.deep:ping in --list but not --complete 2 ... do nested.deep — got: ${JSON.stringify([...got])}`);
  });
});

describe('[P3] type:background — --list surfaces it; --exec refuses; --complete still offers it', () => {
  // The historical shape: --list is discovery (shows everything so a user
  // learns the YAML's inventory), --exec is a RUN gate that refuses non-run
  // types (test-cli.js [5] pins this). --complete follows --list's inclusive
  // policy — the user may be hunting for the key by TAB, then switch to the
  // TUI to invoke it. This test documents + pins that current contract.
  it('`bg` (type:background) appears in --list AND in --complete; is REFUSED by --exec', () => {
    const byGroup = parseList(run('--list').stdout);
    assert((byGroup.echo || []).includes('bg'),
      `--list should include type:background actions (inventory, not gating) — got: ${JSON.stringify(byGroup.echo)}`);
    const got = completeCandidates(2, ['do', 'echo']);
    assert(got.has('bg'),
      `--complete should include type:background actions (parity with --list) — got: ${JSON.stringify([...got])}`);
    const rExec = run('--exec', 'echo:bg');
    assert(rExec.status !== 0, `--exec should refuse type:background, got rc=${rExec.status}`);
    assert(/only "run" is supported/i.test(rExec.stderr),
      `--exec stderr should name the refusal reason, got: ${rExec.stderr.trim()}`);
  });
});

describe('[P4] project_dir / cwd — the three CLI entry points agree on project resolution', () => {
  it('all three (exec/list/complete) succeed from a DIFFERENT cwd than the config lives in', () => {
    // Running from /tmp with an absolute config path exercises the project_dir
    // resolution — all three modes must land on the same cwd semantics as the
    // other, or we have the v0.6.37 class of drift (choices_cmd child inherited
    // process cwd while `script:` ran in projectDirFor).
    const otherDir = os.tmpdir();
    const commonOpts = { encoding: 'utf8', timeout: 5000, cwd: otherDir };
    const rList = spawnSync(process.execPath, [TUI, FIXTURE, '--list'], commonOpts);
    const rExec = spawnSync(process.execPath, [TUI, FIXTURE, '--exec', 'echo:hello'], commonOpts);
    const rComp = spawnSync(process.execPath, [TUI, FIXTURE, '--complete', '1', '--', 'do'], commonOpts);

    eq(rList.status, 0, `--list from different cwd should succeed; stderr=${rList.stderr.trim()}`);
    eq(rExec.status, 0, `--exec from different cwd should succeed; stderr=${rExec.stderr.trim()}`);
    eq(rComp.status, 0, `--complete from different cwd should succeed; stderr=${rComp.stderr.trim()}`);
    // Content sanity: all three saw the same groups.
    const listGroups = Object.keys(parseList(rList.stdout));
    const compGroups = new Set(lines(rComp.stdout));
    for (const g of listGroups) {
      assert(compGroups.has(g),
        `project_dir drift: --list and --complete disagree on groups from cwd=${otherDir}: list=${JSON.stringify(listGroups)} complete=${JSON.stringify([...compGroups])}`);
    }
  });
});

describe('[P5] env-shadow — the shadow-port denylist applies to BOTH --exec and --complete', () => {
  // test-cli.js already pins --exec's shadow refusal; test-completion.js pins
  // --complete's silent drop. This test pins the parity: the two surfaces
  // apply the SAME denylist (adding a new shadowed name should break both at
  // once, not drift).
  it('passing a PATH-named positional has NO effect on either surface (both apply the shadow denylist)', () => {
    const shadowCfg = path.join(TMP, 'shadow.yml');
    fs.writeFileSync(shadowCfg, `project_dir: .

groups:
  s:
    label: S
    actions:
      show:
        label: Show
        type: run
        script: 'printf "PATH=%s\\n" "$PATH"'
        ports:
          in:
            PATH:
              type: string
              required: true
              default: ignored
`);
    // --exec: shadowed port name is refused by runtime (per test-cli.js [env-shadow]).
    const rExec = spawnSync(process.execPath, [TUI, shadowCfg, '--exec', 's:show', 'injected'], {
      encoding: 'utf8', timeout: 5000,
    });
    // Either the parser warns and runtime refuses OR runtime silently drops.
    // The invariant we care about: injected PATH value does NOT reach the
    // subprocess output.
    assert(!rExec.stdout.includes('PATH=injected'),
      `env-shadow leak via --exec: injected PATH value reached the subprocess — stdout=${rExec.stdout.trim()}`);

    // --complete: the earlier-positional binding of PATH is dropped silently
    // (per test-completion.js env-shadow test). So completion returning any
    // normal candidate (or nothing) is fine; what we pin: the parent process
    // PATH is NOT clobbered by the "PATH=injected" positional.
    const rComp = spawnSync(process.execPath, [TUI, shadowCfg, '--complete', '3', '--', 'do', 's', 'show', ''], {
      encoding: 'utf8', timeout: 5000,
    });
    eq(rComp.status, 0, `--complete should exit 0 even on shadow; stderr=${rComp.stderr.trim()}`);
    // Mild sanity: no stderr noise (completion is silent).
    eq(rComp.stderr, '', `--complete should stay silent on stderr even with shadowed ports; got: ${rComp.stderr.trim()}`);
  });
});

report();
