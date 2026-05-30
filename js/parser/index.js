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

const LEFT_HOTKEY_POOL  = ['1', '2', '3', '4', '5', '6'];
const RIGHT_HOTKEY_POOL = ['7', '8', '9'];

// Reserved layout keys consumed by the framework; everything else
// passes through as plugin-specific panel config (e.g. stats panel's
// `topic`, `select_from`).
const RESERVED_PANEL_KEYS = new Set(['type', 'title', 'hotkey', 'height']);

function assignHotkeys(panelsYaml, pool) {
  const explicit = new Map();
  for (let i = 0; i < panelsYaml.length; i++) {
    if (panelsYaml[i].hotkey) explicit.set(i, String(panelsYaml[i].hotkey));
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

function defaultLayout(hasContainers, _hasFiles) {
  const left = [];
  let hk = 1;
  if (hasContainers) {
    left.push({ type: 'containers', title: 'Containers', hotkey: String(hk++), column: 'left', config: {} });
  }
  left.push({ type: 'groups', title: 'Groups', hotkey: String(hk++), column: 'left', config: {} });
  if (_hasFiles) {
    left.push({ type: 'files', source: 'declared', title: 'Files', hotkey: String(hk++), column: 'left', config: {} });
  }
  const right = [
    { type: 'actions', title: 'Actions', hotkey: '7', column: 'right', config: {} },
    { type: 'detail',  title: 'Detail',  hotkey: '8', column: 'right', config: {} },
  ];
  return {
    left_width: 30, left_panels: left, right_panels: right,
    detail_height_pct: 60,
  };
}

function parseLayout(layoutData, _hasContainers, _hasFiles) {
  const leftBlock  = layoutData.left  || {};
  const rightBlock = layoutData.right || {};
  const leftWidth  = (leftBlock.width !== undefined && leftBlock.width !== null) ? leftBlock.width : 30;
  let detailHeightPct = 60;

  const extras = (pdata) => {
    const out = {};
    for (const [k, v] of Object.entries(pdata)) {
      if (!RESERVED_PANEL_KEYS.has(k)) out[k] = v;
    }
    return out;
  };

  const leftYaml  = leftBlock.panels  || [];
  const rightYaml = rightBlock.panels || [];
  const leftKeys  = assignHotkeys(leftYaml,  LEFT_HOTKEY_POOL);
  const rightKeys = assignHotkeys(rightYaml, RIGHT_HOTKEY_POOL);

  const leftPanels = leftYaml.map((pdata, i) => ({
    type: pdata.type,
    title: pdata.title || titleCase(pdata.type),
    hotkey: leftKeys[i],
    column: 'left',
    config: extras(pdata),
  }));

  const rightPanels = rightYaml.map((pdata, i) => {
    if (pdata.type === 'detail' && 'height' in pdata) {
      const h = pdata.height;
      if (typeof h === 'string' && h.endsWith('%')) {
        detailHeightPct = parseInt(h.slice(0, -1), 10);
      } else if (typeof h === 'number' && Number.isInteger(h)) {
        detailHeightPct = h;
      }
    }
    return {
      type: pdata.type,
      title: pdata.title || titleCase(pdata.type),
      hotkey: rightKeys[i],
      column: 'right',
      config: extras(pdata),
    };
  });

  return {
    left_width: leftWidth,
    left_panels: leftPanels,
    right_panels: rightPanels,
    detail_height_pct: detailHeightPct,
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

  validate(data, source);

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
  const layout = ('layout' in data)
    ? parseLayout(data.layout, hasContainers, hasFiles)
    : defaultLayout(hasContainers, hasFiles);

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
  };
}

module.exports = { parse, retiredPluginEntries };
