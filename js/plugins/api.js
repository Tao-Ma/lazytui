/**
 * Plugin API — loads and manages plugins.
 *
 * Plugins provide panel types with data sources.
 * Core built-in panels (groups, actions, file-manager, detail) are
 * registered as internal plugins using the same interface.
 *
 * Zero dependencies (uses local modules).
 */
'use strict';

const path = require('path');
const hub = require('../hub');
const decorators = require('../decorators');
const { decorate } = require('../decorators');

// L0/L2 helpers re-exported as the plugin-facing surface (see PLUGINS.md
// "Plugin API"). Plugin authors should import only from `./api` so the
// surface is one diff away from any future API change. Direct imports
// from `../ansi` etc. still work but are not part of the contract.
const { esc, visibleLen, stripMarkup } = require('../ansi');
const { theme } = require('../themes');
const { renderPanel } = require('../panel');
const { getSel, getScroll, isMultiSel } = require('../state');
const { getFilter } = require('../filter');
const { execAsync } = require('../exec');
const { streamCommand } = require('../stream');
const { addEphemeralTab } = require('../tabs');
const { scheduleRender } = require('../render-queue');

const plugins = {};        // name -> plugin module
const panelTypeMap = {};   // panelType -> plugin name
const statusProviders = []; // plugin modules that expose statusFor(name)

// Components — the TEA-shaped strict-discipline alternative to Plugin.
// See docs/PRINCIPLES.md (and PLUGINS.md when written) for the design
// rationale. A Component owns a state slice via init() and accepts
// messages through update(msg, slice) → newSlice. Render functions
// receive the slice (not the global S) — Components that read
// app-global state must import it explicitly. Both APIs coexist; old
// plugins are untouched.
const components = {};              // name -> component spec
const componentSlices = {};         // name -> current slice
const componentPanelTypeMap = {};   // panelType -> component name

/**
 * Register a plugin. Validates required shape (rejects malformed plugins)
 * and warns about optional-hook shape mismatches so authors notice typos
 * before they cause silent runtime no-ops.
 *
 * Required: `name`, every panelType has `render()`.
 * Optional but type-checked when present: getItems, getInfo, onKey,
 * copyOptions, filterText. Wrong type → warning, plugin still loads.
 *
 * @param {object} plugin
 */
function registerPlugin(plugin, config) {
  if (!plugin || typeof plugin !== 'object' || !plugin.name) {
    console.error('[plugin] missing or invalid name; skipping');
    return;
  }
  // Single init lifecycle: built-ins get plugin.defaults, YAML-loaded
  // plugins get their YAML config (passed by loadPlugins). Hub
  // subscriptions and topic schemas live in init() and must run before
  // any refresh() / render() / publish() can fire.
  if (typeof plugin.init === 'function') {
    try { plugin.init(config || plugin.defaults || {}); }
    catch (e) { console.error(`[plugin:${plugin.name}] init error: ${e.message}`); }
  }
  plugins[plugin.name] = plugin;
  if (plugin.panelTypes) {
    const optionalFns = ['getItems', 'getInfo', 'onKey', 'copyOptions', 'filterText'];
    for (const [type, def] of Object.entries(plugin.panelTypes)) {
      if (!def || typeof def.render !== 'function') {
        console.error(`[plugin:${plugin.name}] panelType '${type}' missing render(); skipping`);
        continue;
      }
      for (const fn of optionalFns) {
        if (def[fn] !== undefined && typeof def[fn] !== 'function') {
          console.error(`[plugin:${plugin.name}] panelType '${type}' has '${fn}' that is not a function; ignored`);
        }
      }
      if (def.filterable && typeof def.getItems !== 'function') {
        console.error(`[plugin:${plugin.name}] panelType '${type}' is filterable but has no getItems(); filtering will no-op`);
      }
      panelTypeMap[type] = plugin.name;
    }
  }
  if (typeof plugin.statusFor === 'function') statusProviders.push(plugin);
  // Decorator handlers — DECORATORS.md. Plugins export `decorators` as a
  // map of slot → handler. Walk the map once at register time so the
  // decorator framework's hot path stays a Map.get + length check.
  if (plugin.decorators && typeof plugin.decorators === 'object') {
    for (const [slot, fn] of Object.entries(plugin.decorators)) {
      decorators.register(slot, fn, plugin.name);
    }
  }
}

/**
 * Register a Component — the strict TEA-shaped alternative to
 * registerPlugin. A Component must declare:
 *
 *   - name: string
 *   - init(): slice       — initial state slice for this component
 *   - update(msg, slice)  — pure: returns the new slice
 *   - panelTypes (opt):   — same shape as Plugin's, but render gets
 *                           (panel, w, h, slice) instead of (..., S)
 *
 * The framework owns the slice. Every Msg (key / refresh / hub /
 * action) is fanned out to every Component's update(). The dispatch
 * stays sync: a single update() returning a new slice is the only
 * mutation site.
 *
 * Components don't have `onKey` — key events arrive as messages
 * through update(). Components can still ship decorators, commands,
 * statusFor — those are unchanged.
 *
 * Coexists with registerPlugin. A plugin author chooses per-plugin.
 */
