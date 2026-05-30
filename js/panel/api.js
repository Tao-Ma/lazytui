/**
 * Component API — registers and runs Components.
 *
 * Every in-tree panel is a Component: a TEA-shaped triple of `init()` /
 * `update(msg, slice)` / `panelTypes[type].render(panel, w, h, slice)`,
 * with optional cross-cutting contributions (`commands`, `groupActions`,
 * `statusFor`, `viewContributions`, `cleanup`). The framework owns slice
 * storage; each Component's `update` is the single writer for its own
 * slice. See `docs/PRINCIPLES.md` §12 + the spec at
 * `docs/v0.5-layout-component.md`.
 *
 * Phase 6 retired the legacy Plugin API surface (`registerPlugin`,
 * `loadPlugins`, per-Plugin refresh loops, the YAML `plugins:` loader).
 * External authors write Components — same API as built-ins.
 *
 * Zero dependencies (uses local modules).
 */
'use strict';

const hub = require('./hub');
const route = require('../leaves/route');

// L0/L2 helpers re-exported as the Component-facing surface. Component
// authors should import only from `./api` so the surface is one diff
// away from any future API change. Direct imports from `../ansi` etc.
// still work but are not part of the contract.
const { esc, visibleLen, stripMarkup } = require('../io/ansi');
const { theme } = require('../render/themes');
const { renderPanel } = require('../render/panel');
const { getSel, getScroll, isMultiSel } = require('../app/state');
const { getModel } = require('../app/runtime');
const { getFilter } = require('../overlay/filter');
const { execAsync } = require('../app/exec');
const { streamCommand } = require('../io/stream');
const { addEphemeralTab } = require('./viewer/tabs');
const { scheduleRender } = require('../render/render-queue');

// Components — the TEA-shaped strict-discipline shape used by every
// in-tree panel. A Component owns a state slice via init() and accepts
// messages through update(msg, slice) → newSlice (or [newSlice, effects]).
// Render functions receive the slice — Components that read app-global
// state import it explicitly via getModel(). See docs/PRINCIPLES.md §12.
const components = {};              // name -> component spec (functions, not state)
const statusProviders = [];         // Components that expose statusFor(name)

// Slice storage + panel→Component ownership map live in `./route` (a
// zero-dep leaf) so the root reducer can read them without a require
// cycle. The nested store (layout at root, others under
// `layout.panels[<name>]`) is documented there; api just calls through.

// Panel-def contract check. Returns false (skip this type) only when
// render() is missing — the one hard requirement. Everything else is a
// non-fatal warning so a typo'd hook surfaces at registration instead of
// as a silent no-op at some scattered `typeof def.X === 'function'` call
// site later.
function _validatePanelDef(compName, type, def) {
  const label = `component:${compName}`;
  if (!def || typeof def.render !== 'function') {
    console.error(`[${label}] panelType '${type}' missing render(); skipping`);
    return false;
  }
  for (const fn of ['getItems', 'getInfo', 'copyOptions', 'filterText', 'idOf']) {
    if (def[fn] !== undefined && typeof def[fn] !== 'function') {
      console.error(`[${label}] panelType '${type}' has '${fn}' that is not a function; ignored`);
    }
  }
  if (def.customFilter !== undefined && typeof def.customFilter !== 'boolean') {
    console.error(`[${label}] panelType '${type}' has non-boolean 'customFilter'; treated as truthy`);
  }
  if (def.keyHints !== undefined && typeof def.keyHints !== 'string') {
    console.error(`[${label}] panelType '${type}' has non-string 'keyHints'`);
  }
  if (def.claimsKeys !== undefined) {
    console.error(`[${label}] panelType '${type}' declares 'claimsKeys' — that field is retired. Return the \`_claimed\` sentinel effect from update() for keys you own.`);
  }
  if (def.filterable && typeof def.getItems !== 'function') {
    console.error(`[${label}] panelType '${type}' is filterable but has no getItems(); filtering will no-op`);
  }
  return true;
}

