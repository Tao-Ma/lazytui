/**
 * Core plugin — unified `files` panel (with `file-manager` and
 * `file-browser` aliases for backward compatibility).
 *
 * One panel type, three behaviors selected by `source:` in YAML:
 *
 *   source: declared     reads the project's declared file registry
 *                        (S.config.files — the YAML `files:` block).
 *                        Old `file-manager` behavior.
 *
 *   source: filesystem   real-filesystem directory browser. Enter on
 *                        a dir navigates into it; Enter on a file opens
 *                        a content tab via tabs.addContentTab + the
 *                        async file-loader. (Default for `type: files`.)
 *
 *   source: both         declared rows first, then filesystem rows
 *                        (including `..` for navigation). Useful for
 *                        projects that want the curated list visible
 *                        while still allowing ad-hoc browsing.
 *
 * Aliases:
 *   - `type: file-manager`  hard-pins source=declared (the v0.3 panel).
 *   - `type: file-browser`  hard-pins source=filesystem (in-development
 *                           name from v0.4; preserved so any tree that
 *                           adopted it during the cycle keeps working).
 *
 * Items are normalized to a single shape so getInfo/copyOptions/onKey/
 * render branch on `item.kind`:
 *
 *   declared:  { kind: 'declared', name, path, var?, desc?, exclude?, category? }
 *   parent:    { kind: 'parent',   name: '..',  path }
 *   dir:       { kind: 'dir',      name, path }
 *   file:      { kind: 'file',     name, path, size, mtime }
 *   symlink:   { kind: 'symlink',  name, path, size, mtime }
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const { S } = require('../../state');
const {
  esc, visibleLen, theme, renderPanel,
  getSel, getScroll, getFilter, isMultiSel, decorate,
  getItems: apiGetItems,
} = require('../api');

const { addContentTab } = require('../../tabs');
const { loadFile, DEFAULT_MAX_BYTES, DEFAULT_HEX_AFTER } = require('../../file-loader');

// --- per-panel state ---

function _ensureState() {
  if (!S.fileBrowser) {
    S.fileBrowser = { cwd: null, showHidden: false, lastError: null };
  }
}

function _resolveInitialCwd(panel) {
  const base = S.projectDir || process.cwd();
  if (panel && typeof panel.root === 'string' && panel.root) {
    return path.isAbsolute(panel.root) ? panel.root : path.resolve(base, panel.root);
  }
  return base;
}

/**
 * Resolve effective `source` for this call.
 *   - If `hardcoded` is set (alias panels), use it.
 *   - Else look at the matching panel in S.layout for `source:`.
 *   - Else default to 'filesystem' (the new canonical default).
 */
function _source(panelType, hardcoded) {
  if (hardcoded) return hardcoded;
  const panel = (S.layout.leftPanels.concat(S.layout.rightPanels))
    .find(p => p.type === panelType);
  return (panel && panel.source) || 'filesystem';
}

function _panelOf(panelType) {
  return (S.layout.leftPanels.concat(S.layout.rightPanels))
    .find(p => p.type === panelType);
}

// --- item production ---

function _declaredItems() {
  const declared = (S.config && S.config.files) || [];
  return declared.map(cf => ({
    kind: 'declared',
    name: cf.path,
    path: cf.path,
    var: cf.var || null,
    desc: cf.desc || null,
    exclude: cf.exclude || [],
    category: cf.category || null,
  }));
}

function _fsItems(cwd) {
  _ensureState();
  const out = [];
  const parent = path.dirname(cwd);
  if (parent !== cwd) {
    out.push({ kind: 'parent', name: '..', path: parent });
  }
  let entries;
  try {
    entries = fs.readdirSync(cwd, { withFileTypes: true });
    S.fileBrowser.lastError = null;
  } catch (err) {
    S.fileBrowser.lastError = err.message;
    return out;
  }
  const dirs = [];
  const files = [];
  for (const ent of entries) {
    const full = path.join(cwd, ent.name);
    let kind = 'file';
    let size = 0;
    let mtime = 0;
    if (ent.isDirectory()) kind = 'dir';
    else if (ent.isSymbolicLink()) kind = 'symlink';
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtimeMs;
      if (st.isDirectory()) kind = 'dir';
    } catch {
      // broken symlink / permission denied — keep inferred kind
    }
    (kind === 'dir' ? dirs : files).push({ kind, name: ent.name, path: full, size, mtime });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return out.concat(dirs, files);
}

