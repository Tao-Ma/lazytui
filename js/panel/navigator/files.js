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
 *   { paneId, browser: { cwd, showHidden, lastError, items, loading, seq },
 *     nav: { cursor, scroll, multiSel, filter } }
 *
 * v0.6.4 Theme A Phase 5 Arc 2 — one instance per placed pane (minted
 * per-paneId in state.js, including the `file-browser` panelType, which
 * resolves to this Component via the panel-type → owner table). Each
 * instance carries exactly ONE `browser` and ONE `nav` entry; the slice
 * stamps its own `paneId` (via `init(paneId)`) so every path — render
 * (`panel`), getItems/key (`slice.paneId`), the broadcast `refresh`
 * (`slice.paneId`, no call-site id), and getInfo/copyOptions (focused
 * paneId threaded from the call site) — resolves "my pane" without a
 * "first pane of this type" guess. The pre-Arc-2 design keyed a
 * `browsers[panelType]` / `nav[panelType]` MAP off one shared instance
 * (the only thing then separating a `files` pane from a `file-browser`
 * pane); two same-type panes collided on the primary. The map is gone.
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

const { getModel } = require('../../model/store');
const mnav = require('../../leaves/wm/nav');
const route = require('../../panel/route');
const {
  esc, visibleLen, theme, renderPanel,
  getSel, getScroll, getFilter, isMultiSel,
  getInstanceSlice,
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
  return require('../../leaves/wm/pool').allPanesInColumns(ly);
}

/** Resolve THIS instance's pane config by its paneId (the slice stamps
 *  it via init(paneId)). Replaces the pre-Arc-2 `_panelOf(panelType)`
 *  "first pane of this type" guess, which collapsed two same-type panes
 *  onto one. Returns null for the degenerate no-paneId singleton (the
 *  register-time slice, disposed once real panes mint) + tests. */
function _paneById(paneId) {
  if (!paneId) return null;
  return _allPanels().find(p => p.paneId === paneId) || null;
}

/** Resolve effective `source` for a pane (hardcoded alias wins, else the
 *  pane's `source:`, else filesystem). */
function _source(panel, hardcoded) {
  if (hardcoded) return hardcoded;
  return (panel && panel.source) || 'filesystem';
}

