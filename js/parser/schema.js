/**
 * YAML schema validation for TUI config. Mirrors parser/schema.py
 * one-to-one — strict unknown-key rejection, type checks, required
 * fields. Errors carry the same message format so the JS port is a
 * drop-in replacement for the Python CLI.
 */
'use strict';

const { SchemaError } = require('./errors');

const VALID_ACTION_TYPES = new Set(['run', 'spawn', 'background']);

const VALID_TOP_KEYS    = new Set(['project_dir', 'groups', 'vars', 'helpers', 'files', 'layout', 'theme', 'plugins', 'register', 'keys', 'keymap', 'mouse', 'context-menu', 'panels']);
const VALID_KEY_BINDING_KEYS = new Set(['action', 'command', 'builtin', 'label', 'desc']);
// v0.6.7 E9 — the `keymap:` block (configurable normal-mode keys). A thin
// versioned container; `normal:` is a flat key→verb map. SHAPE only here — the
// verb-catalog / reserved-key / version-compat semantics validate at load time
// (dispatch.loadKeymap), where the catalog + reserved set live.
const VALID_KEYMAP_KEYS = new Set(['version', 'normal']);

// v0.6.4 Theme F follow-on — the `context-menu:` block (extra right-click
// entries). A list of `{ label, action|command|builtin, pane? }`; the three
// verb forms mirror `keys:` (action = a configured action short key, command =
// a `:`-cmdline command, builtin = a handleAction verb). `pane:` optionally
// gates the entry to one or more pane kinds.
const VALID_CONTEXT_MENU_KEYS = new Set(['label', 'action', 'command', 'builtin', 'pane']);

// v0.6.4 Theme F Phase 4 — the `mouse:` block (gesture → intent overrides).
// Only the three discrete button gestures + the double-click window are
// overridable today; left-click / wheel keep their code defaults. The
// realizable intent vocabulary for a button gesture is activate / context /
// noop (mirrors dispatch/control/mouse-bindings.js); it grows as new intents land
// (e.g. `paste` once a paste intent exists). Kept in sync by hand, same as
// the keys-binding verb set.
const VALID_MOUSE_KEYS    = new Set(['double-click', 'right-click', 'middle-click', 'double-click-ms']);
const VALID_MOUSE_GESTURES = new Set(['double-click', 'right-click', 'middle-click']);
const VALID_MOUSE_INTENTS = new Set(['activate', 'context', 'noop']);
const VALID_REGISTER_KEYS = new Set(['cap']);
const VALID_FILE_KEYS   = new Set(['path', 'var', 'desc', 'exclude', 'category']);
const VALID_GROUP_KEYS  = new Set(['label', 'compose', 'containers', 'actions', 'terminals', 'children', 'quick', 'archive', 'config_branch', 'images']);
const VALID_ARCHIVE_KEYS = new Set(['target', 'output_dir', 'name']);
const VALID_CONFIG_BRANCH_KEYS = new Set(['branch', 'paths', 'excludes', 'source', 'categories']);
const VALID_IMAGES_KEYS = new Set(['list', 'output_dir']);
const VALID_TERMINAL_KEYS = new Set(['cmd', 'label']);
const VALID_ACTION_KEYS = new Set(['cmd', 'script', 'label', 'type', 'confirm', 'args', 'default_cmd', 'desc', 'tab']);