function _matchesFilter(items, pattern) {
  if (!pattern) return items;
  // safeRegex rejects oversize patterns and the classic catastrophic-
  // backtracking shapes (`(a+)+`, `(.*)+` …). Null means "don't apply
  // a filter" — friendlier than blinking to empty on every keystroke,
  // and safer than letting the event loop freeze on `rx.test`.
  const { safeRegex } = require('../../regex-guard');
  const rx = safeRegex(pattern, 'i');
  if (!rx) return items;
  // Never filter out the parent shortcut; navigation must stay reachable.
  return items.filter(it => it.kind === 'parent' || rx.test(it.name));
}

function _getItemsFor(panelType, hardcoded) {
  const source = _source(panelType, hardcoded);
  let items = [];
  if (source === 'declared') {
    items = _declaredItems();
  } else if (source === 'filesystem') {
    _ensureState();
    if (!S.fileBrowser.cwd) S.fileBrowser.cwd = _resolveInitialCwd(_panelOf(panelType));
    items = _fsItems(S.fileBrowser.cwd);
    if (!S.fileBrowser.showHidden) items = items.filter(it => it.kind === 'parent' || !it.name.startsWith('.'));
  } else if (source === 'both') {
    _ensureState();
    if (!S.fileBrowser.cwd) S.fileBrowser.cwd = _resolveInitialCwd(_panelOf(panelType));
    const fsItems = _fsItems(S.fileBrowser.cwd)
      .filter(it => S.fileBrowser.showHidden || it.kind === 'parent' || !it.name.startsWith('.'));
    items = _declaredItems().concat(fsItems);
  }
  return _matchesFilter(items, getFilter(panelType));
}

// --- formatting helpers ---

function _formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

// --- getInfo / copyOptions / render / onKey (kind-aware) ---

function _getInfoFor(item, panelType, hardcoded) {
  _ensureState();
  const source = _source(panelType, hardcoded);
  const lines = [];
  if (source !== 'declared') {
    lines.push(`[bold]${esc(S.fileBrowser.cwd || '?')}[/]`);
    if (S.fileBrowser.lastError) {
      lines.push('', `[red]${esc(S.fileBrowser.lastError)}[/]`);
    }
    lines.push('');
  }
  if (!item) return lines;
  lines.push(`[bold]${esc(item.name)}[/]`);
  lines.push(`[dim]kind:[/]  ${item.kind}`);
  if (item.kind === 'declared') {
    if (item.var)      lines.push(`[dim]var:[/]   $${esc(item.var)}`);
    if (item.desc)     lines.push(`[dim]desc:[/]  ${esc(item.desc)}`);
    if (item.category) lines.push(`[dim]category:[/] ${esc(item.category)}`);
    if (item.exclude && item.exclude.length) {
      lines.push(`[dim]exclude:[/] ${esc(item.exclude.join(', '))}`);
    }
  } else {
    if (item.kind !== 'dir' && item.kind !== 'parent') {
      lines.push(`[dim]size:[/]  ${_formatSize(item.size || 0)} (${item.size || 0} bytes)`);
      if (item.mtime) lines.push(`[dim]mtime:[/] ${new Date(item.mtime).toISOString()}`);
    }
  }
  lines.push(`[dim]path:[/]  ${esc(item.path)}`);
  lines.push('');
  if (item.kind === 'dir') {
    lines.push('[dim]Enter to drill in. `/` filters by regex.[/]');
  } else if (item.kind === 'parent') {
    lines.push('[dim]Enter to go up one level.[/]');
  } else {
    lines.push('[dim]Enter to open as content tab. y for copy options.[/]');
  }
  return lines;
}

