/**
 * YAML schema validation for TUI config. Mirrors parser/schema.py
 * one-to-one — strict unknown-key rejection, type checks, required
 * fields. Errors carry the same message format so the JS port is a
 * drop-in replacement for the Python CLI.
 */
'use strict';

const { SchemaError } = require('./errors');

const VALID_ACTION_TYPES = new Set(['run', 'spawn', 'background']);

const VALID_TOP_KEYS    = new Set(['project_dir', 'groups', 'vars', 'helpers', 'files', 'layout', 'theme', 'plugins', 'register', 'keys']);
const VALID_KEY_BINDING_KEYS = new Set(['action', 'command', 'builtin', 'label', 'desc']);
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

function validate(data, _sourceFile) {
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
  if ('layout' in data)   validateLayout(data.layout);

  for (const [gname, gdata] of Object.entries(groups)) {
    validateGroup(gname, gdata);
  }
}

/**
 * Enforce the PRINCIPLES.md §10 layout invariants at parse time instead
 * of letting violations surface as render-time crashes (two `detail`
 * panels both write S.panelBounds.detail and clobber each other; >6
 * left panels exhaust the hotkey pool; zero detail panels leave the
 * right column dead). Only runs when an explicit `layout:` is given —
 * the generated default layout is always well-formed.
 */
function validateLayout(layout) {
  if (!isMapping(layout)) throw new SchemaError("'layout' must be a mapping");
  const collectPanels = (side, max) => {
    const block = layout[side];
    if (block === undefined) return [];
    if (!isMapping(block)) throw new SchemaError(`'layout.${side}' must be a mapping`);
    const panels = block.panels;
    if (panels === undefined) return [];
    if (!Array.isArray(panels)) throw new SchemaError(`'layout.${side}.panels' must be a list`);
    panels.forEach((p, i) => {
      const ctx = `layout.${side}.panels[${i}]`;
      if (!isMapping(p)) throw new SchemaError(`panel must be a mapping, got ${typeName(p)}`, { context: ctx });
      if (typeof p.type !== 'string' || !p.type.trim()) {
        throw new SchemaError("panel 'type' is required and must be a non-empty string", { context: ctx });
      }
    });
    if (panels.length > max) {
      throw new SchemaError(`'layout.${side}' allows at most ${max} panels, got ${panels.length}`);
    }
    return panels;
  };
  const all = collectPanels('left', 6).concat(collectPanels('right', 3));
  const detailCount = all.filter(p => p.type === 'detail').length;
  if (detailCount !== 1) {
    throw new SchemaError(`layout must have exactly one 'detail' panel, found ${detailCount}`);
  }
  const actionsCount = all.filter(p => p.type === 'actions').length;
  if (actionsCount > 1) {
    throw new SchemaError(`layout allows at most one 'actions' panel, found ${actionsCount}`);
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
