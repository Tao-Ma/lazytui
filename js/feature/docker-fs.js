/**
 * Docker-aware filesystem adapter for the `files` panel and content
 * tabs. Shells out to `docker exec <container> ...` for listing and
 * bounded reads, so the user can browse paths inside a running
 * container without bind-mounting.
 *
 * Surface:
 *   dockerList(container, cwd)            → Promise<{ items, error }>
 *   dockerReadBytes(container, path, max) → Promise<{ buf, totalSize, truncated }>
 *
 * Items use the same normalized shape as the local source:
 *   { kind: 'dir'|'file'|'symlink', name, path, size, mtime }
 * `parent` rows are NOT produced here — files.js appends them so the
 * "first row" decision stays in one place.
 *
 * Read strategy: `stat -c %s` for total size, then `head -c <max>` for
 * a binary-safe capped read. Two short execs (~50–200ms each on a
 * warm daemon); avoids `dd bs=1` which is a syscall-per-byte hog.
 *
 * Compatible with GNU coreutils (Debian, Ubuntu, Alpine with busybox
 * has `-c` on head and `-c %s` on stat too). Falls back to buf.length
 * when stat fails, so truncation may underreport on exotic targets.
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_LIST_TIMEOUT_MS = 5000;
const DEFAULT_READ_TIMEOUT_MS = 10000;

/**
 * Run `docker exec <container> <args...>` and capture stdout as a
 * Buffer (binary-safe). Resolves to { ok, stdout?, error? } — never
 * rejects, so callers can treat container-down / exec-failed exactly
 * like a permission-denied on local FS.
 *
 * Pluggable `spawnImpl` for tests — pass a stub that mimics the
 * node child_process.spawn API.
 */
function _dockerExec(container, args, { timeout, spawnImpl } = {}) {
  const sp = spawnImpl || spawn;
  return new Promise((resolve) => {
    let proc;
    try {
      proc = sp('docker', ['exec', container, ...args], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve({ ok: false, error: err.message });
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let killed = false;
    const to = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    }, timeout || DEFAULT_LIST_TIMEOUT_MS);
    proc.stdout.on('data', c => stdoutChunks.push(c));
    proc.stderr.on('data', c => stderrChunks.push(c));
    proc.on('error', err => {
      clearTimeout(to);
      resolve({ ok: false, error: err.message });
    });
    proc.on('close', (code) => {
      clearTimeout(to);
      if (killed) return resolve({ ok: false, error: 'docker exec timed out' });
      const stdout = Buffer.concat(stdoutChunks);
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        return resolve({ ok: false, error: stderr.trim() || `docker exec exited ${code}` });
      }
      resolve({ ok: true, stdout, stderr });
    });
  });
}

/**
 * Parse one `ls -lA --time-style=+%s` row into a normalized item, or
 * null if the line isn't a recognizable entry (e.g. the leading
 * `total 0` summary line or a blank tail).
 *
 * Row shape (7 fields plus name, which may contain spaces):
 *   drwxr-xr-x 2 postgres postgres 4096 1748293812 base
 *   lrwxrwxrwx 1 root     root        7 1700000000 foo -> /tmp/foo
 *
 * Symlink rows include " -> target" after the name — strip the arrow
 * suffix so the displayed name is just the link's own name.
 */
function _parseLsLine(line) {
  if (!line) return null;
  if (line.startsWith('total ')) return null;
  // Split into up to 7 fields so the name retains any embedded spaces.
  // Format is space-separated with single or multiple spaces (GNU ls
  // pads columns). Use a regex to take exactly 6 leading fields, then
  // the remainder is the name.
  const m = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+)$/);
  if (!m) return null;
  const perms = m[1];
  const size = parseInt(m[5], 10);
  const mtimeSec = parseInt(m[6], 10);
  let name = m[7];
  let kind = 'file';
  if (perms[0] === 'd') kind = 'dir';
  else if (perms[0] === 'l') {
    kind = 'symlink';
    const arrow = name.indexOf(' -> ');
    if (arrow >= 0) name = name.slice(0, arrow);
  }
  // Skip self/parent (shouldn't appear with -A, but defensive).
  if (name === '.' || name === '..') return null;
  return {
    kind, name,
    size:  isNaN(size) ? 0 : size,
    mtime: isNaN(mtimeSec) ? 0 : mtimeSec * 1000,
  };
}