function _copyOptionsFor(item) {
  if (!item || item.kind === 'parent') return [];
  const fsp = require('fs').promises;
  const opts = [
    { label: `Name: ${item.name}`, content: item.name },
    { label: `Path: ${item.path}`, content: item.path },
  ];
  if (item.kind === 'declared' && item.var) {
    opts.push({ label: `Var: $${item.var}`, content: item.var });
  }
  if (item.kind === 'file' || item.kind === 'symlink' || item.kind === 'declared') {
    opts.push({
      label: 'File contents (text, up to cap)',
      content: () => fsp.readFile(item.path, 'utf8').catch(() => ''),
    });
  }
  return opts;
}

function _openFileAsTab(item, panelType) {
  const panel = _panelOf(panelType) || {};
  const maxBytes = _parseSize(panel.max_bytes, DEFAULT_MAX_BYTES);
  const hexAfter = _parseSize(panel.hex_after, DEFAULT_HEX_AFTER);

  // Resolve relative paths against S.projectDir so:
  //   1. The tab key (and dedup) is stable regardless of the process's
  //      cwd at load time.
  //   2. loadFile reads the same file the user pointed at (declared
  //      items like `README.md` resolved against project root, not
  //      whichever directory lazytui happened to be launched from).
  const base = S.projectDir || process.cwd();
  const absPath = path.isAbsolute(item.path) ? item.path : path.resolve(base, item.path);
  const key = `file:${absPath}`;
  const label = item.name;

  // Capture group at submit time. If the user switches groups while
  // the async load is in flight, the resolved content belongs to the
  // originating group's content tab — NOT whatever group happens to
  // be current when the promise resolves.
  const originGroup = S.currentGroup;

  addContentTab(originGroup, key, label, [`[dim]Loading ${esc(absPath)}…[/]`]);

  // Use updateContentTabLines on completion: refreshes the tab's
  // stored lines and re-emits setDetail iff the user is STILL parked
  // on this tab in this group. If they've navigated away, the load
  // result is silently stored for when they come back; no focus yank.
  const { updateContentTabLines } = require('../../tabs');
  loadFile(absPath, { maxBytes, hexAfter }).then(result => {
    updateContentTabLines(originGroup, key, result.lines);
    require('../../render-queue').scheduleRender();
  }).catch(err => {
    // loadFile already catches its own I/O errors and returns
    // {kind:'error',lines:...}, so this catch is mostly defensive
    // for future refactors.
    updateContentTabLines(originGroup, key, [
      '[red]Failed to load:[/]', '', `[dim]${esc(err.message)}[/]`,
    ]);
    require('../../render-queue').scheduleRender();
  });
}

function _parseSize(val, fallback) {
  if (typeof val === 'number' && val > 0) return val;
  if (typeof val !== 'string') return fallback;
  const m = val.trim().match(/^(\d+(?:\.\d+)?)\s*([KkMmGg]?)[Bb]?$/);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === 'K') return Math.round(n * 1024);
  if (unit === 'M') return Math.round(n * 1024 * 1024);
  if (unit === 'G') return Math.round(n * 1024 * 1024 * 1024);
  return Math.round(n);
}

function _onKeyFor(key, item, S, panelType /*, hardcoded*/) {
  if (key !== 'return' || !item) return false;
  if (item.kind === 'parent' || item.kind === 'dir') {
    _ensureState();
    S.fileBrowser.cwd = item.path;
    if (S.sel) S.sel[panelType] = 0;
    if (S.scroll) S.scroll[panelType] = 0;
    if (S.filters) delete S.filters[panelType];
    return true;
  }
  // declared / file / symlink → open in content tab
  _openFileAsTab(item, panelType);
  return true;
}

