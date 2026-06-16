/**
 * config-status — status-aware panel for declared config files (Component API).
 *
 * Reads `S.config.files` and presents them under two ORTHOGONAL view
 * toggles (git-GUI style — `t` layout, `s` scope), both projections over
 * one shared `cache` (no extra compute):
 *   layout: 'tree' — grouped by `category:` hierarchy · 'flat' — flat list
 *   scope:  'all'  — every declared path       · 'tracked' — the ✓ * ! subset
 * All four combinations are valid (incl. all · flat, the combo the old
 * 3-tab cycle could not express). `]`/`[` are NOT claimed here — they fall
 * through to the framework's normal pane/tab cycle.
 *
 * Status badges: ✓ matches · * differs · + local-only · ! branch-only · ? unknown.
 * "Tracked" = the branch has a copy (✓ * !).
 *
 * Component (TEA) model — the panel's state lives in its SLICE, not on S:
 *   { layout, scope, cache, branch, expanded, computing }
 * A `refresh` Msg (dispatched at boot + on `r`/`:refresh` by refreshAll — the
 * periodic loop does NOT, it calls plugin.refresh() directly) kicks the
 * `cfgStatusCompute` effect, which mounts a temp worktree on the configured
 * branch OFF-tick and dispatches `cfgStatusResult` with the cache; update()
 * folds it into the slice (effects can't write the slice). Enter on a file emits
 * `cfgStatusDiff` (git show/diff → the viewer via setViewerContent). `]`/`[`/Enter
 * are handled in update(); each returns the `_claimed` sentinel effect so the
 * framework's tab-cycle / run_selected defaults don't ALSO fire.
 * Branch comes from the pane's `branch:` config (default `config`) —
 * threaded into init() via the mint-loop seed (v0.6.4 #4).
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  esc, theme, renderPanel,
  getScroll, getSel,
} = require('../api');
const mnav = require('../../leaves/nav');

const DEFAULT_LAYOUT = 'tree';   // 'tree' | 'flat'
const DEFAULT_SCOPE = 'all';     // 'all'  | 'tracked'

const STATUS_UNKNOWN = '?';
const STATUS_MATCHES = '✓';
const STATUS_DIFFERS = '*';
const STATUS_LOCAL_ONLY = '+';
const STATUS_BRANCH_ONLY = '!';
const TRACKED = new Set([STATUS_MATCHES, STATUS_DIFFERS, STATUS_BRANCH_ONLY]);

const DEFAULT_BRANCH = 'config';
const WALK_LIMIT = 10;

// --- framework reads (init-time boundary + contributors only) ---
//
// v0.6.3 post-arch-arc T1.2 — Phase D / D3 retired runtime getModel()
// + cross-slice reads from reducer arms by caching the needed root
// facts onto the Component's own slice:
//
//   slice.files       — mirrors model.config.files (snapshot)
//   slice.projectDir  — mirrors model.projectDir (snapshot)
//   slice.branch      — THIS pane's `branch:` config (from the pane def)
//
// v0.6.4 #4 — init-injection: the framework mint loop (state.js) threads
// the seed { config, projectDir, paneDef } into init(paneId, seed) — the
// runtime shell reads getModel() (blessed), init is a pure function of
// (paneId, seed) with NO getModel / getInstanceSlice. Mirrors
// register.init(config.register). branch comes from the pane def the mint
// loop already resolved (no cross-slice layout read). The `set_config`
// arm refreshes files+projectDir when the root reducer rebroadcasts
// config. (branch is fixed at mint — a pane's `branch:` doesn't change
// without a re-mint.) Reducer arms + finalizer stay pure of getModel /
// getInstanceSlice.
//
// Contributors (`getItems`, `getInfo`, `keyHints`) are framework-
// level surfaces, not reducer arms; they may still read root via
// the documented Component contract.
function _readFilesFromModel(m)        { return (m && m.config && m.config.files) || []; }
function _branchFromPaneDef(paneDef) {
  // THIS pane's `branch:` config. The mint loop already resolved the pane
  // (it iterates the placed panes), so init receives the def directly —
  // no pool lookup, no arrange/layout-slice read. The register-time
  // singleton / unit tests pass no def → DEFAULT_BRANCH (throwaway seed).
  //
  // v0.6.4 #4 bugfix — read TOP-LEVEL `branch`: rebuildLayoutFromConfig's
  // widenPane spreads the pool entry's `config` keys onto the pane
  // (`{ branch, id, type, paneId, ... }`), so a placed pane carries
  // `branch` at top level with NO `.config`. The pre-#4 `_branchFromArrange`
  // read `paneDef.config.branch` and so ALWAYS fell back to DEFAULT in
  // production — a second pane's custom `branch:` silently never routed
  // (masked because the single/default-branch case equals DEFAULT). The
  // `.config.branch` fallback keeps the pool-entry / hand-built shape working.
  const b = paneDef && (paneDef.branch != null ? paneDef.branch
                        : (paneDef.config && paneDef.config.branch));
  return (typeof b === 'string' && b) ? b : DEFAULT_BRANCH;
}

// --- slice helpers ---

function layoutOf(slice) {
  return (slice && slice.layout === 'flat') ? 'flat' : DEFAULT_LAYOUT;
}
function scopeOf(slice) {
  return (slice && slice.scope === 'tracked') ? 'tracked' : DEFAULT_SCOPE;
}
// Predicate over a status badge for the current scope; null = include all.
function scopePredicate(slice) {
  return scopeOf(slice) === 'tracked' ? (s) => TRACKED.has(s) : null;
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

function _flat(cf, slice, predicate) {
  const items = [];
  for (const e of cf) {
    const expanded = expandEntry(e, slice);
    for (const f of expanded.items) {
      const status = statusFor(slice, f.path);
      if (predicate && !predicate(status)) continue;
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

  const predicate = scopePredicate(slice);
  const items = layoutOf(slice) === 'flat'
    ? _flat(cf, slice, predicate)
    : _byCategory(cf, slice, predicate);
  if (items.length === 0) {
    const text = scopeOf(slice) === 'tracked'
      ? 'no tracked paths (try `r` to refresh)'
      : 'no files declared in YAML';
    return [...head, { kind: 'note', text }];
  }
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

function render(panel, w, h, slice, opts) {
  // v0.6.4 Theme A Phase 5 — per-pane nav reads (panel.paneId) + per-pane
  // focus (opts.focused). #12 — content (branch + cache) is per-pane too:
  // each instance resolves its own branch at init(paneId) and the compute
  // result routes back to its paneId, so two panes can track distinct branches.
  const items = buildItems(slice, slice.files || []);
  const sel = getSel(panel.paneId);
  const focused = !!(opts && opts.focused);
  const lines = items.map((item, i) => rowText(item, focused && i === sel));
  const title = `${panel.title || 'Config'} — ${layoutOf(slice)} · ${scopeOf(slice)}`;
  return renderPanel({
    width: w, height: h, title,
    panelType: 'config-status', lines, focused,
    hotkey: panel.hotkey, scrollOffset: getScroll(panel.paneId),
    chrome: opts && opts.chrome,
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
    // T32 — esc() each raw line: file content (or git output below) may
    // contain tabs, literal `[`, or terminal-control sequences. Without
    // esc, tabs in a Makefile / postgresql.conf / .py overrun panel
    // padding and corrupt the right border (same class as T31). esc()
    // also strips any dangerous control bytes that survived disk → string
    // (T22's stripControls hook).
    const lines = body.split('\n').slice(0, 200).map(esc);
    return [...header, `[bold]${item.status} local-only — branch has no copy[/]`, '', ...lines];
  }
  if (item.status === STATUS_BRANCH_ONLY) {
    const r = spawnSync('git', ['show', `${branch}:${item.path}`], { cwd: projectDir, encoding: 'utf8' });
    if (r.status !== 0) {
      return [...header, `[red](git show "${branch}:${item.path}" failed)[/]`, ...(r.stderr || '').split('\n').map(esc)];
    }
    const lines = r.stdout.split('\n').slice(0, 200).map(esc);
    return [...header, `[bold]${item.status} branch-only — local missing[/]`, '', ...lines];
  }
  // STATUS_DIFFERS — materialize the branch version, then git diff --no-index.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-status-diff-'));
  const branchFile = path.join(tmp, 'branch');
  try {
    const sh = spawnSync('sh', ['-c', `git show '${branch}:${item.path}' > '${branchFile}'`], { cwd: projectDir, encoding: 'utf8' });
    if (sh.status !== 0) return [...header, `[red](git show failed)[/]`, ...(sh.stderr || '').split('\n').map(esc)];
    const d = spawnSync('git', ['diff', '--no-index', '--', branchFile, localAbs], { encoding: 'utf8' });
    const out = (d.stdout || '').split('\n').map(esc);
    return [...header, `[bold]${item.status} differs — branch vs local[/]`, '', ...out];
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }
}

// --- update + effects (the TEA half) ---

function init(paneId, seed) {
  // v0.6.4 #4 — init-injection. The framework mint loop threads the seed
  // { config, projectDir, paneDef } (it reads getModel() in the blessed
  // shell); init derives its snapshot from the seed and is a pure function
  // of (paneId, seed) — no getModel / getInstanceSlice. A missing seed
  // (the register-time singleton at api.js, disposed once a real pane
  // mints) degrades to empty/defaults — that slice is throwaway.
  // Subsequent updates flow through the set_config arm; reducer arms stay
  // pure. v0.6.4 #12 — slice self-identifies (paneId) so branch + the
  // compute result route per-pane.
  return {
    paneId: paneId || null,
    layout: DEFAULT_LAYOUT, scope: DEFAULT_SCOPE, cache: null, expanded: {}, computing: false,
    files: _readFilesFromModel(seed && { config: seed.config }),
    projectDir: (seed && seed.projectDir) || '.',
    branch: _branchFromPaneDef(seed && seed.paneDef),
    // v0.6.1 Phase 3 — single-panel Component, nav stores the entry directly.
    nav: mnav.init(),
  };
}

function update(msg, slice) {
  // Phase 4a — nav chrome Msgs handled by the shared leaf.
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  // T1.2 — Phase D3 broadcasts set_config through the root reducer;
  // mirror the snapshot onto our slice so reducer arms read locally.
  if (msg.type === 'set_config') {
    return {
      ...slice,
      files: _readFilesFromModel({ config: msg.config }),
      projectDir: (msg.config && msg.config.project_dir) || '.',
    };
  }
  if (msg.type === 'refresh') {
    // Boot + explicit `r`/`:refresh` (refreshAll dispatches it; the periodic
    // loop does not). Recompute unless one is already in flight.
    if (slice.computing) return slice;
    const branch = slice.branch || DEFAULT_BRANCH;
    // T1.2 — thread files + projectDir into the effect payload so the
    // off-tick worker doesn't read root model itself.
    return [{ ...slice, branch, computing: true }, [{
      type: 'cfgStatusCompute', branch, paneId: slice.paneId || null,
      files: slice.files || [], projectDir: slice.projectDir || '.',
    }]];
  }
  if (msg.type === 'cfgStatusResult') {
    return [{ ...slice, cache: msg.cache, computing: false }, [{ type: 'render' }]];
  }
  if (msg.type === 'key') {
    // The Component owns t/s/return on this panel: each branch returns
    // the `_claimed` sentinel effect so the framework default (e.g.
    // run_selected, or a hotkey-jump) doesn't ALSO fire. `]`/`[` are NOT
    // claimed — they fall through to the framework's pane/tab cycle like
    // every other pane. Other keys flow through as no-claim returns.
    if (msg.key === 't') return [{ ...slice, layout: layoutOf(slice) === 'tree' ? 'flat' : 'tree' }, [{ type: '_claimed' }]];
    if (msg.key === 's') return [{ ...slice, scope: scopeOf(slice) === 'all' ? 'tracked' : 'all' }, [{ type: '_claimed' }]];
    if (msg.key === 'return') {
      // T1.2 — read files snapshot from slice (cached via set_config arm),
      // not via getModel(). Cursor from our own slice.nav (via the nav
      // leaf), not the getSel() global — navigator-key-arm purity sweep.
      const item = buildItems(slice, slice.files || [])[mnav.cursorOf(slice, 'config-status')];
      // `return` is claimed regardless of what the row resolves to —
      // even an unclickable header row shouldn't ALSO trigger the
      // framework's run_selected default.
      if (!item) return [slice, [{ type: '_claimed' }]];
      if (item.kind === 'more') {
        const cur = slice.expanded[item.declaredPath] || WALK_LIMIT;
        return [{ ...slice, expanded: { ...slice.expanded, [item.declaredPath]: Math.min(cur + WALK_LIMIT, item.total) } }, [{ type: '_claimed' }]];
      }
      if (item.kind === 'file') {
        return [slice, [{
          type: 'cfgStatusDiff', item,
          branch: slice.branch || DEFAULT_BRANCH,
          projectDir: slice.projectDir || '.',
        }, { type: '_claimed' }]];
      }
      return [slice, [{ type: '_claimed' }]];
    }
    return slice;
  }
  return slice;
}

/** Called from registerComponent after init(). Runs the blocking git
 *  work off-tick / folds results back via Msgs — never writing the
 *  slice directly. */
