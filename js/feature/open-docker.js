/**
 * Docker open-target scheme — `:open docker://<container>/<path>`.
 *
 * Registered on the open-target registry (Phase A) so `:open` routes any
 * `docker://…` URI through this module while still handling host paths
 * via feature/open-file.js. Phase B of the open-target arc.
 *
 * URI shape: `docker://<container>/<path>` (URL-style). The first `/`
 * after `docker://` separates container from path; everything before is
 * the container name, everything from that slash onward (including the
 * slash) is the absolute path inside the container.
 *
 * Completion scope (v1): container names ONLY. Tab on `docker://<prefix>`
 * narrows to containers matching `<prefix>`; Tab on a single matching
 * container completes to `docker://<name>/`. Path-in-container
 * completion is deferred — each directory requires an async
 * `docker exec ls`, which the sync argComplete contract doesn't easily
 * accommodate without a slice-based loading-state cache (Phase B' if we
 * want it later). For now, the user types the path manually after the
 * container.
 *
 * Container cache: refreshed at module load and again on every
 * `dockerComplete()` call, throttled to REFRESH_INTERVAL_MS so rapid
 * typing doesn't spam `docker ps`. Stale or empty cache → no
 * completions show; user can wait a second and Tab again.
 *
 * Reads: `dockerReadBytes` from feature/docker-fs (the same plumbing
 * the files panel uses). Tab key is `docker:<container>:<absPath>`,
 * matching the files-panel key so cached content shares across open
 * paths.
 */
'use strict';

const path = require('path');
const { dockerList, dockerReadBytes, listRunningContainers } = require('./docker-fs');
const { addContentTab, updateContentTabLines } = require('../panel/viewer/tabs');
const { loadFile, DEFAULT_MAX_BYTES, DEFAULT_HEX_AFTER } = require('../io/file-loader');
const { esc } = require('../io/ansi');
const { getModel } = require('../app/runtime');
const openTarget = require('./open-target');

const DOCKER_PREFIX = /^docker:\/\/(.*)$/;
const REFRESH_INTERVAL_MS = 5000;

const _containerCache = { names: [], lastRefresh: 0, inflight: false };

/** Sync probe — used on FIRST completion call so the user doesn't hit
 *  an empty cache while the async probe is still in flight. Blocks for
 *  up to ~1.5s if the daemon is slow; subsequent calls use async refresh. */
function _syncProbe() {
  try {
    const { execSync } = require('child_process');
    const out = execSync('docker ps --format "{{.Names}}"', {
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    _containerCache.names = out.split('\n').map(s => s.trim()).filter(Boolean);
    _containerCache.lastRefresh = Date.now();
  } catch { /* daemon down / docker missing — leave cache empty */ }
}

function _maybeRefreshContainers() {
  // First call after boot — sync to guarantee the cache is populated
  // before this rebuildMatches returns. Eliminates the async-race the
  // initial async probe had on a cold daemon.
  if (_containerCache.lastRefresh === 0) { _syncProbe(); return; }
  if (_containerCache.inflight) return;
  const since = Date.now() - _containerCache.lastRefresh;
  if (since < REFRESH_INTERVAL_MS) return;
  _containerCache.inflight = true;
  listRunningContainers().then(names => {
    _containerCache.names = names;
    _containerCache.lastRefresh = Date.now();
    _containerCache.inflight = false;
  }).catch(() => {
    _containerCache.lastRefresh = Date.now();
    _containerCache.inflight = false;
  });
}

/** Parse `docker://<container>[/<path>]`. Returns {container, path}
 *  where `path === null` means the user hasn't typed the container/path
 *  separator yet (still completing the container name). */
function _parseDockerUri(input) {
  const m = String(input).match(DOCKER_PREFIX);
  if (!m) return null;
  const rest = m[1];
  const slash = rest.indexOf('/');
  if (slash < 0) return { container: rest, path: null };
  return { container: rest.slice(0, slash), path: rest.slice(slash) || '/' };
}

/** Container-name completion. Returns render-safe match entries. */
function _completeContainers(prefix) {
  const lc = prefix.toLowerCase();
  return _containerCache.names
    .filter(n => n.toLowerCase().startsWith(lc))
    .sort()
    .map(name => ({
      display: `open docker://${name}/`,
      desc: '[container]',
      kind: 'path',
      argComplete: true,
      // Enter on a bare container name doesn't open anything — user
      // needs to type the in-container path. The directory case in
      // hostComplete bails the same way.
      run: () => { /* refine further */ },
    }));
}

function dockerComplete(input) {
  // Kick a (throttled) cache refresh — first call after boot, or
  // 5s+ since last refresh. Returns sync result from the current cache.
  _maybeRefreshContainers();
  const parsed = _parseDockerUri(input);
  if (!parsed) return [];
  if (parsed.path === null) return _completeContainers(parsed.container);
  return _completePath(parsed.container, parsed.path);
}

// Path-in-container completion. Cache is module-local:
//   _dirCache[`${container}:${dir}`]  = items[]   (success)
//                                     = null      (fetch failed)
//                                     = undefined (not yet fetched)
// Fetches are async (docker exec ls). First request shows a `[loading…]`
// hint entry; when the fetch resolves we re-fire cmdline_rebuild so the
// dropdown picks up the cached entries. Cache has no TTL — restart
// lazytui to refresh stale listings (acceptable for v1).
const _dirCache = Object.create(null);
const _inflightFetches = new Set();

function _splitDirPrefix(fullPath) {
  if (fullPath.endsWith('/')) {
    return { dir: fullPath.slice(0, -1) || '/', prefix: '' };
  }
  const slash = fullPath.lastIndexOf('/');
  return {
    dir: slash <= 0 ? '/' : fullPath.slice(0, slash),
    prefix: fullPath.slice(slash + 1),
  };
}

function _kickFetch(container, dir) {
  const key = `${container}:${dir}`;
  if (_inflightFetches.has(key)) return;
  _inflightFetches.add(key);
  dockerList(container, dir).then(res => {
    _inflightFetches.delete(key);
    _dirCache[key] = (res && res.error) ? null : (res.items || []);
    _refireCmdlineRebuild();
  }).catch(() => {
    _inflightFetches.delete(key);
    _dirCache[key] = null;
    _refireCmdlineRebuild();
  });
}

/** Re-fire the cmdline_rebuild effect's logic so the dropdown picks
 *  up newly-cached completions. No-op when cmdline isn't open. Mirrors
 *  the registerEffect('cmdline_rebuild', …) handler in dispatch/effects.js. */
function _refireCmdlineRebuild() {
  const runtime = require('../app/runtime');
  if (!runtime.getModel().modes.cmdMode) return;
  const matches = require('../dispatch/cmdline').rebuild(runtime.getModel().modal.cmdline.text);
  require('../dispatch/dispatch').applyMsg({ type: 'cmdline_set_matches', matches });
  require('../render/render-queue').scheduleRender();
}

function _completePath(container, fullPath) {
  const { dir, prefix } = _splitDirPrefix(fullPath);
  const key = `${container}:${dir}`;
  const cached = _dirCache[key];

  // Not fetched yet — kick + show loading hint
  if (cached === undefined) {
    _kickFetch(container, dir);
    return [{
      display: `open docker://${container}${fullPath}`,
      desc: `[loading ${dir}…]`,
      kind: 'hint',
      argComplete: true,
      run: () => {},
    }];
  }
  // Fetch failed (container down, permission denied, exotic FS) — fall
  // back to a single "Enter to open the typed path anyway" entry.
  if (cached === null) {
    const target = `docker://${container}${fullPath}`;
    return [{
      display: `open ${target}`,
      desc: `[failed to list ${dir}] press Enter to open this path anyway`,
      kind: 'hint',
      argComplete: true,
      run: () => { openTarget.openInput(target); },
    }];
  }

  // Cache hit — produce a completion per matching dir/file entry.
  const lcPrefix = prefix.toLowerCase();
  const sep = dir === '/' ? '' : dir;
  return cached
    .filter(e => e.name.toLowerCase().startsWith(lcPrefix))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    })
    .map(e => {
      const isDir = e.kind === 'dir';
      const newPath = `${sep}/${e.name}${isDir ? '/' : ''}`;
      const target = `docker://${container}${newPath}`;
      return {
        display: `open ${target}`,
        desc: isDir ? '[dir]' : '[file]',
        kind: 'path',
        argComplete: true,
        run: () => {
          if (!isDir) openTarget.openInput(target);
          // Directories: Enter is no-op — user should Tab to descend.
        },
      };
    });
}

