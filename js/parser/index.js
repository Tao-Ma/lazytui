/**
 * TUI YAML config parser — validates and resolves config into JSON
 * shape consumed by state.js. Mirrors parser/__init__.py exactly so
 * the JS port is a drop-in replacement for the Python CLI.
 *
 * The output shape is the same dict that `asdict(ParsedConfig)`
 * produced on the Python side — see parser/runnable.py for the
 * dataclass definitions that defined the schema.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const { ParseError } = require('./errors');
const { validate } = require('./schema');
const { passthroughCmd, resolveScript } = require('./resolver');

const { LEFT_HOTKEY_POOL, RIGHT_HOTKEY_POOL, hotkeyPoolForColumn } = require('../leaves/input/hotkeys');
const mpane = require('../leaves/wm/pane');
const mpool = require('../leaves/wm/pool');

// Reserved layout keys consumed by the framework; everything else
// passes through as plugin-specific panel config (e.g. stats panel's
// `topic`, `select_from`).
const RESERVED_PANEL_KEYS = new Set(['type', 'title', 'hotkey', 'height', 'id']);

// v0.6 pool model — a `panels:` top-level block declares panels as a
// mapping of id → {type, title?, ...config}. Layout cells reference
// pool entries by id (string or `{id, ...placement-overrides}`).
// Placement-only fields aren't allowed at the pool level; they belong
// on the cell.
const RESERVED_POOL_KEYS = new Set(['type', 'title']);
const PLACEMENT_ONLY_KEYS = new Set(['hotkey', 'height', 'heightPct', 'collapsed']);

function assignHotkeys(panelsYaml, pool, sideLabel) {
  const explicit = new Map();
  const seen = new Map();   // key → first index that claimed it
  for (let i = 0; i < panelsYaml.length; i++) {
    if (!panelsYaml[i].hotkey) continue;
    const key = String(panelsYaml[i].hotkey);
    if (seen.has(key)) {
      throw new ParseError(`${sideLabel} declares hotkey '${key}' twice (cells ${seen.get(key)} and ${i})`);
    }
    seen.set(key, i);
    explicit.set(i, key);
  }
  const used = new Set(explicit.values());
  const available = pool.filter(k => !used.has(k));
  const out = [];
  for (let i = 0; i < panelsYaml.length; i++) {
    if (explicit.has(i))    out.push(explicit.get(i));
    else if (available.length) out.push(available.shift());
    else                    out.push('');
  }
  return out;
}


function titleCase(s) {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Build a normalized pool entry from a raw YAML mapping.
 *
 * Pool entries hold panel IDENTITY (type, title, plugin-specific config).
 * Placement-only fields (hotkey, height, heightPct) raise — they belong
 * on the layout cell, not the pool. Synthesized entries (from legacy
 * inline `{type:}` cells) carry `_synthesized: true` so Phase 6's
 * `:save-layout` can preserve the inline form unless the pool was
 * explicitly mutated.
 */
function normalizePoolEntry(id, raw, synthesized) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ParseError(`panels.${id}: must be a mapping`);
  }
  if (typeof raw.type !== 'string' || !raw.type) {
    throw new ParseError(`panels.${id}: missing required field 'type'`);
  }
  const config = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'id' || RESERVED_POOL_KEYS.has(k)) continue;
    if (PLACEMENT_ONLY_KEYS.has(k)) {
      throw new ParseError(`panels.${id}: '${k}' is a placement field; put it on the layout cell, not the pool entry`);
    }
    config[k] = v;
  }
  const entry = {
    id,
    type: raw.type,
    title: raw.title || titleCase(raw.type),
    config,
  };
  if (synthesized) entry._synthesized = true;
  return entry;
}

/**
 * Parse the top-level `panels:` block (the v0.6 pool). Returns a Map
 * id → entry. Empty / absent block yields an empty map; layout cells
 * may still synthesize entries into it. Map (not plain object) so the
 * downstream layout pass can mutate it as it walks cells.
 */
function parsePool(panelsData) {
  const pool = new Map();
  if (panelsData === undefined || panelsData === null) return pool;
  if (typeof panelsData !== 'object' || Array.isArray(panelsData)) {
    throw new ParseError("'panels:' must be a mapping of id → { type, ... }");
  }
  for (const [id, entry] of Object.entries(panelsData)) {
    if (typeof id !== 'string' || !id) {
      throw new ParseError("'panels:' entry id must be a non-empty string");
    }
    pool.set(id, normalizePoolEntry(id, entry, /*synthesized*/ false));
  }
  return pool;
}

