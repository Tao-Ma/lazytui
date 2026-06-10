/**
 * files — directory/registry browser panel (Component / TEA API).
 *
 * Owns two panel types, both driven by `source:` selection:
 *
 *   source: declared     reads the project's declared file registry
 *                        (S.config.files — the YAML `files:` block).
 *   source: filesystem   real-filesystem directory browser. (Default for
 *                        `type: files`; hard-pinned for `file-browser`.)
 *   source: both         declared rows first, then filesystem rows.
 *   source: docker       container filesystem browser (needs `container:`).
 *
 * This module owns the `files` and `file-browser` panel types. The
 * v0.3.0 `type: file-manager` back-compat alias was dropped in v0.5 —
 * migrate to `type: files, source: declared`.
 *
 * Slice shape:
 *
 *   { browsers: { [tabId]: { cwd, showHidden, lastError, items, loading, seq } } }
 *
 * Keyed by tab id so distinct panels get independent cwd / showHidden /
 * listing slots. In v0.6.1 Phase 3 the files Component owns a single
 * instance whose two panelTypes (`files` + `file-browser`) double as
 * tab ids — `browsers['files']` / `browsers['file-browser']`. Phase 4
 * mints separate instances per panelType, at which point each instance
 * carries one browser (no map needed) and the keys collapse out.
 *
 * Directory listings are loaded ASYNCHRONOUSLY through the effect loop, never
 * synchronously in getItems (which stays a pure projection of the slice):
 *
 *   refresh / Enter-on-dir  → update() sets cwd + loading, emits a `loadDir`
 *                             effect; getItems shows a `loading` placeholder.
 *   loadDir effect          → reads the dir (fs.readdir or `docker exec ls`)
 *                             OFF-tick and dispatches a `dirLoaded` result Msg.
 *   dirLoaded Msg           → update() folds the rows into the slice (a stale
 *                             seq from a since-abandoned cwd is dropped).
 *   Enter-on-file           → an `openFile` effect (addContentTab + async
 *                             file-loader; same machinery as before).
 *   Enter-on-dir            → also a `resetPanelChrome` effect — wipes
 *                             cursor / scroll / filter on the panel's
 *                             own nav slice via wrapped Msgs (each
 *                             write originates inside the owning
 *                             Component's update).
 *
 * Items are normalized to a single shape so getInfo/copyOptions/render branch
 * on `item.kind` (declared | parent | dir | file | symlink | loading).
 */
'use strict';

const fs   = require('fs');
const path = require('path');

const { getModel } = require('../../app/runtime');
const mnav = require('../../leaves/nav');
const route = require('../../panel/route');
const {
  esc, visibleLen, theme, renderPanel,
  getSel, getScroll, getFilter, isMultiSel,
  getInstanceSlice, getFocus,
} = require('../api');

const { DEFAULT_MAX_BYTES, DEFAULT_HEX_AFTER } = require('../../io/file-loader');
const { dockerList, dockerReadBytes } = require('../../feature/docker-fs');
// _openFileAsTab delegates to the open-target scheme registry (Phase C);
// addContentTab / updateContentTabLines / loadFile are owned by the
// scheme implementations (feature/open-file.js, feature/open-docker.js).

const OWNED_TYPES = ['files', 'file-browser'];

// --- slice helpers ---

function _newBrowser() {
  return { cwd: null, showHidden: false, lastError: null, items: null, loading: false, seq: 0 };
}

/** The panel-type → {hardcoded source} binding. `file-browser` pins filesystem;
 *  `files` honors the panel's `source:` (default filesystem). */
function _hardcodedFor(panelType) {
  return panelType === 'file-browser' ? 'filesystem' : null;
}

// --- framework reads (app-global, read explicitly per the Component contract) ---

function _allPanels() {
  const slice = getInstanceSlice('layout');
  const ly = slice && slice.arrange;
  if (!ly) return [];
  return require('../../leaves/pool').allPanesInColumns(ly);
}

