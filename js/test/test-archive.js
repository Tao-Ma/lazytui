/**
 * archive plugin smoke test — verifies that a group declaring
 *
 *   archive: { target, output_dir, name }
 *
 * gets `archive` and `verify` actions synthesized by groupActions, and
 * that running them end-to-end through tui.js --exec produces a real
 * .tar.xz + .sha256 sidecar that round-trips through verify.
 *
 * The test depends on tar (xz support — universal on macOS / Linux)
 * and either `sha256sum` or `shasum`. CI containers and dev hosts
 * have one of those by default.
 *
 * Run: node js/test/test-archive.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const archive = require('../feature/archive');
const { describe, it, eq, assert, report } = require('./test-runner');

const TUI = path.resolve(__dirname, '..', 'app', 'tui.js');

// --- Pure unit tests for groupActions ---

describe('[1] groupActions returns {} when archive: not declared', () => {
  it('group with no archive', () => {
    eq(Object.keys(archive.groupActions({})).length, 0, 'no actions');
  });
  it('group with malformed archive (missing name)', () => {
    eq(Object.keys(archive.groupActions({ archive: { target: 'x' } })).length, 0, 'no actions');
  });
  it('group with malformed archive (missing target)', () => {
    eq(Object.keys(archive.groupActions({ archive: { name: 'foo' } })).length, 0, 'no actions');
  });
});

describe('[2] groupActions synthesizes archive + verify', () => {
  it('shape includes archive and verify', () => {
    const a = archive.groupActions({ archive: { target: 'data', name: 'foo' } });
    const keys = Object.keys(a).sort();
    eq(keys.join(','), 'archive,verify', 'two actions only');
    eq(a.archive.type, 'run', 'archive type');
    eq(a.verify.type, 'run', 'verify type');
    eq(a.verify.ports.in.file.type, 'string', 'verify declares a `file` input port (ports/wires migration)');
    assert(a.verify.ports.in.file.required === true, 'verify.file is required');
    assert(a.verify.args === undefined, 'legacy `args:` field is retired on verify');
  });
  // Post-v0.6 shell-injection guard: config values are single-quote
  // escaped via shEscape before embedding. `archives` → `'archives'`
  // in the emitted script — POSIX-literal, no shell metas can break out.
  it('output_dir defaults to "." when omitted', () => {
    const a = archive.groupActions({ archive: { target: 'data', name: 'foo' } });
    assert(a.archive.script.includes("mkdir -p '.'"), 'mkdir -p defaults to .');
  });
  it('output_dir custom value lands in script', () => {
    const a = archive.groupActions({ archive: { target: 'data', output_dir: 'archives', name: 'foo' } });
    assert(a.archive.script.includes("mkdir -p 'archives'"), 'mkdir -p uses configured dir');
    assert(a.archive.script.includes("'archives'/'foo'-"), 'archive path includes output_dir/name');
  });
  it('shell-meta in target is neutralised', () => {
    // The single-quote wrap stops the metas from leaving the literal.
    const a = archive.groupActions({ archive: { target: 'foo"; rm -rf /; "', name: 'x' } });
    assert(a.archive.script.includes(`-C 'foo"; rm -rf /; "'`),
      `expected POSIX-literal interpolation, got:\n${a.archive.script}`);
    assert(!/-C foo"; rm -rf/.test(a.archive.script), 'no unquoted metacharacters');
  });
});

describe('[2b] archive script shape — atomic-save invariants pinned textually (v0.6.54)', () => {
  const a = archive.groupActions({ archive: { target: 'src', output_dir: 'archives', name: 'snap' } });
  const scr = a.archive.script;
  it('tar writes to "$OUT.partial", never "$OUT" directly', () => {
    assert(/tar -cJf "\$OUT\.partial" -C 'src' \./.test(scr),
      'tar target is $OUT.partial (atomic invariant 1 — never truncate the previous good archive)');
    assert(!/tar -cJf "\$OUT" /.test(scr),
      'no legacy `tar -cJf "$OUT" ...` form remains');
  });
  it('mv "$OUT.partial" → "$OUT" appears BEFORE the sidecar write (textual order)', () => {
    const mvIdx = scr.indexOf('mv "$OUT.partial" "$OUT"');
    const sidecarIdx = scr.indexOf('> "$OUT.sha256"');
    assert(mvIdx > 0, 'mv step appears');
    assert(sidecarIdx > 0, 'sidecar write appears');
    assert(mvIdx < sidecarIdx, 'sidecar is written AFTER the mv (completed-marker last)');
  });
  it('sidecar line is printf-built from pre-mv hash + the FINAL RELATIVE PATH ($OUT)', () => {
    // Constraint 1 in the brief: the sidecar carries `<hash>  <OUT>` where
    // $OUT is the relative-to-project-dir path (what `verify`'s `$SUM -c`
    // resolves). Byte-identical to the pre-v0.6.54 `$SUM "$OUT" > "$OUT.sha256"`
    // output — zero migration for existing sidecars on disk.
    assert(scr.includes(`HASH=$($SUM "$OUT.partial" | awk '{print $1}')`),
      'hash captured from the partial, pre-mv');
    assert(scr.includes(`printf '%s  %s\\n' "$HASH" "$OUT" > "$OUT.sha256"`),
      'sidecar line names the FINAL $OUT (relative path, not basename)');
    assert(!/printf '[^']*basename/.test(scr), 'does NOT use basename-style sidecar');
  });
  it('stale-partial cleanup is scoped to <dir>/<name>-*.tar.xz.partial', () => {
    // Scoping matters: unrelated files sharing the dir must be untouched.
    assert(scr.includes(`rm -f 'archives'/'snap'-*.tar.xz.partial`),
      'rm -f targets exactly <dir>/<name>-*.tar.xz.partial');
    // The `*` sits outside the single-quoted parts so the shell globs it.
    assert(!/rm -f 'archives\/snap-\*/.test(scr),
      'glob metacharacter is NOT inside a single-quoted literal');
  });
  it('*.tar.xz glob does not match <name>-<date>.tar.xz.partial — invariant 1 (sanity)', () => {
    const matches = (name, glob) => {
      const re = new RegExp('^' + glob.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      return re.test(name);
    };
    assert(matches('snap-20261030.tar.xz', '*.tar.xz'), 'sanity: glob matches a .tar.xz');
    assert(!matches('snap-20261030.tar.xz.partial', '*.tar.xz'),
      '`*.tar.xz` does NOT match `.tar.xz.partial` — any downstream consumer globbing archives skips partials');
  });
});

