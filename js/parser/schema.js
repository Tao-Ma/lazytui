/**
 * YAML schema validation for TUI config. Mirrors parser/schema.py
 * one-to-one — strict unknown-key rejection, type checks, required
 * fields. Errors carry the same message format so the JS port is a
 * drop-in replacement for the Python CLI.
 */
'use strict';

const { SchemaError } = require('./errors');
// Dataflow fabric (docs/ports-and-wires.md) — parser→fabric is a clean
// down-edge (fabric imports nothing back). Reused so the "valid parse kinds",
// extract shape, and address grammar have a single source of truth.
const { parseFabricAddr, isValidFabricName, isValidFabricComponentName } = require('../fabric/address');
const { compileParse, compileExtract } = require('../fabric/parse');
const { compileCommand, commandHoles } = require('../fabric/command');
const { isShadowedEnvName } = require('../leaves/security/env-shadow');

const VALID_ACTION_TYPES = new Set(['run', 'spawn', 'background']);
// Per-action re-run behavior for the streamed output buffer: 'replace' (default)
// reseeds the buffer to the new run's header; 'append' keeps prior runs and adds
// the new run below (a status-over-time log). See docs/DATAFLOW.md.
const VALID_ACTION_OUTPUT_MODES = new Set(['replace', 'append']);

const VALID_TOP_KEYS    = new Set(['project_dir', 'groups', 'vars', 'helpers', 'files', 'layout', 'theme', 'plugins', 'register', 'keys', 'keymap', 'mouse', 'context-menu', 'panels', 'selection', 'editor', 'color_depth', 'theme_background', 'keyboard_protocol', 'metrics', 'components']);

// Global user config (~/.config/lazytui/config.yml, docs/global-config) — only
// the APP-BEHAVIOR sections are honored there; project content (groups,
// layout, vars, …) belongs to the per-project config. Anything else in the
// global file warns and is ignored — a global file must never brick a project.
const GLOBAL_TOP_KEYS = new Set(['theme', 'keys', 'keymap', 'mouse', 'context-menu', 'selection', 'editor', 'color_depth', 'theme_background', 'keyboard_protocol', 'action_status', 'quick_keys']);

// action-status — the reverse-filled command-finish status line on a
// text-view output pane. `segments` are the fields (subset + order); `time` =
// finish clock time.
const VALID_ACTION_STATUS_SEGMENTS = new Set(['status', 'duration', 'time']);
const VALID_ACTION_STATUS_KEYS = new Set(['enabled', 'segments', 'live']);
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
const VALID_GROUP_KEYS  = new Set(['label', 'compose', 'containers', 'actions', 'terminals', 'children', 'quick', 'archive', 'config_branch', 'images', 'wires']);
const VALID_ARCHIVE_KEYS = new Set(['target', 'output_dir', 'name']);
const VALID_CONFIG_BRANCH_KEYS = new Set(['branch', 'paths', 'excludes', 'source', 'categories']);
const VALID_IMAGES_KEYS = new Set(['list', 'output_dir']);
const VALID_TERMINAL_KEYS = new Set(['cmd', 'label']);
const VALID_ACTION_KEYS = new Set(['cmd', 'script', 'label', 'type', 'confirm', 'desc', 'tab', 'output', 'parse', 'ports', 'run']);

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
  // External (consumer-authored) Component modules (docs/PLUGINS.md, docs/PROJECT.md).
  // A list of module paths — `.`-relative paths resolve against project_dir at
  // parse time; bare names go through node require resolution.
  if ('components' in data) {
    if (!Array.isArray(data.components)) {
      throw new SchemaError("'components' must be a list of module paths");
    }
    for (const s of data.components) {
      if (typeof s !== 'string' || !s.trim()) {
        throw new SchemaError("'components' entries must be non-empty strings (module paths)");
      }
    }
  }
  // Global text-selection default (docs/pane-selection.md); default ON. Per-pane
  // `select:` on a panel pool entry overrides it.
  if ('selection' in data && typeof data.selection !== 'boolean') {
    throw new SchemaError("'selection' must be a boolean");
  }
  // Themed screen background (docs/truecolor.md §Themed screen colours); default
  // ON. `false` = transparent (the theme colours text only, terminal bg shows through).
  if ('theme_background' in data && typeof data.theme_background !== 'boolean') {
    throw new SchemaError("'theme_background' must be a boolean");
  }
  if ('editor' in data) validateEditor(data.editor);
  if ('color_depth' in data) validateColorDepth(data.color_depth);
  if ('keyboard_protocol' in data) validateKeyboardProtocol(data.keyboard_protocol);
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
  if ('metrics' in data)  validateMetrics(data.metrics);

  for (const [gname, gdata] of Object.entries(groups)) {
    validateGroup(gname, gdata, '', warnings);
  }
}

// The editor command (a program name/path, optionally with args — e.g.
// `nvim`, `code --wait`). Resolution chain lives in the edit feature:
// project `editor:` → global `editor:` → $VISUAL → $EDITOR → vi.
function validateEditor(v) {
  if (typeof v !== 'string' || !v.trim()) {
    throw new SchemaError("'editor' must be a non-empty string");
  }
}

// Render color depth (truecolor arc 1b, docs/truecolor.md P3). 'auto' =
// detect from the environment (the default); the two numeric forms are
// accepted unquoted (YAML parses `color_depth: 256` as an int) and
// normalized to strings at output assembly.
function validateColorDepth(v) {
  const s = String(v);
  if (s !== 'auto' && s !== 'truecolor' && s !== '256' && s !== '16') {
    throw new SchemaError("'color_depth' must be one of: auto, truecolor, 256, 16");
  }
}

// Keyboard input protocol (kitty-keyboard arc, docs/kitty-keyboard.md).
// 'auto' = run the detection handshake and enable on a confirmed reply (the
// default); 'legacy' = stay on the tokenizer path, never probe or enable;
// 'kitty' = force-enable without the handshake (for terminals that support the
// protocol but don't answer the query). The LAZYTUI_KBD env var overrides this.
function validateKeyboardProtocol(v) {
  const s = String(v);
  if (s !== 'auto' && s !== 'legacy' && s !== 'kitty') {
    throw new SchemaError("'keyboard_protocol' must be one of: auto, legacy, kitty");
  }
}

