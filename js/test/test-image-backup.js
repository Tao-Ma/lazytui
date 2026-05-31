/**
 * image-backup plugin smoke test — verifies that a group declaring
 *
 *   images: { list, output_dir }
 *
 * gets `save` and `load` actions synthesized, and that both run end-
 * to-end against a fake `docker` on PATH (so no real docker daemon
 * needed). `gzip` is universally available, so we use it for real.
 *
 * Run: node js/test/test-image-backup.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const ib = require('../feature/image-backup');
const { describe, it, eq, assert, report } = require('./test-runner');

const TUI = path.resolve(__dirname, '..', 'app', 'tui.js');

// --- Pure unit tests ---

describe('[1] groupActions returns {} when images: missing or malformed', () => {
  it('group with no images', () => {
    eq(Object.keys(ib.groupActions({})).length, 0);
  });
  it('images.list empty', () => {
    eq(Object.keys(ib.groupActions({ images: { list: [] } })).length, 0);
  });
  it('images.list missing', () => {
    eq(Object.keys(ib.groupActions({ images: { output_dir: 'x' } })).length, 0);
  });
});

describe('[2] groupActions synthesizes save + load', () => {
  it('two action keys', () => {
    const a = ib.groupActions({ images: { list: ['a', 'b'] } });
    eq(Object.keys(a).sort().join(','), 'load,save');
  });
  it('safeName flattens / and : then appends a hash', () => {
    // Flat prefix preserved for readability + a hash suffix to keep
    // collision-prone refs distinct on disk.
    const a = ib._safeName('gitea/gitea:latest');
    assert(a.startsWith('gitea_gitea_latest-'), `got: ${a}`);
    eq(a.length, 'gitea_gitea_latest-'.length + 8, '8-char hash');
    const b = ib._safeName('plain');
    assert(b.startsWith('plain-'), `got: ${b}`);
  });
  it('safeName distinguishes refs that would otherwise flatten the same', () => {
    // Three distinct refs, all flatten to `a_b_latest` pre-v0.6 →
    // silent clobber on save. Hash suffix keeps them apart.
    const refs = ['a/b:latest', 'a:b:latest', 'a/b/latest'];
    const names = refs.map(ib._safeName);
    eq(new Set(names).size, 3, 'all three names distinct');
  });
  it('save script uses safe filenames', () => {
    const a = ib.groupActions({ images: { list: ['gitea/gitea:latest'], output_dir: 'out' } });
    // Post-v0.6 shell-injection guard: filename is single-quote escaped.
    const expected = `'out/${ib._safeName('gitea/gitea:latest')}.tar.gz'`;
    assert(a.save.script.includes(expected), `safe filename in save (looking for ${expected})`);
    assert(a.save.script.includes("mkdir -p 'out'"), 'mkdir uses configured dir');
  });
  it('load script refuses if dir missing', () => {
    const a = ib.groupActions({ images: { list: ['x'], output_dir: 'archives' } });
    assert(a.load.script.includes('no backup dir at archives'), 'load aborts on missing dir');
  });
});

// --- End-to-end with PATH-injected fake docker ---

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-test-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// Fake docker: emit synthetic tar bytes for `save`, log calls for `load`.
const FAKES = path.join(TMP, 'fakes');
fs.mkdirSync(FAKES);
fs.writeFileSync(path.join(FAKES, 'docker'), `#!/bin/sh
# Fake docker for image-backup tests.
# - save <image> → emit "FAKE-IMAGE:<image>" on stdout (gzipped by the
#   real shell pipeline, gunzipped + parsed back during load test).
# - load          → consume stdin, log the unzipped header to a sidecar
#                   file so the test can assert what was loaded.

case "$1" in
  save)
    img="$2"
    if [ "$img" = "missing/image" ]; then
      # Simulate "image not found" by exiting non-zero with no stdout —
      # the plugin's gzip-pipe || SKIP fallthrough should catch it.
      echo "Error: No such image: $img" >&2
      exit 1
    fi
    printf 'FAKE-IMAGE:%s' "$img"
    ;;
  load)
    # Consume stdin and append the first line to the load log.
    head -c 256 >> "$TMP_LOAD_LOG"
    printf '\\n' >> "$TMP_LOAD_LOG"
    echo "Loaded image (fake)"
    ;;
  *)
    echo "fake docker: unsupported \\$1" >&2
    exit 1
    ;;
esac
`);
fs.chmodSync(path.join(FAKES, 'docker'), 0o755);

const FIXTURE = path.join(TMP, 'fixture.yml');
fs.writeFileSync(FIXTURE, `project_dir: .

groups:
  imgs:
    label: Images
    images:
      output_dir: image_backup
      list:
        - dev9-env
        - gitea/gitea:latest
        - missing/image
    actions:
      info:
        label: About
        type: run
        script: echo about
`);

function run(action, env = {}) {
  return spawnSync(process.execPath, [TUI, FIXTURE, '--exec', action], {
    encoding: 'utf8', timeout: 15000, cwd: TMP,
    env: {
      ...process.env,
      PATH: `${FAKES}:${process.env.PATH}`,
      TMP_LOAD_LOG: path.join(TMP, 'load.log'),
      ...env,
    },
  });
}

describe('[3] --list shows synthesized save + load', () => {
  it('both appear', () => {
    const r = spawnSync(process.execPath, [TUI, FIXTURE, '--list', 'imgs'], {
      encoding: 'utf8', timeout: 5000, cwd: TMP,
    });
    eq(r.status, 0);
    assert(r.stdout.includes('imgs:save'), 'save listed');
    assert(r.stdout.includes('imgs:load'), 'load listed');
  });
});

describe('[4] save: writes gzipped tarballs, skips missing images, lists output', () => {
  it('save runs and produces tar.gz files for the available images', () => {
    const r = run('imgs:save');
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
    const dir = path.join(TMP, 'image_backup');
    const files = fs.readdirSync(dir).sort();
    const devFile  = `${ib._safeName('dev9-env')}.tar.gz`;
    const gitFile  = `${ib._safeName('gitea/gitea:latest')}.tar.gz`;
    const missFile = `${ib._safeName('missing/image')}.tar.gz`;
    assert(files.includes(devFile), `dev9-env saved (${devFile})`);
    assert(files.includes(gitFile), `safe-named gitea saved (${gitFile})`);
    assert(!files.includes(missFile), 'missing image not written');
  });
  it('save reports SKIP for the missing image', () => {
    // Re-run on the existing dir; this time we just want stdout.
    const r = run('imgs:save');
    eq(r.status, 0);
    assert(r.stdout.includes('SKIP missing/image'), 'reports skip');
  });
  it('saved tar.gz contents are recoverable through gzip', () => {
    const file = path.join(TMP, 'image_backup', `${ib._safeName('dev9-env')}.tar.gz`);
    const r = spawnSync('gunzip', ['-c', file], { encoding: 'utf8' });
    eq(r.status, 0, 'gunzip succeeded');
    eq(r.stdout, 'FAKE-IMAGE:dev9-env', 'fake payload round-tripped');
  });
});

describe('[5] load: feeds every tar.gz back through fake docker', () => {
  it('load reports a count and the fake records each invocation', () => {
    const r = run('imgs:load');
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
    assert(r.stdout.includes('done.'), 'reports done');
    const log = fs.readFileSync(path.join(TMP, 'load.log'), 'utf8');
    assert(log.includes('FAKE-IMAGE:dev9-env'), 'dev9-env loaded');
    assert(log.includes('FAKE-IMAGE:gitea/gitea:latest'), 'gitea loaded');
  });
});

describe('[6] load refuses if backup dir is missing', () => {
  it('rc 1 when output_dir does not exist', () => {
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-empty-'));
    const fixture2 = path.join(tmp2, 'f.yml');
    fs.writeFileSync(fixture2, `project_dir: .
groups:
  imgs:
    label: Images
    images:
      output_dir: nonexistent
      list: [x]
    actions: { info: { label: i, type: run, script: echo x } }
`);
    const r = spawnSync(process.execPath, [TUI, fixture2, '--exec', 'imgs:load'], {
      encoding: 'utf8', timeout: 5000, cwd: tmp2,
      env: { ...process.env, PATH: `${FAKES}:${process.env.PATH}` },
    });
    fs.rmSync(tmp2, { recursive: true, force: true });
    eq(r.status, 1);
    assert(r.stderr.includes('no backup dir'), 'reports the missing dir');
  });
});

report();
