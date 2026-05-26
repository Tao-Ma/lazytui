/**
 * docker-fs — `ls -lA --time-style=+%s` parser and the dockerList /
 * dockerReadBytes pipeline driven against a stub `spawn` impl so the
 * tests run anywhere (no docker daemon required).
 *
 * Run: node js/test/test-docker-fs.js
 */
'use strict';

const { EventEmitter } = require('events');
const { describe, it, eq, assert, section, report } = require('./test-runner');

const {
  dockerList, dockerReadBytes, _parseLsLine,
} = require('../docker-fs');

// ---- spawn stub ---------------------------------------------------

/**
 * Build a fake child_process.spawn that pre-queues stdout/stderr/exit
 * for each invocation. Pass an array of `{ stdout?, stderr?, code? }`
 * entries; calls consume them in order. After exhaustion, every call
 * returns code 0 with empty stdout.
 */
function stubSpawn(queue) {
  let i = 0;
  return function spawnStub(cmd, args /*, opts*/) {
    const next = queue[i++] || { stdout: '', stderr: '', code: 0 };
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    // Replay on the next tick so listeners are attached first.
    setImmediate(() => {
      if (next.stdout) proc.stdout.emit('data',
        Buffer.isBuffer(next.stdout) ? next.stdout : Buffer.from(next.stdout));
      if (next.stderr) proc.stderr.emit('data', Buffer.from(next.stderr));
      proc.emit('close', next.code != null ? next.code : 0);
    });
    proc._cmd = cmd; proc._args = args;
    return proc;
  };
}

// ---- _parseLsLine -------------------------------------------------

describe('[1] _parseLsLine', () => {
  it('parses a regular file row', () => {
    const r = _parseLsLine('-rw-r--r-- 1 postgres postgres  4096 1700000000 postgresql.conf');
    eq(r.kind, 'file');
    eq(r.name, 'postgresql.conf');
    eq(r.size, 4096);
    eq(r.mtime, 1700000000 * 1000);
  });
  it('parses a directory row', () => {
    const r = _parseLsLine('drwx------ 5 postgres postgres   4096 1700000123 base');
    eq(r.kind, 'dir');
    eq(r.name, 'base');
  });
  it('parses a symlink, stripping the `-> target` suffix', () => {
    const r = _parseLsLine('lrwxrwxrwx 1 root root 7 1700000000 foo -> /tmp/foo');
    eq(r.kind, 'symlink');
    eq(r.name, 'foo');
  });
  it('preserves spaces in the name', () => {
    const r = _parseLsLine('-rw-r--r-- 1 u g 12 1700000000 my notes.txt');
    eq(r.name, 'my notes.txt');
    eq(r.size, 12);
  });
  it('returns null for the leading `total N` summary', () => {
    eq(_parseLsLine('total 24'), null);
  });
  it('returns null for blank input', () => {
    eq(_parseLsLine(''), null);
    eq(_parseLsLine(null), null);
  });
  it('skips bare `.` and `..` rows (defensive: -A excludes them)', () => {
    eq(_parseLsLine('drwxr-xr-x 2 u g 4096 1700000000 .'), null);
    eq(_parseLsLine('drwxr-xr-x 2 u g 4096 1700000000 ..'), null);
  });
});

// ---- dockerList ---------------------------------------------------

section('[2] dockerList with stub spawn');
(async () => {
  // --- happy path: lists dirs first, then files, sorted by name ----
  {
    const ls = [
      'total 8',
      'drwx------ 5 postgres postgres  4096 1700000000 base',
      '-rw------- 1 postgres postgres    88 1700000010 PG_VERSION',
      'drwx------ 2 postgres postgres  4096 1700000020 pg_wal',
      '-rw-r--r-- 1 postgres postgres 28000 1700000030 postgresql.conf',
      '',
    ].join('\n');
    const { items, error } = await dockerList('pg', '/var/lib/postgresql/data', {
      spawnImpl: stubSpawn([{ stdout: ls, code: 0 }]),
    });
    eq(error, null, 'no error');
    const names = items.map(i => i.name);
    // Dirs (sorted) come before files (sorted)
    eq(names[0], 'base');
    eq(names[1], 'pg_wal');
    eq(names[2], 'PG_VERSION');
    eq(names[3], 'postgresql.conf');
    // Paths are POSIX-joined to the cwd
    eq(items[3].path, '/var/lib/postgresql/data/postgresql.conf');
    eq(items[3].size, 28000);
  }

  // --- error path: non-zero exit surfaces stderr ------------------
  {
    const { items, error } = await dockerList('pg', '/nope', {
      spawnImpl: stubSpawn([{
        stdout: '', stderr: 'ls: cannot access /nope: No such file or directory\n', code: 2,
      }]),
    });
    eq(items.length, 0);
    assert(error && error.includes('No such file'),
      `error surfaced: ${error}`);
  }

  // --- error path: container not running --------------------------
  {
    const { items, error } = await dockerList('ghost', '/', {
      spawnImpl: stubSpawn([{
        stdout: '', stderr: 'Error: No such container: ghost\n', code: 1,
      }]),
    });
    eq(items.length, 0);
    assert(error && error.includes('No such container'));
  }

  // ---- dockerReadBytes ----
  {
    // stat → "12345\n"; head → 4-byte payload "PG\x00\x01"
    const payload = Buffer.from([0x50, 0x47, 0x00, 0x01]);
    const res = await dockerReadBytes('pg', '/var/lib/postgresql/data/PG_VERSION', 4, {
      spawnImpl: stubSpawn([
        { stdout: '12345\n', code: 0 },
        { stdout: payload, code: 0 },
      ]),
    });
    eq(res.totalSize, 12345);
    eq(res.buf.length, 4);
    assert(res.buf.equals(payload), 'buffer round-trips binary bytes');
    eq(res.truncated, true);
  }

  // dockerReadBytes: stat fails → totalSize falls back to buf.length
  {
    const payload = Buffer.from('hi');
    const res = await dockerReadBytes('pg', '/etc/foo', 1024, {
      spawnImpl: stubSpawn([
        { stdout: '', stderr: 'stat: not allowed', code: 1 },
        { stdout: payload, code: 0 },
      ]),
    });
    eq(res.totalSize, 2);
    eq(res.truncated, false);
  }

  // dockerReadBytes: head fails → throws
  {
    let threw = null;
    try {
      await dockerReadBytes('pg', '/etc/foo', 1024, {
        spawnImpl: stubSpawn([
          { stdout: '99', code: 0 },
          { stdout: '', stderr: 'head: cannot open', code: 1 },
        ]),
      });
    } catch (e) { threw = e; }
    assert(threw && /head: cannot open/.test(threw.message), 'read failure throws');
  }

  report();
})().catch(err => { console.error(err); process.exit(1); });