// action_status (docs/global-config.md). A mapping (or the boolean shorthands:
// `true` = default-on, `false` = disable). Shape only; the resolve/default
// logic lives in the action-status leaf. `null`/absent (a bare `action_status:`
// key) is TOLERATED as default-on to match the leaf's resolveConfig(null),
// which returns the default-on shape — rejecting it here would throw through
// validateGlobal and drop the ENTIRE global config to project-only over one
// empty key, against the never-brick contract. (This section's resolver treats
// null as a meaningful value, unlike the sibling honored keys.)
// quick_keys (docs/global-config.md) — where a pane's item-action quick keys
// surface: `border` (the on-pane bottom-border bar, default), `footer` (the
// status-line hints, lazytui's traditional style), or `off` (neither; the keys
// still work). Global-only; resolve/default lives at the read sites.
const VALID_QUICK_KEYS = new Set(['border', 'footer', 'off']);
function validateQuickKeys(v) {
  if (v == null) return;   // bare key → default (border) at the read site
  if (!VALID_QUICK_KEYS.has(v)) {
    throw new SchemaError(`'quick_keys' must be one of: ${[...VALID_QUICK_KEYS].join(', ')}`);
  }
}

// metrics (docs/metrics-producer.md) — a mapping of hub-topic → producer def.
// Each producer polls `cmd` on an interval and publishes extracted numbers to
// its topic (the map key). PROJECT-level (VALID_TOP_KEYS, not global): a
// malformed producer is an authoring error the user must see, so shape errors
// throw here (consistent with every other project section) — runtime command
// failures degrade softly at poll time (execAsync never rejects; a mis-parse
// renders as '—'), that's a separate concern.
// NOTE: `refresh_ladder` is NOT accepted here yet — the metrics-poll kind does
// not consume it (only the docker pane does). Accepting it would be a validated
// no-op; it returns when live rate-stepping wires it (metrics-producer.md §7).
const VALID_METRICS_KEYS = new Set(['cmd', 'interval', 'timeout', 'focus_gate', 'extract', 'schema']);
const VALID_EXTRACT_KEYS = new Set(['mode', 'fields', 'delimiter', 'skip', 'row_key', 'root']);
const VALID_EXTRACT_MODES = new Set(['regex', 'columns', 'json']);
// Advisory column types (HUB.md §16). A closed set so a typo (`strng`) is caught
// at parse time rather than silently coercing a label to NaN; the full documented
// set is allowed, so `rate`/`duration` (deferred derivations) still validate.
// `counter` is a PRODUCER directive: the raw value is a monotonic counter
// (/proc/net/dev bytes, /proc/diskstats sectors, …) and the metrics-poll kind
// publishes its per-second RATE — the topic then advertises the column as
// `rate` to consumers. See docs/metrics-producer.md §counter.
const VALID_COLUMN_TYPES = new Set(['number', 'percent', 'bytes', 'rate', 'counter', 'string', 'duration']);
// The keys a metrics `schema.columns.<name>` def may carry. `type` = coercion/display
// type; `unit` = display suffix (docs/metrics-producer.md); `meta` = scale-reference flag
// (skipped from graphing/display). A misspelled key (`tpye`, `metaa`) would otherwise be
// silently dropped — the display default silently masks the typo (docs/STATS.md).
const VALID_METRICS_COLUMN_KEYS = new Set(['type', 'unit', 'meta']);
function validateMetrics(v) {
  if (v == null) return; // bare `metrics:` key → no producers (never-brick)
  if (!isMapping(v)) throw new SchemaError("'metrics' must be a mapping (topic → producer)");
  for (const [topic, def] of Object.entries(v)) {
    const ctx = `metrics.${topic}`;
    if (!isMapping(def)) throw new SchemaError(`'${ctx}' must be a mapping`);
    checkUnknownKeys(def, VALID_METRICS_KEYS, ctx);
    if (typeof def.cmd !== 'string' || !def.cmd.trim()) {
      throw new SchemaError(`'${ctx}.cmd' is required and must be a non-empty string`);
    }
    for (const numKey of ['interval', 'timeout']) {
      if (numKey in def && (typeof def[numKey] !== 'number' || def[numKey] <= 0)) {
        throw new SchemaError(`'${ctx}.${numKey}' must be a positive number (ms)`);
      }
    }
    if ('focus_gate' in def && typeof def.focus_gate !== 'boolean') {
      throw new SchemaError(`'${ctx}.focus_gate' must be a boolean`);
    }
    if (!isMapping(def.extract)) throw new SchemaError(`'${ctx}.extract' is required and must be a mapping`);
    const ex = def.extract, exCtx = `${ctx}.extract`;
    checkUnknownKeys(ex, VALID_EXTRACT_KEYS, exCtx);
    const mode = ex.mode || 'regex';
    if (!VALID_EXTRACT_MODES.has(mode)) {
      throw new SchemaError(`'${exCtx}.mode' must be one of: ${[...VALID_EXTRACT_MODES].join(', ')}`);
    }
    if (!isMapping(ex.fields) || Object.keys(ex.fields).length === 0) {
      throw new SchemaError(`'${exCtx}.fields' is required and must be a non-empty mapping`);
    }
    // `ts` is a RESERVED sample field: the producer stamps every sample with a wall-clock
    // capture time there (read by the stats time-axis, docs/metrics-producer.md). A user
    // field named `ts` would be silently overwritten each tick, so reject it up front —
    // an authoring error the user must see (like the shape errors above), not a runtime
    // surprise. Applies to every extract mode (field names become sample keys).
    if ('ts' in ex.fields) {
      throw new SchemaError(`'${exCtx}.fields.ts' uses the reserved field name 'ts' — the producer stamps a capture timestamp there (read by the stats time-axis); rename this field`);
    }
    if ('skip' in ex && (typeof ex.skip !== 'number' || ex.skip < 0 || !Number.isInteger(ex.skip))) {
      throw new SchemaError(`'${exCtx}.skip' must be a non-negative integer`);
    }
    if ('delimiter' in ex && typeof ex.delimiter !== 'string') {
      throw new SchemaError(`'${exCtx}.delimiter' must be a string ('whitespace', 'tab', or a literal)`);
    }
    if (mode === 'columns') {
      for (const [f, idx] of Object.entries(ex.fields)) {
        if (typeof idx !== 'number' || idx < 0 || !Number.isInteger(idx)) {
          throw new SchemaError(`'${exCtx}.fields.${f}' must be a non-negative column index (columns mode)`);
        }
      }
      if ('row_key' in ex && !(ex.row_key in ex.fields)) {
        throw new SchemaError(`'${exCtx}.row_key' ('${ex.row_key}') must name a field in extract.fields`);
      }
    } else if (mode === 'json') {
      for (const [f, p] of Object.entries(ex.fields)) {
        if (typeof p !== 'string' || !p) {
          throw new SchemaError(`'${exCtx}.fields.${f}' must be a non-empty path string (json mode, e.g. '$.load.1m')`);
        }
      }
      if ('row_key' in ex && !(ex.row_key in ex.fields)) {
        throw new SchemaError(`'${exCtx}.row_key' ('${ex.row_key}') must name a field in extract.fields`);
      }
      if ('root' in ex && typeof ex.root !== 'string') {
        throw new SchemaError(`'${exCtx}.root' must be a path string (json mode)`);
      }
    } else { // regex
      for (const [f, pat] of Object.entries(ex.fields)) {
        if (typeof pat !== 'string' || !pat) {
          throw new SchemaError(`'${exCtx}.fields.${f}' must be a non-empty regex string (regex mode)`);
        }
        try { new RegExp(pat); }
        catch (e) { throw new SchemaError(`'${exCtx}.fields.${f}' is not a valid regex: ${e.message}`); }
      }
    }
    if ('schema' in def) {
      if (!isMapping(def.schema)) throw new SchemaError(`'${ctx}.schema' must be a mapping`);
      if ('columns' in def.schema) {
        if (!isMapping(def.schema.columns)) throw new SchemaError(`'${ctx}.schema.columns' must be a mapping`);
        for (const [cname, cdef] of Object.entries(def.schema.columns)) {
          // `ts` is reserved (see extract.fields above): the producer stamps a
          // capture timestamp there, and the display iterates schema.columns —
          // a `ts` column would surface the raw epoch as if it were data. Reject
          // it here too (the extract.fields guard doesn't cover a column declared
          // ONLY under schema.columns).
          if (cname === 'ts') {
            throw new SchemaError(`'${ctx}.schema.columns.ts' uses the reserved column name 'ts' — the producer stamps a capture timestamp there (read by the stats time-axis), so it must never be a display column; rename it`);
          }
          if (!isMapping(cdef)) throw new SchemaError(`'${ctx}.schema.columns.${cname}' must be a mapping`);
          checkUnknownKeys(cdef, VALID_METRICS_COLUMN_KEYS, `${ctx}.schema.columns.${cname}`);
          if ('type' in cdef && !VALID_COLUMN_TYPES.has(cdef.type)) {
            throw new SchemaError(`'${ctx}.schema.columns.${cname}.type' must be one of: ${[...VALID_COLUMN_TYPES].join(', ')}`);
          }
          if ('meta' in cdef && typeof cdef.meta !== 'boolean') {
            throw new SchemaError(`'${ctx}.schema.columns.${cname}.meta' must be a boolean`);
          }
        }
      }
    }
  }
}