/**
 * Register a Component. A Component must declare:
 *
 *   - name: string
 *   - init(): slice       — initial state slice for this component
 *   - update(msg, slice)  — pure: returns the new slice (or [slice, effects])
 *   - panelTypes (opt):   — { [type]: { render, getItems?, getInfo?,
 *                           copyOptions?, filterText?, idOf?,
 *                           keyHints?, ... } }. `render` gets
 *                           (panel, w, h, slice). Omitted entirely for
 *                           chrome-only Components (see below).
 *   - viewContributions (opt): — `{ footerLeft?, footerRight? }` — see
 *                           `collectViewContributions` below.
 *   - statusFor, groupActions, commands, getCommands, cleanup (opt) —
 *                           cross-cutting contributions; collected by
 *                           the framework.
 *
 * **Chrome-only Components** — a Component with no `panelTypes` is
 * valid and supported. It owns a slice + update + (optionally) view
 * contributions, but renders no panel in the grid. The `layout`
 * Component is the canonical example. Chrome-only Components still
 * receive fan-out Msgs (refresh / hub / action / wrapped); they do NOT
 * receive `key` Msgs since key arbitration routes to the focused
 * panel's owner.
 *
 * The framework owns the slice. Refresh / hub / action Msgs fan out to
 * every Component's update(); a single update() returning a new slice
 * is the only mutation site. Dispatch stays sync.
 *
 * Key events arrive at the focused Component as `{type:'key', key, seq}`
 * Msgs through update() via `dispatchKeyToFocused`. To suppress the
 * framework default for a key the Component owns, return the
 * `_claimed` sentinel effect alongside the slice:
 *
 *     return [slice, [{ type: '_claimed' }]];
 *
 * `dispatchKeyToFocused` consumes the sentinel and short-circuits the
 * framework switch in handleNormalKey. Both the claim and the handler
 * live in the same return statement — no separate field to keep in
 * sync.
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
  // Phase 3 — initial slice goes through the nested storage in route.
  // The first Component registered MUST be 'layout' so non-layout
  // slices have a place to nest under. tui.js + test-runner already
  // enforce that order; a misordered register triggers the
  // route._flatFallback warning (kept lenient so a stray test doesn't crash).
  if (comp.name !== 'layout' && !route.hasSlice('layout')) {
    console.error(`[component:${comp.name}] registered before 'layout' — Phase 3 requires layout to register first; slice will land in the flat fallback bag`);
  }
  try { route.setSlice(comp.name, comp.init()); }
  catch (e) {
    console.error(`[component:${comp.name}] init error: ${e.message}`);
    route.setSlice(comp.name, null);
  }
  if (comp.panelTypes) {
    for (const [type, def] of Object.entries(comp.panelTypes)) {
      if (!_validatePanelDef(comp.name, type, def)) continue;
      const prev = route.componentForPanel(type);
      if (prev && prev !== comp.name) {
        console.error(`[component:${comp.name}] panelType '${type}' already registered by component '${prev}'; last-wins`);
      }
      route.registerPanelOwner(type, comp.name);
    }
  }
  if (typeof comp.statusFor === 'function') statusProviders.push(comp);
  if (comp.decorators) {
    console.error(`[component:${comp.name}] 'decorators' map is no longer supported (decorator framework retired in v0.5 Phase 5); compose row decorations inline in render()`);
  }
  // viewContributions — the Component-native chrome contribution API.
  // Each entry is a function `(slice, ctx) → string | { text, weight }`
  // stored per-slot in registration order. The layout renderer iterates
  // `viewContributionsBySlot[slot]` and composes (`collectViewContributions`).
  if (comp.viewContributions && typeof comp.viewContributions === 'object') {
    for (const [key, fn] of Object.entries(comp.viewContributions)) {
      if (typeof fn !== 'function') {
        console.error(`[component:${comp.name}] viewContributions.${key} is not a function; ignored`);
        continue;
      }
      if (!VIEW_CONTRIBUTION_SLOTS.has(key)) {
        console.error(`[component:${comp.name}] viewContributions.${key} is not a known slot; ignored (valid: ${[...VIEW_CONTRIBUTION_SLOTS].join(', ')})`);
        continue;
      }
      let bucket = viewContributionsBySlot[key];
      if (!bucket) { bucket = []; viewContributionsBySlot[key] = bucket; }
      bucket.push({ owner: comp.name, fn });
    }
  }
}

// Phase 5 final shape: the only viewContribution slots are the footer
// halves. New slots (status bar, title etc.) extend this set.
const VIEW_CONTRIBUTION_SLOTS = new Set(['footerLeft', 'footerRight']);

// slot → [{ owner, fn }] in registration order. Empty by default; layout's
// footer asks `collectViewContributions` per frame, which hot-paths empty.
const viewContributionsBySlot = Object.create(null);

/**
 * Collect every Component's contribution to a viewContribution slot and
 * compose into a single string. Returns '' when nothing's registered (the
 * empty-slot hot path — a Map.get + falsiness check).
 *
 *   `slot`  — 'footerLeft' or 'footerRight'.
 *   `ctx`   — passed verbatim as the second arg to each contributor
 *             (`{ width, focus, view, ... }`). The owning Component's own
 *             slice is passed as the first arg.
 *
 * Composition: each contributor's result is either a string or
 * `{ text, weight }`. Items sort ascending by weight (stable, registration
 * order on tie); on 'footerRight' the result is reversed so the highest-
 * weight segment renders rightmost (matches the legacy decorator policy).
 * Joined with ` │ ` (heavy pipe — distinct from the regular `|` key-hint
 * separator). Truncated to `ctx.width` as a safety net.
 *
 * One contributor throwing is reported and skipped; the rest still render.
 */
