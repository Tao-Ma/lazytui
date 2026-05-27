/**
 * config-status plugin — status-aware panel for declared config files.
 *
 * Reads `S.config.files` (the framework's existing top-level
 * registry of tracked paths) and presents them in a three-tab view
 * the user cycles with `]` / `[`:
 *
 *   0  File tree     — every declared path, grouped by `category:`
 *   1  Tracked tree  — the "tracked" subset, same hierarchy
 *   2  Tracked flat  — the "tracked" subset, flat list (for /-filter)
 *
 * Status badges per path:
 *
 *   ✓  matches branch        local present, branch present, content same
 *   *  differs               local present, branch present, content differs
 *   +  local-only            local present, branch missing — needs save
 *   !  branch-only           local missing, branch present — needs restore
 *   ?  unknown               neither side has it
 *
 * "Tracked" = any path the branch has a copy of (✓ * !). The local-only
 * (+) and unknown (?) buckets are excluded from the Tracked tabs.
 *
 * Comparison is on-demand: the first call to getItems with no cache
 * triggers refreshStatus, which mounts a temp worktree on the
 * configured branch and runs `git diff --no-index --quiet` per
 * declared path. `r` clears the cache, forcing a recompute on the
 * next getItems. Branch is read from the panel's `config.branch`
 * field in the layout YAML, with `config` as the default (matching
 * the config-branch plugin's default).
 *
 * Plugin contract: `name` + `panelTypes`. No `groupActions` hook.
 * Cache lives on `S.configStatusCache`; tab state on
 * `S.configStatusTab`; resolved branch on `S.configStatusBranch`
 * (set by render so getItems can pick it up without re-reading the
 * panel object).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  esc, theme, renderPanel,
  getScroll,
} = require('./api');

const TAB_FILE_TREE = 0;
const TAB_TRACKED_TREE = 1;
const TAB_TRACKED_FLAT = 2;
const TAB_LABELS = ['File tree', 'Tracked tree', 'Tracked flat'];

const STATUS_UNKNOWN = '?';
const STATUS_MATCHES = '✓';
const STATUS_DIFFERS = '*';
const STATUS_LOCAL_ONLY = '+';
const STATUS_BRANCH_ONLY = '!';
const TRACKED = new Set([STATUS_MATCHES, STATUS_DIFFERS, STATUS_BRANCH_ONLY]);

const DEFAULT_BRANCH = 'config';

// Pagination: each declared directory shows this many of its files
// before a "... N more" expand row appears. Pressing Enter on that
// row reveals another batch. Tracked subset (by status filter) hides
// the expand row — pagination is a filesystem-walk concept, not a
// status-filter one.
const WALK_LIMIT = 10;

// --- tab state on S ---

function tabIdx(S) {
  const t = S.configStatusTab;
  return (typeof t === 'number' && t >= 0 && t < TAB_LABELS.length) ? t : 0;
}

function cycleTab(S, delta) {
  S.configStatusTab = ((tabIdx(S) + delta) % TAB_LABELS.length + TAB_LABELS.length) % TAB_LABELS.length;
}

// --- status comparison ---

/**
 * Walk a local directory recursively, returning project-relative
 * file paths. Honors the same `exclude:` patterns the schema accepts
 * on `files:` entries (substring match — keep it simple).
 */
function walkRecursive(absRoot, projectDir, excludes) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (excludes.some((p) => full.includes(p))) continue;
      if (e.isDirectory()) visit(full);
      else if (e.isFile() || e.isSymbolicLink()) {
        out.push(path.relative(projectDir, full));
      }
    }
  };
  visit(absRoot);
  out.sort();
  return out;
}

/**
 * Mount a worktree on `branch` (relative to `projectDir`) and compare
 * each declared path. For dir entries, walks the local tree and caches
 * per-file status alongside the dir's aggregate status. Returns the
 * cache object on S.configStatusCache.
 *
 * Cache shape:
 *   { branch, byPath: { <path>: <status> },
 *     children: { <declaredPath>: [<sub-relative-paths>] },
 *     error?, computedAt }
 *
 * Spawns git synchronously — fine for ~tens of declared paths and a
 * few hundred sub-files. If the branch doesn't exist locally / on
 * origin, every declared path gets `?` and cache.error captures it.
 */