function validateActionStatus(v) {
  if (v === true || v === false || v == null) return;
  if (!isMapping(v)) {
    throw new SchemaError("'action_status' must be a mapping (or a boolean to enable/disable)");
  }
  checkUnknownKeys(v, VALID_ACTION_STATUS_KEYS, 'action_status');
  if ('enabled' in v && typeof v.enabled !== 'boolean') {
    throw new SchemaError("'action_status.enabled' must be a boolean");
  }
  if ('live' in v && typeof v.live !== 'boolean') {
    throw new SchemaError("'action_status.live' must be a boolean");
  }
  if ('segments' in v) {
    if (!Array.isArray(v.segments)) {
      throw new SchemaError("'action_status.segments' must be a list");
    }
    for (const s of v.segments) {
      if (!VALID_ACTION_STATUS_SEGMENTS.has(s)) {
        throw new SchemaError(`'action_status.segments' has unknown segment '${s}' (valid: ${[...VALID_ACTION_STATUS_SEGMENTS].join(', ')})`);
      }
    }
  }
}

/**
 * Scoped validation for the GLOBAL user config. Tolerant by design: only
 * GLOBAL_TOP_KEYS are honored; every other key — project content or a typo —
 * appends a `{code, message}` warning and is filtered out, instead of
 * throwing. The honored sections validate with the SAME validators as the
 * project config, and those DO throw: a malformed honored section is a real
 * error the user must see (the caller catches and degrades to project-only).
 * PURE of its input: returns a filtered COPY (the caller's object is never
 * mutated — it may be reused after a caught throw).
 */