function registerComponent(comp) {
  if (!comp || typeof comp !== 'object' || typeof comp.name !== 'string') {
    console.error('[component] missing or invalid name; skipping');
    return;
  }
  if (typeof comp.init !== 'function' || typeof comp.update !== 'function') {
    console.error(`[component:${comp.name}] requires init() and update(msg, slice); skipping`);
    return;
  }
  components[comp.name] = comp;
  try { componentSlices[comp.name] = comp.init(); }
  catch (e) {
    console.error(`[component:${comp.name}] init error: ${e.message}`);
    componentSlices[comp.name] = null;
  }
  if (comp.panelTypes) {
    for (const [type, def] of Object.entries(comp.panelTypes)) {
      if (!def || typeof def.render !== 'function') {
        console.error(`[component:${comp.name}] panelType '${type}' missing render(); skipping`);
        continue;
      }
      componentPanelTypeMap[type] = comp.name;
    }
  }
  if (typeof comp.statusFor === 'function') statusProviders.push(comp);
  if (comp.decorators && typeof comp.decorators === 'object') {
    for (const [slot, fn] of Object.entries(comp.decorators)) {
      decorators.register(slot, fn, comp.name);
    }
  }
}

/**
 * Dispatch a Msg to every registered Component. Each Component's
 * slice is replaced with the return value of its update(msg, slice).
 *
 * Msg shape mirrors the event-log entries:
 *   { type: 'key', key, seq }
 *   { type: 'refresh' }
 *   { type: 'hub', topic, rowKey, sample }
 *   { type: 'action', actionKey, args, type: 'run'|'spawn'|... }
 *
 * Failures in one Component's update don't stop dispatch to the
 * others — error logged, that Component's slice is left as-is.
 */
function dispatchMsg(msg) {
  for (const [name, comp] of Object.entries(components)) {
    try {
      const next = comp.update(msg, componentSlices[name]);
      if (next !== undefined) componentSlices[name] = next;
    } catch (e) {
      console.error(`[component:${name}] update error: ${e.message}`);
    }
  }
}

function getComponent(name)              { return components[name]; }
function getComponentSlice(name)         { return componentSlices[name]; }
function getComponentOwningPanel(panelT) { return componentPanelTypeMap[panelT]; }

/**
 * Ask all plugins that contribute item status (e.g. docker container state).
 * First non-null answer wins. Returns null if no provider has an opinion.
 * Lets core renderers display status without knowing which plugin owns it.
 */
function statusFor(name) {
  for (const p of statusProviders) {
    const s = p.statusFor(name);
    if (s != null) return s;
  }
  return null;
}

/**
 * Load plugins from YAML config. Errors are reported to stderr; failed
 * plugins are skipped so the TUI can still start.
 */
function loadPlugins(pluginsConfig, configDir) {
  if (!pluginsConfig) return;
  for (const [name, conf] of Object.entries(pluginsConfig)) {
    try {
      let pluginPath;
      if (conf && conf.path) {
        pluginPath = path.resolve(configDir, conf.path);
        // YAML plugins are merged into the config by the parser before JS
        // sees the data; nothing to load on the JS side.
        if (pluginPath.endsWith('.yml') || pluginPath.endsWith('.yaml')) continue;
      } else {
        pluginPath = path.join(__dirname, `${name}.js`);
      }
      const plugin = require(pluginPath);
      registerPlugin(plugin, conf || {});
    } catch (e) {
      console.error(`[plugin] failed to load '${name}': ${e.message}`);
    }
  }
}

/**
 * Get the plugin that owns a panel type.
 * @param {string} panelType
 * @returns {object|null} plugin module or null
 */
function getPlugin(panelType) {
  const name = panelTypeMap[panelType];
  return name ? plugins[name] : null;
}

/**
 * Get panel type definition from its plugin.
 * @param {string} panelType
 * @returns {object|null} { mode, render, getItems, getInfo, ... }
 */
function getPanelDef(panelType) {
  const plugin = getPlugin(panelType);
  return plugin && plugin.panelTypes ? plugin.panelTypes[panelType] : null;
}

/**
 * Canonical filtered item list for a panel. Plugins return raw items from
 * `panelDef.getItems(S)`; the framework applies the active filter using
 * `panelDef.filterText(item)` (defaults to String(item)). This is THE
 * single source of items for renderers, navigation, mouse hit-testing,
 * detail info, and copy options — no caller may filter independently,
 * which would desync selection index vs rendered list.
 */
