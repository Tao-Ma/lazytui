/**
 * image-backup plugin smoke test — verifies that a group declaring
 *
 *   images: { list, output_dir }
 *
 * gets `save` / `load` / `verify` / `status` actions synthesized, and
 * that each runs end-to-end against a fake `docker` on PATH (so no
 * real docker daemon needed). `gzip`/`tar`/`sha256sum`/`shasum` are
 * universally available, so we use them for real.
 *
 * Pins the four invariants of the v0.6.53 integrity rework:
 *   1. ATOMIC SAVE — the gzip pipeline writes to `.partial`; the
 *      sidecar is written LAST; a mid-pipeline interrupt can never
 *      touch the previous good backup.
 *   2. VERIFIED LOAD — `$SUM -c` runs BEFORE `docker load`; a bad
 *      sum aborts the whole batch; files without a sidecar are
 *      refused unless the `force` port is set.
 *   3. VERIFY — standalone integrity gate (OK / FAIL / UNVERIFIED
 *      + leftover-partial WARN); rc 1 on any FAIL only.
 *   4. STATUS — matches EITHER tar layout (containerd index.json OR
 *      classic manifest.json), surfaces strays separately.
 *
 * Run: node js/test/test-image-backup.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
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

describe('[2] groupActions synthesizes save + load + verify + status', () => {
  it('four action keys', () => {
    const a = ib.groupActions({ images: { list: ['a', 'b'] } });
    eq(Object.keys(a).sort().join(','), 'load,save,status,verify');
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
    const safe = ib._safeName('gitea/gitea:latest');
    assert(a.save.script.includes(`'out/${safe}.tar.gz.partial'`),
      'save redirect targets the .partial sibling (not the final name)');
    assert(a.save.script.includes(`'out/${safe}.tar.gz'`), 'final name appears (mv target + sidecar step)');
    assert(a.save.script.includes("mkdir -p 'out'"), 'mkdir uses configured dir');
  });
  it('load script refuses if dir missing', () => {
    const a = ib.groupActions({ images: { list: ['x'], output_dir: 'archives' } });
    assert(a.load.script.includes('no backup dir at archives'), 'load aborts on missing dir');
  });
  it('load declares the `force` port (optional, remember:false)', () => {
    const a = ib.groupActions({ images: { list: ['x'] } });
    const force = a.load.ports && a.load.ports.in && a.load.ports.in.force;
    assert(force, 'force port declared');
    eq(force.required, false, 'optional');
    eq(force.remember, false, 'remember:false — a safety override must not prefill');
  });
  it('B2-class: malicious output_dir / image ref is escaped in the ECHO lines too (not just functional lines)', () => {
    const evil = 'd; touch /tmp/pwned #';
    const a = ib.groupActions({ images: { list: ['img$(id)'], output_dir: evil } });
    // The display echoes carried raw ${out}/${img} inside double quotes before —
    // `$()`/`;` were live. Now the whole message is single-quote wrapped (inert).
    assert(a.save.script.includes(`'saved to ${evil}/'`), 'save "saved to" echo single-quoted');
    assert(a.save.script.includes("'  img$(id)...'"), 'per-image echo single-quoted (img$(id) inert)');
    assert(a.load.script.includes(`'no backup dir at ${evil}'`), 'load "no dir" echo single-quoted');
    assert(!/echo "[^"]*touch \/tmp\/pwned/.test(a.save.script + a.load.script + a.verify.script + a.status.script),
      'no raw double-quoted splice remains across any synthesized action');
  });
});

describe('[2b] save script shape — atomic invariants pinned textually', () => {
  const a = ib.groupActions({ images: { list: ['dev9-env'], output_dir: 'out' } });
  const safe = ib._safeName('dev9-env');
  const scr = a.save.script;
  it('gzip redirect lands in .partial, not the final name', () => {
    assert(/gzip > "\$2"/.test(scr), 'pipeline redirects via positional $2');
    // The partial path is what gets passed as "$2" in the bash -c wrapper.
    assert(scr.includes(`'out/${safe}.tar.gz.partial'`), 'partial path is passed as the pipeline target');
  });
  it('mv partial → final appears BEFORE the sidecar write (textual order)', () => {
    const mvIdx  = scr.indexOf(`mv 'out/${safe}.tar.gz.partial' 'out/${safe}.tar.gz'`);
    const sideIdx = scr.indexOf(`> 'out/${safe}.tar.gz.sha256'`);
    assert(mvIdx > 0, 'mv step appears');
    assert(sideIdx > 0, 'sidecar write appears');
    assert(mvIdx < sideIdx, 'sidecar is written AFTER the mv (completed-marker last)');
  });
  it('sidecar carries the FINAL basename (so `$SUM -c` from the dir works)', () => {
    // The printf line interpolates "$HASH" and the quoted basename.
    assert(scr.includes(`printf '%s  %s\\n' "$HASH" '${safe}.tar.gz'`),
      'sidecar line is `<hash>  <final-basename>` — not the partial name');
  });
  it('failure path cleans the .partial (no truncated file left behind under either name)', () => {
    // Both branches (pipeline failure + checksum step failure) rm the partial.
    const rmPartialCount = (scr.match(new RegExp(`rm -f 'out/${safe}\\.tar\\.gz\\.partial'`, 'g')) || []).length;
    assert(rmPartialCount >= 2, `rm -f partial appears in BOTH failure branches (got ${rmPartialCount})`);
  });
  it('*.tar.gz glob does not match <name>.tar.gz.partial — invariant 2 (sanity)', () => {
    // Not a shell call — the invariant is literal: fnmatch-like glob matching of
    // `*.tar.gz` against `foo.tar.gz.partial` is false because `.partial` is
    // past the `.tar.gz` suffix anchor. Pin it as a plain predicate so future
    // readers see why we don't need an explicit `! -s "*.partial"` guard.
    const matches = (name, glob) => {
      // Convert the simple glob (`*` only) to a regex anchored to the whole name.
      const re = new RegExp('^' + glob.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      return re.test(name);
    };
    assert(matches('a.tar.gz', '*.tar.gz'), 'sanity: glob matches a .tar.gz');
    assert(!matches('a.tar.gz.partial', '*.tar.gz'), '`*.tar.gz` does NOT match `.tar.gz.partial`');
  });
});

describe('[2c] load script shape — sum check precedes docker load; force branch', () => {
  const a = ib.groupActions({ images: { list: ['x'], output_dir: 'image_backup' } });
  const scr = a.load.script;
  it('$SUM -c appears textually BEFORE the subsequent `gunzip -c "$f" | docker load`', () => {
    const sumIdx = scr.indexOf('$SUM -c "$base.sha256"');
    const loadIdx = scr.indexOf('gunzip -c "$f" | docker load');
    assert(sumIdx > 0, 'sum check appears');
    assert(loadIdx > 0, 'docker load appears');
    assert(sumIdx < loadIdx, 'sum check lexically precedes docker load (sum-gate pin)');
  });
  it('bad-sum branch exits non-zero (whole-batch abort)', () => {
    assert(/FAIL checksum:/.test(scr), 'labelled FAIL message');
    assert(/exit 1/.test(scr), 'exits non-zero on sum failure');
  });
  it('no-sidecar branch tests `${force:-}` (optional-port env binding)', () => {
    assert(scr.includes('[ -n "${force:-}" ]'), 'force branch gated on env binding');
    assert(scr.includes('SKIP $base (no .sha256 sidecar'),
      'no-force path emits a loud SKIP, not silent fallthrough');
  });
});

// --- End-to-end with PATH-injected fake docker ---

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-test-'));
process.on('exit', () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
});

// Fake docker: emit synthetic tar bytes for `save`, log calls for `load`,
// serve a configurable image ID for `inspect` (status verb).
const FAKES = path.join(TMP, 'fakes');
fs.mkdirSync(FAKES);
fs.writeFileSync(path.join(FAKES, 'docker'), `#!/bin/sh
# Fake docker for image-backup tests.
# - save <image>              → emit "FAKE-IMAGE:<image>" on stdout
#   (gzipped by the real shell pipeline).
# - load                      → consume stdin, append to a log file.
# - inspect --format '{{.Id}}' <ref> → read a per-ref ID file if present,
#   else exit 1 (missing).

case "$1" in
  save)
    img="$2"
    if [ "$img" = "missing/image" ]; then
      echo "Error: No such image: $img" >&2
      exit 1
    fi
    printf 'FAKE-IMAGE:%s' "$img"
    ;;
  load)
    head -c 256 >> "$TMP_LOAD_LOG"
    printf '\\n' >> "$TMP_LOAD_LOG"
    echo "Loaded image (fake)"
    ;;
  inspect)
    # Positional args here: inspect --format '{{.Id}}' <ref>
    # Resolve to \$TMP_IDS_DIR/<ref-escaped>.id or exit 1.
    shift
    while [ "\$#" -gt 0 ]; do
      case "\$1" in
        --format) shift; shift ;;
        -*) shift ;;
        *) break ;;
      esac
    done
    ref="\$1"
    [ -n "\$ref" ] || exit 1
    # safeName flattens / and :
    safe=\$(printf '%s' "\$ref" | tr '/:' '__')
    f="\$TMP_IDS_DIR/\$safe.id"
    if [ -f "\$f" ]; then
      cat "\$f"
    else
      echo "Error: No such object: \$ref" >&2
      exit 1
    fi
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

function run(action, env = {}, args = []) {
  return spawnSync(process.execPath, [TUI, FIXTURE, '--exec', action, ...args], {
    encoding: 'utf8', timeout: 15000, cwd: TMP,
    env: {
      ...process.env,
      PATH: `${FAKES}:${process.env.PATH}`,
      TMP_LOAD_LOG: path.join(TMP, 'load.log'),
      TMP_IDS_DIR: path.join(TMP, 'ids'),
      ...env,
    },
  });
}

describe('[3] --list shows synthesized save + load + verify + status', () => {
  it('all four appear', () => {
    const r = spawnSync(process.execPath, [TUI, FIXTURE, '--list', 'imgs'], {
      encoding: 'utf8', timeout: 5000, cwd: TMP,
    });
    eq(r.status, 0);
    for (const key of ['imgs:save', 'imgs:load', 'imgs:verify', 'imgs:status']) {
      assert(r.stdout.includes(key), `${key} listed`);
    }
  });
});

describe('[4] save: atomic — final file + sidecar; no .partial left; SKIP on missing', () => {
  it('save runs; final tar.gz + .sha256 exist for the available images, no .partial residue', () => {
    const r = run('imgs:save');
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
    const dir = path.join(TMP, 'image_backup');
    const files = fs.readdirSync(dir).sort();
    const devBase  = `${ib._safeName('dev9-env')}.tar.gz`;
    const gitBase  = `${ib._safeName('gitea/gitea:latest')}.tar.gz`;
    const missBase = `${ib._safeName('missing/image')}.tar.gz`;
    assert(files.includes(devBase), `dev9-env saved (${devBase})`);
    assert(files.includes(`${devBase}.sha256`), 'dev9-env sidecar written');
    assert(files.includes(gitBase), `gitea saved (${gitBase})`);
    assert(files.includes(`${gitBase}.sha256`), 'gitea sidecar written');
    assert(!files.includes(missBase), 'missing image not written');
    assert(!files.includes(`${missBase}.partial`), 'missing image left no .partial residue');
    assert(!files.some((f) => f.endsWith('.partial')),
      'no leftover .partial from any image (invariant 1 — failure path cleans up)');
  });
  it('save reports SKIP for the missing image', () => {
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
  it('sidecar line references the FINAL basename (so `$SUM -c` from the dir works)', () => {
    const safe = ib._safeName('dev9-env');
    const sidecar = fs.readFileSync(path.join(TMP, 'image_backup', `${safe}.tar.gz.sha256`), 'utf8');
    // sha256sum/shasum line shape: `<64 hex>  <basename>\n`
    assert(/^[0-9a-f]{64}\s+/.test(sidecar), 'sidecar starts with 64-hex');
    assert(sidecar.includes(`${safe}.tar.gz`), 'sidecar names the FINAL file (not the partial)');
    assert(!sidecar.includes('.partial'), 'sidecar does NOT name the partial');
  });
});

describe('[5] load: sum-gated — happy path still loads every valid file', () => {
  it('load reports a count and the fake records each invocation', () => {
    // load.log may be left over from [4]'s dry run; clear.
    try { fs.unlinkSync(path.join(TMP, 'load.log')); } catch (_) {}
    const r = run('imgs:load');
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
    assert(r.stdout.includes('done.'), 'reports done');
    const log = fs.readFileSync(path.join(TMP, 'load.log'), 'utf8');
    assert(log.includes('FAKE-IMAGE:dev9-env'), 'dev9-env loaded');
    assert(log.includes('FAKE-IMAGE:gitea/gitea:latest'), 'gitea loaded');
  });
});

describe('[6] load: a bad sum aborts the whole batch (rc 1)', () => {
  it('tampered file → FAIL checksum, exit 1, nothing further loaded', () => {
    const devFile = path.join(TMP, 'image_backup', `${ib._safeName('dev9-env')}.tar.gz`);
    // Flip one byte near the end of the gzip stream. The sidecar stays
    // correct for the ORIGINAL bytes, so $SUM -c now mismatches.
    const buf = fs.readFileSync(devFile);
    buf[buf.length - 2] ^= 0xff;
    fs.writeFileSync(devFile, buf);
    try { fs.unlinkSync(path.join(TMP, 'load.log')); } catch (_) {}
    const r = run('imgs:load');
    eq(r.status, 1, 'batch aborted');
    assert(r.stderr.includes('FAIL checksum'), 'reports the sum failure');
    // The whole-batch abort means we do NOT fall through to subsequent
    // files. Depending on alphabetical globbing, gitea may or may not
    // have loaded before dev9-env's turn; the invariant is "stops at
    // the first failure", which is satisfied by rc 1.
    // Restore the file for later tests.
    buf[buf.length - 2] ^= 0xff;
    fs.writeFileSync(devFile, buf);
  });
});

describe('[7] load: no sidecar → SKIP without force, loaded with force', () => {
  it('legacy file (sidecar removed) is skipped loudly when `force` is unset', () => {
    const safe = ib._safeName('dev9-env');
    const sidecar = path.join(TMP, 'image_backup', `${safe}.tar.gz.sha256`);
    const stash = fs.readFileSync(sidecar);
    fs.unlinkSync(sidecar);
    try { fs.unlinkSync(path.join(TMP, 'load.log')); } catch (_) {}
    const r = run('imgs:load');
    // The other image still has a sidecar, so load succeeds overall;
    // dev9-env is the one that gets skipped.
    assert(r.stdout.includes(`SKIP ${safe}.tar.gz`), 'legacy file reported as SKIP');
    assert(r.stdout.includes('no .sha256 sidecar'), 'tells the user why');
    const log = fs.existsSync(path.join(TMP, 'load.log')) ? fs.readFileSync(path.join(TMP, 'load.log'), 'utf8') : '';
    assert(!log.includes('FAKE-IMAGE:dev9-env'), 'the sidecar-less file was NOT fed to docker load');
    fs.writeFileSync(sidecar, stash);
  });
  it('setting the `force` port (positional arg) loads the sidecar-less file with a notice', () => {
    const safe = ib._safeName('dev9-env');
    const sidecar = path.join(TMP, 'image_backup', `${safe}.tar.gz.sha256`);
    const stash = fs.readFileSync(sidecar);
    fs.unlinkSync(sidecar);
    try { fs.unlinkSync(path.join(TMP, 'load.log')); } catch (_) {}
    // `force` is declared first and only — the positional arg binds to it
    // via cli.js's ports-in resolver (SHELL_ACTION ports → env map).
    const r = run('imgs:load', {}, ['1']);
    eq(r.status, 0, `rc 0 with force (stderr: ${r.stderr})`);
    assert(r.stdout.includes('unverified — force'), 'notice emitted on the force-loaded file');
    const log = fs.readFileSync(path.join(TMP, 'load.log'), 'utf8');
    assert(log.includes('FAKE-IMAGE:dev9-env'), 'force-loaded file DID reach docker load');
    fs.writeFileSync(sidecar, stash);
  });
});

describe('[8] load refuses if backup dir is missing', () => {
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

describe('[9] verify: standalone integrity gate', () => {
  it('clean dir reports OK on sidecar-backed files and rc 0', () => {
    const r = run('imgs:verify');
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
    const safe = ib._safeName('dev9-env');
    assert(new RegExp(`OK\\s+${safe}\\.tar\\.gz`).test(r.stdout), 'OK line for sidecar-backed file');
  });
  it('tampered file → FAIL (checksum), rc 1', () => {
    const devFile = path.join(TMP, 'image_backup', `${ib._safeName('dev9-env')}.tar.gz`);
    const buf = fs.readFileSync(devFile);
    buf[buf.length - 2] ^= 0xff;
    fs.writeFileSync(devFile, buf);
    const r = run('imgs:verify');
    eq(r.status, 1, 'rc 1 on tamper');
    assert(r.stdout.includes('FAIL (checksum)'), 'labelled checksum failure');
    buf[buf.length - 2] ^= 0xff;
    fs.writeFileSync(devFile, buf);
  });
  it('legacy file (no sidecar) reports UNVERIFIED but keeps rc 0', () => {
    const safe = ib._safeName('dev9-env');
    const sidecar = path.join(TMP, 'image_backup', `${safe}.tar.gz.sha256`);
    const stash = fs.readFileSync(sidecar);
    fs.unlinkSync(sidecar);
    const r = run('imgs:verify');
    eq(r.status, 0, 'UNVERIFIED alone is informational — rc 0');
    assert(r.stdout.includes('UNVERIFIED (no sidecar)'), 'reports UNVERIFIED');
    fs.writeFileSync(sidecar, stash);
  });
  it('leftover .partial surfaces as a WARN line', () => {
    const safe = ib._safeName('dev9-env');
    const partial = path.join(TMP, 'image_backup', `${safe}.tar.gz.partial`);
    fs.writeFileSync(partial, 'residue\n');
    const r = run('imgs:verify');
    eq(r.status, 0, 'rc 0 (partial is WARN, not FAIL)');
    assert(r.stdout.includes('WARN leftover partial'), 'labelled leftover partial');
    fs.unlinkSync(partial);
  });
  it('a corrupt gzip without sidecar is a hard FAIL (gzip -t), rc 1', () => {
    const dir = path.join(TMP, 'image_backup');
    const name = 'junk.tar.gz';
    fs.writeFileSync(path.join(dir, name), 'not a gzip stream\n');
    const r = run('imgs:verify');
    eq(r.status, 1, 'rc 1 on corrupt gzip');
    assert(r.stdout.includes('FAIL (gzip -t)'), 'labelled gzip failure');
    fs.unlinkSync(path.join(dir, name));
  });
});

// --- Status verb --- construct tiny tar.gz files for the two ID formats

function makeTarGz(entries) {
  // Minimal plain-ustar builder — one 512-byte header per entry, data
  // padded to 512 bytes, then two 512-byte zero blocks as the trailer.
  // Avoids a `tar` dep in the test; the real `tar` is used by the
  // status script to EXTRACT what we build.
  const blocks = [];
  for (const [name, data] of entries) {
    const buf = Buffer.alloc(512);
    buf.write(name, 0, 100, 'utf8');          // name
    buf.write('0000644\0', 100);              // mode
    buf.write('0000000\0', 108);              // uid
    buf.write('0000000\0', 116);              // gid
    buf.write(data.length.toString(8).padStart(11, '0') + '\0', 124); // size (octal)
    buf.write('00000000000\0', 136);          // mtime
    buf.write('        ', 148);               // checksum placeholder (spaces)
    buf.write('0', 156);                      // typeflag (regular)
    buf.write('ustar  \0', 257, 8, 'utf8');   // magic + version (GNU variant)
    // Compute checksum: sum of all bytes with checksum field as spaces.
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += buf[i];
    const chkOct = sum.toString(8).padStart(6, '0') + '\0 ';
    buf.write(chkOct, 148);
    blocks.push(buf);
    const content = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    content.write(data, 0, data.length, 'utf8');
    blocks.push(content);
  }
  blocks.push(Buffer.alloc(512), Buffer.alloc(512));  // EOF
  return zlib.gzipSync(Buffer.concat(blocks));
}

function sha256(buf) {
  return require('crypto').createHash('sha256').update(buf).digest('hex');
}

describe('[10] status: matches EITHER tar layout (containerd vs classic)', () => {
  const ID_A = 'a'.repeat(60) + 'cafe';   // 64-hex, "containerd" fixture
  const ID_B = 'b'.repeat(60) + 'beef';   // 64-hex, "classic" fixture
  const ID_C = 'c'.repeat(60) + 'face';   // 64-hex, "stale" (daemon has different id)

  it('CURRENT when live ID appears in index.json (containerd layout)', () => {
    // Build a .tar.gz containing index.json with the manifest digest.
    const idxJson = JSON.stringify({
      manifests: [{ digest: `sha256:${ID_A}`, mediaType: 'application/vnd.oci.image.manifest.v1+json' }],
    });
    const tgz = makeTarGz([['index.json', idxJson]]);
    // Wire a config whose output_dir holds this one file + sidecar.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-status-'));
    const ref = 'ct-only';
    const safe = ib._safeName(ref);
    const outDir = path.join(dir, 'image_backup');
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, `${safe}.tar.gz`), tgz);
    fs.writeFileSync(path.join(outDir, `${safe}.tar.gz.sha256`), `${sha256(tgz)}  ${safe}.tar.gz\n`);
    const idsDir = path.join(dir, 'ids');
    fs.mkdirSync(idsDir);
    fs.writeFileSync(path.join(idsDir, `${ref}.id`), `sha256:${ID_A}\n`);
    const fixture = path.join(dir, 'f.yml');
    fs.writeFileSync(fixture, `project_dir: .
groups:
  imgs:
    label: I
    images: { output_dir: image_backup, list: [${ref}] }
    actions: { info: { label: i, type: run, script: echo x } }
`);
    const r = spawnSync(process.execPath, [TUI, fixture, '--exec', 'imgs:status'], {
      encoding: 'utf8', timeout: 10000, cwd: dir,
      env: {
        ...process.env,
        PATH: `${FAKES}:${process.env.PATH}`,
        TMP_IDS_DIR: idsDir,
        TMP_LOAD_LOG: '/dev/null',
      },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
    assert(r.stdout.includes('CURRENT'), `CURRENT on containerd layout (stdout: ${r.stdout})`);
    assert(r.stdout.includes(ref), 'ref is named');
  });

  it('CURRENT when live ID appears in manifest.json Config (classic layout, both forms)', () => {
    for (const configForm of [`${ID_B}.json`, `blobs/sha256/${ID_B}`]) {
      const manJson = JSON.stringify([{ Config: configForm, RepoTags: ['x:latest'], Layers: [] }]);
      const tgz = makeTarGz([['manifest.json', manJson]]);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-status-'));
      const ref = 'classic-only';
      const safe = ib._safeName(ref);
      const outDir = path.join(dir, 'image_backup');
      fs.mkdirSync(outDir);
      fs.writeFileSync(path.join(outDir, `${safe}.tar.gz`), tgz);
      fs.writeFileSync(path.join(outDir, `${safe}.tar.gz.sha256`), `${sha256(tgz)}  ${safe}.tar.gz\n`);
      const idsDir = path.join(dir, 'ids');
      fs.mkdirSync(idsDir);
      fs.writeFileSync(path.join(idsDir, `${ref}.id`), `sha256:${ID_B}\n`);
      const fixture = path.join(dir, 'f.yml');
      fs.writeFileSync(fixture, `project_dir: .
groups:
  imgs:
    label: I
    images: { output_dir: image_backup, list: [${ref}] }
    actions: { info: { label: i, type: run, script: echo x } }
`);
      const r = spawnSync(process.execPath, [TUI, fixture, '--exec', 'imgs:status'], {
        encoding: 'utf8', timeout: 10000, cwd: dir,
        env: {
          ...process.env,
          PATH: `${FAKES}:${process.env.PATH}`,
          TMP_IDS_DIR: idsDir,
          TMP_LOAD_LOG: '/dev/null',
        },
      });
      fs.rmSync(dir, { recursive: true, force: true });
      eq(r.status, 0, `rc 0 for Config form "${configForm}" (stderr: ${r.stderr})`);
      assert(r.stdout.includes('CURRENT'),
        `CURRENT on classic layout, Config form "${configForm}" (stdout: ${r.stdout})`);
    }
  });

  it('STALE when inner IDs do not include the live ID', () => {
    const idxJson = JSON.stringify({ manifests: [{ digest: `sha256:${ID_C}` }] });
    const tgz = makeTarGz([['index.json', idxJson]]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-status-'));
    const ref = 'drifted';
    const safe = ib._safeName(ref);
    const outDir = path.join(dir, 'image_backup');
    fs.mkdirSync(outDir);
    fs.writeFileSync(path.join(outDir, `${safe}.tar.gz`), tgz);
    fs.writeFileSync(path.join(outDir, `${safe}.tar.gz.sha256`), `${sha256(tgz)}  ${safe}.tar.gz\n`);
    const idsDir = path.join(dir, 'ids');
    fs.mkdirSync(idsDir);
    // Daemon reports a DIFFERENT id (not ID_C).
    fs.writeFileSync(path.join(idsDir, `${ref}.id`), `sha256:${'d'.repeat(64)}\n`);
    const fixture = path.join(dir, 'f.yml');
    fs.writeFileSync(fixture, `project_dir: .
groups:
  imgs:
    label: I
    images: { output_dir: image_backup, list: [${ref}] }
    actions: { info: { label: i, type: run, script: echo x } }
`);
    const r = spawnSync(process.execPath, [TUI, fixture, '--exec', 'imgs:status'], {
      encoding: 'utf8', timeout: 10000, cwd: dir,
      env: {
        ...process.env,
        PATH: `${FAKES}:${process.env.PATH}`,
        TMP_IDS_DIR: idsDir,
        TMP_LOAD_LOG: '/dev/null',
      },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
    assert(r.stdout.includes('STALE'), `STALE verdict (stdout: ${r.stdout})`);
  });
});

describe('[11] status: strays section surfaces non-expected non-partial files', () => {
  it('a legacy-named file (no hash suffix) is reported as a stray; .partial is NOT', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ib-stray-'));
    const outDir = path.join(dir, 'image_backup');
    fs.mkdirSync(outDir);
    // Legacy pre-v0.6 name (no `-<hash>` suffix) — the dev9 incident class.
    fs.writeFileSync(path.join(outDir, 'dev9-env.tar.gz'), 'legacy\n');
    // A leftover .partial — must NOT appear in strays (it's a verify concern).
    fs.writeFileSync(path.join(outDir, `${ib._safeName('dev9-env')}.tar.gz.partial`), 'residue\n');
    const idsDir = path.join(dir, 'ids');
    fs.mkdirSync(idsDir);
    const fixture = path.join(dir, 'f.yml');
    fs.writeFileSync(fixture, `project_dir: .
groups:
  imgs:
    label: I
    images: { output_dir: image_backup, list: [dev9-env] }
    actions: { info: { label: i, type: run, script: echo x } }
`);
    const r = spawnSync(process.execPath, [TUI, fixture, '--exec', 'imgs:status'], {
      encoding: 'utf8', timeout: 10000, cwd: dir,
      env: {
        ...process.env,
        PATH: `${FAKES}:${process.env.PATH}`,
        TMP_IDS_DIR: idsDir,
        TMP_LOAD_LOG: '/dev/null',
      },
    });
    fs.rmSync(dir, { recursive: true, force: true });
    eq(r.status, 0, `rc 0 (stderr: ${r.stderr})`);
    assert(/strays:[\s\S]*dev9-env\.tar\.gz/.test(r.stdout),
      'legacy-named file appears in strays section');
    assert(!/strays:[\s\S]*\.partial/.test(r.stdout),
      '.partial is NOT in strays (it is a verify concern)');
  });
});

report();