function refreshStatus(S, opts) {
  const cf = (S.config && S.config.files) || [];
  const branch = (opts && opts.branch) || S.configStatusBranch || DEFAULT_BRANCH;
  const projectDir = (opts && opts.projectDir) || S.projectDir || '.';

  const cache = { branch, byPath: {}, children: {}, computedAt: Date.now() };

  if (cf.length === 0) {
    S.configStatusCache = cache;
    return cache;
  }

  // Verify branch exists locally; if not, mark all paths unknown and bail.
  const refCheck = spawnSync('git', ['rev-parse', '--verify', branch], {
    cwd: projectDir, stdio: 'pipe',
  });
  if (refCheck.status !== 0) {
    cache.error = `branch "${branch}" does not exist`;
    for (const e of cf) {
      cache.byPath[e.path] = STATUS_UNKNOWN;
      cache.children[e.path] = [];
    }
    S.configStatusCache = cache;
    return cache;
  }

  // Mount a temp worktree on the branch — gives us a real on-disk view
  // we can `git diff --no-index` against. Cleaned up at the end.
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'config-status-wt-'));
  const add = spawnSync('git', ['worktree', 'add', wt, branch, '--quiet'], {
    cwd: projectDir, stdio: 'pipe',
  });
  if (add.status !== 0) {
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch (_) {}
    cache.error = `worktree add failed: ${(add.stderr || '').toString().trim()}`;
    for (const e of cf) {
      cache.byPath[e.path] = STATUS_UNKNOWN;
      cache.children[e.path] = [];
    }
    S.configStatusCache = cache;
    return cache;
  }

  try {
    for (const e of cf) {
      // Always cache the declared path's aggregate status (used by
      // tabs that don't expand and for the leaf-file case).
      cache.byPath[e.path] = compareOne(e.path, projectDir, wt);

      // If declared path is a local directory, fan out. Sub-files get
      // their own per-path status entries in the cache; the children
      // index lets buildItems paginate through them on demand.
      const fullLocal = path.resolve(projectDir, e.path);
      let stat;
      try { stat = fs.statSync(fullLocal); } catch (_) { stat = null; }
      if (stat && stat.isDirectory()) {
        const subs = walkRecursive(fullLocal, projectDir, e.exclude || []);
        for (const sub of subs) {
          if (!(sub in cache.byPath)) {
            cache.byPath[sub] = compareOne(sub, projectDir, wt);
          }
        }
        cache.children[e.path] = subs;
      } else {
        cache.children[e.path] = [];
      }
    }
  } finally {
    spawnSync('git', ['worktree', 'remove', wt, '--force'], {
      cwd: projectDir, stdio: 'pipe',
    });
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch (_) {}
  }

  S.configStatusCache = cache;
  return cache;
}

function compareOne(declared, projectDir, worktree) {
  const local = path.resolve(projectDir, declared);
  const inBranch = path.resolve(worktree, declared);
  const localExists = fs.existsSync(local);
  const branchExists = fs.existsSync(inBranch);

  if (localExists && branchExists) {
    // git diff --no-index --quiet returns 0 if same, 1 if differ. Works
    // for files and (recursively) for directories, so a single call
    // covers both leaf paths and dir-prefix declarations like "client/".
    const d = spawnSync('git', ['diff', '--no-index', '--quiet', '--', local, inBranch], {
      stdio: 'pipe',
    });
    return d.status === 0 ? STATUS_MATCHES : STATUS_DIFFERS;
  }
  if (localExists) return STATUS_LOCAL_ONLY;
  if (branchExists) return STATUS_BRANCH_ONLY;
  return STATUS_UNKNOWN;
}

/**
 * Return every child path for a declared entry. Leaf (file) entries
 * yield a single-item list with the declared path itself; declared
 * directories yield the full walked children list. Pagination is
 * applied downstream in _byCategory (and only when no predicate
 * filter is active — status filtering shouldn't be capped).
 */
function expandEntry(entry, S) {
  const cache = S.configStatusCache || {};
  const children = (cache.children && cache.children[entry.path]) || [];
  if (children.length === 0) {
    return { items: [{ path: entry.path }], total: 1 };
  }
  return {
    items: children.map((p) => ({ path: p })),
    total: children.length,
  };
}

function paginate(entry, items, S) {
  // Apply WALK_LIMIT (default) or the user's expanded count for this
  // entry. Returns { shown, more? }. Pagination only applies when
  // expandEntry produced multiple items (i.e. it's a real directory).
  if (items.length <= 1) return { shown: items, more: null };
  const limit = (S.configStatusExpanded && S.configStatusExpanded[entry.path]) || WALK_LIMIT;
  if (items.length <= limit) return { shown: items, more: null };
  const shown = items.slice(0, limit);
  return {
    shown,
    more: { kind: 'more', declaredPath: entry.path, shown: shown.length, total: items.length },
  };
}