function collectViewContributions(slot, ctx) {
  const bucket = viewContributionsBySlot[slot];
  if (!bucket || bucket.length === 0) return '';

  const items = [];
  for (const entry of bucket) {
    let result;
    try { result = entry.fn(route.getSlice(entry.owner), ctx); }
    catch (e) {
      console.error(`[viewContributions:${entry.owner}] '${slot}' handler error: ${e.message}`);
      continue;
    }
    if (result == null || result === '') continue;
    if (typeof result === 'string') items.push({ text: result, weight: 0 });
    else if (typeof result === 'object' && typeof result.text === 'string' && result.text !== '') {
      items.push({ text: result.text, weight: result.weight || 0 });
    }
  }
  if (items.length === 0) return '';

  // Stable sort (ES2019); reverse for footerRight so the highest-weight
  // entry sits rightmost on screen after the renderer right-aligns the seg.
  items.sort((a, b) => a.weight - b.weight);
  let parts = items.map(i => i.text);
  if (slot === 'footerRight') parts = parts.reverse();
  let out = parts.join(' │ ');

  if (ctx && typeof ctx.width === 'number' && ctx.width > 0) {
    if (visibleLen(out) > ctx.width) {
      out = out.slice(0, Math.max(0, ctx.width - 1)) + '…';
    }
  }
  return out;
}

/** Test-only: clear all registered viewContributions (between cases). */
function _resetViewContributions() {
  for (const k of Object.keys(viewContributionsBySlot)) delete viewContributionsBySlot[k];
}

/**
 * Wrap a child Msg with its target Component's name. Used by callers
 * that want to route a Msg to exactly one Component instead of fan-out.
 * Phase 0 introduces the shape behind a back-compat shim; Phase 2 (the
 * one-way door) makes wrapped dispatch the only Component-routing path.
 *
 *   dispatch(wrap('groups', { type: 'toggle_group', name: 'a' }))
 *
 * The inner msg is the Component's own Msg shape — its update() never
 * sees the wrapper.
 */
const { wrap } = route;

/**
 * Dispatch a Msg. Two shapes are accepted:
 *
 * 1. **Wrapped Msg**: `{ kind: <ComponentName>, msg: <inner> }` —
 *    routes ONLY to the Component named `kind`. The Component's
 *    update() sees the unwrapped inner msg. Unknown `kind` is
 *    logged and dropped.
 *
 * 2. **Broadcast Msg**: one of the three framework signals —
 *    `refresh`, `hub`, `action`. Fans out to every registered
 *    Component's update(msg, slice). (Key events go through
 *    `dispatchKeyToFocused`, not the broadcast path — they need a
 *    return value to gate the framework default.)
 *
 * Phase 2f locked this contract: every Component-specific Msg MUST
 * be wrapped (via api.wrap). The previous "flat fan-out for any Msg
 * type" path is gone. An unwrapped Component-specific Msg is logged
 * as an error and dropped — the missed wrap site needs fixing.
 *
 * Failures in one Component's update don't stop dispatch to the
 * others — error logged, that Component's slice is left as-is.
 *
 * Effects returned via `[slice, effects]` flow through the unified
 * effects registry regardless of shape.
 */