function pickPlacement(raw) {
  const out = {};
  if (raw.hotkey !== undefined)    out.hotkey    = String(raw.hotkey);
  if (raw.heightPct !== undefined) out.heightPct = raw.heightPct;
  if (raw.height !== undefined)    out.height    = raw.height;
  if (raw.collapsed !== undefined) out.collapsed = !!raw.collapsed;
  return out;
}

/**
 * Normalize one layout cell into `{ tabPoolIds, placement, activeTab? }`.
 *
 * v0.6.1 form:
 *   - bare string         → single-tab pane shorthand (single pool-id ref)
 *   - { tabs: [id, ...] } → multi-tab pane, optional activeTab, plus
 *                           placement-only fields (hotkey/height/etc.)
 *
 * Pool entries must already exist (declared in top-level `panels:`).
 * Throws on unresolvable refs.
 */
function resolveLayoutCell(raw, pool) {
  if (typeof raw === 'string') {
    if (!pool.has(raw)) {
      throw new ParseError(`layout cell references unknown panel id '${raw}'`);
    }
    return { tabPoolIds: [raw], placement: {}, activeTab: raw };
  }
  // Schema layer already rejected v0.6 cell shapes; this is the
  // happy-path mapping form.
  const tabs = raw.tabs.slice();
  for (const tid of tabs) {
    if (!pool.has(tid)) {
      throw new ParseError(`layout cell references unknown pool id '${tid}'`);
    }
  }
  return {
    tabPoolIds: tabs,
    placement: pickPlacement(raw),
    activeTab: raw.activeTab || tabs[0],
  };
}

/** Serialize the pool Map into a plain object for the parser output. */
function poolToObject(pool) {
  const out = {};
  for (const [id, entry] of pool) out[id] = entry;
  return out;
}

/**
 * Build a placed pane object from a resolved cell + pool.
 *
 * The pane carries `tabs` (array of {id, poolId} for every tab in the
 * cell) + `activeTabId` (currently focused tab) + `paneId` (slot
 * identity). For multi-tab panes the active tab's pool entry populates
 * the legacy top-level Panel fields (`id, type, title, config`) so
 * Phase 1-8 readers that pull `p.type` keep working until Phase 10.
 *
 * The `height` placement-only field is detail-pane-only — becomes
 * detail_height_pct via the caller's setter.
 */
function buildPlacedPane(resolved, hotkey, columnIndex, detailHeightSetter, pool) {
  const tabIds = resolved.tabPoolIds;
  const placement = resolved.placement;
  const activeTabPoolId = resolved.activeTab;

  // Tab entries — one per pool id in the cell. The schema validator
  // already checked that all tab pool ids exist + activeTab is one of
  // them, so we trust the input here.
  const tabs = tabIds.map(pid => ({ id: pid, poolId: pid }));
  const active = pool.get(activeTabPoolId);

  // detail can't be collapsed — the runtime reducer refuses. Reject at
  // parse time so a hand-edited YAML doesn't land in an inconsistent
  // visual state.
  if (mpool.isDetailPane(active) && placement.collapsed === true) {
    throw new ParseError(`layout cell '${activeTabPoolId}': detail panel can't be collapsed`);
  }
  // Detail height. The `height: X%` cell form is detail-only. v0.6.4
  // unified detail height onto the per-pane `heightPct` field (every
  // other pane already self-describes its height that way) — so we set
  // BOTH: `detail_height_pct` stays as the layout-level default seed for
  // newly-spawned detail panes, and `pane.heightPct` makes THIS detail
  // pane self-contained so two detail panes can carry independent
  // heights. Captured here, applied to the pane after it's built below.
  let detailHeightPct;
  if (mpool.isDetailPane(active) && placement.height !== undefined) {
    const h = placement.height;
    if (typeof h === 'string' && h.endsWith('%')) {
      detailHeightPct = parseInt(h.slice(0, -1), 10);
    } else if (typeof h === 'number' && Number.isInteger(h)) {
      detailHeightPct = h;
    }
    if (detailHeightPct !== undefined) detailHeightSetter(detailHeightPct);
  }
  const pane = {
    // Legacy Panel fields populated from the active tab's pool entry.
    // Phase 10 may retire these in favor of always going through
    // firstTab(pane) / activePoolId(pane); Phase 9 keeps them so the
    // wide intermediate form remains valid.
    id: active.id,
    type: active.type,
    title: active.title,
    hotkey,
    columnIndex,
    config: active.config,
    // Pane fields (v0.6.1 canonical).
    paneId: mpane.newPaneId(activeTabPoolId),
    tabs,
    activeTabId: activeTabPoolId,
  };
  if (placement.heightPct !== undefined) pane.heightPct = placement.heightPct;
  // Detail's `height: X%` becomes the same self-describing heightPct
  // every other pane uses (v0.6.4). Set last so an explicit `height:`
  // wins over any stray heightPct on a detail cell.
  if (detailHeightPct !== undefined) pane.heightPct = detailHeightPct;
  if (placement.collapsed === true)      pane.collapsed = true;
  return pane;
}