function isMapping(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function typeName(v) {
  if (v === null) return 'NoneType';
  if (Array.isArray(v)) return 'list';
  if (typeof v === 'object') return 'dict';
  if (typeof v === 'string') return 'str';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  return typeof v;
}
function joinPath(parentPath, name) {
  return parentPath ? `${parentPath}.${name}` : name;
}
function checkUnknownKeys(data, valid, context) {
  const unknown = Object.keys(data).filter(k => !valid.has(k)).sort();
  if (unknown.length) {
    throw new SchemaError(`unknown key(s): ${unknown.join(', ')}`, { context });
  }
}

function validate(data, _sourceFile, warnings) {
  if (!isMapping(data)) throw new SchemaError('config must be a YAML mapping');
  checkUnknownKeys(data, VALID_TOP_KEYS, 'top level');

  if (!('groups' in data)) throw new SchemaError("'groups' is required");
  const groups = data.groups;
  if (!isMapping(groups) || Object.keys(groups).length === 0) {
    throw new SchemaError("'groups' must be a non-empty mapping");
  }

  if ('project_dir' in data && typeof data.project_dir !== 'string') {
    throw new SchemaError("'project_dir' must be a string");
  }
  if ('vars' in data)    validateVars(data.vars);
  if ('helpers' in data) validateHelpers(data.helpers);
  if ('files' in data)   validateFiles(data.files);
  if ('register' in data) validateRegister(data.register);
  if ('keys' in data)     validateKeys(data.keys);
  if ('keymap' in data)   validateKeymap(data.keymap);
  if ('mouse' in data)    validateMouse(data.mouse);
  if ('context-menu' in data) validateContextMenu(data['context-menu']);
  if ('panels' in data)   validatePanels(data.panels);
  if ('layout' in data)   validateLayout(data.layout, warnings);

  for (const [gname, gdata] of Object.entries(groups)) {
    validateGroup(gname, gdata);
  }
}

/**
 * Structural shape check for the `layout:` block (v0.6.2 form).
 *
 * The layout has an ordered `columns:` list. Each column is a mapping
 * with required `panels:` plus an optional `width:` (last column's width
 * is implicit — it takes whatever's left).
 *
 * Each cell within `panels:` is either:
 *   - a bare string (pool-id reference; single-tab pane shorthand), or
 *   - a mapping with required `tabs: [poolId, ...]` plus optional
 *     `activeTab`, `hotkey`, `height`, `heightPct`, `collapsed`.
 *
 * The v0.6 inline-declare form (`{type: ..., title: ...}` at the cell
 * level) is rejected with a migration pointer. Pool entries declare at
 * the top-level `panels:` block; layout cells only reference them.
 *
 * The v0.6.1 two-column `left:`/`right:` form is rejected with a
 * migration pointer to docs/v0.6.2-columns.md.
 *
 * The semantic invariants — exactly-one detail, at-most-one actions —
 * depend on resolved tab kinds (string ids resolve through the pool),
 * so they run in `parseLayout` post-resolution.
 *
 * Column size cap (`SOFT_COL_CAP_FIRST` / `SOFT_COL_CAP_LAST`) is SOFT:
 * exceeding it appends a warning to the caller-supplied `warnings` array
 * but doesn't throw. The renderer's MIN_PANEL_H + terminal-row floor is
 * the physical limit; above the soft cap users just get a more
 * compressed display.
 */
const VALID_LAYOUT_CELL_KEYS = new Set([
  'tabs', 'activeTab', 'hotkey', 'height', 'heightPct', 'collapsed',
]);

const VALID_COLUMN_KEYS = new Set(['width', 'panels']);

const SOFT_COL_CAP_FIRST = 6;
const SOFT_COL_CAP_LAST  = 3;

function validateLayout(layout, warnings) {
  if (!isMapping(layout)) throw new SchemaError("'layout' must be a mapping");
  // v0.6.1 form rejection — `left:`/`right:` blocks are no longer the
  // way; the layout is an ordered `columns:` list.
  if ('left' in layout || 'right' in layout) {
    throw new SchemaError(
      "v0.6.1 layout shape (`left:` / `right:` blocks) is not supported in v0.6.2. " +
      "Use `columns: [{width?, panels: [...]}, ...]` (last column's width is implicit). " +
      "See docs/v0.6.2-migrate.md.",
      { context: 'layout' },
    );
  }
  if (!('columns' in layout)) {
    throw new SchemaError("'layout' must declare a `columns:` list", { context: 'layout' });
  }
  const columns = layout.columns;
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new SchemaError("'layout.columns' must be a non-empty list", { context: 'layout' });
  }
  // Empty-layout guard: at least one column must hold panes. Without
  // this the user gets the downstream "must have exactly one tab of
  // kind 'detail', found 0" — accurate but cryptic given the actual
  // structural problem is "no panes declared in any column".
  const totalCells = columns.reduce(
    (s, c) => s + (Array.isArray(c && c.panels) ? c.panels.length : 0),
    0,
  );
  if (totalCells === 0) {
    throw new SchemaError(
      "'layout.columns' has no panes — at least one column must declare a `panels:` entry referencing a pool id",
      { context: 'layout' },
    );
  }
  const lastIdx = columns.length - 1;
  columns.forEach((col, ci) => {
    const ctx = `layout.columns[${ci}]`;
    if (!isMapping(col)) {
      throw new SchemaError(`column must be a mapping, got ${typeName(col)}`, { context: ctx });
    }
    checkUnknownKeys(col, VALID_COLUMN_KEYS, ctx);
    if ('width' in col) {
      const w = col.width;
      // Width must be a positive integer when present. `width: null` /
      // any non-integer value is rejected — users wanting an implicit
      // column should OMIT the key entirely, not write `width: null`
      // (that form was accepted silently and behaved identically, which
      // made the schema feel ambiguous).
      if (typeof w !== 'number' || !Number.isInteger(w) || w <= 0) {
        throw new SchemaError("'width' must be a positive integer (omit the key for an implicit-width column)", { context: ctx });
      }
      if (ci === lastIdx && warnings) {
        warnings.push({
          code: 'layout.last_column_width_ignored',
          message: `layout.columns[${ci}]: 'width' on the last column is ignored — it takes the remainder`,
        });
      }
    }
    if (!('panels' in col)) {
      throw new SchemaError("column requires a 'panels:' list", { context: ctx });
    }
    const panels = col.panels;
    if (!Array.isArray(panels)) {
      throw new SchemaError("'panels' must be a list", { context: ctx });
    }
    panels.forEach((p, i) => {
      const cellCtx = `${ctx}.panels[${i}]`;
      if (typeof p === 'string') {
        if (!p.trim()) throw new SchemaError("layout cell id must be non-empty", { context: cellCtx });
        return;
      }
      if (!isMapping(p)) {
        throw new SchemaError(`layout cell must be a string id or a {tabs: [...]} mapping, got ${typeName(p)}`, { context: cellCtx });
      }
      if ('type' in p || 'id' in p) {
        throw new SchemaError(
          "v0.6 inline cell shape ({type: ...} / {id: ...}) is not supported. " +
          "Declare the panel in a top-level `panels:` block and reference it via " +
          "`{tabs: [pool-id]}` or the bare-string shorthand. " +
          "See docs/v0.6.1-migrate.md.",
          { context: cellCtx },
        );
      }
      checkUnknownKeys(p, VALID_LAYOUT_CELL_KEYS, cellCtx);
      if (!('tabs' in p)) {
        throw new SchemaError("layout cell mapping requires 'tabs: [pool-id, ...]'", { context: cellCtx });
      }
      if (!Array.isArray(p.tabs) || p.tabs.length === 0) {
        throw new SchemaError("'tabs' must be a non-empty list of pool ids", { context: cellCtx });
      }
      p.tabs.forEach((tid, j) => {
        if (typeof tid !== 'string' || !tid.trim()) {
          throw new SchemaError(`tabs[${j}]: pool id must be a non-empty string`, { context: cellCtx });
        }
      });
      if ('activeTab' in p && (typeof p.activeTab !== 'string' || !p.tabs.includes(p.activeTab))) {
        throw new SchemaError("'activeTab' must be one of the entries in `tabs`", { context: cellCtx });
      }
    });
    // Soft cap: first column (Navigators) tolerates more panels than
    // the last column (Viewer-side, where detail + actions sit). Mirrors
    // the two-column v0.6.1 caps (6 / 3) for the typical 2-column layout.
    const softCap = ci === 0 ? SOFT_COL_CAP_FIRST
                  : ci === lastIdx ? SOFT_COL_CAP_LAST
                  : SOFT_COL_CAP_FIRST;
    if (panels.length > softCap && warnings) {
      warnings.push({
        code: 'layout.column_over_soft_cap',
        message: `layout.columns[${ci}]: ${panels.length} panes exceeds soft cap of ${softCap} — panels may be cramped on small terminals`,
      });
    }
  });
}