const BROADCAST_TYPES = new Set(['refresh', 'hub', 'action']);

function dispatchMsg(msg) {
  // Wrapped-Msg path. Routes to exactly one Component. Discriminator:
  // { kind: string, msg: any } AND no top-level `type` field — the
  // latter rules out any pre-existing flat Msg shape that happens to
  // also carry `kind` / `msg` properties.
  if (msg && typeof msg.kind === 'string' && msg.msg !== undefined && msg.type === undefined) {
    const name = msg.kind;
    const comp = components[name];
    if (!comp) {
      console.error(`[dispatch] wrapped Msg targeting unknown Component '${name}'; dropped`);
      return;
    }
    _runComponentUpdate(name, comp, msg.msg);
    return;
  }
  // Broadcast path. Only the 3 framework signals fan out; everything
  // else must arrive wrapped.
  if (msg && BROADCAST_TYPES.has(msg.type)) {
    for (const [name, comp] of Object.entries(components)) {
      _runComponentUpdate(name, comp, msg);
    }
    return;
  }
  // Phase 2f strictness: any other flat Msg is a missed wrap site.
  const ty = msg && msg.type ? `'${msg.type}'` : '(no type)';
  console.error(`[dispatch] unwrapped Component-specific Msg ${ty}; dropped. Wrap with api.wrap('<component>', msg).`);
}

/**
 * Dispatch a `key` Msg to the focused Component and return whether the
 * Component claimed the keystroke (i.e. asked the framework to skip its
 * default for this key). The claim shows up as a `_claimed` sentinel
 * effect in the Component's `[slice, effects]` return; the framework
 * consumes it here and runs the remaining effects normally.
 *
 * The key arbitration is identical to the old broadcast path — only the
 * focused-panel Component receives the keystroke. Chrome-only
 * Components never see it. The return-value contract is what makes the
 * claim work without a separate `claimsKeys` declaration: the same
 * branch that handles the key decides whether to suppress the default.
 */
function dispatchKeyToFocused(key, seq) {
  const compName = route.componentForPanel(route.getFocus());
  if (!compName) return false;
  const comp = components[compName];
  if (!comp) return false;

  let claimed = false;
  try {
    const result = comp.update({ type: 'key', key, seq }, route.getSlice(compName));
    if (result === undefined) return false;
    if (Array.isArray(result)) {
      const [next, effects] = result;
      if (next !== undefined) route.setSlice(compName, next);
      const filtered = [];
      for (const e of (effects || [])) {
        if (e && e.type === '_claimed') claimed = true;
        else if (e) filtered.push(e);
      }
      if (filtered.length) require('../dispatch/effects').runEffects(filtered);
    } else {
      route.setSlice(compName, result);
    }
  } catch (e) {
    console.error(`[component:${compName}] key update error: ${e.message}`);
    _recordError({ where: 'component_key', component: compName,
      message: e && e.message, stack: e && e.stack });
  }
  return claimed;
}

// Inner helper — runs one Component's update, handles the
// undefined / slice / [slice, effects] return contract, and isolates
// throws. Shared by both the wrapped and broadcast dispatch paths.
// Reads + writes go through route.getSlice / route.setSlice so the
// underlying nesting (layout.slice.panels[name] post-Phase-3) is
// transparent here.
function _runComponentUpdate(name, comp, msg) {
  try {
    const result = comp.update(msg, route.getSlice(name));
    if (result === undefined) return;
    if (Array.isArray(result)) {
      const [next, effects] = result;
      if (next !== undefined) route.setSlice(name, next);
      require('../dispatch/effects').runEffects(effects);
    } else {
      route.setSlice(name, result);
    }
  } catch (e) {
    console.error(`[component:${name}] update error: ${e.message}`);
    _recordError({ where: 'component_update', component: name,
      message: e && e.message, stack: e && e.stack });
  }
}