function statusFor(S, p) {
  const cache = S.configStatusCache;
  if (!cache || !cache.byPath) return STATUS_UNKNOWN;
  return cache.byPath[p] || STATUS_UNKNOWN;
}

/** Resolve the branch from the config-status panel's `config.branch`
 *  (the authoritative source), independent of whether render() has run
 *  yet — the deferred cache build can fire before the first paint. */
function _resolveBranch(S) {
  const panels = (S.layout && [...(S.layout.leftPanels || []), ...(S.layout.rightPanels || [])]) || [];
  const p = panels.find(pp => pp.type === 'config-status');
  const b = p && p.config && p.config.branch;
  if (typeof b === 'string' && b) return b;
  return S.configStatusBranch || DEFAULT_BRANCH;
}

/**
 * Schedule the (blocking) git status computation OFF the render path.
 * render()/getItems must stay side-effect-free and cheap (PRINCIPLES
 * §11) — they used to call refreshStatus() inline, spawning a git
 * worktree synchronously on the first paint and freezing input. Now the
 * first render shows a "computing…" placeholder and the work runs on a
 * deferred tick, re-painting when the cache lands. A computing-guard
 * prevents piling up duplicate runs across the frames shown while it's
 * in flight.
 */
function _kickCache(S, force) {
  if (S._configStatusComputing) return;
  if (S.configStatusCache && !force) return;
  S._configStatusComputing = true;
  setImmediate(() => {
    try { refreshStatus(S, { branch: _resolveBranch(S) }); }
    catch (_) { /* refreshStatus records git failures in cache.error */ }
    finally {
      S._configStatusComputing = false;
      try { require('./api').scheduleRender(); } catch (_) { /* no renderer (tests) */ }
    }
  });
}

// --- item builders ---

function _categorize(cf) {
  const groups = {};
  for (const e of cf) {
    const cat = e.category || 'uncategorized';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(e);
  }
  // Sort: secret → config → everything else alphabetical → uncategorized last
  const PRI = { secret: 0, config: 1, uncategorized: 99 };
  const cats = Object.keys(groups).sort((a, b) => {
    const ai = PRI[a] !== undefined ? PRI[a] : 50;
    const bi = PRI[b] !== undefined ? PRI[b] : 50;
    return ai !== bi ? ai - bi : a.localeCompare(b);
  });
  return { groups, cats };
}

function _byCategory(cf, S, predicate) {
  const { groups, cats } = _categorize(cf);
  const out = [];
  for (const cat of cats) {
    const catRows = [];
    let fileCount = 0;
    for (const e of groups[cat]) {
      const expanded = expandEntry(e, S);
      // Apply pagination ONLY when there's no predicate — status
      // filtering should never be artificially capped.
      const sliced = predicate ? { shown: expanded.items, more: null } : paginate(e, expanded.items, S);
      const fileRows = sliced.shown.map((f) => ({
        kind: 'file',
        path: f.path,
        category: cat,
        status: statusFor(S, f.path),
        declaredPath: e.path,
        desc: e.desc,
      }));
      const filtered = predicate ? fileRows.filter((r) => predicate(r.status)) : fileRows;
      if (filtered.length === 0 && !sliced.more) continue;
      catRows.push(...filtered);
      fileCount += filtered.length;
      if (sliced.more) catRows.push({ ...sliced.more, category: cat });
    }
    if (catRows.length === 0) continue;
    out.push({ kind: 'header', cat, count: fileCount });
    out.push(...catRows);
  }
  return out;
}

function _flatTracked(cf, S) {
  const items = [];
  for (const e of cf) {
    const expanded = expandEntry(e, S);
    // No pagination in tracked-flat: the user explicitly asked for the
    // full tracked set in one screenful.
    for (const f of expanded.items) {
      const status = statusFor(S, f.path);
      if (!TRACKED.has(status)) continue;
      items.push({
        kind: 'file',
        path: f.path,
        category: e.category || 'uncategorized',
        status,
        declaredPath: e.path,
        desc: e.desc,
      });
    }
  }
  // Flat sort: by path, A→Z. The category-grouping disappears in this view —
  // it's the "scan everything in one screenful" mode.
  items.sort((a, b) => a.path.localeCompare(b.path));
  return items;
}

