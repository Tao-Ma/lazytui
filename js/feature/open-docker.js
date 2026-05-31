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
const { dockerReadBytes, listRunningContainers } = require('./docker-fs');
const { addContentTab, updateContentTabLines } = require('../panel/viewer/tabs');
const { loadFile, DEFAULT_MAX_BYTES, DEFAULT_HEX_AFTER } = require('../io/file-loader');
const { esc } = require('../io/ansi');
const { getModel } = require('../app/runtime');
const openTarget = require('./open-target');

const DOCKER_PREFIX = /^docker:\/\/(.*)$/;
const REFRESH_INTERVAL_MS = 5000;

const _containerCache = { names: [], lastRefresh: 0, inflight: false };

function _maybeRefreshContainers() {
  if (_containerCache.inflight) return;
  const since = Date.now() - _containerCache.lastRefresh;
  if (_containerCache.lastRefresh > 0 && since < REFRESH_INTERVAL_MS) return;
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
  // Path-in-container — deferred. Echo a single hint entry so the user
  // sees the URI is being claimed by the docker scheme and that Enter
  // will open the typed path.
  const absPath = parsed.path;
  const target = `docker://${parsed.container}${absPath}`;
  return [{
    display: `open ${target}`,
    desc: `[docker:${parsed.container}] press Enter to open`,
    kind: 'path',
    argComplete: true,
    run: () => { openTarget.openInput(target); },
  }];
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
  open: (target, opts) => {
    if (!target || !target.container || target.path === null) return;
    dockerOpenFileAsTab(target.container, target.path, opts);
  },
});

// Kick off the initial container probe so the first `:open docker://`
// has names available without waiting.
_maybeRefreshContainers();

module.exports = {
  dockerOpenFileAsTab, dockerComplete,
  // Exposed for tests
  _parseDockerUri, _containerCache,
};