// Persist diagnostics from the Component fan-out paths (key + Msg) to the
// event log. The console.error above is invisible while the TUI is
// drawing (the next render paints over it); the event log file is the
// only place a thrown Component update is inspectable post-mortem.
// Lazy-require avoids a panel/api ↔ dispatch/event-log cycle.
function _recordError(payload) {
  try { require('../dispatch/event-log').record('error', payload); }
  catch (_) { /* event-log unavailable — already logged to console */ }
}

function getComponent(name)              { return components[name]; }
const { getSlice: getComponentSlice, componentForPanel: getComponentOwningPanel, getFocus } = route;

/**
 * Ask all registered Components that contribute item status (e.g. docker
 * container state). First non-null answer wins. Returns null if no
 * provider has an opinion. Lets core renderers display status without
 * knowing which Component owns it.
 */
function statusFor(name) {
  for (const c of statusProviders) {
    const s = c.statusFor(name);
    if (s != null) return s;
  }
  return null;
}

/**
 * Get the panel type definition from its owning Component.
 * @param {string} panelType
 * @returns {object|null} { mode, render, getItems, getInfo, ... }
 */
function getPanelDef(panelType) {
  const compName = route.componentForPanel(panelType);
  if (!compName) return null;
  const comp = components[compName];
  return comp && comp.panelTypes ? comp.panelTypes[panelType] : null;
}

/**
 * Canonical filtered item list for a panel. The owning Component's
 * `getItems(slice)` returns the raw rows; the framework applies the
 * active filter using `panelDef.filterText(item)` (defaults to
 * `String(item)`). This is THE single source of items for renderers,
 * navigation, mouse hit-testing, detail info, and copy options — no
 * caller may filter independently, which would desync the selection
 * index vs the rendered list.
 *
 * `customFilter: true` means the Component's `getItems` already honored
 * the filter text itself (regex match, fuzzy match, anything beyond
 * substring); skip the framework's substring filter so we don't
 * double-filter.
 */
function getItems(panelType) {
  const def = getPanelDef(panelType);
  if (!def || typeof def.getItems !== 'function') return [];
  const compName = route.componentForPanel(panelType);
  const raw = def.getItems(getComponentSlice(compName));
  if (!def.filterable) return raw;
  if (def.customFilter) return raw;
  // Phase 4c — committed filter text lives on each Navigator's nav
  // slice (`slice.nav[panelType].filter`). Read it off the same slice
  // we already have; falls back to '' if no nav entry (Monitor panels,
  // panels that haven't been touched yet).
  const slice = getComponentSlice(compName);
  const navEntry = slice && slice.nav && slice.nav[panelType];
  const filterText = (navEntry && navEntry.filter) || '';
  if (!filterText) return raw;
  const lc = filterText.toLowerCase();
  const fieldOf = typeof def.filterText === 'function' ? def.filterText : String;
  return raw.filter(item => fieldOf(item).toLowerCase().includes(lc));
}

/**
 * Fan a `refresh` Msg out to every Component's update(). Components that
 * drive their own polling (docker, files, config-status) self-arm via the
 * `tick` effect from their refresh handler; there's no framework poll
 * loop. Used at boot, on `r`, and on `:refresh`.
 */
async function refreshAll() {
  // Event log (PRINCIPLES.md §11 + CHANGELOG v0.2.0). One record per
  // tick — payload empty because the tick itself is the input event;
  // each Component's refresh-Msg side-effects are responses.
  require('../dispatch/event-log').record('refresh', null);
  dispatchMsg({ type: 'refresh' });
}

/** Fire each Component's optional cleanup() hook, isolated. Lets a
 *  Component that spawned a long-lived child (e.g. docker's
 *  `docker events` stream) tear it down through the framework instead
 *  of relying solely on its own process.on('exit') backstop. */
function cleanupComponents() {
  for (const comp of Object.values(components)) {
    if (typeof comp.cleanup !== 'function') continue;
    try { comp.cleanup(); }
    catch (e) { console.error(`[${comp.name}] cleanup error: ${e.message}`); }
  }
}

/**
 * Collect Component-contributed actions for a group. Components that
 * implement `groupActions(group, groupName)` can inject actions
 * automatically (e.g. docker synthesizes `up`/`down`/`logs` for groups
 * with `compose:`). Returns a flat object keyed by action name.
 */
