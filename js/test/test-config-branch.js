/**
 * config-branch plugin smoke test — end-to-end save / check-stale / load
 * round-trip in a real ephemeral git repo. No network, no real $HOME,
 * no shared state.
 *
 * Layout each case starts from:
 *   $TMP/.git/                  ← git init
 *   $TMP/client/id_ed25519      ← user config payload
 *   $TMP/data/openvpn/ca.crt
 *   $TMP/fixture.yml            ← lazytui config pointing config_branch:
 *                                  at the paths above
 *
 * Runs `tui.js --exec` against $TMP, asserts on stdout, file contents,
 * and exit codes.
 *
 * Run: node js/test/test-config-branch.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const cb = require('../feature/config-branch');
const { describe, it, eq, assert, report } = require('./test-runner');

const TUI = path.resolve(__dirname, '..', 'app', 'tui.js');

// --- Pure unit tests for groupActions ---

describe('[1] groupActions returns {} when config_branch: not declared or malformed', () => {
  it('group with no config_branch', () => {
    eq(Object.keys(cb.groupActions({})).length, 0);
  });
  it('config_branch missing branch', () => {
    eq(Object.keys(cb.groupActions({ config_branch: { paths: ['x'] } })).length, 0);
  });
  it('config_branch with empty paths', () => {
    eq(Object.keys(cb.groupActions({ config_branch: { branch: 'b', paths: [] } })).length, 0);
  });
});

describe('[2] groupActions synthesizes save / load / check-stale', () => {
  it('all three keys present', () => {
    const a = cb.groupActions({ config_branch: { branch: 'config', paths: ['a', 'b'] } });
    const keys = Object.keys(a).sort();
    eq(keys.join(','), 'check-stale,load,save');
  });
  it('save script embeds branch + paths', () => {
    const a = cb.groupActions({ config_branch: { branch: 'config', paths: ['a', 'b'] } });
    assert(a.save.script.includes('BRANCH="config"'), 'branch in save');
    assert(a.save.script.includes('PATHS="a b"'), 'paths in save');
    assert(a.save.script.includes('git worktree add'), 'save uses worktree');
  });
});

// --- End-to-end: real git repo, real save/load/check-stale ---

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed:\n${r.stderr}`);
  }
  return r.stdout;
}

// Init a git repo with one initial commit so HEAD exists.
git(TMP, 'init', '--quiet', '--initial-branch=main');
git(TMP, 'config', 'user.email', 'test@example.com');
git(TMP, 'config', 'user.name', 'Test');
fs.writeFileSync(path.join(TMP, 'README.md'), 'init\n');
git(TMP, 'add', 'README.md');
git(TMP, 'commit', '-m', 'init', '--quiet');

// Seed the user-data layout the YAML refers to.
fs.mkdirSync(path.join(TMP, 'client'), { recursive: true });
fs.mkdirSync(path.join(TMP, 'data', 'openvpn'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-KEY-V1\n');
fs.writeFileSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'), 'CA-CERT-V1\n');

const FIXTURE = path.join(TMP, 'fixture.yml');
fs.writeFileSync(FIXTURE, `project_dir: .

groups:
  branch:
    label: Branch sync
    config_branch:
      branch: config
      paths:
        - client
        - data/openvpn
    actions:
      info:
        label: About
        type: run
        script: echo about
`);

function run(action, ...rest) {
  return spawnSync(process.execPath, [TUI, FIXTURE, '--exec', action, ...rest], {
    encoding: 'utf8', timeout: 15000, cwd: TMP,
  });
}

describe('[3] --list shows synthesized save / load / check-stale', () => {
  it('all three appear', () => {
    const r = spawnSync(process.execPath, [TUI, FIXTURE, '--list', 'branch'], {
      encoding: 'utf8', timeout: 5000, cwd: TMP,
    });
    eq(r.status, 0);
    for (const k of ['save', 'load', 'check-stale']) {
      assert(r.stdout.includes('branch:' + k), `${k} listed`);
    }
  });
});

describe('[4] save creates the branch and commits the snapshot', () => {
  it('first save creates branch + commit, copies paths', () => {
    const r = run('branch:save');
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
    assert(r.stdout.includes('committed snapshot'), 'committed message');

    // Branch now exists; switch to it and inspect tree (read-only via git ls-tree)
    const tree = git(TMP, 'ls-tree', '-r', '--name-only', 'config').trim().split('\n');
    assert(tree.includes('client/id_ed25519'), 'client key on branch');
    assert(tree.includes('data/openvpn/ca.crt'), 'CA cert on branch');
  });
});

describe('[5] check-stale: clean tree → rc 0; modified → rc 1 with DIFF report', () => {
  it('clean: matches branch', () => {
    const r = run('branch:check-stale');
    eq(r.status, 0);
    assert(r.stdout.includes('no differences'), 'reports no differences');
  });
  it('after local edit: reports DIFF + indented per-file detail, rc 1', () => {
    fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-KEY-MUTATED\n');
    const r = run('branch:check-stale');
    eq(r.status, 1);
    assert(r.stdout.includes('DIFF: client'), 'reports the path');
    assert(/^ {2}.*id_ed25519.*differ/m.test(r.stdout), 'per-file detail indented under label');
  });
  it('multi-path DIFF: each path gets its own label + indented detail', () => {
    // client is still mutated from the previous case; also mutate ca.crt.
    fs.writeFileSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'), 'CA-CERT-MUTATED\n');
    const r = run('branch:check-stale');
    eq(r.status, 1);
    assert(r.stdout.includes('DIFF: client'), 'client label');
    assert(r.stdout.includes('DIFF: data/openvpn'), 'data/openvpn label');
    assert(/^ {2}.*id_ed25519.*differ/m.test(r.stdout), 'client detail indented');
    assert(/^ {2}.*ca\.crt.*differ/m.test(r.stdout), 'openvpn detail indented');
  });
  it('after deleting a local path: reports ONLY-BRANCH, rc 1', () => {
    // Restore client first so the prior assertion's mutation doesn't pollute
    fs.writeFileSync(path.join(TMP, 'client', 'id_ed25519'), 'PRIVATE-KEY-V1\n');
    fs.rmSync(path.join(TMP, 'data', 'openvpn'), { recursive: true });
    const r = run('branch:check-stale');
    eq(r.status, 1);
    assert(r.stdout.includes('ONLY-BRANCH: data/openvpn'), 'reports the missing local path');
  });
});

describe('[6] load: restores branch contents into cwd', () => {
  it('load brings back deleted data/openvpn', () => {
    assert(!fs.existsSync(path.join(TMP, 'data', 'openvpn')), 'precondition: dir missing');
    const r = run('branch:load');
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
    assert(fs.existsSync(path.join(TMP, 'data', 'openvpn', 'ca.crt')), 'ca.crt restored');
    eq(fs.readFileSync(path.join(TMP, 'data', 'openvpn', 'ca.crt'), 'utf8'), 'CA-CERT-V1\n', 'content matches');
  });
  it('after load, check-stale reports clean again', () => {
    const r = run('branch:check-stale');
    eq(r.status, 0);
  });
});

describe('[7] load refuses if branch missing', () => {
  it('drop the branch, then load fails with rc 1', () => {
    git(TMP, 'branch', '-D', 'config');
    // Also drop the remote-tracking ref if any
    spawnSync('git', ['update-ref', '-d', 'refs/remotes/origin/config'], { cwd: TMP });
    const r = run('branch:load');
    eq(r.status, 1);
    assert(r.stderr.includes('does not exist'), 'message names the missing branch');
  });
});

// --- excludes: end-to-end ---
//
// New fixture and ephemeral repo to keep the case isolated from the
// `branch` group above (which has been mutated across tests). Tracks
// data/svc which contains a logs/ subdir to be excluded.

const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-ex-'));
process.on('exit', () => {
  try { fs.rmSync(TMP2, { recursive: true, force: true }); } catch (_) {}
});

git(TMP2, 'init', '--quiet', '--initial-branch=main');
git(TMP2, 'config', 'user.email', 'test@example.com');
git(TMP2, 'config', 'user.name', 'Test');
fs.writeFileSync(path.join(TMP2, 'README.md'), 'init\n');
git(TMP2, 'add', 'README.md');
git(TMP2, 'commit', '-m', 'init', '--quiet');

fs.mkdirSync(path.join(TMP2, 'data', 'svc', 'auth'), { recursive: true });
fs.mkdirSync(path.join(TMP2, 'data', 'svc', 'logs'), { recursive: true });
fs.writeFileSync(path.join(TMP2, 'data', 'svc', 'token.json'), '{"v":1}\n');
fs.writeFileSync(path.join(TMP2, 'data', 'svc', 'auth', 'oauth.key'), 'KEY-V1\n');
fs.writeFileSync(path.join(TMP2, 'data', 'svc', 'logs', 'errors.log'), 'boom\n');

const FIXTURE2 = path.join(TMP2, 'fixture.yml');
fs.writeFileSync(FIXTURE2, `project_dir: .

groups:
  branch:
    label: Branch sync
    config_branch:
      branch: config
      paths:
        - data/svc
      excludes:
        - data/svc/logs
    actions:
      info:
        label: About
        type: run
        script: echo about
`);

function run2(action, ...rest) {
  return spawnSync(process.execPath, [TUI, FIXTURE2, '--exec', action, ...rest], {
    encoding: 'utf8', timeout: 15000, cwd: TMP2,
  });
}

describe('[8] excludes: save commits the path but strips excluded subdirs', () => {
  it('save reports the exclude and commits without it', () => {
    const r = run2('branch:save');
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
    assert(r.stdout.includes('excluded: data/svc/logs'), 'announces the exclude');
    const tree = git(TMP2, 'ls-tree', '-r', '--name-only', 'config').trim().split('\n');
    assert(tree.includes('data/svc/token.json'), 'tracked file on branch');
    assert(tree.includes('data/svc/auth/oauth.key'), 'auth file on branch');
    assert(!tree.some((f) => f.startsWith('data/svc/logs')), 'logs not on branch');
  });
});

describe('[X-source] groupActions resolves paths/excludes from config.files', () => {
  it('source: files pulls every file path', () => {
    const config = {
      files: [
        { path: 'a', category: 'secret' },
        { path: 'b', category: 'config' },
        { path: 'c' /* uncategorized — auto-injected, no category */ },
      ],
    };
    const a = cb.groupActions(
      { config_branch: { branch: 'b', source: 'files' } },
      'g',
      config,
    );
    const keys = Object.keys(a).sort();
    eq(keys.join(','), 'check-stale,load,save');
    assert(a.save.script.includes('PATHS="a b c"'), 'all paths included by default');
  });
  it('categories: filter scopes the source', () => {
    const config = {
      files: [
        { path: 'a', category: 'secret' },
        { path: 'b', category: 'config' },
        { path: 'c' },
      ],
    };
    const a = cb.groupActions(
      { config_branch: { branch: 'b', source: 'files', categories: ['secret', 'config'] } },
      'g',
      config,
    );
    assert(a.save.script.includes('PATHS="a b"'), 'uncategorized excluded');
    assert(!a.save.script.includes(' c"'), 'no uncategorized leak');
  });
  it('per-file exclude: lists merge into excludes', () => {
    const config = {
      files: [
        { path: 'a', category: 'secret', exclude: ['a/tmp', 'a/cache/'] },
        { path: 'b', category: 'config' },
      ],
    };
    const a = cb.groupActions(
      { config_branch: { branch: 'b', source: 'files' } },
      'g',
      config,
    );
    assert(a.save.script.includes('EXCLUDES="a/tmp a/cache/"'), 'per-file excludes plumbed');
    assert(a.save.desc.includes('− 2 excluded'), 'desc reflects exclude count');
  });
  it('source: files with no matching categories yields no actions', () => {
    const config = { files: [{ path: 'a' }] };
    const a = cb.groupActions(
      { config_branch: { branch: 'b', source: 'files', categories: ['nope'] } },
      'g',
      config,
    );
    eq(Object.keys(a).length, 0);
  });
});