function defaultLayout(hasContainers, hasFiles, userPool) {
  const pool = new Map();
  const firstColPanels = [];
  let hk = 1;
  const addDefault = (id, type, title, columnIndex, hotkey, extra) => {
    const entry = { id, type, title, config: extra || {}, _synthesized: true };
    pool.set(id, entry);
    return mpane.wrapAsPane(
      { id, type, title, hotkey, columnIndex, config: entry.config },
      mpane.newPaneId(id),
    );
  };
  if (hasContainers) {
    firstColPanels.push(addDefault('containers', 'containers', 'Containers', 0, String(hk++)));
  }
  firstColPanels.push(addDefault('groups', 'groups', 'Groups', 0, String(hk++)));
  if (hasFiles) {
    firstColPanels.push(addDefault('files', 'files', 'Files', 0, String(hk++), { source: 'declared' }));
  }
  const lastColPanels = [
    addDefault('actions', 'actions', 'Actions', 1, '7'),
    addDefault('detail',  'detail',  'Detail',  1, '8'),
  ];
  // Merge user-declared pool entries (from a top-level `panels:` block
  // that the YAML had without a matching `layout:`). Without this, the
  // user's entries would be silently dropped — surface them as HIDDEN
  // pool entries (available via the `w` overlay), since the default
  // layout doesn't know where to place them. Default entries win on
  // id collision; the user entry would have been visible through the
  // pool anyway if they'd written a layout block.
  if (userPool) {
    for (const [id, entry] of userPool) {
      if (!pool.has(id)) pool.set(id, entry);
    }
  }
  return {
    columns: [
      { width: 30, panels: firstColPanels },
      { panels: lastColPanels },
    ],
    detail_height_pct: 60,
    pool: poolToObject(pool),
  };
}