function _panelOf(panelType) {
  return _allPanels().find(p => p.type === panelType);
}

/** Resolve effective `source` for a panel type (hardcoded alias wins, else
 *  the panel's `source:`, else filesystem). */
function _source(panelType, hardcoded) {
  if (hardcoded) return hardcoded;
  const panel = _panelOf(panelType);
  return (panel && panel.source) || 'filesystem';
}

function _resolveInitialCwd(panel, source) {
  // Docker roots are container-side absolute POSIX paths — pass through
  // verbatim (no host-side resolution) or default to '/'.
  if (source === 'docker') {
    if (panel && typeof panel.root === 'string' && panel.root) return panel.root;
    return '/';
  }
  const base = getModel().projectDir || process.cwd();
  if (panel && typeof panel.root === 'string' && panel.root) {
    return path.isAbsolute(panel.root) ? panel.root : path.resolve(base, panel.root);
  }
  return base;
}

// --- item production (pure projections of the slice + app-global config) ---

function _declaredItems() {
  const cfg = getModel().config;
  const declared = (cfg && cfg.files) || [];
  return declared.map(cf => ({
    kind: 'declared',
    name: cf.path,
    path: cf.path,
    var: cf.var || null,
    desc: cf.desc || null,
    exclude: cf.exclude || [],
    category: cf.category || null,
    container: cf.container || null,
  }));
}

function _matchesFilter(items, pattern) {
  if (!pattern) return items;
  // safeRegex rejects oversize / catastrophic-backtracking patterns; null
  // means "don't filter" (friendlier than blinking to empty mid-type).
  const { safeRegex } = require('../../leaves/regex-guard');
  const rx = safeRegex(pattern, 'i');
  if (!rx) return items;
  // Never filter out parent / loading rows — navigation + status must stay
  // reachable regardless of pattern.
  return items.filter(it => it.kind === 'parent' || it.kind === 'loading' || rx.test(it.name));
}

const LOADING_ROW = { kind: 'loading', name: 'Loading…', path: null };

/**
 * THE canonical filtered item list for a panel type — a pure projection of
 * the slice (loaded rows) + app-global config (declared rows). Loaded
 * filesystem/docker rows include dotfiles; the showHidden gate is applied
 * here, so toggling visibility never needs a re-list.
 */