/**
 * List a container directory. Returns { items, error }. On error,
 * items is [] and error is a non-empty string — the caller is
 * expected to surface it via state.lastError, same as local
 * readdir failures.
 */
async function dockerList(container, cwd, opts = {}) {
  const res = await _dockerExec(container, [
    'ls', '-lA', '--time-style=+%s', '--', cwd,
  ], { timeout: opts.timeout || DEFAULT_LIST_TIMEOUT_MS, spawnImpl: opts.spawnImpl });
  if (!res.ok) return { items: [], error: res.error };

  const dirs = [];
  const files = [];
  const text = res.stdout.toString('utf8');
  for (const ln of text.split('\n')) {
    const parsed = _parseLsLine(ln);
    if (!parsed) continue;
    const full = path.posix.join(cwd, parsed.name);
    const entry = { ...parsed, path: full };
    (parsed.kind === 'dir' ? dirs : files).push(entry);
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { items: dirs.concat(files), error: null };
}

/**
 * Read up to `maxBytes` from a container file path. Returns
 *   { buf, totalSize, truncated }
 * Throws on exec failure so the file-loader's existing error path
 * surfaces the message in the content tab (parallel to local
 * _readCapped semantics).
 */
async function dockerReadBytes(container, absPath, maxBytes, opts = {}) {
  const spawnImpl = opts.spawnImpl;
  // 1. Total size (best-effort; falls back to buf length if missing).
  const sizeRes = await _dockerExec(container, ['stat', '-c', '%s', '--', absPath],
    { timeout: opts.listTimeout || DEFAULT_LIST_TIMEOUT_MS, spawnImpl });
  let totalSize = -1;
  if (sizeRes.ok) {
    const n = parseInt(sizeRes.stdout.toString('utf8').trim(), 10);
    if (!isNaN(n) && n >= 0) totalSize = n;
  }

  // 2. Binary-safe capped read.
  const readRes = await _dockerExec(container, ['head', '-c', String(maxBytes), '--', absPath],
    { timeout: opts.readTimeout || DEFAULT_READ_TIMEOUT_MS, spawnImpl });
  if (!readRes.ok) throw new Error(readRes.error);
  const buf = readRes.stdout;
  if (totalSize < 0) totalSize = buf.length;
  return { buf, totalSize, truncated: totalSize > buf.length };
}

/**
 * List names of currently running docker containers via `docker ps`.
 * Returns Promise<string[]> — empty array on error (daemon down, docker
 * not installed). Never rejects.
 *
 * Used by the docker open-target scheme (feature/open-docker.js) to
 * power `:open docker://<TAB>` container-name completion. Throttled
 * caching lives in the consumer; this is a bare-metal probe.
 */
function listRunningContainers(opts = {}) {
  const { spawn } = require('child_process');
  const sp = opts.spawnImpl || spawn;
  return new Promise((resolve) => {
    let proc;
    try {
      proc = sp('docker', ['ps', '--format', '{{.Names}}'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      return resolve([]);
    }
    const chunks = [];
    let killed = false;
    const to = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch { /* already dead */ }
    }, opts.timeout || DEFAULT_LIST_TIMEOUT_MS);
    proc.stdout.on('data', c => chunks.push(c));
    proc.stderr.on('data', () => { /* suppressed — silent on failure */ });
    proc.on('error', () => { clearTimeout(to); resolve([]); });
    proc.on('close', (code) => {
      clearTimeout(to);
      if (killed || code !== 0) return resolve([]);
      const names = Buffer.concat(chunks).toString('utf8').split('\n')
        .map(s => s.trim()).filter(Boolean);
      resolve(names);
    });
  });
}

module.exports = {
  dockerList,
  dockerReadBytes,
  listRunningContainers,
  // Exposed for tests
  _parseLsLine,
  DEFAULT_LIST_TIMEOUT_MS, DEFAULT_READ_TIMEOUT_MS,
};