describe('[2c] verify script byte-shape unchanged — zero migration (constraint 2)', () => {
  it('verify script is EXACTLY the pre-v0.6.54 three-line form', () => {
    // The brief fixes verify as a hard constraint: all existing archives +
    // sidecars must verify before and after the bump. Pin the exact bytes
    // so an accidental refactor can't drift the shape.
    const a = archive.groupActions({ archive: { target: 'src', name: 'snap' } });
    const EXPECTED = [
      'set -e',
      "if command -v sha256sum >/dev/null 2>&1; then SUM='sha256sum'; else SUM='shasum -a 256'; fi",
      '$SUM -c "$file.sha256"',
    ].join('\n');
    eq(a.verify.script, EXPECTED, 'verify script bytes unchanged');
  });
});

// --- End-to-end: build fixture YAML, run --exec archive, then verify ---

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-test-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

// Project layout the YAML refers to (cwd at action execution = project_dir = .)
fs.mkdirSync(path.join(TMP, 'src'), { recursive: true });
fs.writeFileSync(path.join(TMP, 'src', 'a.txt'), 'hello\n');
fs.writeFileSync(path.join(TMP, 'src', 'b.txt'), 'world\n');

const FIXTURE = path.join(TMP, 'fixture.yml');
fs.writeFileSync(FIXTURE, `project_dir: .

groups:
  backup:
    label: Backup
    archive:
      target: src
      output_dir: archives
      name: snap
    actions:
      info:
        label: About
        type: run
        script: echo backup-info
`);

function run(action, ...rest) {
  return spawnSync(process.execPath, [TUI, FIXTURE, '--exec', action, ...rest], {
    encoding: 'utf8',
    timeout: 15000,
    cwd: TMP,
  });
}

describe('[3] --list shows synthesized archive + verify', () => {
  it('both appear under the backup group', () => {
    const r = spawnSync(process.execPath, [TUI, FIXTURE, '--list', 'backup'], {
      encoding: 'utf8', timeout: 5000, cwd: TMP,
    });
    eq(r.status, 0, 'rc 0');
    assert(r.stdout.includes('backup:archive'), 'archive listed');
    assert(r.stdout.includes('backup:verify'), 'verify listed');
    assert(r.stdout.includes('backup:info'), 'YAML info still listed alongside');
  });
});

describe('[4] end-to-end: archive then verify', () => {
  it('archive writes a .tar.xz + .sha256 in output_dir', () => {
    const r = run('backup:archive');
    eq(r.status, 0, `rc 0 (stdout: ${r.stdout}; stderr: ${r.stderr})`);
    const archives = fs.readdirSync(path.join(TMP, 'archives'));
    const tarball = archives.find((f) => f.startsWith('snap-') && f.endsWith('.tar.xz'));
    assert(!!tarball, 'tar.xz file written');
    assert(archives.includes(`${tarball}.sha256`), 'sha256 sidecar written');
  });
  it('verify against the just-written archive succeeds', () => {
    const archives = fs.readdirSync(path.join(TMP, 'archives'));
    const tarball = archives.find((f) => f.startsWith('snap-') && f.endsWith('.tar.xz'));
    const r = run('backup:verify', `archives/${tarball}`);
    eq(r.status, 0, `verify rc 0 (stderr: ${r.stderr})`);
    assert(r.stdout.includes('OK') || r.stderr === '', 'sha256sum/shasum reports OK');
  });
  it('verify on a tampered archive fails', () => {
    const archives = fs.readdirSync(path.join(TMP, 'archives'));
    const tarball = archives.find((f) => f.startsWith('snap-') && f.endsWith('.tar.xz'));
    // Append junk to break the checksum without breaking the file (tar
    // would refuse to read it, but sha256 will mismatch first).
    fs.appendFileSync(path.join(TMP, 'archives', tarball), 'tampered\n');
    const r = run('backup:verify', `archives/${tarball}`);
    assert(r.status !== 0, 'verify rejects tampered archive (rc != 0)');
  });
});

report();