function getItems(panelType, S) {
  const def = getPanelDef(panelType);
  if (!def || typeof def.getItems !== 'function') return [];
  const raw = def.getItems(S);
  if (!def.filterable) return raw;
  // Inlined filter match — kept here (rather than imported from ../filter)
  // so plugins/api stays free of a back-edge to filter.js, which lazy-
  // requires from this module for filterable-panel detection.
  const filterText = (S.filters[panelType] || '');
  if (!filterText) return raw;
  const lc = filterText.toLowerCase();
  const fieldOf = typeof def.filterText === 'function' ? def.filterText : String;
  return raw.filter(item => fieldOf(item).toLowerCase().includes(lc));
}

/**
 * Call refresh() on all loaded plugins. Plugins SHOULD return a Promise
 * (use exec.js's execAsync for shell commands) — sync refresh blocks the
 * event loop and freezes the UI on slow I/O. Sync boolean return is still
 * supported for trivial plugins.
 *
 * @returns {Promise<boolean>} true if any plugin reported changes
 */
async function refreshAll(config) {
  // Event log (PRINCIPLES.md §11 + CHANGELOG v0.2.0). One record per
  // tick — payload empty because the tick itself is the input event;
  // the per-plugin refresh side-effects are responses.
  require('../event-log').record('refresh', null);
  // Component Msg dispatch (v0.3.0). Refresh ticks fan out to every
  // Component's update() as a 'refresh' Msg.
  dispatchMsg({ type: 'refresh' });
  let changed = false;
  for (const plugin of Object.values(plugins)) {
    if (plugin.refresh) {
      try {
        const result = await plugin.refresh(config);
        if (result) changed = true;
      } catch (e) {
        console.error(`[plugin:${plugin.name}] refresh error: ${e.message}`);
      }
    }
  }
  return changed;
}

/**
 * Start per-plugin refresh loops. Each loaded plugin with a
 * `refresh()` function gets its own self-scheduling setTimeout
 * keyed on its declared `refreshIntervalMs` (default 10000ms).
 *
 * A plugin author who wants fast updates (stats panel at ~1s)
 * declares `refreshIntervalMs: 1000`; a plugin that polls a remote
 * API declares the slower cadence it actually needs.
 *
 * The runtime guarantees:
 *   - Overlap protection: if a plugin's refresh is still running
 *     when its next tick fires, the tick is skipped (don't queue
 *     up backlogged runs on a slow plugin).
 *   - Focus gating: if `isFocused()` returns false, ticks are
 *     skipped — the runtime still reschedules, so cadence picks
 *     back up when focus returns. (Provided by the caller so api.js
 *     stays state.js-agnostic.)
 *   - One-shot `refreshAll` (for :refresh cmdline + initial paint)
 *     keeps working unchanged; it iterates plugins serially and
 *     ignores their declared interval.
 *
 * @param {object} config        - parsed YAML config passed to each refresh()
 * @param {object} opts
 * @param {() => boolean} opts.isFocused - return true if the TUI should poll
 * @param {() => void} opts.onChanged    - called when any plugin returned truthy
 */
function startRefreshLoops(config, { isFocused = () => true, onChanged } = {}) {
  for (const plugin of Object.values(plugins)) {
    if (!plugin.refresh) continue;
    const interval = plugin.refreshIntervalMs || 10000;
    let running = false;

    async function tick() {
      if (!running && isFocused()) {
        running = true;
        try {
          const changed = await plugin.refresh(config);
          if (changed && onChanged) onChanged();
        } catch (e) {
          console.error(`[plugin:${plugin.name}] refresh error: ${e.message}`);
        } finally {
          running = false;
        }
      }
      setTimeout(tick, interval);
    }
    setTimeout(tick, interval);
  }
}

/**
 * Check if a panel type is provided by a plugin (not core built-in).
 */
function isPluginPanel(panelType) {
  return panelType in panelTypeMap;
}

/**
 * Get all registered plugin names.
 */
function pluginNames() {
  return Object.keys(plugins);
}

/**
 * Collect plugin-contributed actions for a group. Plugins that implement
 * `groupActions(group, groupName)` can inject actions automatically (e.g.
 * docker plugin synthesizes `up`/`down`/`logs` for groups with `compose:`).
 * Returns a flat object keyed by action name.
 */
function getGroupActions(group, groupName) {
  const result = {};
  for (const plugin of Object.values(plugins)) {
    if (typeof plugin.groupActions === 'function') {
      try {
        Object.assign(result, plugin.groupActions(group, groupName) || {});
      } catch (e) {
        console.error(`[plugin:${plugin.name}] groupActions error: ${e.message}`);
      }
    }
  }
  return result;
}

