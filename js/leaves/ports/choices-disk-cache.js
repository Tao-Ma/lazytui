/**
 * On-disk TTL cache for the completion helper's choices_cmd results.
 *
 * Context: the TUI's model-resident stale-while-refetch cache (Brief 3 of
 * v0.6.41, `model.choicesCache`) does not apply to `--complete` because
 * the helper is a one-shot process — every TAB press would otherwise
 * respawn `choices_cmd`, costing up to `COMPLETION_TIMEOUT_MAX_MS` on top
 * of helper boot. This leaf persists results between invocations so a
 * burst of TABs while composing one command line hits disk once.
 *
 * Shape:
 *   One JSON file per config under $XDG_CACHE_HOME/lazytui/complete/
 *   (fallback ~/.cache/…). Filename is sha1(realpath(configPath)) so two
 *   projects sharing a machine can't collide and symlinked YAMLs map to
 *   the same file.
 *   File body: { entries: { <key>: { items, labels, truncated, at } },
 *                order: [<key> MRU last] }.
 *   LRU bound: `cap` (default 64) via `put`; a long-lived shell can't
 *   grow it unbounded.
 *   Atomic write: tmp file + rename. A torn read of a half-written JSON
 *   by a concurrent TAB in another shell silently falls through to
 *   spawn — the `--complete` contract is absolute (always exit 0,
 *   nothing on stderr).
 *
 * Pure leaf for `get` / `put`; `readCache` / `writeCache` touch disk but
 * swallow every error — the caller never sees a throw.
 *
 * NOT used by the TUI: WAL replay would conflict with cross-process
 * state. The model.choicesCache stays authoritative there.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const DEFAULT_TTL_MS = 15000;
const DEFAULT_CAP = 64;

function _baseDir() {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = typeof xdg === 'string' && xdg.length > 0 && path.isAbsolute(xdg)
    ? xdg
    : path.join(os.homedir(), '.cache');
  return path.join(base, 'lazytui', 'complete');
}

/**
 * Absolute path of the cache file for `configPath`. Resolves the realpath
 * so two paths that symlink to the same config share one file; falls
 * back to the given path if realpath can't be taken (file missing, etc.
 * — the caller is already in a safe-fail path).
 */
function cachePathForConfig(configPath) {
  let real;
  try { real = fs.realpathSync(configPath); } catch (_) { real = configPath; }
  const sha = crypto.createHash('sha1').update(String(real)).digest('hex');
  return path.join(_baseDir(), `${sha}.json`);
}

/**
 * Read + parse the cache file for `configPath`. Returns `{entries, order}`
 * or null on ANY failure (missing file, torn JSON, bad types, permission
 * error). The caller treats null as a cold cache.
 */
function readCache(configPath) {
  try {
    const file = cachePathForConfig(configPath);
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const entries = (parsed.entries && typeof parsed.entries === 'object' && !Array.isArray(parsed.entries))
      ? parsed.entries : {};
    const order = Array.isArray(parsed.order) ? parsed.order.filter((k) => typeof k === 'string') : [];
    return { entries, order };
  } catch (_) {
    return null;
  }
}

/**
 * Write `state` for `configPath` atomically. Creates the dir if missing,
 * writes a tmp file with mode 0600, renames into place. Returns true on
 * success, false on ANY failure — caller never sees a throw.
 */
function writeCache(configPath, state) {
  try {
    const file = cachePathForConfig(configPath);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (_) { /* best-effort — mode flag may be dropped by umask on some fs */ }
    fs.renameSync(tmp, file);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Pure TTL-gated lookup. Returns the payload (`{items, labels, truncated, at}`)
 * when the entry exists and has age < ttlMs; null otherwise.
 */
function get(state, key, now, ttlMs) {
  if (!state || !key) return null;
  const entry = state.entries && state.entries[key];
  if (!entry) return null;
  const at = typeof entry.at === 'number' ? entry.at : 0;
  const limit = (typeof ttlMs === 'number' && ttlMs > 0) ? ttlMs : DEFAULT_TTL_MS;
  if (now - at >= limit) return null;
  return entry;
}

/**
 * Pure put — returns a NEW `{entries, order}` object (never mutates
 * input). LRU: when the result would exceed `cap`, the LRU-most keys
 * (order[0], order[1], …) are dropped. An update to an existing key
 * moves it to MRU; a new key appends. Payload is stamped with `at: now`.
 */
function put(state, key, payload, now, cap) {
  const limit = (typeof cap === 'number' && cap > 0) ? cap : DEFAULT_CAP;
  const prev = state && typeof state === 'object' ? state : { entries: {}, order: [] };
  const prevEntries = prev.entries || {};
  const prevOrder = (prev.order || []).filter((k) => k !== key && k in prevEntries);
  prevOrder.push(key);
  const entries = { ...prevEntries, [key]: { ...(payload || {}), at: now } };
  while (prevOrder.length > limit) {
    const evicted = prevOrder.shift();
    delete entries[evicted];
  }
  return { entries, order: prevOrder };
}

module.exports = {
  cachePathForConfig, readCache, writeCache, get, put,
  DEFAULT_TTL_MS, DEFAULT_CAP,
};