/**
 * Structural shape check for the v0.6 top-level `panels:` pool. Must be
 * a mapping of id → mapping. Per-entry field validation (required
 * `type`, no placement-only fields) lives in the resolver
 * (`normalizePoolEntry` in parser/index.js).
 */
function validatePanels(panelsBlock) {
  if (!isMapping(panelsBlock)) {
    throw new SchemaError("'panels' must be a mapping of id → { type, ... }");
  }
  for (const [id, entry] of Object.entries(panelsBlock)) {
    const ctx = `panels.${id}`;
    if (!isMapping(entry)) {
      throw new SchemaError(`panel entry must be a mapping, got ${typeName(entry)}`, { context: ctx });
    }
  }
}

// v0.6.7 E9 — `keymap:` shape. `version` (optional int) + `normal` (optional
// mapping of key → verb). A binding value is a non-empty string (a verb name, or
// `noop` to disable) OR a one-verb `{action|command|builtin}` mapping (mirrors
// `keys:`). Semantics (verb exists, key not reserved, version compat) are checked
// at load time so the parser stays free of dispatch-layer knowledge.
function validateKeymap(block) {
  if (!isMapping(block)) throw new SchemaError("'keymap' must be a mapping");
  checkUnknownKeys(block, VALID_KEYMAP_KEYS, 'keymap');
  if ('version' in block && (typeof block.version !== 'number' || !Number.isInteger(block.version))) {
    throw new SchemaError("'keymap.version' must be an integer");
  }
  if ('normal' in block) {
    if (!isMapping(block.normal)) throw new SchemaError("'keymap.normal' must be a mapping");
    for (const [key, spec] of Object.entries(block.normal)) {
      const ctx = `keymap.normal, '${key}'`;
      if (typeof spec === 'string') {
        if (!spec.trim()) throw new SchemaError('binding string must be non-empty', { context: ctx });
        continue;
      }
      if (!isMapping(spec)) {
        throw new SchemaError(`binding must be a verb name or a {action|command|builtin} mapping, got ${typeName(spec)}`, { context: ctx });
      }
      checkUnknownKeys(spec, VALID_KEY_BINDING_KEYS, ctx);
      const verbs = ['action', 'command', 'builtin'].filter(v => v in spec);
      if (verbs.length === 0) throw new SchemaError("binding needs one of 'action', 'command', or 'builtin'", { context: ctx });
      if (verbs.length > 1) throw new SchemaError(`binding has conflicting targets: ${verbs.join(', ')}`, { context: ctx });
      if (typeof spec[verbs[0]] !== 'string' || !spec[verbs[0]].trim()) {
        throw new SchemaError(`'${verbs[0]}' must be a non-empty string`, { context: ctx });
      }
      for (const opt of ['label', 'desc']) {
        if (opt in spec && typeof spec[opt] !== 'string') throw new SchemaError(`'${opt}' must be a string`, { context: ctx });
      }
    }
  }
}