// --- chmod 600 on sensitive files at load: end-to-end ---
//
// Isolated repo: file modes asserted here would entangle with the
// [1-9] cases (which mutate state across describes). Tracks one OVPN
// inline (glob match), one SSH key (exact-name match), one easy-rsa
// pki/private entry (path match), and one sibling that should NOT
// be tightened (id_ed25519.pub) to pin the negative case.

const TMP3 = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-chmod-'));
process.on('exit', () => {
  try { fs.rmSync(TMP3, { recursive: true, force: true }); } catch (_) {}
});

git(TMP3, 'init', '--quiet', '--initial-branch=main');
git(TMP3, 'config', 'user.email', 'test@example.com');
git(TMP3, 'config', 'user.name', 'Test');
fs.writeFileSync(path.join(TMP3, 'README.md'), 'init\n');
git(TMP3, 'add', 'README.md');
git(TMP3, 'commit', '-m', 'init', '--quiet');

fs.mkdirSync(path.join(TMP3, 'vpn'), { recursive: true });
fs.mkdirSync(path.join(TMP3, 'ssh'), { recursive: true });
fs.mkdirSync(path.join(TMP3, 'vpn', 'pki', 'private'), { recursive: true });
fs.writeFileSync(path.join(TMP3, 'vpn', 'client.ovpn'), 'remote vpn.example\n');
fs.writeFileSync(path.join(TMP3, 'ssh', 'id_ed25519'), 'PRIVATE-V1\n');
fs.writeFileSync(path.join(TMP3, 'ssh', 'id_ed25519.pub'), 'PUBLIC-V1\n');
fs.writeFileSync(path.join(TMP3, 'vpn', 'pki', 'private', 'server.key'), 'EASY-RSA-V1\n');

