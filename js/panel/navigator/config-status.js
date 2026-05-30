/**
 * config-status — status-aware panel for declared config files (Component API).
 *
 * Reads `S.config.files` and presents them in a three-tab view (`]`/`[`):
 *   0  File tree     — every declared path, grouped by `category:`
 *   1  Tracked tree  — the "tracked" subset, same hierarchy
 *   2  Tracked flat  — the "tracked" subset, flat list (for /-filter)
 *
 * Status badges: ✓ matches · * differs · + local-only · ! branch-only · ? unknown.
 * "Tracked" = the branch has a copy (✓ * !).
 *
 * Component (TEA) model — the panel's state lives in its SLICE, not on S:
 *   { tab, cache, branch, expanded, computing }
 * A `refresh` Msg (dispatched at boot + on `r`/`:refresh` by refreshAll — the
 * periodic loop does NOT, it calls plugin.refresh() directly) kicks the
 * `cfgStatusCompute` effect, which mounts a temp worktree on the configured
 * branch OFF-tick and dispatches `cfgStatusResult` with the cache; update()
 * folds it into the slice (effects can't write the slice). Enter on a file emits
 * `cfgStatusDiff` (git show/diff → the detail panel via setDetail). `]`/`[`/Enter
 * are handled in update(); claimsKeys suppresses the framework key defaults.
 * Branch comes from the panel's `config.branch` (default `config`).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  esc, theme, renderPanel,
  getScroll, getSel,
  getComponentSlice, getFocus,
} = require('../api');
const { registerEffect } = require('../../dispatch/effects');
const { getModel } = require('../../app/runtime');
const mnav = require('../../model/nav');

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
const WALK_LIMIT = 10;

// --- framework reads (app-global, read explicitly per the Component contract) ---

function _files()      { const c = getModel().config; return (c && c.files) || []; }
function _projectDir() { return getModel().projectDir || '.'; }

/** Resolve the branch from the config-status panel's `config.branch`. */
function _resolveBranch() {
  const slice = getComponentSlice('layout');
  const ly = slice && slice.arrange;
  const panels = (ly && [...(ly.leftPanels || []), ...(ly.rightPanels || [])]) || [];
  const p = panels.find(pp => pp.type === 'config-status');
  const b = p && p.config && p.config.branch;
  return (typeof b === 'string' && b) ? b : DEFAULT_BRANCH;
}

// --- slice helpers ---

function tabIdx(slice) {
  const t = slice && slice.tab;
  return (typeof t === 'number' && t >= 0 && t < TAB_LABELS.length) ? t : 0;
}

// --- status comparison (pure — no S, returns the cache) ---

/** Walk a local directory recursively → project-relative file paths. */
function walkRecursive(absRoot, projectDir, excludes) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (excludes.some((p) => full.includes(p))) continue;
      if (e.isDirectory()) visit(full);
      else if (e.isFile() || e.isSymbolicLink()) out.push(path.relative(projectDir, full));
    }
  };
  visit(absRoot);
  out.sort();
  return out;
}

/**
 * Mount a worktree on `branch` and compare each declared path. Pure: returns
 * the cache object, writes nothing to the model. Spawns git synchronously —
 * the caller runs this off the render/keypress tick (the cfgStatusCompute
 * effect).
 *
 * Cache shape: { branch, byPath:{path:status}, children:{declaredPath:[subs]},
 *                error?, computedAt }
 */