function _renderFor(panel, w, h, state, panelType, hardcoded) {
  const S = state;
  const items = require('../api').getItems(panelType, S);
  const innerW = w - 2;
  const sel = getSel(panelType);
  const isFocused = S.focus === panelType;
  const t = theme();
  const source = _source(panelType, hardcoded);
  const lines = items.map((it, i) => {
    const isSel = i === sel && isFocused;
    let marker;
    if (it.kind === 'parent')        marker = '↩ ';
    else if (it.kind === 'dir')      marker = '▸ ';
    else if (it.kind === 'declared') marker = source === 'both' ? '★ ' : '  ';
    else                              marker = '  ';
    const sizeStr = (it.kind === 'file' || it.kind === 'symlink') ? _formatSize(it.size || 0) : '';
    const ms = isMultiSel(panelType, it.path) ? '*' : ' ';
    const nameMax = Math.max(4, innerW - marker.length - sizeStr.length - 4);
    let name = it.name;
    if (name.length > nameMax) name = name.slice(0, nameMax - 1) + '…';
    const left = `${ms} ${marker}${esc(name)}`;
    const pad = Math.max(1, innerW - visibleLen(left) - sizeStr.length - 1);
    const row = `${left}${' '.repeat(pad)}${sizeStr} `;
    if (isSel) return `[${t.selected}]${row}`;
    if (it.kind === 'dir' || it.kind === 'parent') return `[bold]${row}[/]`;
    if (it.kind === 'declared' && source === 'both') return `[dim]${row}[/]`;
    return row;
  });

  const filterText = getFilter(panelType);
  let title = panel.title;
  if (filterText) title += ` /${esc(filterText)}`;
  if (source === 'both') title += ' [dim]\\[both][/]';
  else if (source === 'declared' && panelType === 'files') title += ' [dim]\\[declared][/]';
  return renderPanel({
    width: w, height: h, lines,
    title, hotkey: panel.hotkey,
    panelType,
    focused: isFocused,
    count: items.length ? [sel + 1, items.length] : null,
    scrollOffset: getScroll(panelType),
  });
}

// --- legacy file-manager def ---
//
// The `file-manager` panel type ships in v0.3.0. Keep its behavior
// VERBATIM under v0.4 — no customFilter, no onKey, no marker-based
// rendering, no shared cwd state. Users with `type: file-manager` in
// YAML see zero behavioral change. The `files` and `file-browser`
// types get the new unified behavior; the `file-manager` alias
// resolves to this legacy def instead.

function _legacyFmGetItems() {
  return (S.config && S.config.files) || [];
}

function _legacyFmGetInfo(item) {
  if (!item) return [];
  const lines = [`[bold]${esc(item.path)}[/]`];
  if (item.desc) lines.push('', esc(item.desc), '');
  if (item.var) lines.push(`[dim]var:[/] $${esc(item.var)}`);
  if (item.exclude && item.exclude.length) {
    lines.push(`[dim]exclude:[/] ${esc(item.exclude.join(', '))}`);
  }
  return lines;
}

function _legacyFmCopyOptions(item) {
  if (!item) return [];
  const fsp = require('fs').promises;
  const opts = [
    { label: `Path: ${item.path}`, content: item.path },
  ];
  if (item.var) opts.push({ label: `Var: $${item.var}`, content: item.var });
  opts.push({
    label: 'File contents',
    content: () => fsp.readFile(item.path, 'utf8').catch(() => ''),
  });
  return opts;
}