function installEffects(registerEffect) {
  registerEffect('cfgStatusCompute', (eff) => {
    setImmediate(() => {
      let cache;
      try { cache = computeStatus(eff.branch, eff.files || [], eff.projectDir || '.'); }
      catch (e) { cache = { branch: eff.branch, byPath: {}, children: {}, error: e.message, computedAt: Date.now() }; }
      // Route the result to the pane that kicked the compute — NOT the
      // kind's primary. `wrap('config-status')` would land every instance's
      // result on the first pane, leaving the others stuck on "computing…"
      // (the files Arc 2 / docker Arc 3 collapse-to-primary footgun).
      const api = require('../api');
      api.dispatchMsg(api.wrap(eff.paneId || 'config-status', { type: 'cfgStatusResult', cache }));
    });
  });
  registerEffect('cfgStatusDiff', (eff) => {
    const { setViewerContent } = require('../nav-state');
    setViewerContent(null, diffFor(eff.item, eff.branch, eff.projectDir || '.').join('\n'));
  });
}

module.exports = {
  name: 'config-status',
  init,
  update,
  installEffects,
  panelTypes: {
    'config-status': {
      render,
      getItems: (slice) => buildItems(slice, slice.files || []),
      getInfo,
      keyHints: 't tree/flat | s all/tracked | r refresh | ⏎ diff',
      filterable: true,
      filterText: (item) => {
        if (!item) return '';
        if (item.kind === 'file') return item.path;
        if (item.kind === 'header') return item.cat;
        return '';
      },
    },
  },
  // Exposed for unit tests; not part of the public contract.
  _layoutOf: layoutOf,
  _scopeOf: scopeOf,
  _buildItems: buildItems,
  _byCategory,
  _flat,
  _branchFromPaneDef,
  _computeStatus: computeStatus,
  _statusFor: statusFor,
  _diffFor: diffFor,
  _update: update,
  _init: init,
  STATUS: {
    UNKNOWN: STATUS_UNKNOWN, MATCHES: STATUS_MATCHES, DIFFERS: STATUS_DIFFERS,
    LOCAL_ONLY: STATUS_LOCAL_ONLY, BRANCH_ONLY: STATUS_BRANCH_ONLY,
  },
};