/**
 * Stable identity for an item in a panel. Used by multi-select state so
 * selections survive filtering / reordering. Plugins declare `idOf(item)`
 * on their panelType def; default fallback is `String(item)` (works for
 * panels whose items are already strings, like containers).
 */
function idOf(panelType, item) {
  const def = getPanelDef(panelType);
  if (def && typeof def.idOf === 'function') return def.idOf(item);
  return String(item);
}

/**
 * Bulk-operation operand resolver. Returns an array:
 *   - all multi-selected items in the panel, if any
 *   - else the single focused item (single-element array)
 *   - else []
 *
 * Bulk-capable plugin commands call this with their panelType and act on
 * the result — same code path for one and many. See CMDMODE.md.
 */
function selectedOrFocused(panelType, S) {
  const items = getItems(panelType, S);
  const ms = S.multiSel[panelType];
  if (ms && ms.size > 0) {
    return items.filter(item => ms.has(idOf(panelType, item)));
  }
  const sel = (S.sel && S.sel[panelType]) || 0;
  return items[sel] ? [items[sel]] : [];
}

/**
 * Framework default `:` commands — `quit`, `refresh`, `help`. They live
 * here (not in corePlugin) because they're framework actions, not panel-
 * type behavior. corePlugin used to host them, which made it import
 * `../dispatch` and `../cleanup` and break the plugin/host layering.
 *
 * `help` is wired via lazy require to avoid an api → help-text → api
 * cycle at module-load time. `cleanup` is also lazy-required because
 * it pulls `../terminal` → `node-pty`, which CLI mode (cli.js) needs to
 * avoid: cli.js may require this module to discover plugin
 * `groupActions` without booting the TUI runtime.
 */

const FRAMEWORK_COMMANDS = [
  {
    name: 'quit',
    desc: 'Exit the TUI',
    run: () => {
      const { cleanup } = require('../cleanup');
      cleanup();
      process.exit(0);
    },
  },
  {
    name: 'refresh',
    desc: 'Re-run plugin refresh()',
    // S comes from the cmdline-dispatched run(args, S) contract.
    run: async (_args, S) => { await refreshAll(S.config); },
  },
  {
    name: 'help',
    desc: 'Show key help in detail panel',
    run: () => { require('../help-text').showHelp(); },
  },
];

/**
 * Collect commands for `:` cmdline mode. Three sources:
 *   1. Framework defaults (quit / refresh / help) — always available.
 *   2. Plugin `commands` arrays (fixed verbs).
 *   3. Plugin `getCommands(S)` (state-derived candidates like
 *      `theme <name>` — one entry per available theme).
 *
 * Each command must have { name, desc, run(args, S) }. The source name
 * is stamped on `_plugin` for telemetry / disambiguation; framework
 * defaults are stamped `<framework>`.
 */
function getCommands(S) {
  const out = [];
  for (const c of FRAMEWORK_COMMANDS) {
    out.push({ ...c, _plugin: '<framework>' });
  }
  for (const plugin of Object.values(plugins)) {
    const collect = (list) => {
      if (!Array.isArray(list)) return;
      for (const c of list) {
        if (!c || typeof c.name !== 'string' || typeof c.run !== 'function') continue;
        out.push({ ...c, _plugin: plugin.name });
      }
    };
    collect(plugin.commands);
    if (typeof plugin.getCommands === 'function') {
      try { collect(plugin.getCommands(S)); }
      catch (e) { console.error(`[plugin:${plugin.name}] getCommands error: ${e.message}`); }
    }
  }
  return out;
}

module.exports = {
  // --- Plugin registry / lifecycle ---
  registerPlugin, loadPlugins, getPlugin, getPanelDef, getItems,
  refreshAll, startRefreshLoops, isPluginPanel, pluginNames, getGroupActions, statusFor,
  registerComponent, dispatchMsg,
  getComponent, getComponentSlice, getComponentOwningPanel,
  getCommands, idOf, selectedOrFocused,

  // --- Subsystems (plugins commonly publish/subscribe or decorate) ---
  hub,         // event hub (HUB.md) — pub/sub data bus
  decorators,  // decorator framework module (DECORATORS.md) — register/decorate/slots
  decorate,    // shorthand: the slot-dispatch fn

  // --- L0/L2 helpers re-exported as the plugin-facing surface ---
  // ansi
  esc, visibleLen, stripMarkup,
  // themes
  theme,
  // panel
  renderPanel,
  // state (read helpers — plugins should not mutate S directly)
  getSel, getScroll, isMultiSel,
  // filter
  getFilter,
  // exec
  execAsync,
  // stream / tabs / render scheduling — host capabilities a plugin
  // may invoke (run a shell command, open an ephemeral terminal tab,
  // request a redraw on async events)
  streamCommand,
  addEphemeralTab,
  scheduleRender,
};