function validateKeys(keysBlock) {
  if (!isMapping(keysBlock)) throw new SchemaError("'keys' must be a mapping");
  for (const [seq, spec] of Object.entries(keysBlock)) {
    const ctx = `keys, '${seq}'`;
    if (!isMapping(spec)) {
      throw new SchemaError(`binding must be a mapping, got ${typeName(spec)}`, { context: ctx });
    }
    checkUnknownKeys(spec, VALID_KEY_BINDING_KEYS, ctx);
    // Exactly one target verb.
    const verbs = ['action', 'command', 'builtin'].filter(v => v in spec);
    if (verbs.length === 0) {
      throw new SchemaError("binding needs one of 'action', 'command', or 'builtin'", { context: ctx });
    }
    if (verbs.length > 1) {
      throw new SchemaError(`binding has conflicting targets: ${verbs.join(', ')}`, { context: ctx });
    }
    const verb = verbs[0];
    if (typeof spec[verb] !== 'string' || !spec[verb].trim()) {
      throw new SchemaError(`'${verb}' must be a non-empty string`, { context: ctx });
    }
    for (const opt of ['label', 'desc']) {
      if (opt in spec && typeof spec[opt] !== 'string') {
        throw new SchemaError(`'${opt}' must be a string`, { context: ctx });
      }
    }
  }
}

