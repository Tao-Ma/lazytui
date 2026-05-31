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
    eq(a.verify.args, '<archive-file>', 'verify documents its arg');
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