function _resolveInitialCwd(panel, source, projectDir) {
  // Docker roots are container-side absolute POSIX paths — pass through
  // verbatim (no host-side resolution) or default to '/'.
  if (source === 'docker') {
    if (panel && typeof panel.root === 'string' && panel.root) return panel.root;
    return '/';
  }
  // `projectDir` is the resolved base, threaded in by augmentMsg (was
  // getModel().projectDir || process.cwd()) so the reducer stays pure.
  const base = projectDir;
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
  const { safeRegex } = require('../../leaves/text/regex-guard');
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
// PURE — the filtered item list from the slice + an explicit facts bundle
// ({ panel, declaredItems, filter }) instead of global reads. The reducer's
// key arm calls this with msg.filesModel (threaded by augmentMsg).
function _itemsForFrom(slice, panelType, hardcoded, bundle) {
  const panel = bundle.panel;
  const source = _source(panel, hardcoded);
  const b = slice.browser || {};
  const showHidden = !!b.showHidden;
  const hideDot = (it) => showHidden || it.kind === 'parent' || it.kind === 'loading' || !it.name.startsWith('.');

  let items;
  if (source === 'declared') {
    items = bundle.declaredItems;
  } else if (source === 'both') {
    const declared = bundle.declaredItems
      .filter(it => showHidden || !path.basename(it.path).startsWith('.'));
    const fsRows = b.items == null ? [LOADING_ROW] : b.items.filter(hideDot);
    items = declared.concat(fsRows);
  } else { // filesystem | docker
    if (source === 'docker' && !(panel || {}).container) {
      items = [];
    } else if (b.items == null) {
      items = [LOADING_ROW];
    } else {
      items = b.items.filter(hideDot);
    }
  }
  return _matchesFilter(items, bundle.filter);
}

// Shell/render-side wrapper — reads the live globals. NOT for the reducer:
// the key arm uses _itemsForFrom(…, msg.filesModel). Used by render() +
// the `getItems` def option.
function _itemsFor(slice, panelType, hardcoded) {
  return _itemsForFrom(slice, panelType, hardcoded, {
    panel: _paneById(slice.paneId),
    declaredItems: _declaredItems(),
    filter: getFilter(slice.paneId),
  });
}

// Msg-enrichment hook (dispatch/runtime/loop _runInstance / dispatchKeyToFocused). The
// impure shell computes the per-pane facts the reducer needs — its pane def,
// the resolved project base, the declared item rows, and the effective filter
// — so update() stays pure of getModel()/getInstanceSlice()/getFilter().
// `slice` is THIS instance's slice (paneId-stamped), so multi-pane files
// resolve independently.
function augmentMsg(msg, model, slice) {
  const paneId = slice && slice.paneId;
  return {
    ...msg,
    filesModel: {
      panel: _paneById(paneId),
      projectDir: model.projectDir || process.cwd(),
      declaredItems: _declaredItems(),
      filter: getFilter(paneId),
    },
  };
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

function _getInfoFor(item, paneId, hardcoded) {
  const slice = route.sliceForPane(paneId, 'files') || { browser: {} };
  const b = slice.browser || {};
  const panel = _paneById(paneId);
  const source = _source(panel, hardcoded);
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

function _copyOptionsFor(item, paneId) {
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
    const panel = _paneById(paneId) || {};
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
  // v0.6.4 Theme A Phase 5 — per-pane nav reads (panel.paneId) + per-pane
  // focus (opts.focused). Arc 2: the per-pane `slice` carries one `browser`
  // + one `nav` entry; source/cwd resolve from THIS `panel`, never a
  // first-of-type guess.
  const sel = getSel(panel.paneId);
  const isFocused = !!(opts && opts.focused);
  const t = theme();
  const source = _source(panel, hardcoded);
  const lines = items.map((it, i) => {
    const isSel = i === sel && isFocused;
    let marker;
    if (it.kind === 'parent')        marker = '↩ ';
    else if (it.kind === 'dir')      marker = '▸ ';
    else if (it.kind === 'loading')  marker = '⋯ ';
    else if (it.kind === 'declared') marker = source === 'both' ? '★ ' : '  ';
    else                              marker = '  ';
    const sizeStr = (it.kind === 'file' || it.kind === 'symlink') ? _formatSize(it.size || 0) : '';
    const ms = it.kind === 'loading' ? ' ' : (isMultiSel(panel.paneId, it.path) ? '*' : ' ');
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

  const filterText = getFilter(panel.paneId);
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
    scrollOffset: getScroll(panel.paneId),
    chrome: opts && opts.chrome,
  });
}

// --- update + effects (the TEA half) ---

function init(paneId) {
  return {
    // v0.6.4 Theme A Phase 5 Arc 2 — the slice self-identifies. state.js
    // mints one instance per placed pane and passes its paneId here, so
    // every update/getItems path (incl. the broadcast `refresh`, which
    // gets no call-site id) resolves "my pane" from the slice. null for
    // the register-time singleton (disposed once real panes mint).
    paneId: paneId || null,
    // One browser + one nav entry per instance — the per-panelType maps
    // collapsed out (each pane is now its own instance).
    browser: _newBrowser(),
    nav: mnav.init(),
  };
}

/** Each refresh / navigation produces a fresh load with a bumped seq so a
 *  result from an abandoned cwd (user navigated away mid-flight) is dropped
 *  by the dirLoaded stale guard rather than clobbering the current listing. */
function _kickLoad(b, panel, source, paneId, container, projectDir) {
  const cwd = b.cwd || _resolveInitialCwd(panel, source, projectDir);
  const seq = (b.seq || 0) + 1;
  const next = { ...b, cwd, items: null, loading: true, seq, lastError: null };
  const effect = { type: 'loadDir', paneId, source, cwd, container: container || null, seq };
  return { next, effect };
}

function update(msg, slice) {
  // Phase 4a — nav chrome Msgs handled by the shared leaf.
  if (mnav.isNavMsg(msg)) return mnav.apply(slice, msg);
  if (msg.type === 'refresh') {
    // Boot + explicit `r`/`:refresh` (refreshAll dispatches refresh; the
    // periodic loop does not). Broadcast → one update per instance; each
    // re-lists ONLY its own pane (resolved from slice.paneId). declared /
    // both's declared half needs no I/O.
    const fm = msg.filesModel || {};
    const panel = fm.panel;
    if (!panel || !OWNED_TYPES.includes(panel.type)) return slice;
    const hardcoded = _hardcodedFor(panel.type);
    const source = _source(panel, hardcoded);
    if (source === 'declared') return slice;
    if (source === 'docker' && !panel.container) {
      return [{ ...slice, browser: {
        ..._newBrowser(), ...slice.browser,
        items: [], loading: false,
        lastError: 'source: docker requires `container:` on the panel',
      } }, [{ type: 'render' }]];
    }
    const { next, effect } = _kickLoad(slice.browser, panel, source, slice.paneId, panel.container, fm.projectDir);
    return [{ ...slice, browser: next }, [effect]];
  }

  if (msg.type === 'dirLoaded') {
    const b = slice.browser;
    // Stale guard: a since-superseded load (navigated away) drops its result.
    if (!b || msg.seq !== b.seq) return slice;
    const next = { ...b, items: msg.items || [], loading: false, lastError: msg.error || null };
    return [{ ...slice, browser: next }, [{ type: 'render' }]];
  }

  if (msg.type === 'showHidden') {
    // Per-instance toggle. The :show-hidden command fans this Msg out to
    // every files/file-browser instance (global from the user's view);
    // each instance flips its own browser. No re-list — the projection
    // re-gates dotfiles.
    const b = slice.browser;
    const sh = msg.mode === 'on' ? true : msg.mode === 'off' ? false : !b.showHidden;
    return [{ ...slice, browser: { ...b, showHidden: sh } }, [{ type: 'render' }]];
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
  // Pure key arm — all global facts arrive via msg.filesModel (threaded by
  // augmentMsg in the shell): the pane def, the declared items, the filter,
  // the project base. The cursor comes from slice.nav via the nav leaf. No
  // getFocus()/getSel()/getModel()/getInstanceSlice() reads. A non-owned /
  // unresolved pane falls through to `return slice`.
  const fm = msg.filesModel || {};
  const panel = fm.panel;
  if (!panel || !OWNED_TYPES.includes(panel.type)) return slice;
  const panelType = panel.type;
  const hardcoded = _hardcodedFor(panelType);
  const item = _itemsForFrom(slice, panelType, hardcoded, fm)[mnav.cursorOf(slice, panelType)];
  // `return` is claimed even when the row resolves to nothing actionable
  // (no item / loading) — the framework default would just call back
  // into the panel with no useful result.
  if (!item || item.kind === 'loading') return [slice, [{ type: '_claimed' }]];
  if (item.kind === 'parent' || item.kind === 'dir') {
    const source = _source(panel, hardcoded);
    // Navigation forces a fresh cwd, so seed the load directly from item.path.
    const { next, effect } = _kickLoad({ ...slice.browser, cwd: item.path }, panel, source, slice.paneId, panel.container, fm.projectDir);
    return [
      { ...slice, browser: next },
      [effect, { type: 'resetPanelChrome', paneId: slice.paneId }, { type: '_claimed' }],
    ];
  }
  // declared / file / symlink → open in a content tab
  return [slice, [{ type: 'openFile', paneId: slice.paneId, item }, { type: '_claimed' }]];
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
  registerEffect('loadDir', (eff, host) => {
    const { paneId, source, cwd, container, seq } = eff;
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
      // Wrap to the ORIGINATING paneId so the result lands on the pane
      // that kicked the load — not the kind's primary (wrap('files') would
      // route to _primaryByKind, clobbering the wrong pane under
      // multi-instance). The instance store resolves a paneId directly.
      host.dispatchMsg(host.wrap(paneId, { type: 'dirLoaded', cwd, seq, items, error }));
    });
  });

  registerEffect('openFile', (eff) => {
    _openFileAsTab(eff.item, eff.paneId);
  });

  // resetPanelChrome: re-home the pane's cursor/scroll/filter on
  // navigation — they live on this instance's single `slice.nav` entry,
  // written by its own update via wrapped Msgs targeting the paneId.
  registerEffect('resetPanelChrome', (eff, host) => {
    if (!require('../api').getComponentOwningPanel(eff.paneId)) return;
    host.dispatchMsg(host.wrap(eff.paneId, { type: 'set_cursor',   panel: eff.paneId, index: 0 }));
    host.dispatchMsg(host.wrap(eff.paneId, { type: 'set_scroll',   panel: eff.paneId, offset: 0 }));
    host.dispatchMsg(host.wrap(eff.paneId, { type: 'clear_filter', panel: eff.paneId }));
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
function _openFileAsTab(item, paneId) {
  const panel = _paneById(paneId) || {};
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
    // getInfo/copyOptions get the FOCUSED paneId threaded from the call
    // site (viewer / copy overlay) — they receive no slice, so the paneId
    // is how they resolve which pane's browser + config to read.
    getInfo: (item, paneId) => _getInfoFor(item, paneId, hardcoded),
    copyOptions: (item, paneId) => _copyOptionsFor(item, paneId),
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
      const panelHost = require('../../ports/panel-host');
      // Fan out to every files/file-browser instance — global from the
      // user's view, but each pane owns its own browser slice post-collapse
      // (wrap('files') would hit only the primary instance).
      let any = false;
      route.eachInstance(inst => {
        if (!OWNED_TYPES.includes(inst.kind)) return;
        any = true;
        panelHost.dispatchMsg(route.wrap(inst.id, { type: 'showHidden', mode }));
      });
      // Degenerate: no placed instance yet — hit the register-time primary.
      if (!any) panelHost.dispatchMsg(route.wrap('files', { type: 'showHidden', mode }));
    },
  },
];

module.exports = {
  name: 'files',
  init,
  update,
  augmentMsg,
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