function parseLayout(layoutData, _hasContainers, _hasFiles, userPool) {
  const columnsYaml = layoutData.columns;
  let detailHeightPct = 60;
  const setDetailHeight = (n) => { detailHeightPct = n; };

  // v0.6.1: every pool entry is declared in the top-level `panels:`
  // block before parseLayout runs. Cells only reference them; the pool
  // is no longer mutated by resolveLayoutCell.
  const pool = userPool || new Map();

  const N = columnsYaml.length;
  // Resolve each column's cells through the pool. Width threads through
  // as-is; the last column's width is ignored at paint time (it takes
  // the remainder).
  const resolvedColumns = columnsYaml.map(col => ({
    width: col.width !== undefined ? col.width : null,
    resolved: (col.panels || []).map(c => resolveLayoutCell(c, pool)),
  }));

  // Cross-cell pool-id uniqueness — every pool entry has exactly one
  // home in the placed grid. Two cells referencing the same id would
  // produce two distinct panes wrapping the same pool entry, with all
  // the surprises that come from one pool entry having two identities
  // (`:hide` ambiguity, double-mount of stateful viewers, etc.).
  // Multi-tab cells reference multiple ids — the check walks every
  // tab pool id across every cell.
  const seenPoolId = new Map();  // poolId → "column N pane M"
  for (let ci = 0; ci < N; ci++) {
    const cells = resolvedColumns[ci].resolved;
    for (let pi = 0; pi < cells.length; pi++) {
      for (const tid of cells[pi].tabPoolIds) {
        if (seenPoolId.has(tid)) {
          throw new ParseError(
            `panel id '${tid}' placed in two cells: ${seenPoolId.get(tid)} and column ${ci} pane ${pi}`,
          );
        }
        seenPoolId.set(tid, `column ${ci} pane ${pi}`);
      }
    }
  }

  // Hotkey assignment runs against placement-level hotkey overrides per
  // column. First column gets LEFT_HOTKEY_POOL, last gets RIGHT — middle
  // columns get no auto-pool (user must specify explicit hotkeys).
  const columnsKeys = resolvedColumns.map((c, ci) =>
    assignHotkeys(
      c.resolved.map(r => r.placement),
      hotkeyPoolForColumn(ci, N),
      `column ${ci}`,
    ),
  );

  // Cross-column collision check — only one panel can answer to a given
  // hotkey in normal-mode dispatch. Explicit hotkeys can claim ANY key
  // (not just the per-column pool), so a column-0 cell with `hotkey: '7'`
  // and a last-column cell that auto-picks '7' would collide silently.
  const seenKey = new Map();
  for (let ci = 0; ci < N; ci++) {
    for (const k of columnsKeys[ci]) {
      if (!k) continue;
      if (seenKey.has(k)) {
        throw new ParseError(`hotkey '${k}' claimed by both column ${seenKey.get(k)} and column ${ci}`);
      }
      seenKey.set(k, ci);
    }
  }

  const columns = resolvedColumns.map((c, ci) => ({
    width: c.width,
    panels: c.resolved.map((r, i) =>
      buildPlacedPane(r, columnsKeys[ci][i], ci, setDetailHeight, pool)),
  }));

  // Semantic layout invariants — restated at the TAB level (every tab
  // in every pane). With one tab per pane (today's common shape) these
  // collapse to the prior panel-level checks; with multi-tab cells the
  // invariant scales.
  const tabKinds = (pane) => pane.tabs.map(t => pool.get(t.poolId).type);
  const allTabKindsByCol = columns.map(c => c.panels.flatMap(tabKinds));
  const allTabKinds = allTabKindsByCol.flat();

  // v0.6.4 multi-viewer — the parser is the sole POLICY layer for detail
  // placement; CORE (geometry/render/routing/free-config) is now
  // count/position-agnostic. Two motivated restrictions survive; the old
  // "last column / last pane of last column" geometry rules are dropped.
  //
  // (1) At least one detail tab — there must always be a viewer to route
  //     content/search/select to (resolveTarget would otherwise no-op).
  const detailCount = allTabKinds.filter(t => t === 'detail').length;
  if (detailCount < 1) {
    throw new ParseError(`layout must have at least one tab of kind 'detail', found ${detailCount}`);
  }
  // (2) Each detail tab must be the SOLE tab in its pane — the
  //     tab→instance map for a multi-tab pane hosting a viewer doesn't
  //     exist (a real implementation gap, not geometry policy). Checked
  //     per pane across every column, not just the last.
  for (let ci = 0; ci < N; ci++) {
    for (const pane of columns[ci].panels) {
      if (pane.tabs.length > 1 && tabKinds(pane).includes('detail')) {
        throw new ParseError(`tab of kind 'detail' must be the only tab in its pane (multi-tab panes hosting detail are deferred)`);
      }
    }
  }
  const actionsCount = allTabKinds.filter(t => t === 'actions').length;
  if (actionsCount > 1) {
    throw new ParseError(`layout allows at most one tab of kind 'actions', found ${actionsCount}`);
  }
  // actions must live in the last column.
  for (let ci = 0; ci < N - 1; ci++) {
    if (allTabKindsByCol[ci].includes('actions')) {
      throw new ParseError(`tab of kind 'actions' must be in the last column, not column ${ci}`);
    }
  }

  return {
    columns,
    detail_height_pct: detailHeightPct,
    pool: poolToObject(pool),
  };
}