function computeStatus(branch, files, projectDir) {
  const cache = { branch, byPath: {}, children: {}, computedAt: Date.now() };
  if (!files.length) return cache;

  const refCheck = spawnSync('git', ['rev-parse', '--verify', branch], { cwd: projectDir, stdio: 'pipe' });
  if (refCheck.status !== 0) {
    cache.error = `branch "${branch}" does not exist`;
    for (const e of files) { cache.byPath[e.path] = STATUS_UNKNOWN; cache.children[e.path] = []; }
    return cache;
  }

  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'config-status-wt-'));
  const add = spawnSync('git', ['worktree', 'add', wt, branch, '--quiet'], { cwd: projectDir, stdio: 'pipe' });
  if (add.status !== 0) {
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch (_) {}
    cache.error = `worktree add failed: ${(add.stderr || '').toString().trim()}`;
    for (const e of files) { cache.byPath[e.path] = STATUS_UNKNOWN; cache.children[e.path] = []; }
    return cache;
  }

  try {
    for (const e of files) {
      cache.byPath[e.path] = compareOne(e.path, projectDir, wt);
      const fullLocal = path.resolve(projectDir, e.path);
      let stat;
      try { stat = fs.statSync(fullLocal); } catch (_) { stat = null; }
      if (stat && stat.isDirectory()) {
        const subs = walkRecursive(fullLocal, projectDir, e.exclude || []);
        for (const sub of subs) {
          if (!(sub in cache.byPath)) cache.byPath[sub] = compareOne(sub, projectDir, wt);
        }
        cache.children[e.path] = subs;
      } else {
        cache.children[e.path] = [];
      }
    }
  } finally {
    spawnSync('git', ['worktree', 'remove', wt, '--force'], { cwd: projectDir, stdio: 'pipe' });
    try { fs.rmSync(wt, { recursive: true, force: true }); } catch (_) {}
  }
  return cache;
}

function compareOne(declared, projectDir, worktree) {
  const local = path.resolve(projectDir, declared);
  const inBranch = path.resolve(worktree, declared);
  const localExists = fs.existsSync(local);
  const branchExists = fs.existsSync(inBranch);
  if (localExists && branchExists) {
    const d = spawnSync('git', ['diff', '--no-index', '--quiet', '--', local, inBranch], { stdio: 'pipe' });
    return d.status === 0 ? STATUS_MATCHES : STATUS_DIFFERS;
  }
  if (localExists) return STATUS_LOCAL_ONLY;
  if (branchExists) return STATUS_BRANCH_ONLY;
  return STATUS_UNKNOWN;
}

// --- item builders (read the SLICE for cache/expanded) ---

function expandEntry(entry, slice) {
  const cache = slice.cache || {};
  const children = (cache.children && cache.children[entry.path]) || [];
  if (children.length === 0) return { items: [{ path: entry.path }], total: 1 };
  return { items: children.map((p) => ({ path: p })), total: children.length };
}

function paginate(entry, items, slice) {
  if (items.length <= 1) return { shown: items, more: null };
  const limit = (slice.expanded && slice.expanded[entry.path]) || WALK_LIMIT;
  if (items.length <= limit) return { shown: items, more: null };
  const shown = items.slice(0, limit);
  return { shown, more: { kind: 'more', declaredPath: entry.path, shown: shown.length, total: items.length } };
}

function statusFor(slice, p) {
  const cache = slice.cache;
  if (!cache || !cache.byPath) return STATUS_UNKNOWN;
  return cache.byPath[p] || STATUS_UNKNOWN;
}

function _categorize(cf) {
  const groups = {};
  for (const e of cf) {
    const cat = e.category || 'uncategorized';
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(e);
  }
  const PRI = { secret: 0, config: 1, uncategorized: 99 };
  const cats = Object.keys(groups).sort((a, b) => {
    const ai = PRI[a] !== undefined ? PRI[a] : 50;
    const bi = PRI[b] !== undefined ? PRI[b] : 50;
    return ai !== bi ? ai - bi : a.localeCompare(b);
  });
  return { groups, cats };
}