function buildItems(S) {
  const cf = (S.config && S.config.files) || [];
  if (cf.length === 0) {
    return [{ kind: 'note', text: 'no files declared in YAML' }];
  }
  // No cache yet → kick the (deferred, off-render) computation and show
  // a placeholder this frame. The deferred run scheduleRenders when done.
  if (!S.configStatusCache) {
    _kickCache(S);
    return [{ kind: 'note', text: 'computing config status…' }];
  }
  const cache = S.configStatusCache || {};
  const head = [];
  if (cache.error) head.push({ kind: 'note', text: cache.error });

  const tab = tabIdx(S);
  if (tab === TAB_FILE_TREE) return [...head, ..._byCategory(cf, S, null)];
  if (tab === TAB_TRACKED_TREE) {
    const items = _byCategory(cf, S, (s) => TRACKED.has(s));
    if (items.length === 0) return [...head, { kind: 'note', text: 'no tracked paths (try `r` to refresh)' }];
    return [...head, ...items];
  }
  // TAB_TRACKED_FLAT
  const items = _flatTracked(cf, S);
  if (items.length === 0) return [...head, { kind: 'note', text: 'no tracked paths (try `r` to refresh)' }];
  return [...head, ...items];
}

// --- render helpers ---

function rowText(item, isSelected) {
  if (!item) return '';
  // Selected rows are plain text inside [reverse] (PRINCIPLES.md §8 —
  // any inner markup kills the reverse). Reset is added by the panel
  // renderer before the right border, so we leave it open.
  if (item.kind === 'header') {
    if (isSelected) return `[${theme().selected}]${esc(item.cat)} (${item.count})`;
    return `[bold]${esc(item.cat)} (${item.count})[/]`;
  }
  if (item.kind === 'note') {
    if (isSelected) return `[${theme().selected}]${esc(item.text)}`;
    return `[dim]${esc(item.text)}[/]`;
  }
  if (item.kind === 'more') {
    const remaining = item.total - item.shown;
    const text = `... ${remaining} more (Enter to show ${Math.min(remaining, WALK_LIMIT)})`;
    if (isSelected) return `[${theme().selected}]  ${text}`;
    return `[dim]  ${text}[/]`;
  }
  // file row
  if (isSelected) return `[${theme().selected}]  ${item.status}  ${esc(item.path)}`;
  return `  ${item.status}  ${esc(item.path)}`;
}

function render(panel, w, h) {
  const { S } = require('../state');
  // Panel extras live at the top of the panel entry (per the parser's
  // _extras helper) — `branch:` lands in panel.config.branch.
  const cfg = (panel && panel.config) || {};
  if (typeof cfg.branch === 'string' && cfg.branch) {
    S.configStatusBranch = cfg.branch;
  } else if (!S.configStatusBranch) {
    S.configStatusBranch = DEFAULT_BRANCH;
  }

  const items = buildItems(S);
  const sel = require('./api').getSel('config-status');
  const focused = S.focus === 'config-status';
  const lines = items.map((item, i) => rowText(item, focused && i === sel));
  const title = `${panel.title || 'Config'} — ${TAB_LABELS[tabIdx(S)]}`;
  return renderPanel({
    width: w, height: h,
    title,
    panelType: 'config-status',
    lines,
    focused,
    hotkey: panel.hotkey,
    scrollOffset: getScroll('config-status'),
  });
}

function getItems(S) {
  return buildItems(S);
}

function getInfo(item) {
  if (!item) return [];
  if (item.kind === 'header') {
    return [`Category: ${item.cat}`, `Declared paths: ${item.count}`];
  }
  if (item.kind === 'note') {
    return [item.text];
  }
  const lines = [
    item.path,
    '',
    `category: ${item.category || 'uncategorized'}`,
    `status: ${item.status}`,
  ];
  if (item.desc) lines.push('', item.desc);
  return lines;
}

/**
 * Build the detail-panel preview for a file row. Status drives the
 * choice of representation:
 *
 *   ✓  matches branch        short note (no diff)
 *   *  differs                full diff (branch:path vs local)
 *   +  local-only             head of local file
 *   !  branch-only            head of branch:path content
 *   ?  unknown                short note
 *
 * Lines are returned as a string array suitable for assigning to
 * S.detailLines. Spawning git here is on-demand and synchronous; the
 * payloads are small enough (single-file diffs, head-of-content) that
 * it doesn't risk blocking the event loop in practice.
 */