function validateMouse(mouseBlock) {
  if (!isMapping(mouseBlock)) throw new SchemaError("'mouse' must be a mapping");
  checkUnknownKeys(mouseBlock, VALID_MOUSE_KEYS, 'mouse');
  for (const g of VALID_MOUSE_GESTURES) {
    if (!(g in mouseBlock)) continue;
    const intent = mouseBlock[g];
    if (typeof intent !== 'string' || !VALID_MOUSE_INTENTS.has(intent)) {
      const list = '[' + [...VALID_MOUSE_INTENTS].sort().map(s => `'${s}'`).join(', ') + ']';
      throw new SchemaError(`'${g}' must be one of ${list}, got ${typeof intent === 'string' ? `'${intent}'` : typeName(intent)}`, { context: 'mouse' });
    }
  }
  if ('double-click-ms' in mouseBlock) {
    const ms = mouseBlock['double-click-ms'];
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms <= 0) {
      throw new SchemaError("'mouse.double-click-ms' must be a positive integer", { context: 'mouse' });
    }
  }
}

function validateContextMenu(block) {
  if (!Array.isArray(block)) {
    throw new SchemaError(`'context-menu' must be a list, got ${typeName(block)}`);
  }
  block.forEach((entry, i) => {
    const ctx = `context-menu[${i}]`;
    if (!isMapping(entry)) {
      throw new SchemaError(`entry must be a mapping, got ${typeName(entry)}`, { context: ctx });
    }
    checkUnknownKeys(entry, VALID_CONTEXT_MENU_KEYS, ctx);
    if (typeof entry.label !== 'string' || !entry.label.trim()) {
      throw new SchemaError("'label' must be a non-empty string", { context: ctx });
    }
    // Exactly one target verb — mirrors validateKeys.
    const verbs = ['action', 'command', 'builtin'].filter(v => v in entry);
    if (verbs.length === 0) {
      throw new SchemaError("entry needs one of 'action', 'command', or 'builtin'", { context: ctx });
    }
    if (verbs.length > 1) {
      throw new SchemaError(`entry has conflicting targets: ${verbs.join(', ')}`, { context: ctx });
    }
    const verb = verbs[0];
    if (typeof entry[verb] !== 'string' || !entry[verb].trim()) {
      throw new SchemaError(`'${verb}' must be a non-empty string`, { context: ctx });
    }
    if ('pane' in entry) {
      const single = typeof entry.pane === 'string' && entry.pane.trim();
      const list = Array.isArray(entry.pane) && entry.pane.length
        && entry.pane.every(p => typeof p === 'string' && p.trim());
      if (!single && !list) {
        throw new SchemaError("'pane' must be a non-empty string or list of non-empty strings", { context: ctx });
      }
    }
  });
}

function validateVars(varsBlock) {
  if (!isMapping(varsBlock)) throw new SchemaError("'vars' must be a mapping");
  for (const [k, v] of Object.entries(varsBlock)) {
    if (typeof k !== 'string') {
      throw new SchemaError(`var key must be a string, got ${typeName(k)}`);
    }
    if (typeof v !== 'string') {
      throw new SchemaError(`var '${k}' value must be a string, got ${typeName(v)}`, { context: 'vars' });
    }
  }
}

function validateHelpers(helpersBlock) {
  if (!isMapping(helpersBlock)) throw new SchemaError("'helpers' must be a mapping");
  for (const [k, v] of Object.entries(helpersBlock)) {
    if (typeof k !== 'string') {
      throw new SchemaError(`helper key must be a string, got ${typeName(k)}`);
    }
    if (typeof v !== 'string') {
      throw new SchemaError(`helper '${k}' value must be a string`, { context: 'helpers' });
    }
  }
}

function validateRegister(regBlock) {
  if (!isMapping(regBlock)) throw new SchemaError("'register' must be a mapping");
  checkUnknownKeys(regBlock, VALID_REGISTER_KEYS, 'register');
  if ('cap' in regBlock) {
    const cap = regBlock.cap;
    if (typeof cap !== 'number' || !Number.isInteger(cap) || cap <= 0) {
      throw new SchemaError("'register.cap' must be a positive integer");
    }
  }
}