function _itemsFor(slice, panelType, hardcoded) {
  const source = _source(panelType, hardcoded);
  const b = (slice.browsers && slice.browsers[panelType]) || {};
  const showHidden = !!b.showHidden;
  const hideDot = (it) => showHidden || it.kind === 'parent' || it.kind === 'loading' || !it.name.startsWith('.');

  let items;
  if (source === 'declared') {
    items = _declaredItems();
  } else if (source === 'both') {
    const declared = _declaredItems()
      .filter(it => showHidden || !path.basename(it.path).startsWith('.'));
    const fsRows = b.items == null ? [LOADING_ROW] : b.items.filter(hideDot);
    items = declared.concat(fsRows);
  } else { // filesystem | docker
    if (source === 'docker' && !(_panelOf(panelType) || {}).container) {
      items = [];
    } else if (b.items == null) {
      items = [LOADING_ROW];
    } else {
      items = b.items.filter(hideDot);
    }
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

// --- getInfo / copyOptions / render (kind-aware) ---

function _getInfoFor(item, panelType, hardcoded) {
  const slice = getInstanceSlice('files') || { browsers: {} };
  const b = (slice.browsers && slice.browsers[panelType]) || {};
  const source = _source(panelType, hardcoded);
  const panel = _panelOf(panelType);
  const lines = [];
  if (source !== 'declared') {
    const cwdPrefix = source === 'docker' && panel && panel.container
      ? `${esc(panel.container)}:` : '';
    lines.push(`[bold]${cwdPrefix}${esc(b.cwd || '?')}[/]`);
    if (b.lastError) lines.push('', `[red]${esc(b.lastError)}[/]`);
    lines.push('');
  }
  if (!item) return lines;
  if (item.kind === 'loading') {
    lines.push('[dim]Fetching directory listing…[/]');
    return lines;
  }
  lines.push(`[bold]${esc(item.name)}[/]`);
  lines.push(`[dim]kind:[/]  ${item.kind}`);
  if (item.kind === 'declared') {
    if (item.var)       lines.push(`[dim]var:[/]   $${esc(item.var)}`);
    if (item.desc)      lines.push(`[dim]desc:[/]  ${esc(item.desc)}`);
    if (item.category)  lines.push(`[dim]category:[/] ${esc(item.category)}`);
    if (item.container) lines.push(`[dim]container:[/] ${esc(item.container)}`);
    if (item.exclude && item.exclude.length) {
      lines.push(`[dim]exclude:[/] ${esc(item.exclude.join(', '))}`);
    }
  } else if (item.kind !== 'dir' && item.kind !== 'parent') {
    lines.push(`[dim]size:[/]  ${_formatSize(item.size || 0)} (${item.size || 0} bytes)`);
    if (item.mtime) lines.push(`[dim]mtime:[/] ${new Date(item.mtime).toISOString()}`);
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

function _copyOptionsFor(item, panelType) {
  if (!item || item.kind === 'parent' || item.kind === 'loading') return [];
  const fsp = require('fs').promises;
  const opts = [
    { label: `Name: ${item.name}`, content: item.name },
    { label: `Path: ${item.path}`, content: item.path },
  ];
  if (item.kind === 'declared' && item.var) {
    opts.push({ label: `Var: $${item.var}`, content: item.var });
  }
  if (item.kind === 'file' || item.kind === 'symlink' || item.kind === 'declared') {
    const panel = _panelOf(panelType) || {};
    const container = item.container || (panel.source === 'docker' ? panel.container : null);
    opts.push({
      label: 'File contents (text, up to cap)',
      content: container
        ? () => dockerReadBytes(container, item.path, DEFAULT_MAX_BYTES)
            .then(r => r.buf.toString('utf8')).catch(() => '')
        : () => fsp.readFile(item.path, 'utf8').catch(() => ''),
    });
  }
  return opts;
}

function _renderFor(panel, w, h, slice, panelType, hardcoded, opts) {
  const items = _itemsFor(slice, panelType, hardcoded);
  const innerW = w - 2;
  const sel = getSel(panelType);
  // v0.6.3 B3 — getFocus() is a paneId; the renderer is called per-type
  // so compare via the route table (paneId → kind name).
  const isFocused = route.instanceKind(getFocus()) === panelType;
  const t = theme();
  const source = _source(panelType, hardcoded);
  const lines = items.map((it, i) => {
    const isSel = i === sel && isFocused;
    let marker;
    if (it.kind === 'parent')        marker = '↩ ';
    else if (it.kind === 'dir')      marker = '▸ ';
    else if (it.kind === 'loading')  marker = '⋯ ';
    else if (it.kind === 'declared') marker = source === 'both' ? '★ ' : '  ';
    else                              marker = '  ';
    const sizeStr = (it.kind === 'file' || it.kind === 'symlink') ? _formatSize(it.size || 0) : '';
    const ms = it.kind === 'loading' ? ' ' : (isMultiSel(panelType, it.path) ? '*' : ' ');
    const nameMax = Math.max(4, innerW - marker.length - sizeStr.length - 4);
    let name = it.name;
    if (name.length > nameMax) name = name.slice(0, nameMax - 1) + '…';
    const left = `${ms} ${marker}${esc(name)}`;
    const pad = Math.max(1, innerW - visibleLen(left) - sizeStr.length - 1);
    const row = `${left}${' '.repeat(pad)}${sizeStr} `;
    if (isSel) return `[${t.selected}]${row}`;
    if (it.kind === 'loading') return `[dim]${row}[/]`;
    if (it.kind === 'dir' || it.kind === 'parent') return `[bold]${row}[/]`;
    if (it.kind === 'declared' && source === 'both') return `[dim]${row}[/]`;
    return row;
  });

  const filterText = getFilter(panelType);
  let title = panel.title;
  if (filterText) title += ` /${esc(filterText)}`;
  if (source === 'both') title += ' [dim]\\[both][/]';
  else if (source === 'declared' && panelType === 'files') title += ' [dim]\\[declared][/]';
  else if (source === 'docker') {
    const c = panel.container || '?';
    title += ` [dim]\\[docker:${esc(c)}][/]`;
  }
  return renderPanel({
    width: w, height: h, lines,
    title, hotkey: panel.hotkey,
    panelType,
    focused: isFocused,
    count: items.length ? [sel + 1, items.length] : null,
    scrollOffset: getScroll(panelType),
    chrome: opts && opts.chrome,
  });
}

// --- update + effects (the TEA half) ---

function init() {
  return {
    browsers: {},
    // Phase 4a — nav chrome lives on the slice now. `files` owns two
    // panel types — `files` and `file-browser` — so the `nav` map is
    // keyed per-panel-type. A single Component, two independent nav
    // entries; matches the per-panel-type semantics of the helpers.
    nav: { files: mnav.init(), 'file-browser': mnav.init() },
  };
}

/** Each refresh / navigation produces a fresh load with a bumped seq so a
 *  result from an abandoned cwd (user navigated away mid-flight) is dropped
 *  by the dirLoaded stale guard rather than clobbering the current listing. */
function _kickLoad(b, panel, source, panelType, container) {
  const cwd = b.cwd || _resolveInitialCwd(panel, source);
  const seq = (b.seq || 0) + 1;
  const next = { ...b, cwd, items: null, loading: true, seq, lastError: null };
  const effect = { type: 'loadDir', panelType, source, cwd, container: container || null, seq };
  return { next, effect };
}

function update(msg, slice) {
  // Phase 4a — nav chrome Msgs handled by the shared leaf.
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  if (msg.type === 'refresh') {
    // Boot + explicit `r`/`:refresh` (refreshAll dispatches refresh; the
    // periodic loop does not). Re-list every owned fs/docker panel present in
    // the layout — declared/both's declared half needs no I/O.
    let browsers = slice.browsers;
    const effects = [];
    const seen = new Set();
    for (const panel of _allPanels()) {
      if (!OWNED_TYPES.includes(panel.type) || seen.has(panel.type)) continue;
      seen.add(panel.type);
      const panelType = panel.type;
      const source = _source(panelType, _hardcodedFor(panelType));
      if (source === 'declared') continue;
      if (source === 'docker' && !panel.container) {
        browsers = { ...browsers, [panelType]: {
          ..._newBrowser(), ...browsers[panelType],
          items: [], loading: false,
          lastError: 'source: docker requires `container:` on the panel',
        } };
        continue;
      }
      const b = browsers[panelType] || _newBrowser();
      const { next, effect } = _kickLoad(b, panel, source, panelType, panel.container);
      browsers = { ...browsers, [panelType]: next };
      effects.push(effect);
    }
    if (effects.length === 0) return slice;
    return [{ ...slice, browsers }, effects];
  }

  if (msg.type === 'dirLoaded') {
    const b = slice.browsers[msg.panelType];
    // Stale guard: a since-superseded load (navigated away) drops its result.
    if (!b || msg.seq !== b.seq) return slice;
    const next = { ...b, items: msg.items || [], loading: false, lastError: msg.error || null };
    return [{ ...slice, browsers: { ...slice.browsers, [msg.panelType]: next } }, [{ type: 'render' }]];
  }

  if (msg.type === 'showHidden') {
    // Fan out across every files-style slot (toggle is global from the user's
    // perspective). Pre-seed the canonical types so the toggle works before
    // the user has visited either panel. No re-list — the projection re-gates.
    const browsers = { ...slice.browsers };
    for (const pt of OWNED_TYPES) if (!browsers[pt]) browsers[pt] = _newBrowser();
    for (const k of Object.keys(browsers)) {
      const b = browsers[k];
      const sh = msg.mode === 'on' ? true : msg.mode === 'off' ? false : !b.showHidden;
      browsers[k] = { ...b, showHidden: sh };
    }
    return [{ ...slice, browsers }, [{ type: 'render' }]];
  }

  if (msg.type === 'key') return _handleKey(msg, slice);
  return slice;
}

/**
 * Enter is the only key the Component owns — the handler returns the
 * `_claimed` sentinel effect to suppress the framework's run_selected
 * default. Cursor navigation is framework chrome (Phase 4a moved it
 * onto this Component's slice.nav[panelType], written by the wrapped
 * set_cursor Msg the global j/k path emits). The key Msg carries no
 * selected row — re-derive it from the slice + cursor, the same way
 * list render() does.
 */
function _handleKey(msg, slice) {
  if (msg.key !== 'return') return slice;
  // Pure key arm — msg.focusKind is the focused pane's panel-type
  // (threaded by dispatchKeyToFocused; equals paneTypeOf(getFocus())
  // for the focused pane); the cursor comes from slice.nav via the
  // nav leaf. No getFocus()/getSel() global reads. A non-owned focus
  // falls through to `return slice`, same as the old paneId fallback.
  const panelType = msg.focusKind;
  if (!OWNED_TYPES.includes(panelType)) return slice;
  const hardcoded = _hardcodedFor(panelType);
  const item = _itemsFor(slice, panelType, hardcoded)[mnav.cursorOf(slice, panelType)];
  // `return` is claimed even when the row resolves to nothing actionable
  // (no item / loading) — the framework default would just call back
  // into the panel with no useful result.
  if (!item || item.kind === 'loading') return [slice, [{ type: '_claimed' }]];
  if (item.kind === 'parent' || item.kind === 'dir') {
    const source = _source(panelType, hardcoded);
    const panel = _panelOf(panelType) || {};
    const b = slice.browsers[panelType] || _newBrowser();
    // Navigation forces a fresh cwd, so seed the load directly from item.path.
    const { next, effect } = _kickLoad({ ...b, cwd: item.path }, panel, source, panelType, panel.container);
    return [
      { ...slice, browsers: { ...slice.browsers, [panelType]: next } },
      [effect, { type: 'resetPanelChrome', panel: panelType }, { type: '_claimed' }],
    ];
  }
  // declared / file / symlink → open in a content tab
  return [slice, [{ type: 'openFile', panelType, item }, { type: '_claimed' }]];
}

// --- effects (registered once at module load) ---

/** Build the normalized parent + dirs + files rows for a host directory.
 *  May throw (readdir on an unreadable dir) — the caller keeps the parent
 *  row navigable on error so the user isn't trapped. */
function _readDirRows(cwd) {
  const out = [];
  const parent = path.dirname(cwd);
  if (parent !== cwd) out.push({ kind: 'parent', name: '..', path: parent });
  const entries = fs.readdirSync(cwd, { withFileTypes: true });
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
    } catch { /* broken symlink / permission denied — keep inferred kind */ }
    (kind === 'dir' ? dirs : files).push({ kind, name: ent.name, path: full, size, mtime });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return out.concat(dirs, files);
}

/** Called from registerComponent after init() — replaces the
 *  pre-cleanup module-top-level registrations so test lifecycles
 *  that clear+reinstall effects can drive registration through the
 *  same path. */
function installEffects(registerEffect) {
  registerEffect('loadDir', (eff) => {
    const { panelType, source, cwd, container, seq } = eff;
    // Off-tick so a slow filesystem (NFS, sshfs) or a docker exec never blocks
    // the render/keypress tick; the result folds back via the dirLoaded Msg.
    setImmediate(async () => {
      let items = [];
      let error = null;
      try {
        if (source === 'docker') {
          const res = await dockerList(container, cwd);
          error = res.error || null;
          const parent = path.posix.dirname(cwd);
          const head = parent !== cwd ? [{ kind: 'parent', name: '..', path: parent }] : [];
          items = head.concat(res.items || []);
        } else {
          items = _readDirRows(cwd);
        }
      } catch (e) {
        error = e.message;
        const dn = source === 'docker' ? path.posix.dirname(cwd) : path.dirname(cwd);
        items = dn !== cwd ? [{ kind: 'parent', name: '..', path: dn }] : [];
      }
      require('../api').dispatchMsg(require('../api').wrap('files', { type: 'dirLoaded', panelType, cwd, seq, items, error }));
    });
  });

  registerEffect('openFile', (eff) => {
    _openFileAsTab(eff.item, eff.panelType);
  });

  // resetPanelChrome: re-home the panel's cursor/scroll/filter on
  // navigation — all live on the owning Component's `slice.nav[panel]`
  // and are written by its own update via wrapped Msgs.
  registerEffect('resetPanelChrome', (eff) => {
    const api = require('../api');
    const compName = api.getComponentOwningPanel(eff.panel);
    if (!compName) return;
    api.dispatchMsg(api.wrap(compName, { type: 'set_cursor',   panel: eff.panel, index: 0 }));
    api.dispatchMsg(api.wrap(compName, { type: 'set_scroll',   panel: eff.panel, offset: 0 }));
    api.dispatchMsg(api.wrap(compName, { type: 'clear_filter', panel: eff.panel }));
  });
}

/**
 * Phase C: delegate to the open-target scheme registry. The two schemes
 * (feature/open-file.js for host, feature/open-docker.js for docker)
 * own the load+tab+error machinery; this Component just picks which
 * scheme based on item.container / panel.source and threads per-panel
 * config (max_bytes / hex_after / label) through as opts.
 *
 * Future schemes (ssh, s3, …) automatically work for the files panel
 * once registered — no change needed here.
 */
function _openFileAsTab(item, panelType) {
  const panel = _panelOf(panelType) || {};
  const opts = {
    maxBytes: _parseSize(panel.max_bytes, DEFAULT_MAX_BYTES),
    hexAfter: _parseSize(panel.hex_after, DEFAULT_HEX_AFTER),
    label: item.name,
  };
  // A docker-source panel reads every file through panel.container; a declared
  // registry can mix host + container paths via per-entry `container:`.
  const container = item.container || (panel.source === 'docker' ? panel.container : null);
  if (container) {
    require('../../feature/open-docker').dockerOpenFileAsTab(container, item.path, opts);
  } else {
    require('../../feature/open-file').openHostFileAsTab(item.path, opts);
  }
}

// --- per-panel-type def factory ---

function _makeDef(panelType, hardcoded) {
  return {    render: (panel, w, h, slice, opts) => _renderFor(panel, w, h, slice, panelType, hardcoded, opts),
    getItems: (slice) => _itemsFor(slice, panelType, hardcoded),
    getInfo: (item) => _getInfoFor(item, panelType, hardcoded),
    copyOptions: (item) => _copyOptionsFor(item, panelType),
    filterable: true,
    customFilter: true,
    filterText: (it) => it.name || it.path || '',
    idOf: (it) => it.path,
    // Enter is owned in update() (navigate / open) — suppress the framework
    // default (run_selected / viewer_show_info) for it.
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
    run: (args) => {
      const arg = ((args && args[0]) || '').toLowerCase();
      const mode = arg === 'on' ? 'on' : arg === 'off' ? 'off' : 'toggle';
      require('../api').dispatchMsg(require('../api').wrap('files', { type: 'showHidden', mode }));
    },
  },
];

module.exports = {
  name: 'files',
  init,
  update,
  installEffects,
  panelTypes: {
    files:          _makeDef('files', null),
    'file-browser': _makeDef('file-browser', 'filesystem'),
  },
  commands,
  // Exposed for unit tests; not part of the public contract.
  _init: init,
  _update: update,
  _itemsFor,
  _readDirRows,
};