function _legacyFmRender(panel, w, h) {
  const cfiles = apiGetItems('file-manager', S);
  const innerW = w - 2;
  const sel = getSel('file-manager');
  const isFocused = S.focus === 'file-manager';
  const maxPathLen = w - 5;
  const lines = cfiles.map((cf, i) => {
    let p = cf.path;
    if (p.length > maxPathLen) p = '…' + p.slice(-(maxPathLen - 1));
    const isSel = i === sel && isFocused;
    const ctx = { panelType: 'file-manager', item: cf, selected: isSel, S };
    const left  = decorate('row:left:file-manager',  { ...ctx, width: 4 });
    const pathLen = p.length;
    const gutterLen = 2;
    const used = gutterLen + (left ? visibleLen(left) + 1 : 0) + pathLen;
    const right = decorate('row:right:file-manager', { ...ctx, width: Math.max(0, innerW - used - 1) });
    const lhead = left  ? `${left} `  : '';
    const rtail = right ? ` ${right}` : '';
    const gutter = isMultiSel('file-manager', cf.path) ? '* ' : '  ';
    const base = isSel ? `[${theme().selected}]${gutter}${lhead}${p}${rtail}` : `${gutter}${lhead}${p}${rtail}`;
    return base;
  });
  const filterText = getFilter('file-manager');
  const title = filterText ? `${panel.title} /${esc(filterText)}` : panel.title;
  return renderPanel({
    width: w, height: h, lines,
    title, hotkey: panel.hotkey,
    panelType: 'file-manager',
    focused: isFocused,
    count: cfiles.length ? [sel + 1, cfiles.length] : null,
    scrollOffset: getScroll('file-manager'),
  });
}

const _legacyFileManagerDef = {
  mode: 'list',
  render: _legacyFmRender,
  getItems: _legacyFmGetItems,
  getInfo: _legacyFmGetInfo,
  copyOptions: _legacyFmCopyOptions,
  filterable: true,
  filterText: (cf) => cf.path,
  idOf: (cf) => cf.path,
};

// --- per-panel-type def factory ---

function _makeDef(panelType, hardcoded) {
  return {
    mode: 'list',
    render: (panel, w, h, state) => _renderFor(panel, w, h, state, panelType, hardcoded),
    getItems: () => _getItemsFor(panelType, hardcoded),
    getInfo: (item) => _getInfoFor(item, panelType, hardcoded),
    copyOptions: _copyOptionsFor,
    onKey: (key, item, state) => _onKeyFor(key, item, state, panelType, hardcoded),
    filterable: true,
    customFilter: true,
    // For consistency, filterText returns the displayed name (used by
    // framework fallback when customFilter is off — but ours is on so
    // this is mainly for future-proofing if customFilter ever flips).
    filterText: (it) => it.name || it.path || '',
    idOf: (it) => it.path,
    keyHints: hardcoded === 'declared'
      ? 'Enter open · / filter · y copy'
      : 'Enter open · / regex · y copy',
  };
}

// --- cmdline commands ---

const commands = [
  {
    name: 'show-hidden',
    desc: 'Toggle dotfile visibility in files panels (on/off/toggle)',
    run: (args /*, S */) => {
      _ensureState();
      const arg = (args && args[0] || '').toLowerCase();
      if (arg === 'on')        S.fileBrowser.showHidden = true;
      else if (arg === 'off')  S.fileBrowser.showHidden = false;
      else                     S.fileBrowser.showHidden = !S.fileBrowser.showHidden;
    },
  },
];

// --- registration: three panel types via this single module ---
//
// `files`         — canonical name; honors `source:` from YAML
// `file-manager`  — legacy alias, uses the verbatim v0.3 def
//                   (substring filter, no onKey, decorate hooks
//                   preserved) so existing YAMLs see ZERO behavior
//                   change after the merge. Users opting into the
//                   new declared-list behavior should migrate to
//                   `type: files, source: declared`.
// `file-browser`  — pre-release alias, source pinned to 'filesystem'

module.exports = [
  { panelType: 'files',        def: _makeDef('files', null) },
  { panelType: 'file-manager', def: _legacyFileManagerDef },
  { panelType: 'file-browser', def: _makeDef('file-browser', 'filesystem') },
  // Commands ride on the first entry — core/index.js merges all `commands`
  // arrays from each mod. We attach them once to avoid duplicate
  // registration when an alias is also registered. Convention: put
  // commands on the first entry of an array-mod.
].map((entry, i) => i === 0 ? { ...entry, commands } : entry);