function validateFiles(files) {
  if (!Array.isArray(files)) throw new SchemaError("'files' must be a list");
  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    const ctx = `files[${i}]`;
    if (typeof entry === 'string') continue;
    if (isMapping(entry)) {
      if (!('path' in entry)) throw new SchemaError("'path' is required", { context: ctx });
      if (typeof entry.path !== 'string') throw new SchemaError("'path' must be a string", { context: ctx });
      checkUnknownKeys(entry, VALID_FILE_KEYS, ctx);
      if ('var' in entry && typeof entry.var !== 'string')   throw new SchemaError("'var' must be a string", { context: ctx });
      if ('desc' in entry && typeof entry.desc !== 'string') throw new SchemaError("'desc' must be a string", { context: ctx });
      if ('exclude' in entry && !Array.isArray(entry.exclude)) {
        throw new SchemaError("'exclude' must be a list", { context: ctx });
      }
      if ('category' in entry && typeof entry.category !== 'string') {
        throw new SchemaError("'category' must be a string", { context: ctx });
      }
    } else {
      throw new SchemaError('must be a string or mapping', { context: ctx });
    }
  }
}

function validateGroup(gname, gdata, parentPath = '') {
  const full = joinPath(parentPath, gname);
  const ctx = `group '${full}'`;
  if (!isMapping(gdata)) throw new SchemaError('must be a mapping', { context: ctx });

  // Group keys are EXTENSIBLE. The framework owns a small set
  // (label/actions/terminals/children/quick); the rest — `compose`/
  // `containers` (docker), `archive`, `config_branch`, `images`, and any
  // key a user plugin introduces — are plugin data. We validate the
  // shapes of the keys the framework + bundled plugins know about
  // (below), but do NOT reject unknown keys: they pass through to the
  // parsed group (see parser walkGroups) for whatever plugin consumes
  // them, mirroring how panel `extras` pass through. This is what lets a
  // plugin add a group-level key without editing this file (PRINCIPLES
  // §1/§5/§9). VALID_GROUP_KEYS is kept as documentation of the
  // framework + bundled-plugin vocabulary.
  void VALID_GROUP_KEYS;

  if (!('label' in gdata)) throw new SchemaError("'label' is required", { context: ctx });
  if (typeof gdata.label !== 'string') throw new SchemaError("'label' must be a string", { context: ctx });

  if ('containers' in gdata) {
    const containers = gdata.containers;
    if (!Array.isArray(containers)) throw new SchemaError("'containers' must be a list", { context: ctx });
    for (const c of containers) {
      if (typeof c !== 'string') {
        throw new SchemaError(`container name must be a string, got ${typeName(c)}`, { context: ctx });
      }
    }
  }

  const hasActions  = 'actions' in gdata;
  const hasChildren = 'children' in gdata;
  if (!hasActions && !hasChildren) {
    throw new SchemaError("must have 'actions', 'children', or both", { context: ctx });
  }

  if ('compose' in gdata && typeof gdata.compose !== 'string') {
    throw new SchemaError("'compose' must be a string", { context: ctx });
  }

  if ('archive' in gdata) {
    const archive = gdata.archive;
    if (!isMapping(archive)) throw new SchemaError("'archive' must be a mapping", { context: ctx });
    checkUnknownKeys(archive, VALID_ARCHIVE_KEYS, `${ctx}, archive`);
    for (const required of ['target', 'name']) {
      if (!(required in archive)) {
        throw new SchemaError(`'archive.${required}' is required`, { context: ctx });
      }
      if (typeof archive[required] !== 'string' || !archive[required]) {
        throw new SchemaError(`'archive.${required}' must be a non-empty string`, { context: ctx });
      }
    }
    if ('output_dir' in archive && typeof archive.output_dir !== 'string') {
      throw new SchemaError("'archive.output_dir' must be a string", { context: ctx });
    }
  }

  if ('config_branch' in gdata) {
    const cb = gdata.config_branch;
    if (!isMapping(cb)) throw new SchemaError("'config_branch' must be a mapping", { context: ctx });
    checkUnknownKeys(cb, VALID_CONFIG_BRANCH_KEYS, `${ctx}, config_branch`);
    if (!('branch' in cb) || typeof cb.branch !== 'string' || !cb.branch) {
      throw new SchemaError("'config_branch.branch' must be a non-empty string", { context: ctx });
    }
    const hasSource = 'source' in cb;
    const hasPaths  = 'paths'  in cb;
    if (hasSource && hasPaths) {
      throw new SchemaError("'config_branch' cannot set both 'source' and 'paths' — pick one", { context: ctx });
    }
    if (!hasSource && !hasPaths) {
      throw new SchemaError("'config_branch' must declare 'paths' (explicit list) or 'source' (reference)", { context: ctx });
    }
    if (hasSource) {
      if (cb.source !== 'files') {
        throw new SchemaError("'config_branch.source' must be \"files\" (the only supported reference)", { context: ctx });
      }
      if ('excludes' in cb) {
        throw new SchemaError(
          "'config_branch.excludes' cannot be combined with 'source: files' — declare per-file 'exclude:' on the relevant 'files:' entries instead",
          { context: ctx },
        );
      }
      if ('categories' in cb) {
        const cats = cb.categories;
        if (!Array.isArray(cats) || cats.length === 0) {
          throw new SchemaError("'config_branch.categories' must be a non-empty list", { context: ctx });
        }
        for (let i = 0; i < cats.length; i++) {
          if (typeof cats[i] !== 'string' || !cats[i]) {
            throw new SchemaError(`'config_branch.categories[${i}]' must be a non-empty string`, { context: ctx });
          }
        }
      }
    } else if ('categories' in cb) {
      throw new SchemaError("'config_branch.categories' is only valid with 'source: files'", { context: ctx });
    } else {
      const paths = cb.paths;
      if (!Array.isArray(paths) || paths.length === 0) {
        throw new SchemaError("'config_branch.paths' must be a non-empty list", { context: ctx });
      }
      for (let i = 0; i < paths.length; i++) {
        if (typeof paths[i] !== 'string' || !paths[i]) {
          throw new SchemaError(`'config_branch.paths[${i}]' must be a non-empty string`, { context: ctx });
        }
      }
      if ('excludes' in cb) {
        const excludes = cb.excludes;
        if (!Array.isArray(excludes)) {
          throw new SchemaError("'config_branch.excludes' must be a list", { context: ctx });
        }
        for (let i = 0; i < excludes.length; i++) {
          if (typeof excludes[i] !== 'string' || !excludes[i]) {
            throw new SchemaError(`'config_branch.excludes[${i}]' must be a non-empty string`, { context: ctx });
          }
        }
      }
    }
  }

  if ('images' in gdata) {
    const images = gdata.images;
    if (!isMapping(images)) throw new SchemaError("'images' must be a mapping", { context: ctx });
    checkUnknownKeys(images, VALID_IMAGES_KEYS, `${ctx}, images`);
    const ilist = images.list;
    if (!Array.isArray(ilist) || ilist.length === 0) {
      throw new SchemaError("'images.list' must be a non-empty list", { context: ctx });
    }
    for (let i = 0; i < ilist.length; i++) {
      if (typeof ilist[i] !== 'string' || !ilist[i]) {
        throw new SchemaError(`'images.list[${i}]' must be a non-empty string`, { context: ctx });
      }
    }
    if ('output_dir' in images && typeof images.output_dir !== 'string') {
      throw new SchemaError("'images.output_dir' must be a string", { context: ctx });
    }
  }

  if ('quick' in gdata && typeof gdata.quick !== 'boolean') {
    throw new SchemaError("'quick' must be a boolean", { context: ctx });
  }

  if (hasActions) {
    const actions = gdata.actions;
    if (!isMapping(actions) || Object.keys(actions).length === 0) {
      throw new SchemaError("'actions' must be a non-empty mapping", { context: ctx });
    }
    for (const [aname, adata] of Object.entries(actions)) {
      validateAction(full, aname, adata);
    }
  }

  if (hasChildren) {
    const children = gdata.children;
    if (!isMapping(children) || Object.keys(children).length === 0) {
      throw new SchemaError("'children' must be a non-empty mapping", { context: ctx });
    }
    for (const [cname, cdata] of Object.entries(children)) {
      validateGroup(cname, cdata, full);
    }
  }

  if ('terminals' in gdata) {
    const terminals = gdata.terminals;
    if (!isMapping(terminals)) {
      throw new SchemaError("'terminals' must be a mapping", { context: ctx });
    }
    for (const [tname, tdata] of Object.entries(terminals)) {
      validateTerminal(full, tname, tdata);
    }
  }
}