function mergePluginInto(main, plugin) {
  for (const [gname, gdata] of Object.entries(plugin.groups || {})) {
    if (!gdata || typeof gdata !== 'object' || Array.isArray(gdata)) continue;
    if (!main.groups) main.groups = {};
    const existing = main.groups[gname];
    if (existing === undefined) {
      main.groups[gname] = gdata;
    } else {
      for (const sub of ['actions', 'terminals', 'children']) {
        if (sub in gdata && gdata[sub] && typeof gdata[sub] === 'object' && !Array.isArray(gdata[sub])) {
          if (!(sub in existing)) existing[sub] = {};
          for (const [k, v] of Object.entries(gdata[sub])) {
            if (!(k in existing[sub])) existing[sub][k] = v;
          }
        }
      }
      if ('containers' in gdata && Array.isArray(gdata.containers)) {
        if (!('containers' in existing)) existing.containers = [];
        existing.containers.push(...gdata.containers);
      }
      for (const f of ['label', 'compose']) {
        if (f in gdata && !(f in existing)) existing[f] = gdata[f];
      }
    }
  }
  for (const [k, v] of Object.entries(plugin.vars || {})) {
    if (!main.vars) main.vars = {};
    if (!(k in main.vars)) main.vars[k] = v;
  }
  for (const [k, v] of Object.entries(plugin.helpers || {})) {
    if (!main.helpers) main.helpers = {};
    if (!(k in main.helpers)) main.helpers[k] = v;
  }
  if (Array.isArray(plugin.files)) {
    if (!main.files) main.files = [];
    main.files.push(...plugin.files);
  }
}

// A `plugins:` entry is a YAML config split (still supported in v0.5)
// when it's a well-formed mapping whose `path:` ends in `.yml`/`.yaml`.
// Anything else — a non-yaml path, a malformed entry, a string scalar —
// would have been a runtime Plugin API entry under the retired API.
function isYamlSplitEntry(conf) {
  if (!conf || typeof conf !== 'object' || Array.isArray(conf)) return false;
  const p = typeof conf.path === 'string' ? conf.path : '';
  return p.endsWith('.yml') || p.endsWith('.yaml');
}

// Names of `plugins:` entries that AREN'T config splits — the warning
// surface for tui.js boot. Pure; no side effects; tested directly.
function retiredPluginEntries(plugins) {
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return [];
  return Object.keys(plugins).filter(name => !isYamlSplitEntry(plugins[name]));
}