function getGroupActions(group, groupName) {
  const result = {};
  for (const comp of Object.values(components)) {
    if (typeof comp.groupActions !== 'function') continue;
    try {
      Object.assign(result, comp.groupActions(group, groupName) || {});
    } catch (e) {
      console.error(`[${comp.name}] groupActions error: ${e.message}`);
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
 * Bulk-capable Component commands call this with their panelType and act
 * on the result — same code path for one and many. See CMDMODE.md.
 */
function selectedOrFocused(panelType) {
  const items = getItems(panelType);
  // Phase 4a — nav chrome lives on the owning Component's slice
  // (`slice.nav[panelType] = { cursor, scroll, multiSel }`). Use the
  // state.js helpers so this stays in lockstep with how renderers and
  // navigation read the same values.
  const state = require('../app/state');
  const sel = state.getSel(panelType);
  if (state.multiSelCount(panelType) > 0) {
    return items.filter(item => state.isMultiSel(panelType, idOf(panelType, item)));
  }
  return items[sel] ? [items[sel]] : [];
}

/**
 * Framework default `:` commands — `quit`, `refresh`, `help`. They live
 * here because they're framework actions, not Component behavior.
 *
 * `help` is wired via lazy require to avoid an api → help-text → api
 * cycle at module-load time. `cleanup` is also lazy-required because
 * it pulls `../terminal` → `node-pty`, which CLI mode (cli.js) needs to
 * avoid: cli.js may require this module to discover Component
 * `groupActions` without booting the TUI runtime.
 */

const FRAMEWORK_COMMANDS = [
  {
    name: 'quit',
    desc: 'Exit the TUI',
    run: () => {
      const { cleanup } = require('../app/cleanup');
      cleanup();
      process.exit(0);
    },
  },
  {
    name: 'refresh',
    desc: 'Re-fan a refresh Msg to every Component',
    run: async () => { await refreshAll(); },
  },
  {
    name: 'help',
    desc: 'Show key help in detail panel',
    run: () => { require('../dispatch/help-text').showHelp(); },
  },
  {
    name: 'save-layout',
    desc: 'Persist current panel layout to the YAML config',
    run: () => {
      const { writeLayoutToFile } = require('../feature/yaml-layout');
      const { setDetail } = require('../app/state');
      const m = getModel();
      const { error } = writeLayoutToFile(route.getSlice('layout').arrange, m.configPath);
      if (error) {
        setDetail(`[red]Layout save failed:[/] ${error.message}`);
      } else {
        dispatchMsg(wrap('layout', { type: 'set_arrange', dirty: false }));
        setDetail(`[green]Layout saved to[/] ${m.configPath}`);
      }
    },
  },
  {
    name: 'restore-layout',
    desc: 'Discard runtime changes; reload panel layout from YAML',
    run: () => {
      const { rebuildLayoutFromConfig, setDetail } = require('../app/state');
      const m = getModel();
      dispatchMsg(wrap('layout', {
        type: 'set_arrange', arrange: rebuildLayoutFromConfig(m.config), dirty: false,
      }));
      // The runtime layout the user was working with is gone; the
      // undo/redo history pointed at it is no longer meaningful.
      dispatchMsg(wrap('layout', { type: 'design_clear_undo' }));
      setDetail(`[green]Layout restored from[/] ${m.configPath}`);
    },
  },
];

/**
 * Dynamic framework `:` verbs — synthesized per call because their
 * candidates depend on current state (loaded themes, configured panels,
 * --design flag). The static framework defaults are in FRAMEWORK_COMMANDS.
 */
function _frameworkDynamicCommands(m) {
  const { setTheme, themeNames } = require('../render/themes');
  const { allPanels } = require('../app/state');
  const out = [];
  for (const name of themeNames()) {
    out.push({
      name: `theme ${name}`,
      desc: `Switch to ${name} theme`,
      run: () => { setTheme(name); },
    });
  }
  for (const p of allPanels()) {
    out.push({
      name: `focus ${p.title}`,
      desc: `Focus the ${p.title} panel`,
      // focus_set is handled by layout.update (Phase 1c); route via
      // Component fan-out so the cascade (show_selected_info Cmd) runs.
      // Writing getFocus() directly would skip the refresh.
      run: () => {
        dispatchMsg(wrap('layout', { type: 'focus_set', focus: p.type }));
      },
    });
  }
  const layoutSlice = route.getSlice('layout');
  if (layoutSlice && layoutSlice.design.enabled) {
    out.push({
      name: 'design',
      desc: 'Open layout design mode',
      run: () => { require('../dispatch/dispatch').startDesignMode(); },
    });
  }
  return out;
}

/**
 * Collect commands for `:` cmdline mode. Four sources:
 *   1. FRAMEWORK_COMMANDS (quit / refresh / help / save-layout / restore-layout).
 *   2. Dynamic framework verbs (theme <name> / focus <panel> / design).
 *   3. Component `commands` arrays (fixed verbs).
 *   4. Component `getCommands(model)` (state-derived candidates).
 *
 * Each command must have { name, desc, run(args) }. The source name
 * is stamped on `_source` for telemetry / disambiguation; framework
 * defaults + dynamic framework verbs are stamped `<framework>`.
 */
function getCommands() {
  const out = [];
  for (const c of FRAMEWORK_COMMANDS) {
    out.push({ ...c, _source: '<framework>' });
  }
  const m = getModel();
  for (const c of _frameworkDynamicCommands(m)) {
    out.push({ ...c, _source: '<framework>' });
  }
  for (const comp of Object.values(components)) {
    const collect = (list) => {
      if (!Array.isArray(list)) return;
      for (const c of list) {
        if (!c || typeof c.name !== 'string' || typeof c.run !== 'function') continue;
        out.push({ ...c, _source: comp.name });
      }
    };
    collect(comp.commands);
    if (typeof comp.getCommands === 'function') {
      try { collect(comp.getCommands(m)); }
      catch (e) { console.error(`[${comp.name}] getCommands error: ${e.message}`); }
    }
  }
  return out;
}

// --- Host write capabilities ---
//
// Convenience wrappers for the two writes Components commonly need
// (set the active viewer tab; leave terminal mode). Both go through
// the reducer / Component fan-out — the caller never touches the
// model directly. Components register their own effect descriptors
// via `registerEffect` (e.g. config-status' cfgStatusCompute); proxy
// to the effects registry so api.js stays the single import for
// Component authors.
function registerEffect(type, fn) { require('../dispatch/effects').registerEffect(type, fn); }

function setActiveTab(tab) {
  // viewer_set_tab is handled by the detail Component's update — route
  // via the Component fan-out, not the root reducer.
  dispatchMsg(wrap('detail', { type: 'viewer_set_tab', tab }));
}
function leaveTerminalMode() {
  const { getModel } = require('../app/runtime');
  require('../dispatch/dispatch').applyMsg({ type: 'terminal_exit' });
}

module.exports = {
  // --- Component registry / lifecycle ---
  registerComponent, registerEffect, dispatchMsg, dispatchKeyToFocused, wrap,
  getComponent, getComponentSlice, getComponentOwningPanel, getFocus,
  getPanelDef, getItems, idOf, selectedOrFocused,
  refreshAll, cleanupComponents,
  getCommands, getGroupActions, statusFor,
  // Phase 5 — viewContributions registry. footerLeft / footerRight
  // contributors compose through `collectViewContributions`.
  collectViewContributions, _resetViewContributions,

  // --- Subsystems ---
  hub,         // event hub (HUB.md) — pub/sub data bus

  // --- L0/L2 helpers re-exported as the Component-facing surface ---
  // ansi
  esc, visibleLen, stripMarkup,
  // themes
  theme,
  // panel
  renderPanel,
  // state (read helpers — Components write via wrapped Msgs into their own slice)
  getSel, getScroll, isMultiSel,
  // filter
  getFilter,
  // exec
  execAsync,
  // stream / tabs / render scheduling — host capabilities a Component
  // may invoke (run a shell command, open an ephemeral terminal tab,
  // request a redraw on async events)
  streamCommand,
  addEphemeralTab,
  scheduleRender,
  setActiveTab,
  leaveTerminalMode,
};