function _byCategory(cf, slice, predicate) {
  const { groups, cats } = _categorize(cf);
  const out = [];
  for (const cat of cats) {
    const catRows = [];
    let fileCount = 0;
    for (const e of groups[cat]) {
      const expanded = expandEntry(e, slice);
      const sliced = predicate ? { shown: expanded.items, more: null } : paginate(e, expanded.items, slice);
      const fileRows = sliced.shown.map((f) => ({
        kind: 'file', path: f.path, category: cat,
        status: statusFor(slice, f.path), declaredPath: e.path, desc: e.desc,
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

function _flatTracked(cf, slice) {
  const items = [];
  for (const e of cf) {
    const expanded = expandEntry(e, slice);
    for (const f of expanded.items) {
      const status = statusFor(slice, f.path);
      if (!TRACKED.has(status)) continue;
      items.push({
        kind: 'file', path: f.path, category: e.category || 'uncategorized',
        status, declaredPath: e.path, desc: e.desc,
      });
    }
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  return items;
}

function buildItems(slice, files) {
  const cf = files || [];
  if (cf.length === 0) return [{ kind: 'note', text: 'no files declared in YAML' }];
  // No cache yet → the boot `refresh` Msg kicks the compute; show a placeholder
  // until cfgStatusResult lands (buildItems no longer triggers the compute).
  if (!slice.cache) return [{ kind: 'note', text: 'computing config status…' }];
  const cache = slice.cache;
  const head = [];
  if (cache.error) head.push({ kind: 'note', text: cache.error });

  const tab = tabIdx(slice);
  if (tab === TAB_FILE_TREE) return [...head, ..._byCategory(cf, slice, null)];
  if (tab === TAB_TRACKED_TREE) {
    const items = _byCategory(cf, slice, (s) => TRACKED.has(s));
    if (items.length === 0) return [...head, { kind: 'note', text: 'no tracked paths (try `r` to refresh)' }];
    return [...head, ...items];
  }
  const items = _flatTracked(cf, slice);
  if (items.length === 0) return [...head, { kind: 'note', text: 'no tracked paths (try `r` to refresh)' }];
  return [...head, ...items];
}

// --- render ---

function rowText(item, isSelected) {
  if (!item) return '';
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
  if (isSelected) return `[${theme().selected}]  ${item.status}  ${esc(item.path)}`;
  return `  ${item.status}  ${esc(item.path)}`;
}

function render(panel, w, h, slice) {
  const items = buildItems(slice, _files());
  const sel = getSel('config-status');
  const focused = getFocus() === 'config-status';
  const lines = items.map((item, i) => rowText(item, focused && i === sel));
  const title = `${panel.title || 'Config'} — ${TAB_LABELS[tabIdx(slice)]}`;
  return renderPanel({
    width: w, height: h, title,
    panelType: 'config-status', lines, focused,
    hotkey: panel.hotkey, scrollOffset: getScroll('config-status'),
  });
}

function getInfo(item) {
  if (!item) return [];
  if (item.kind === 'header') return [`Category: ${item.cat}`, `Declared paths: ${item.count}`];
  if (item.kind === 'note') return [item.text];
  const lines = [item.path, '', `category: ${item.category || 'uncategorized'}`, `status: ${item.status}`];
  if (item.desc) lines.push('', item.desc);
  return lines;
}

/** Build the detail-panel preview for a file row. Pure: takes branch +
 *  projectDir (was S), spawns git synchronously — run by the cfgStatusDiff
 *  effect on Enter, not in update(). */
function diffFor(item, branch, projectDir) {
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
  // STATUS_DIFFERS — materialize the branch version, then git diff --no-index.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-status-diff-'));
  const branchFile = path.join(tmp, 'branch');
  try {
    const sh = spawnSync('sh', ['-c', `git show '${branch}:${item.path}' > '${branchFile}'`], { cwd: projectDir, encoding: 'utf8' });
    if (sh.status !== 0) return [...header, `[red](git show failed)[/]`, ...(sh.stderr || '').split('\n')];
    const d = spawnSync('git', ['diff', '--no-index', '--', branchFile, localAbs], { encoding: 'utf8' });
    const out = (d.stdout || '').split('\n');
    return [...header, `[bold]${item.status} differs — branch vs local[/]`, '', ...out];
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

// --- update + effects (the TEA half) ---

function init() {
  return {
    tab: 0, cache: null, branch: null, expanded: {}, computing: false,
    // Phase 4a — nav chrome on the slice; one entry for the panel type.
    nav: { 'config-status': mnav.init() },
  };
}

function update(msg, slice) {
  // Phase 4a — nav chrome Msgs handled by the shared leaf.
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  if (msg.type === 'refresh') {
    // Boot + explicit `r`/`:refresh` (refreshAll dispatches it; the periodic
    // loop does not). Recompute unless one is already in flight.
    if (slice.computing) return slice;
    const branch = _resolveBranch();
    return [{ ...slice, branch, computing: true }, [{ type: 'cfgStatusCompute', branch }]];
  }
  if (msg.type === 'cfgStatusResult') {
    return [{ ...slice, cache: msg.cache, computing: false }, [{ type: 'render' }]];
  }
  if (msg.type === 'key') {
    if (msg.key === ']') return { ...slice, tab: (tabIdx(slice) + 1) % TAB_LABELS.length };
    if (msg.key === '[') return { ...slice, tab: (tabIdx(slice) + TAB_LABELS.length - 1) % TAB_LABELS.length };
    if (msg.key === 'return') {
      // The key Msg carries no selected row — re-derive it from the slice +
      // the framework cursor (getSel), the same list render uses.
      const item = buildItems(slice, _files())[getSel('config-status')];
      if (!item) return slice;
      if (item.kind === 'more') {
        const cur = slice.expanded[item.declaredPath] || WALK_LIMIT;
        return { ...slice, expanded: { ...slice.expanded, [item.declaredPath]: Math.min(cur + WALK_LIMIT, item.total) } };
      }
      if (item.kind === 'file') {
        return [slice, [{ type: 'cfgStatusDiff', item, branch: slice.branch || DEFAULT_BRANCH }]];
      }
    }
    return slice;
  }
  return slice;
}

// Effects (registered once at module load). They run the blocking git work
// off-tick / fold results back via Msgs — never writing the slice directly.
registerEffect('cfgStatusCompute', (eff) => {
  setImmediate(() => {
    let cache;
    try { cache = computeStatus(eff.branch, _files(), _projectDir()); }
    catch (e) { cache = { branch: eff.branch, byPath: {}, children: {}, error: e.message, computedAt: Date.now() }; }
    require('../api').dispatchMsg(require('../api').wrap('config-status', { type: 'cfgStatusResult', cache }));
  });
});
registerEffect('cfgStatusDiff', (eff) => {
  const { setDetail } = require('../../app/state');
  setDetail(diffFor(eff.item, eff.branch, _projectDir()).join('\n'));
});

module.exports = {
  name: 'config-status',
  init,
  update,
  panelTypes: {
    'config-status': {
      render,
      getItems: (slice) => buildItems(slice, _files()),
      getInfo,
      keyHints: '[ ] tabs | r refresh | ⏎ diff',
      filterable: true,
      filterText: (item) => {
        if (!item) return '';
        if (item.kind === 'file') return item.path;
        if (item.kind === 'header') return item.cat;
        return '';
      },
      // The component handles these in update(); suppress framework defaults.
      claimsKeys: [']', '[', 'return'],
    },
  },
  // Exposed for unit tests; not part of the public contract.
  _tabIdx: tabIdx,
  _buildItems: buildItems,
  _byCategory,
  _computeStatus: computeStatus,
  _statusFor: statusFor,
  _diffFor: diffFor,
  _update: update,
  _init: init,
  STATUS: {
    UNKNOWN: STATUS_UNKNOWN, MATCHES: STATUS_MATCHES, DIFFERS: STATUS_DIFFERS,
    LOCAL_ONLY: STATUS_LOCAL_ONLY, BRANCH_ONLY: STATUS_BRANCH_ONLY,
  },
  TAB_LABELS,
};