function mergeYamlPlugins(data, baseDir) {
  // T19 note: pluginPath is resolved relative to the source YAML's
  // directory. Path traversal (`../foo.yml`) is by design — configs
  // are user-owned and a project may share helpers / vars across
  // multiple YAMLs in a parent directory. The .yml/.yaml extension
  // guard inside isYamlSplitEntry blocks the obvious "read /etc/passwd"
  // misuse; beyond that, the user's filesystem boundaries are their concern.
  const plugins = data.plugins;
  if (!plugins || typeof plugins !== 'object' || Array.isArray(plugins)) return;
  for (const [name, conf] of Object.entries(plugins)) {
    if (!isYamlSplitEntry(conf)) continue;
    const pluginPath = conf.path;
    const full = path.resolve(baseDir, pluginPath);
    let text;
    try {
      text = fs.readFileSync(full, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') throw new ParseError(`plugin yaml not found: ${full}`);
      throw new ParseError(`cannot read plugin yaml '${name}': ${e.message}`);
    }
    let pdata;
    try {
      pdata = yaml.load(text) || {};
    } catch (e) {
      throw new ParseError(`invalid YAML in plugin '${name}': ${e.message}`);
    }
    if (!pdata || typeof pdata !== 'object' || Array.isArray(pdata)) {
      throw new ParseError(`plugin '${name}' must be a YAML mapping`);
    }
    mergePluginInto(data, pdata);
    if (!data.files) data.files = [];
    data.files.push({ path: pluginPath, desc: `TUI plugin: ${name}` });
  }
}

function generateConfigCopyTo(files) {
  const lines = [];
  const dirs = new Set();
  for (const cf of files) {
    const p = cf.path;
    if (p.endsWith('/')) {
      dirs.add(p.replace(/\/+$/, ''));
    } else if (p.includes('*')) {
      dirs.add(path.dirname(p));
    } else {
      dirs.add(path.dirname(p));
    }
  }
  if (dirs.size) {
    const dirArgs = [...dirs].sort().map(d => `"$COPY_DST/${d}"`).join(' ');
    lines.push(`mkdir -p ${dirArgs}`);
  }
  for (const cf of files) {
    const p = cf.path;
    if (cf.exclude && cf.exclude.length) {
      const excludes = cf.exclude.map(e => `--exclude='${e}'`).join(' ');
      lines.push(`rsync -a ${excludes} "$COPY_SRC/${p}" "$COPY_DST/${p}" 2>/dev/null || true`);
    } else if (p.endsWith('/')) {
      lines.push(`cp -a "$COPY_SRC/${p}." "$COPY_DST/${p}" 2>/dev/null || true`);
    } else if (p.includes('*')) {
      const parent = path.dirname(p);
      lines.push(`cp -a $COPY_SRC/${p} "$COPY_DST/${parent}/" 2>/dev/null || true`);
    } else {
      const parent = path.dirname(p);
      lines.push(`cp -a "$COPY_SRC/${p}" "$COPY_DST/${parent}/" 2>/dev/null || true`);
    }
  }
  return lines.join('\n') + '\n';
}

function walkGroups(rawGroups, varsBlock, helpersBlock, source, parent, depth, out) {
  for (const [gname, gdata] of Object.entries(rawGroups)) {
    const groupPath = parent ? `${parent}.${gname}` : gname;
    // T19 — flat dotted-name `"a.b":` collides with nested
    // `a: { children: { b: ... } }` at the same dotted path. Pre-fix
    // walkGroups silently overwrote on collision (last write wins,
    // user's earlier-declared group vanished). Detect + throw cleanly.
    if (groupPath in out) {
      throw new ParseError(`duplicate group path '${groupPath}' (declared both as a flat key and a nested child)`);
    }
    const containers = gdata.containers || [];

    const actions = {};
    if ('actions' in gdata) {
      for (const [aname, adata] of Object.entries(gdata.actions)) {
        const ctx = `group '${groupPath}', action '${aname}'`;
        let script, varsUsed, helpersUsed;
        if ('cmd' in adata) {
          ({ script, varsUsed, helpersUsed } = passthroughCmd(adata.cmd, ctx));
        } else {
          ({ script, varsUsed, helpersUsed } = resolveScript(adata.script, varsBlock, helpersBlock, ctx));
        }
        actions[aname] = {
          group: groupPath,
          key: aname,
          label: adata.label,
          type: adata.type || 'run',
          confirm:     adata.confirm     !== undefined ? adata.confirm     : null,
          args:        adata.args        !== undefined ? adata.args        : null,
          default_cmd: adata.default_cmd !== undefined ? adata.default_cmd : null,
          desc:        adata.desc        !== undefined ? adata.desc        : null,
          tab: adata.tab === true,
          script,
          containers,
          debug: {
            source_file: source,
            action_line: -1,
            vars_used: varsUsed,
            helpers_used: helpersUsed,
            resolved_script: script,
          },
        };
      }
    }

    const terminals = {};
    for (const [tname, tdata] of Object.entries(gdata.terminals || {})) {
      terminals[tname] = { cmd: tdata.cmd, label: tdata.label };
    }

    const childPaths = ('children' in gdata)
      ? Object.keys(gdata.children).map(c => `${groupPath}.${c}`)
      : [];

    const parsedGroup = {
      name: groupPath,
      label: gdata.label,
      compose: gdata.compose !== undefined ? gdata.compose : null,
      containers,
      actions,
      terminals,
      children: childPaths,
      parent,
      depth,
      quick: !!gdata.quick,
      archive:       gdata.archive       !== undefined ? gdata.archive       : null,
      config_branch: gdata.config_branch !== undefined ? gdata.config_branch : null,
      images:        gdata.images        !== undefined ? gdata.images        : null,
    };

    // Pass through any plugin-introduced group keys the framework doesn't
    // name above, so a plugin can read its own group-level config without
    // the parser (a framework-core module) having to know about it. The
    // explicitly-handled keys win; `children` is already transformed into
    // childPaths so the raw value must not overwrite it.
    for (const [k, v] of Object.entries(gdata)) {
      if (!(k in parsedGroup) && k !== 'children') parsedGroup[k] = v;
    }
    out[groupPath] = parsedGroup;

    if ('children' in gdata) {
      walkGroups(gdata.children, varsBlock, helpersBlock, source, groupPath, depth + 1, out);
    }
  }
}

function parse(yamlPath) {
  const source = String(yamlPath);
  const absPath = path.resolve(yamlPath);

  let text;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') throw new ParseError(`config file not found: ${source}`);
    throw new ParseError(`cannot read config file: ${e.message}`);
  }

  let data;
  try {
    data = yaml.load(text);
  } catch (e) {
    throw new ParseError(`invalid YAML: ${e.message}`);
  }
  if (data === null || data === undefined) {
    throw new ParseError('config file is empty');
  }

  // Load and merge YAML plugins BEFORE validation. Resolved from the
  // directory containing the source YAML.
  mergeYamlPlugins(data, path.dirname(absPath));

  // Soft-cap warnings (column over default cap, etc.) accumulate here
  // and ride out on the returned config. tui.js boot reads them.
  const warnings = [];
  validate(data, source, warnings);

  // Build files list (before groups — auto-helper needs it).
  const files = [];
  for (const entry of (data.files || [])) {
    if (typeof entry === 'string') {
      files.push({ path: entry, var: null, desc: null, exclude: [], category: null });
    } else {
      files.push({
        path: entry.path,
        var:      entry.var      !== undefined ? entry.var      : null,
        desc:     entry.desc     !== undefined ? entry.desc     : null,
        exclude:  entry.exclude  !== undefined ? entry.exclude  : [],
        category: entry.category !== undefined ? entry.category : null,
      });
    }
  }

  const varsBlock = data.vars || {};
  const helpersBlock = { ...(data.helpers || {}) };
  const rawProjectDir = data.project_dir !== undefined ? data.project_dir : '.';

  if (files.length && !('config_copy_to' in helpersBlock)) {
    helpersBlock.config_copy_to = generateConfigCopyTo(files);
  }

  const yamlDir = path.dirname(absPath);
  const projectDir = path.resolve(yamlDir, rawProjectDir);

  const groups = {};
  walkGroups(data.groups, varsBlock, helpersBlock, source, null, 0, groups);

  const hasContainers = Object.values(groups).some(g => g.containers && g.containers.length > 0);
  const hasFiles = files.length > 0;
  const userPool = parsePool(data.panels);
  const layout = ('layout' in data)
    ? parseLayout(data.layout, hasContainers, hasFiles, userPool)
    : defaultLayout(hasContainers, hasFiles, userPool);

  return {
    project_dir: projectDir,
    groups,
    source_file: source,
    files,
    layout,
    theme: data.theme !== undefined ? data.theme : 'monokai',
    // Preserve the `plugins:` block for round-trip fidelity. The Plugin
    // API itself retired in v0.5 Phase 6; tui.js surfaces a one-time
    // warning if the field is non-empty. (YAML plugin merging — entries
    // with `.yml`/`.yaml` paths — still happens above via
    // `mergeYamlPlugins`; that's a config-merge concern, not a runtime
    // hook, and stays.)
    plugins: data.plugins !== undefined ? data.plugins : {},
    // Yank-register config (top-level `register: { cap: N }`). state.js
    // forwards this to register.init() at boot. Default cap (100) is
    // applied inside register.init() when this block is absent.
    register: data.register !== undefined ? data.register : {},
    // Leader-key bindings (top-level `keys:`). dispatch.loadKeyBindings
    // registers each entry into the prefix-key tree at boot. Default
    // empty — the built-in chords are registered unconditionally.
    keys: data.keys !== undefined ? data.keys : {},
    // Mouse gesture → intent overrides (top-level `mouse:`). v0.6.4 Theme F:
    // dispatch.loadMouseBindings merges these over the code defaults at boot.
    // Default empty — the built-in gesture map applies unchanged.
    mouse: data.mouse !== undefined ? data.mouse : {},
    // Extra right-click context-menu entries (top-level `context-menu:`).
    // v0.6.4 Theme F follow-on: dispatch.loadContextMenu hands these to the
    // context-menu registry at boot. Default empty — only the built-in
    // copy/refresh/help rows apply.
    'context-menu': data['context-menu'] !== undefined ? data['context-menu'] : [],
    // Soft-fail diagnostics from validation (today: column over soft
    // cap). tui.js boot drains these into the event log + a brief
    // chrome notice; nothing else reads them.
    warnings,
  };
}

module.exports = { parse, retiredPluginEntries };