function validateGlobal(data, warnings) {
  if (!isMapping(data)) throw new SchemaError('global config must be a YAML mapping');
  const out = {};
  for (const k of Object.keys(data).sort()) {
    if (GLOBAL_TOP_KEYS.has(k)) { out[k] = data[k]; continue; }
    if (warnings) {
      warnings.push({
        code: 'global.ignored_key',
        message: `global config: '${k}' is not a global section (honored: ${[...GLOBAL_TOP_KEYS].sort().join(', ')}) — ignored`,
      });
    }
  }
  if ('selection' in out && typeof out.selection !== 'boolean') {
    throw new SchemaError("'selection' must be a boolean");
  }
  if ('theme_background' in out && typeof out.theme_background !== 'boolean') {
    throw new SchemaError("'theme_background' must be a boolean");
  }
  if ('editor' in out)   validateEditor(out.editor);
  if ('color_depth' in out) validateColorDepth(out.color_depth);
  if ('keyboard_protocol' in out) validateKeyboardProtocol(out.keyboard_protocol);
  if ('action_status' in out) validateActionStatus(out.action_status);
  if ('quick_keys' in out) validateQuickKeys(out.quick_keys);
  if ('keys' in out)     validateKeys(out.keys);
  if ('keymap' in out)   validateKeymap(out.keymap);
  if ('mouse' in out)    validateMouse(out.mouse);
  if ('context-menu' in out) validateContextMenu(out['context-menu']);
  return out;
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
      // Width is a positive integer (FIXED) or the literal `flex` (the column
      // SHARES the leftover with the other flex columns + the implicit last one).
      // `width: null` / any other value is rejected — an implicit-width column
      // should OMIT the key entirely, not write `width: null` (that form was
      // accepted silently and behaved identically, making the schema ambiguous).
      const isFlex = w === 'flex';
      if (!isFlex && (typeof w !== 'number' || !Number.isInteger(w) || w <= 0)) {
        throw new SchemaError("'width' must be a positive integer or 'flex' (omit the key for an implicit-width column)", { context: ctx });
      }
      // A NUMERIC width on the last column is ignored (it always takes the
      // remainder); `width: flex` there is a harmless, honest no-op (not warned).
      if (ci === lastIdx && typeof w === 'number' && warnings) {
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
      // Sizing keys — validate VALUES, not just the key names. Unchecked, a
      // malformed `height` became parseInt→NaN and poisoned layout geometry (the
      // detail pane collapsed to h:0), and a mistyped `heightPct`/`collapsed` was
      // silently dropped downstream. All express a percentage (1-100) or a boolean.
      if ('height' in p) {
        const h = p.height;
        const pct = (typeof h === 'string' && /^\d+%$/.test(h)) ? Number(h.slice(0, -1)) : null;
        const okStr = pct !== null && pct > 0 && pct <= 100;
        const okNum = typeof h === 'number' && Number.isInteger(h) && h > 0 && h <= 100;
        if (!okStr && !okNum) {
          throw new SchemaError(`'height' must be a percent — an integer 1-100 or a "N%" string (got ${JSON.stringify(h)})`, { context: cellCtx });
        }
      }
      if ('heightPct' in p && !(typeof p.heightPct === 'number' && Number.isFinite(p.heightPct) && p.heightPct > 0 && p.heightPct <= 100)) {
        throw new SchemaError(`'heightPct' must be a number 1-100 (got ${JSON.stringify(p.heightPct)})`, { context: cellCtx });
      }
      if ('collapsed' in p && typeof p.collapsed !== 'boolean') {
        throw new SchemaError(`'collapsed' must be true or false (got ${JSON.stringify(p.collapsed)})`, { context: cellCtx });
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

// Values string-interpolated into SYNTHESIZED shell scripts — config_branch's git-worktree
// save/load scripts and the auto-generated `config_copy_to` helper (parser/index.js) — must
// not carry shell metacharacters, or a `"`, backtick, `$(…)`, `;`, … breaks out of the
// quoting and executes (B2, command injection). Reject at parse time — fail loud, per
// PRINCIPLES §9 — rather than escaping at each synthesis site. Normal path chars and globs
// (`*`) stay legal; a literal space is allowed (paths are double-quoted at those sites),
// control chars are not.
const SHELL_META_RE = /[$`"'\\;&|<>(){}\x00-\x1f]/;
function rejectShellMeta(value, what, ctx) {
  if (typeof value === 'string' && SHELL_META_RE.test(value)) {
    throw new SchemaError(`${what} must not contain shell metacharacters ($ \` " ' \\ ; & | < > ( ) { } or control chars)`, { context: ctx });
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
      rejectShellMeta(entry.path, "'path'", ctx);
      checkUnknownKeys(entry, VALID_FILE_KEYS, ctx);
      if ('var' in entry && typeof entry.var !== 'string')   throw new SchemaError("'var' must be a string", { context: ctx });
      if ('desc' in entry && typeof entry.desc !== 'string') throw new SchemaError("'desc' must be a string", { context: ctx });
      if ('exclude' in entry && !Array.isArray(entry.exclude)) {
        throw new SchemaError("'exclude' must be a list", { context: ctx });
      }
      if (Array.isArray(entry.exclude)) {
        for (let j = 0; j < entry.exclude.length; j++) {
          if (typeof entry.exclude[j] !== 'string') throw new SchemaError(`'exclude[${j}]' must be a string`, { context: ctx });
          rejectShellMeta(entry.exclude[j], `'exclude[${j}]'`, ctx);
        }
      }
      if ('category' in entry && typeof entry.category !== 'string') {
        throw new SchemaError("'category' must be a string", { context: ctx });
      }
    } else {
      throw new SchemaError('must be a string or mapping', { context: ctx });
    }
  }
}

function validateGroup(gname, gdata, parentPath = '', warnings) {
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
    rejectShellMeta(cb.branch, "'config_branch.branch'", ctx);
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
        rejectShellMeta(paths[i], `'config_branch.paths[${i}]'`, ctx);
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
          rejectShellMeta(excludes[i], `'config_branch.excludes[${i}]'`, ctx);
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
      validateAction(full, aname, adata, warnings);
    }
  }

  // Fabric wires reference this group's action ports (same-group in P1), so
  // validate after the actions above.
  validateGroupWires(gdata, ctx);

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