const FIXTURE3 = path.join(TMP3, 'fixture.yml');
fs.writeFileSync(FIXTURE3, `project_dir: .

groups:
  branch:
    label: Branch sync
    config_branch:
      branch: config
      paths:
        - vpn
        - ssh
    actions:
      info:
        label: About
        type: run
        script: echo about
`);

function run3(action, ...rest) {
  return spawnSync(process.execPath, [TUI, FIXTURE3, '--exec', action, ...rest], {
    encoding: 'utf8', timeout: 15000, cwd: TMP3,
  });
}

describe('[10] load chmods 0600 on sensitive files (SSH/OVPN/PKI)', () => {
  it('save first', () => {
    const r = run3('branch:save');
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
  });
  it('delete local, load, sensitive files come back at 0600', () => {
    fs.rmSync(path.join(TMP3, 'vpn'), { recursive: true });
    fs.rmSync(path.join(TMP3, 'ssh'), { recursive: true });
    const r = run3('branch:load');
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
    const modeOf = (p) => fs.statSync(path.join(TMP3, p)).mode & 0o777;
    eq(modeOf('vpn/client.ovpn'), 0o600, '*.ovpn → 0600');
    eq(modeOf('ssh/id_ed25519'), 0o600, 'id_ed25519 → 0600');
    eq(modeOf('vpn/pki/private/server.key'), 0o600, 'pki/private/* → 0600');
  });
  it('the .pub sibling is NOT tightened', () => {
    // id_ed25519.pub doesn't match `id_ed25519` (different name) — public
    // keys are intentionally world-readable, and SSH won't complain.
    const pubMode = fs.statSync(path.join(TMP3, 'ssh', 'id_ed25519.pub')).mode & 0o777;
    assert(pubMode !== 0o600, `pub stayed at ${pubMode.toString(8)}, not 0600`);
  });
});

describe('[9] excludes: check-stale ignores changes under excluded subpath', () => {
  it('clean state matches', () => {
    const r = run2('branch:check-stale');
    eq(r.status, 0, `clean rc 0 (stderr: ${r.stderr})`);
    assert(r.stdout.includes('no differences'), 'reports clean');
  });
  it('mutating logs/ does NOT make check-stale dirty', () => {
    fs.writeFileSync(path.join(TMP2, 'data', 'svc', 'logs', 'errors.log'), 'NEW-BOOM\n');
    fs.writeFileSync(path.join(TMP2, 'data', 'svc', 'logs', 'fresh.log'), 'fresh\n');
    const r = run2('branch:check-stale');
    eq(r.status, 0, `still clean rc 0 (stdout: ${r.stdout})`);
  });
  it('mutating tracked files DOES make check-stale dirty', () => {
    fs.writeFileSync(path.join(TMP2, 'data', 'svc', 'token.json'), '{"v":2}\n');
    const r = run2('branch:check-stale');
    eq(r.status, 1);
    assert(r.stdout.includes('DIFF: data/svc'), 'reports the path');
  });
});

report();