function validateAction(groupPath, aname, adata) {
  const ctx = `group '${groupPath}', action '${aname}'`;
  if (!isMapping(adata)) throw new SchemaError('must be a mapping', { context: ctx });
  checkUnknownKeys(adata, VALID_ACTION_KEYS, ctx);

  const hasCmd    = 'cmd'    in adata;
  const hasScript = 'script' in adata;
  if (hasCmd && hasScript) {
    throw new SchemaError("must have exactly one of 'cmd' or 'script', not both", { context: ctx });
  }
  if (!hasCmd && !hasScript) {
    throw new SchemaError("must have exactly one of 'cmd' or 'script'", { context: ctx });
  }
  if (hasCmd && typeof adata.cmd !== 'string') {
    throw new SchemaError("'cmd' must be a string", { context: ctx });
  }
  if (hasScript && typeof adata.script !== 'string') {
    throw new SchemaError("'script' must be a string", { context: ctx });
  }
  // T19 — empty / whitespace-only cmd/script accepted pre-fix; runtime
  // ran `/bin/sh -c ''` as a no-op and the user got no feedback for an
  // action that simply did nothing. Reject at parse time.
  if (hasCmd && !adata.cmd.trim()) {
    throw new SchemaError("'cmd' must not be empty or whitespace-only", { context: ctx });
  }
  if (hasScript && !adata.script.trim()) {
    throw new SchemaError("'script' must not be empty or whitespace-only", { context: ctx });
  }

  if (!('label' in adata)) throw new SchemaError("'label' is required", { context: ctx });
  if (typeof adata.label !== 'string') throw new SchemaError("'label' must be a string", { context: ctx });

  if ('type' in adata) {
    if (!VALID_ACTION_TYPES.has(adata.type)) {
      const sorted = [...VALID_ACTION_TYPES].sort();
      // Python repr-style list: ['background', 'run', 'spawn']
      const list = '[' + sorted.map(s => `'${s}'`).join(', ') + ']';
      throw new SchemaError(`'type' must be one of ${list}, got '${adata.type}'`, { context: ctx });
    }
  }
  if ('confirm' in adata && typeof adata.confirm !== 'string') throw new SchemaError("'confirm' must be a string", { context: ctx });
  if ('desc'    in adata && typeof adata.desc    !== 'string') throw new SchemaError("'desc' must be a string",    { context: ctx });
  if ('args'    in adata && typeof adata.args    !== 'string') throw new SchemaError("'args' must be a string",    { context: ctx });

  if ('default_cmd' in adata) {
    if (typeof adata.default_cmd !== 'string') {
      throw new SchemaError("'default_cmd' must be a string", { context: ctx });
    }
    if (!('args' in adata)) {
      throw new SchemaError("'default_cmd' requires 'args' to be set (default fills the prompt)", { context: ctx });
    }
  }
  if ('tab' in adata && typeof adata.tab !== 'boolean') {
    throw new SchemaError("'tab' must be a boolean", { context: ctx });
  }
}

function validateTerminal(groupPath, tname, tdata) {
  const ctx = `group '${groupPath}', terminal '${tname}'`;
  if (!isMapping(tdata)) throw new SchemaError('must be a mapping', { context: ctx });
  checkUnknownKeys(tdata, VALID_TERMINAL_KEYS, ctx);
  if (!('cmd' in tdata))   throw new SchemaError("'cmd' is required",   { context: ctx });
  if (typeof tdata.cmd !== 'string')   throw new SchemaError("'cmd' must be a string",   { context: ctx });
  if (!('label' in tdata)) throw new SchemaError("'label' is required", { context: ctx });
  if (typeof tdata.label !== 'string') throw new SchemaError("'label' must be a string", { context: ctx });
}

module.exports = { validate };