function validateAction(groupPath, aname, adata, warnings) {
  const ctx = `group '${groupPath}', action '${aname}'`;
  if (!isMapping(adata)) throw new SchemaError('must be a mapping', { context: ctx });
  checkUnknownKeys(adata, VALID_ACTION_KEYS, ctx);

  const hasCmd    = 'cmd'    in adata;
  const hasScript = 'script' in adata;
  const hasRun    = 'run'    in adata;   // fabric consumer: no-shell argv template (decision A)
  if (hasCmd && hasScript) {
    throw new SchemaError("must have exactly one of 'cmd' or 'script', not both", { context: ctx });
  }
  if (hasRun && (hasCmd || hasScript)) {
    throw new SchemaError("'run' (fabric, no-shell) cannot combine with 'cmd' / 'script' — pick one", { context: ctx });
  }
  if (!hasCmd && !hasScript && !hasRun) {
    throw new SchemaError("must have exactly one of 'cmd', 'script', or 'run'", { context: ctx });
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
  if ('tab' in adata && typeof adata.tab !== 'boolean') {
    throw new SchemaError("'tab' must be a boolean", { context: ctx });
  }
  if ('output' in adata) {
    if (!VALID_ACTION_OUTPUT_MODES.has(adata.output)) {
      const list = '[' + [...VALID_ACTION_OUTPUT_MODES].sort().map(s => `'${s}'`).join(', ') + ']';
      throw new SchemaError(`'output' must be one of ${list}, got '${adata.output}'`, { context: ctx });
    }
    // `output:` controls the STREAMED text-view buffer (replace vs append), so it
    // only means anything for `type: run` (the default). A `spawn` action's output
    // lives in its PTY tab and `background` runs detached with stdio ignored —
    // neither reads `action.output` in action-runner. Reject it there rather than
    // silently no-op a config the user clearly meant to have an effect.
    if (adata.type === 'spawn' || adata.type === 'background') {
      throw new SchemaError(`'output' has no effect on a '${adata.type}' action (it applies to 'run' output only); remove it or drop 'type'`, { context: ctx });
    }
  }

  // Dataflow fabric (docs/ports-and-wires.md): an action that declares `parse`
  // / `ports` is a fabric component (a producer and/or consumer).
  if ('parse' in adata) {
    try { compileParse(adata.parse); }
    catch (e) { throw new SchemaError(`invalid 'parse': ${e.message}`, { context: ctx }); }
  }
  if ('ports' in adata) validateActionPorts(aname, adata.ports, ctx, warnings);
  if ('run' in adata) validateActionRun(adata, ctx);
}

// Validate an action's `run:` argv template (decision A / decision 2): a
// non-empty string, or a non-empty list of strings, and every {{hole}} must be
// a declared input port (so a typo can't silently expand to nothing).
function validateActionRun(adata, ctx) {
  const run = adata.run;
  if (Array.isArray(run)) {
    if (run.length === 0) throw new SchemaError("'run' list must not be empty", { context: ctx });
    for (const el of run) {
      if (typeof el !== 'string') throw new SchemaError("'run' list elements must be strings", { context: ctx });
    }
  } else if (typeof run === 'string') {
    if (!run.trim()) throw new SchemaError("'run' must not be empty or whitespace-only", { context: ctx });
  } else {
    throw new SchemaError("'run' must be a list of strings or a string", { context: ctx });
  }
  let holes;
  try { holes = commandHoles(compileCommand(run)); }
  catch (e) { throw new SchemaError(`invalid 'run': ${e.message}`, { context: ctx }); }
  const inputs = (isMapping(adata.ports) && isMapping(adata.ports.in)) ? adata.ports.in : {};
  for (const hole of holes) {
    if (!(hole in inputs)) {
      throw new SchemaError(`'run' references {{${hole}}} but no input port '${hole}' is declared`, { context: ctx });
    }
  }
}

// Validate an action's `ports: { in?, out? }`. The action NAME is addressable
// as `name.port` (decision 4 — dot-free), so hyphens are fine (hyphen != dot)
// but every segment must still be free of the `.` separator. Port NAMES stay
// stricter — they bind as POSIX env vars and must `\w`-match in `{{name}}`
// template holes. Every port carries a required `type` (the equality-match
// key); an output port projects via `from` (defaults to the port name) OR a
// `{regex,group}` extract, not both.
function validateActionPorts(aname, ports, ctx, warnings) {
  if (!isMapping(ports)) throw new SchemaError("'ports' must be a mapping", { context: ctx });
  if (!isValidFabricComponentName(aname)) {
    throw new SchemaError(
      `action name '${aname}' declares ports, so it must be [A-Za-z_][A-Za-z0-9_-]* ` +
      `(identifiers with hyphens ok, dots reserved as the address separator)`,
      { context: ctx });
  }
  for (const dir of Object.keys(ports)) {
    if (dir !== 'in' && dir !== 'out') {
      throw new SchemaError(`'ports' keys must be 'in' or 'out', got '${dir}'`, { context: ctx });
    }
    const defs = ports[dir];
    if (!isMapping(defs)) throw new SchemaError(`'ports.${dir}' must be a mapping`, { context: ctx });
    for (const [pname, pdef] of Object.entries(defs)) {
      const pctx = `${ctx}, port '${dir}.${pname}'`;
      if (!isValidFabricName(pname)) {
        throw new SchemaError("port name must be an identifier [A-Za-z_][A-Za-z0-9_]*", { context: pctx });
      }
      if (!isMapping(pdef)) throw new SchemaError("port must be a mapping", { context: pctx });
      if (typeof pdef.type !== 'string' || !pdef.type) {
        throw new SchemaError("'type' is required (a non-empty string — the wire equality-match key)", { context: pctx });
      }
      if ('desc' in pdef && typeof pdef.desc !== 'string') {
        throw new SchemaError("'desc' must be a string", { context: pctx });
      }
      if (dir === 'out') {
        const hasFrom = 'from' in pdef, hasExtract = 'extract' in pdef;
        if (hasFrom && hasExtract) {
          throw new SchemaError("an output port uses 'from' OR 'extract', not both", { context: pctx });
        }
        if (hasFrom && typeof pdef.from !== 'string') {
          throw new SchemaError("'from' must be a string", { context: pctx });
        }
        if (hasExtract) {
          try { compileExtract(pdef.extract); }
          catch (e) { throw new SchemaError(`invalid 'extract': ${e.message}`, { context: pctx }); }
        }
        // Brief 3 — `variadic` is an input-only modifier (it routes argv tail
        // into `"$@"`, which has no symmetric meaning for an output port).
        if ('variadic' in pdef) {
          throw new SchemaError("'variadic' is an input-port modifier — not valid on an output port", { context: pctx });
        }
      } else {
        if ('required' in pdef && typeof pdef.required !== 'boolean') {
          throw new SchemaError("'required' must be a boolean", { context: pctx });
        }
        if ('from' in pdef || 'extract' in pdef) {
          throw new SchemaError("input ports don't take 'from' / 'extract'", { context: pctx });
        }
        // Brief 3 — `variadic: true` opts a port into "command + arbitrary
        // args" mode. Per-port type check here; cross-port rules (uniqueness,
        // last-position, collisions with choices/depends_on/default) run in a
        // second pass below (`_validateVariadicConstraints`) once every port's
        // own fields have been validated. OUT ports never take variadic.
        if ('variadic' in pdef && typeof pdef.variadic !== 'boolean') {
          throw new SchemaError("'variadic' must be a boolean", { context: pctx });
        }
        // Brief 3 (v0.6.43) — `remember: false` opts a port OUT of the per-
        // action "last-submitted value" session cache (the `[last]` chip on
        // form re-open). Default is remember-on for every port. Enforced
        // strictly boolean (no truthy/falsy coercion): a typo like
        // `remember: "no"` would otherwise be truthy → opt-IN, defeating the
        // author's intent. Warn-drop per
        // [[feedback_backcompat_on_new_validations]] — no pre-existing YAML
        // can have carried `remember:` before this brief, but keeping warn-
        // drop matches sibling conventions (bad_default_type / bad_choices_*)
        // so the author sees it in the parser warning list rather than a
        // crash.
        if ('remember' in pdef && typeof pdef.remember !== 'boolean') {
          // typeof null === 'object' in JS; call it out as 'null' explicitly
          // (a `remember: null` warning that just said "got object" would
          // leave the author wondering which object).
          const got = pdef.remember === null ? 'null' : typeof pdef.remember;
          if (warnings) {
            warnings.push({
              code: 'port.bad_remember',
              message: `${pctx}: 'remember' must be a boolean (got ${got}) — dropped`,
            });
          }
          delete pdef.remember;
        }
        // v0.6.44 Brief 3 — `sensitive: true` masks the port's value in the
        // submit preview (shown as `name=••••••`) and REDACTS it in the
        // WAL `fabric_form_submit` payload. Replay of a sensitive action
        // thus pauses at missing-required and reprompts via the form,
        // which is the correct security behavior ("my recording is safe
        // to share"). Default sensitive-off for every port.
        //
        // Strict boolean parse mirrors `remember`; a typo like
        // `sensitive: "yes"` would be truthy under coercion → opt-IN
        // mask on an unintended port. Warn-drop per
        // [[feedback_backcompat_on_new_validations]].
        //
        // IMPLICIT COUPLING: sensitive:true automatically forces
        // remember:false, even if the author wrote remember:true. The
        // rationale is the brief-3 design discussion: a sensitive-but-
        // remembered value persists in session formHistory and the next
        // open re-seeds the field with the real value; the preview mask
        // would then lie about what runs. Collapsing the two switches
        // prevents that footgun — a sensitive port is always both
        // masked AND not persisted. The author can keep writing
        // `remember: true` on a sensitive port (parser warns but doesn't
        // crash); the effective behavior is remember:false.
        if ('sensitive' in pdef && typeof pdef.sensitive !== 'boolean') {
          const got = pdef.sensitive === null ? 'null' : typeof pdef.sensitive;
          if (warnings) {
            warnings.push({
              code: 'port.bad_sensitive',
              message: `${pctx}: 'sensitive' must be a boolean (got ${got}) — dropped`,
            });
          }
          delete pdef.sensitive;
        }
        if (pdef.sensitive === true) {
          if (pdef.remember === true && warnings) {
            warnings.push({
              code: 'port.sensitive_overrides_remember',
              message: `${pctx}: 'sensitive: true' implies 'remember: false' — override applied (your 'remember: true' is ignored for this port)`,
            });
          }
          // Force the implicit coupling by stamping remember:false onto
          // the normalized decl. Downstream code (`formHistory` writer,
          // preview formatter) reads the stamped value, so one decision
          // point owns the behavior.
          pdef.remember = false;
        }
        // S2: a `default:` must be a primitive scalar — string, number, boolean.
        // A non-primitive would get `String()`'d by action-runner at run time,
        // yielding "[object Object]" or "1,2,3" as the form pre-fill — never
        // what the author meant. We WARN (not throw) and DROP the bad default
        // so the port behaves as if no default was declared, preserving
        // backward compat with any YAML that already had this quietly broken.
        // (Slice-1 pre-release review round 4 Fork 1 S2 — warn-not-throw per
        // round 5 backward-compat review.)
        if ('default' in pdef) {
          const dt = typeof pdef.default;
          if (pdef.default != null && dt !== 'string' && dt !== 'number' && dt !== 'boolean') {
            if (warnings) {
              warnings.push({
                code: 'port.bad_default_type',
                message: `${pctx}: 'default' must be a string/number/boolean (got ${
                  dt === 'object' && Array.isArray(pdef.default) ? 'array' : dt
                }) — dropped`,
              });
            }
            delete pdef.default;
          }
        }
        // S1: a port name that would shadow a security-sensitive env var
        // (PATH, LD_PRELOAD, BASH_ENV, …) will be dropped at run time by
        // _envWithShadowGuard regardless, so the port never actually overrides
        // the parent env. We WARN at load (not throw) so the author sees the
        // bug WITHOUT breaking a pre-existing config whose whole load would
        // otherwise fail at the first offending port. The port stays in the
        // schema; the runtime guard is the actual defense. (Slice-1 pre-release
        // review round 4 Fork 1 S1 — warn-not-throw per round 5 backward-
        // compat review.)
        if (isShadowedEnvName(pname) && warnings) {
          warnings.push({
            code: 'port.env_shadow',
            message: `${pctx}: port name '${pname}' would shadow a security-sensitive env var — dropped at run time; rename it (e.g. '${pname.toLowerCase()}') to silence this warning`,
          });
        }
        // args→ports slice 3+1 — literal `choices:` (static sibling of
        // choices_fn/choices_cmd). YAML list of scalars (value, no label) or
        // {value, label} maps. The static form has no fetch effect, no
        // timeout, no deps — the field.computed slot is seeded directly from
        // config at form_enter. The CLI completion helper and `--exec`
        // missing-required line read the same source without a spawn.
        //
        // Collision rule: `choices` + `choices_cmd` OR `choices` + `choices_fn`
        // on the same port is a HARD parse error, same severity as the
        // existing cmd+fn collision. Three sibling channels are mutually
        // exclusive — no silent precedence surprises.
        if ('choices' in pdef) {
          if ('choices_cmd' in pdef || 'choices_fn' in pdef) {
            throw new SchemaError(
              "'choices' is mutually exclusive with 'choices_cmd' / 'choices_fn' — pick one",
              { context: pctx });
          }
          const raw = pdef.choices;
          if (!Array.isArray(raw)) {
            if (warnings) {
              warnings.push({
                code: 'port.bad_choices',
                message: `${pctx}: 'choices' must be a list of scalars or {value,label} maps — dropped`,
              });
            }
            delete pdef.choices;
          } else {
            const CAP_CHOICES = 1024;                           // same cap as fn channel
            const items = [];
            const labels = [];
            let anyLabel = false;
            let dropped = 0;
            for (const it of raw) {
              // Scalar → stringified value, no label.
              if (it != null && (typeof it === 'string' || typeof it === 'number' || typeof it === 'boolean')) {
                items.push(String(it));
                labels.push(null);
                continue;
              }
              // {value, label} map — both required strings (label optional, coerces to '').
              // Allowing value: number for YAML convenience; label stays string-only.
              if (it && typeof it === 'object' && !Array.isArray(it)
                  && 'value' in it
                  && (typeof it.value === 'string' || typeof it.value === 'number' || typeof it.value === 'boolean')) {
                items.push(String(it.value));
                if (typeof it.label === 'string' && it.label) { labels.push(it.label); anyLabel = true; }
                else labels.push(null);
                continue;
              }
              dropped++;
            }
            if (dropped > 0 && warnings) {
              warnings.push({
                code: 'port.bad_choices_item',
                message: `${pctx}: 'choices' dropped ${dropped} item(s) that were neither a scalar nor {value,label}`,
              });
            }
            // Belt-and-suspenders cap: author-controlled list is bounded by
            // the same 1024 as the fn channel (humans picking from a list
            // this long is dubious; past this, the author should narrow at
            // the data source).
            let truncated = false;
            if (items.length > CAP_CHOICES) {
              items.length = CAP_CHOICES;
              labels.length = CAP_CHOICES;
              truncated = true;
              if (warnings) {
                warnings.push({
                  code: 'port.choices_truncated',
                  message: `${pctx}: 'choices' truncated to the first ${CAP_CHOICES} entries`,
                });
              }
            }
            // Normalize onto the pdef so downstream (action-runner, completion,
            // cli) reads a single shape: {items:[], labels:[] | null, truncated}.
            // labels: null when NO entry carried a label; otherwise an array
            // aligned to items with null for the entries that didn't label.
            pdef.choices = {
              items,
              labels: anyLabel ? labels : null,
              truncated,
            };
          }
        }
        // args→ports slice 2 — `choices_fn:` + `depends_on:` validation.
        // Both are warn-drop (not throw) per [[feedback_backcompat_on_new_
        // validations]]: a new rule that would reject previously-valid YAML
        // belongs on the `warnings` channel, with the runtime as the actual
        // defense (an unknown ref paints `[error]` on the field).
        if ('choices_fn' in pdef) {
          const ref = pdef.choices_fn;
          const ok = typeof ref === 'string' &&
                     /^[A-Za-z_][A-Za-z0-9_-]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(ref);
          // R1B-SMELL2 — defense-in-depth: reject refs whose component or fn
          // name is `__proto__` / `constructor` / `prototype`. The runtime
          // registry is Map-backed (prototype-safe), so these are already
          // non-exploitable; this check keeps a confused author from naming
          // a legitimate fn after a reserved identifier and getting silent
          // null-lookups at run time.
          const reservedRef = typeof ref === 'string' &&
            /(^|\.)(__proto__|constructor|prototype)(\.|$)/.test(ref);
          if (!ok || reservedRef) {
            if (warnings) {
              warnings.push({
                code: reservedRef ? 'port.reserved_choices_fn' : 'port.bad_choices_fn',
                message: reservedRef
                  ? `${pctx}: 'choices_fn' names a reserved identifier (${JSON.stringify(ref)}) — dropped`
                  : `${pctx}: 'choices_fn' must be a dotted ref '<component>.<fnName>' (got ${JSON.stringify(ref)}) — dropped`,
              });
            }
            delete pdef.choices_fn;
          }
        }
        // args→ports slice 3 — `choices_cmd:` + `choices_labeled:` + `choices_timeout:`.
        // `choices_cmd:` is a shell-backed sibling of `choices_fn:` — a shell
        // command whose stdout is split into choices through the same effect
        // channel. Trust parity with action `script:` (if you can author the
        // YAML you already have arbitrary shell). The env-shadow name check
        // above (line ~1142) covers both arms uniformly — a port named `PATH`
        // can't shadow regardless of which choices mechanism is used.
        //
        // Collision rule: `choices_cmd` + `choices_fn` on the same port is a
        // HARD parse error (not warn-drop). The combination couldn't exist
        // before this slice, so [[feedback_backcompat_on_new_validations]]
        // doesn't apply — no previously-valid config is being newly rejected.
        // Loud failure prevents silent precedence surprises.
        if ('choices_cmd' in pdef) {
          if ('choices_fn' in pdef) {
            throw new SchemaError(
              "'choices_cmd' and 'choices_fn' are both set on this port — pick one",
              { context: pctx });
          }
          const cmd = pdef.choices_cmd;
          if (typeof cmd !== 'string' || !cmd.trim()) {
            if (warnings) {
              warnings.push({
                code: 'port.bad_choices_cmd',
                message: `${pctx}: 'choices_cmd' must be a non-empty string — dropped`,
              });
            }
            delete pdef.choices_cmd;
          }
        }
        if ('choices_labeled' in pdef) {
          if (typeof pdef.choices_labeled !== 'boolean') {
            if (warnings) {
              warnings.push({
                code: 'port.bad_choices_labeled',
                message: `${pctx}: 'choices_labeled' must be a boolean — dropped`,
              });
            }
            delete pdef.choices_labeled;
          }
        }
        if ('choices_timeout' in pdef) {
          const t = pdef.choices_timeout;
          const MAX_CHOICES_TIMEOUT = 60000;
          const bad = typeof t !== 'number' || !Number.isFinite(t) || t <= 0
            || t > MAX_CHOICES_TIMEOUT || Math.floor(t) !== t;
          if (bad) {
            if (warnings) {
              warnings.push({
                code: 'port.bad_choices_timeout',
                message: `${pctx}: 'choices_timeout' must be a positive integer ms ≤ ${MAX_CHOICES_TIMEOUT} — dropped`,
              });
            }
            delete pdef.choices_timeout;
          }
        }
        // Dangling keys — `choices_labeled` / `choices_timeout` with none of
        // the three choices channels set is a no-op; warn-drop so the author
        // sees the typo without a broken load. (For `choices_fn:` these keys
        // also do nothing today; the author presumably intended them for
        // `choices_cmd:` and misspelled or lost a key.)
        //
        // ORDER MATTERS: these two checks run AFTER the type checks above
        // that may `delete pdef.choices_cmd`. A bad `choices_cmd` is dropped
        // first, then any lingering `choices_labeled`/`choices_timeout` fires
        // dangling. Re-ordering the blocks silently breaks this.
        //
        // For LITERAL `choices:`, labels come from the inline map entries
        // ({value, label}) — `choices_labeled` is nonsensical there. Keep
        // the same dangling-warn pattern.
        if ('choices_labeled' in pdef && !('choices_cmd' in pdef)) {
          if (warnings) {
            warnings.push({
              code: 'port.dangling_choices_labeled',
              message: `${pctx}: 'choices_labeled' has no effect without 'choices_cmd' — dropped`,
            });
          }
          delete pdef.choices_labeled;
        }
        if ('choices_timeout' in pdef && !('choices_cmd' in pdef)) {
          if (warnings) {
            warnings.push({
              code: 'port.dangling_choices_timeout',
              message: `${pctx}: 'choices_timeout' has no effect without 'choices_cmd' — dropped`,
            });
          }
          delete pdef.choices_timeout;
        }
        if ('depends_on' in pdef) {
          const raw = pdef.depends_on;
          // Dangling: depends_on only makes sense when there's a FETCH that
          // re-fires on dep change (choices_cmd / choices_fn). Literal
          // `choices:` has no fetch — warn-drop so the author sees it. Must
          // run BEFORE the type/sibling validation so a bad `depends_on`
          // with literal `choices:` doesn't also warn about non-sibling refs.
          if ('choices' in pdef && !('choices_cmd' in pdef) && !('choices_fn' in pdef)) {
            if (warnings) {
              warnings.push({
                code: 'port.dangling_depends_on',
                message: `${pctx}: 'depends_on' has no effect alongside literal 'choices' (no fetch to re-fire) — dropped`,
              });
            }
            delete pdef.depends_on;
          } else if (!Array.isArray(raw)) {
            if (warnings) {
              warnings.push({
                code: 'port.bad_depends_on',
                message: `${pctx}: 'depends_on' must be a list of sibling port names — dropped`,
              });
            }
            delete pdef.depends_on;
          } else {
            const siblingNames = Object.keys(defs);
            const kept = [];
            for (const name of raw) {
              if (typeof name !== 'string') {
                if (warnings) {
                  warnings.push({
                    code: 'port.bad_depends_on_entry',
                    message: `${pctx}: 'depends_on' entry must be a string (got ${typeof name}) — dropped`,
                  });
                }
                continue;
              }
              if (name === pname) {
                if (warnings) {
                  warnings.push({
                    code: 'port.self_depends',
                    message: `${pctx}: 'depends_on' can't reference the port itself — dropped`,
                  });
                }
                continue;
              }
              if (!siblingNames.includes(name)) {
                if (warnings) {
                  warnings.push({
                    code: 'port.unknown_depends_on',
                    message: `${pctx}: 'depends_on' names '${name}' but no sibling port with that name is declared — dropped`,
                  });
                }
                continue;
              }
              kept.push(name);
            }
            pdef.depends_on = kept;
          }
        }
      }
    }
    // Brief 3 — cross-port rules for `variadic: true` input ports. Runs after
    // every individual port is validated so the per-port state we read (type,
    // choices arms, depends_on, default) reflects the normalized shape.
    //   1. At most one variadic port per action.
    //   2. The variadic port MUST be last in declaration order (argv tail is
    //      what the shell interprets as $@; a scalar after it would get
    //      silently misbound).
    //   3. A variadic port cannot carry `choices` / `choices_cmd` /
    //      `choices_fn` / `depends_on` / `default` — HARD error. Choices
    //      presume a popover; depends_on presumes a fetch; `default` is a
    //      scalar surface. None of them have coherent semantics on an item
    //      list.
    // HARD errors (not warn-drop) because the combinations couldn't exist
    // before this brief — [[feedback_backcompat_on_new_validations]] does
    // not apply; no previously-valid YAML is being newly rejected.
    if (dir === 'in') {
      _validateVariadicConstraints(defs, ctx);
    }
  }
}

function _validateVariadicConstraints(defs, ctx) {
  const names = Object.keys(defs);
  const variadics = names.filter((n) => defs[n] && defs[n].variadic === true);
  if (variadics.length === 0) return;
  if (variadics.length > 1) {
    throw new SchemaError(
      `at most one 'variadic: true' port per action, got ${variadics.length}: ${variadics.join(', ')}`,
      { context: ctx });
  }
  const vname = variadics[0];
  if (names[names.length - 1] !== vname) {
    throw new SchemaError(
      `'variadic: true' port '${vname}' must be LAST in declaration order (argv tail is $@); ` +
      `move it after ${names.slice(names.indexOf(vname) + 1).map((n) => `'${n}'`).join(', ')}`,
      { context: ctx });
  }
  const vdef = defs[vname];
  const banned = ['choices', 'choices_cmd', 'choices_fn', 'depends_on', 'default'];
  for (const key of banned) {
    if (key in vdef) {
      throw new SchemaError(
        `variadic port '${vname}' cannot carry '${key}' (no coherent popover / fetch / scalar semantics on an item list)`,
        { context: ctx });
    }
  }
}

// Validate a group's `wires: [{ from, to }]` — addresses parse (same-group
// component.port), endpoints exist with the right direction, and the two ends'
// types are string-equal (decision 1 / type model). Runs after the actions are
// validated so the port declarations are present.
function validateGroupWires(gdata, ctx) {
  if (!('wires' in gdata)) return;
  const wires = gdata.wires;
  if (!Array.isArray(wires)) throw new SchemaError("'wires' must be a list", { context: ctx });
  const actions = isMapping(gdata.actions) ? gdata.actions : {};
  const portOf = (comp, port, dir) => {
    const a = actions[comp];
    const p = a && isMapping(a.ports) && isMapping(a.ports[dir]) ? a.ports[dir][port] : null;
    return p && isMapping(p) ? p : null;
  };
  for (const w of wires) {
    if (!isMapping(w) || typeof w.from !== 'string' || typeof w.to !== 'string') {
      throw new SchemaError("each wire must be { from: <component.port>, to: <component.port> }", { context: ctx });
    }
    let f, t;
    try { f = parseFabricAddr(w.from); } catch (e) { throw new SchemaError(`wire.from: ${e.message}`, { context: ctx }); }
    try { t = parseFabricAddr(w.to);   } catch (e) { throw new SchemaError(`wire.to: ${e.message}`,   { context: ctx }); }
    const fOut = portOf(f.component, f.port, 'out');
    if (!fOut) throw new SchemaError(`wire.from '${w.from}' — no such output port in this group`, { context: ctx });
    const tIn = portOf(t.component, t.port, 'in');
    if (!tIn) throw new SchemaError(`wire.to '${w.to}' — no such input port in this group`, { context: ctx });
    if (fOut.type !== tIn.type) {
      throw new SchemaError(
        `wire type mismatch: ${w.from} (${fOut.type}) → ${w.to} (${tIn.type})`, { context: ctx });
    }
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

module.exports = { validate, validateGlobal };