/** Open `<absPath>` inside `<container>` as a content tab. Mirrors
 *  openHostFileAsTab; the only differences are the tab key + the
 *  readBytes function passed to loadFile. */
function dockerOpenFileAsTab(container, absPath, opts = {}) {
  const key = `docker:${container}:${absPath}`;
  const label = opts.label || path.posix.basename(absPath) || absPath;
  const originGroup = getModel().currentGroup;
  const loadingLabel = `[dim]Loading ${esc(container)}:${esc(absPath)}…[/]`;
  addContentTab(originGroup, key, label, [loadingLabel]);

  const loadOpts = {
    maxBytes: opts.maxBytes || DEFAULT_MAX_BYTES,
    hexAfter: opts.hexAfter || DEFAULT_HEX_AFTER,
    readBytes: (p, n) => dockerReadBytes(container, p, n),
  };
  loadFile(absPath, loadOpts).then(result => {
    updateContentTabLines(originGroup, key, result.lines);
    require('../render/render-queue').scheduleRender();
  }).catch(err => {
    updateContentTabLines(originGroup, key, [
      '[red]Failed to load:[/]', '', `[dim]${esc(err.message)}[/]`,
    ]);
    require('../render/render-queue').scheduleRender();
  });
}

// Register the docker scheme. match() claims any input starting with
// `docker://` (including incomplete ones — `docker://abc` while the user
// is still typing the container name) so completion can route through.
// open() validates: a partial URI without container/path can't be opened
// and is a silent no-op (the cmdline closes; user sees nothing happen).
openTarget.registerOpenScheme('docker', {
  match: input => _parseDockerUri(input),
  complete: dockerComplete,
  // urlPrefix lets open-target's hint-injection logic surface this
  // scheme whenever the user types a prefix of `docker://`
  // (e.g. `d`, `dock`, `docker:`) — not just empty input.
  urlPrefix: 'docker://',
  hintEntry: () => ({
    display: 'open docker://',
    desc: '[docker container — Tab to list]',
    kind: 'hint',
    argComplete: true,
    run: () => { /* not runnable bare; user Tabs / types more */ },
  }),
  open: (target, opts) => {
    if (!target || !target.container || target.path === null) return;
    dockerOpenFileAsTab(target.container, target.path, opts);
  },
});

// Probe is now lazy (on first dockerComplete call) so we don't pay
// the docker-ps cost at boot for users who never `:open docker://`.

module.exports = {
  dockerOpenFileAsTab, dockerComplete,
  // Exposed for tests
  _parseDockerUri, _containerCache,
};