function diffFor(item, S) {
  const projectDir = S.projectDir || '.';
  const branch = S.configStatusBranch || DEFAULT_BRANCH;
  const localAbs = path.resolve(projectDir, item.path);

  const header = [`[bold]${esc(item.path)}[/]`, ''];

  if (item.status === STATUS_MATCHES) {
    return [...header, `[green]${item.status} matches branch "${branch}" — no diff[/]`];
  }
  if (item.status === STATUS_UNKNOWN) {
    return [...header, `[dim]${item.status} declared but absent on both sides[/]`];
  }
  if (item.status === STATUS_LOCAL_ONLY) {
    let body;
    try { body = fs.readFileSync(localAbs, 'utf8'); } catch (e) { body = `(error reading: ${e.message})`; }
    const lines = body.split('\n').slice(0, 200);
    return [...header, `[bold]${item.status} local-only — branch has no copy[/]`, '', ...lines];
  }
  if (item.status === STATUS_BRANCH_ONLY) {
    const r = spawnSync('git', ['show', `${branch}:${item.path}`], { cwd: projectDir, encoding: 'utf8' });
    if (r.status !== 0) {
      return [...header, `[red](git show "${branch}:${item.path}" failed)[/]`, ...(r.stderr || '').split('\n')];
    }
    const lines = r.stdout.split('\n').slice(0, 200);
    return [...header, `[bold]${item.status} branch-only — local missing[/]`, '', ...lines];
  }
  // STATUS_DIFFERS — real diff. Materialize the branch's version into
  // a temp file, then `git diff --no-index` against the local copy
  // (same call shape we use for status comparison, just with the
  // output captured). Cleanup happens in finally.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-status-diff-'));
  const branchFile = path.join(tmp, 'branch');
  try {
    const sh = spawnSync('sh', ['-c', `git show '${branch}:${item.path}' > '${branchFile}'`], {
      cwd: projectDir, encoding: 'utf8',
    });
    if (sh.status !== 0) {
      return [...header, `[red](git show failed)[/]`, ...(sh.stderr || '').split('\n')];
    }
    // git diff --no-index: rc 0 = identical, rc 1 = differ. Both yield
    // valid stdout for our purposes (the latter being the diff itself).
    const d = spawnSync('git', ['diff', '--no-index', '--', branchFile, localAbs], { encoding: 'utf8' });
    const out = (d.stdout || '').split('\n');
    return [...header, `[bold]${item.status} differs — branch vs local[/]`, '', ...out];
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

function onKey(key, item, S) {
  if (key === ']') { cycleTab(S, +1); return true; }
  if (key === '[') { cycleTab(S, -1); return true; }
  if (key === 'r') {
    // Force-refresh: clear the cache and recompute OFF the keypress
    // path (the git worktree spawn would otherwise block the `r` press).
    // The deferred run scheduleRenders when the fresh cache lands.
    S.configStatusCache = null;
    _kickCache(S, true);
    return true;
  }
  if (key === 'return' && item && item.kind === 'more') {
    // Expand: show another WALK_LIMIT files for this declared dir.
    // Cap at total — once we've shown everything, the next render
    // simply omits the "more" row.
    if (!S.configStatusExpanded) S.configStatusExpanded = {};
    const current = S.configStatusExpanded[item.declaredPath] || WALK_LIMIT;
    S.configStatusExpanded[item.declaredPath] = Math.min(current + WALK_LIMIT, item.total);
    return true;
  }
  if (key === 'return' && item && item.kind === 'file') {
    // Drop a status-aware diff/preview into the detail panel.
    // Same convention as the docker plugin's `i` (inspect) — we
    // overwrite S.detailLines and reset the scroll. Detail panel
    // re-renders against this on next paint.
    S.detailLines = diffFor(item, S);
    S.detailScroll = 0;
    return true;
  }
  return false;
}

const panelType = {
  mode: 'list',
  render,
  getItems,
  getInfo,
  onKey,
  keyHints: '[ ] tabs | r refresh | ⏎ diff',
  filterable: true,
  filterText: (item) => {
    if (!item) return '';
    if (item.kind === 'file') return item.path;
    if (item.kind === 'header') return item.cat;
    return '';
  },
};

module.exports = {
  name: 'config-status',
  panelTypes: { 'config-status': panelType },
  // Exported for unit tests; not part of the public plugin contract.
  _tabIdx: tabIdx,
  _cycleTab: cycleTab,
  _buildItems: buildItems,
  _byCategory,
  _refreshStatus: refreshStatus,
  _statusFor: statusFor,
  _diffFor: diffFor,
  STATUS: {
    UNKNOWN: STATUS_UNKNOWN,
    MATCHES: STATUS_MATCHES,
    DIFFERS: STATUS_DIFFERS,
    LOCAL_ONLY: STATUS_LOCAL_ONLY,
    BRANCH_ONLY: STATUS_BRANCH_ONLY,
  },
  TAB_LABELS,
};
