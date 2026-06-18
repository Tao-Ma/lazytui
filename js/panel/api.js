/**
 * Component API — registers and runs Components.
 *
 * Every in-tree panel is a Component: a TEA-shaped triple of `init()` /
 * `update(msg, slice)` / `panelTypes[type].render(panel, w, h, slice)`,
 * with optional cross-cutting contributions (`commands`, `groupActions`,
 * `statusFor`, `viewContributions`, `cleanup`). The framework owns slice
 * storage (panel/route.js's instance store); each Component's `update`
 * is the single writer for its own slice. See `docs/PRINCIPLES.md` §12
 * + the spec at `docs/v0.5-layout-component.md`.
 *
 * Zero dependencies (uses local modules).
 */
'use strict';

const hub = require('../leaves/infra/hub');
const route = require('../panel/route');

// L0/L2 helpers re-exported as the Component-facing surface. Component
// authors should import only from `./api` so the surface is one diff
// away from any future API change. Direct imports from `../ansi` etc.
// still work but are not part of the contract.
const { esc, visibleLen, stripMarkup, wrapColor } = require('../leaves/ansi');
const { theme } = require('../leaves/infra/themes');
const { renderPanel, setDimsProvider } = require('../leaves/draw');

// Render-exit seam (docs/v0.6.5-render-exit.md): leaves/draw can't read the
// model (panel layer) NOR import io (it's a pure bottom leaf). Inject the full
// terminal-dims resolution here: the layout slice's resize-as-Msg dims (the
// model clock) first, then the io/term singleton as the boot/no-Msg fallback
// before the first term_resized lands. Both the model-read and the io read
// live here (panel — which may depend on model + io); the leaf only consumes
// the resolved {cols,rows}. This is what lets draw drop its io/term import
// while preserving the "io/term is the boot fallback" behavior overlays rely
// on (test-overlay-dims §2). So the DIMS the frame reads come from the model
// (resize-as-Msg `layoutSlice.dims`) once the first term_resized has landed,
// with io/term only as the pre-first-resize boot fallback. (This unifies the
// dims source; it does not by itself make the whole frame a pure function of
// the model — see the #D5 replayability boundary in model/store.js.)
const _term = require('../io/term');
setDimsProvider(() => {
  const ls = route.getInstanceSlice('layout');
  const d = ls && ls.dims;
  if (d && d.cols > 0 && d.rows > 0) return d;
  return { cols: _term.cols(), rows: _term.rows() };
});

// Panel-state accessors live in ./nav-state (v0.6.5 §1 Phase 2). api re-exports
// the nav readers + composites as part of its Component-facing surface (the
// navigator Components read them from here). The nav-state writers require api
// back lazily, so this top-level edge is one-directional (api → nav-state).
const { getSel, getScroll, isMultiSel,
        selectedOrFocused, infoLinesFromFocus } = require('./nav-state');
const { getModel } = require('../model/store');
const mnav = require('../leaves/nav');
const { execAsync } = require('../io/exec');

/**
 * Active filter text for a panel. While in filter mode, the live
 * (uncommitted) draft is returned for the panel being edited; other
 * panels see their committed value from `slice.nav[panel].filter`.
 * Used by Navigator getItems implementations to filter rows.
 * (AR3 — was overlay/filter.js, retired: that module didn't paint,
 * just facaded these two reads.)
 */
function getFilter(panelType) {
  const m = getModel();
  if (m.modes.filterMode && m.modal.filter.panel === panelType) return m.modal.filter.text;
  const compName = route.componentForPanel(panelType);
  if (!compName) return '';
  // v0.6.3 post-arch-arc — accepts paneId or panel-type; mnav indexes
  // by panel-type for multi-panel Components (files: { files, file-browser }).
  const typeKey = route.paneTypeOf(panelType) || panelType;
  // v0.6.4 Theme A Phase 5 — per-pane slice (panelType may be a paneId).
  const entry = mnav.entryOf(route.sliceForPane(panelType, compName), typeKey);
  return (entry && entry.filter) || '';
}

/** Live filter text for the currently-active filter session — used
 *  by renderFooter to paint the `/text │` prompt. */
function filterCurrentText() { return getModel().modal.filter.text; }

// panel→dispatch / panel→overlay calls are inverted through the panel-host
// seam (wired at boot) so panel stays a clean lower layer than dispatch.
// See ports/panel-host.js + docs/v0.6.5-render-exit.md "Domain detangle".
const panelHost = require('../ports/panel-host');
const { streamCommand } = panelHost;       // re-exported below for docker
const { addEphemeralTab } = require('./viewer/tabs');
const { scheduleRender } = require('../leaves/infra/render-queue');

// Components — the TEA-shaped strict-discipline shape used by every
// in-tree panel. A Component owns a state slice via init() and accepts
// messages through update(msg, slice) → newSlice (or [newSlice, effects]).
// Render functions receive the slice — Components that read app-global
// state import it explicitly via getModel(). See docs/PRINCIPLES.md §12.
const components = {};              // name -> component spec (functions, not state)
const statusProviders = [];         // Components that expose statusFor(name)

// Slice storage + panel→Component ownership map live in `./route` (a
// zero-dep leaf) so the root reducer can read them without a require
// cycle. Instance-keyed store: every slice lives in `_instances` keyed
// by tab id (id === kind for today's singletons).

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
 * **Service slots** — chrome Components register as a SERVICE
 * (kind-global, undisposable — see route.js §Service slots): having no
 * `panelTypes` means the Component can never be placed as a pane, so
 * its register-time instance is definitionally its only instance.
 * A placeable Component whose register-time instance owns kind-global
 * content opts in with `service: true` (docker: the content owner that
 * runs the fetch loop + events stream; placed panes carry nav only).
 * Plain placeable Components get a kind-keyed singleton seed instead,
 * which `initState` disposes when it mints per-pane instances.
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
  // Initial slice goes through the instance store as a singleton
  // (id === kind === comp.name). The first Component registered MUST
  // be 'layout' (chrome) so the focus reader has a slice to read;
  // tui.js + test-runner enforce that order.
  if (comp.name !== 'layout' && !route.hasInstance('layout')) {
    console.error(`[component:${comp.name}] registered before 'layout' — layout must register first`);
  }
  // An init() throw propagates — boot fails fast at the actual
  // source. The component is already in `components` (set above) so
  // a later registration sees this one as registered; only the
  // instance write is skipped on throw.
  //
  // Chrome (no panelTypes) + explicit `service: true` → service slot
  // (kind-global, undisposable); plain placeable → kind-keyed
  // singleton seed that initState swaps for per-pane instances.
  if (!comp.panelTypes || comp.service === true) {
    route.setService(comp.name, comp.init());
  } else {
    route.setInstance(comp.name, comp.name, comp.init());
  }
  // Per-Component effects (loadDir, openFile, historyReplay, …) — used
  // to be registered at module-top-level via top-level
  // `registerEffect(...)` calls in each file, which meant a test that
  // did `clearEffects()` + `installBuiltins()` would silently lose the
  // per-Component handlers (the file-cached side effect didn't re-run).
  // Routing through the Component lifecycle keeps registration symmetric
  // with the test reset path — `clearEffects()` followed by re-running
  // `registerComponent` brings every effect back.
  if (typeof comp.installEffects === 'function') {
    try { comp.installEffects(registerEffect); }
    catch (e) { console.error(`[component:${comp.name}] installEffects error: ${e.message}`); }
  }
  if (comp.panelTypes) {
    for (const [type, def] of Object.entries(comp.panelTypes)) {
      if (!_validatePanelDef(comp.name, type, def)) continue;
      const prev = route.componentForPanel(type);
      // Duplicate registration used to log + last-wins, which silently
      // routed a panel to a different Component than the YAML expected.
      // Throw unless the second Component opts in with `override: true`
      // on the panelType def. No in-tree caller uses override today;
      // the opt-in is there for future plugins that genuinely replace
      // a built-in (e.g. a third-party docker variant).
      if (prev && prev !== comp.name && !def.override) {
        throw new Error(
          `[component:${comp.name}] panelType '${type}' already registered by component '${prev}'. ` +
          `Set \`override: true\` on the panelType def to replace it.`,
        );
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
  // `viewContributionsBySlot[slot]` and composes via
  // `collectViewContributions`.
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

// Today's viewContribution slots are the footer halves. New slots
// (status bar, title etc.) extend this set.
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
    // entry.owner is a Component NAME — explicit kind-level read.
    try { result = entry.fn(route.primarySliceOf(entry.owner), ctx); }
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
 *
 *   dispatch(wrap('groups', { type: 'toggle_group', name: 'a' }))
 *
 * The inner msg is the Component's own Msg shape — its update() never
 * sees the wrapper. Wrapped dispatch is the only Component-routing path
 * for Component-specific Msgs; the broadcast lane is reserved for the
 * three framework signals (refresh / hub / action).
 */
const { wrap } = route;


function getComponent(name)              { return components[name]; }
const { componentForPanel: getComponentOwningPanel, getFocus } = route;

// Tab-instance registry surface. `getInstanceSlice(tabId)` is the
// slice-read primitive every reader uses. See `panel/route.js` for
// the data model.
const {
  setInstance, getInstance, getInstanceSlice, sliceForPane, setInstanceSlice,
  hasInstance, disposeInstance, instanceKind, eachInstance,
  setService, serviceSlice, isService, primarySliceOf,
} = route;

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
function getPanelDef(id) {
  // v0.6.3 post-arch-arc T3.5 — accepts paneId or panel-type.
  // `route.paneTypeOf` does the canonical resolution (direct panel-
  // type, paneId via instance.kind, or paneId via arrange walk for
  // docker-style `panelTypes` Components whose panes don't get
  // per-pane instances). Result is the panel-type key for
  // `comp.panelTypes`.
  //
  // Resolve panelType FIRST, then look up the Component by panel-type —
  // that hits `_panelOwner`'s direct map (arm 1) and skips a second
  // arrange walk. Pre-consolidation this called both componentForPanel
  // AND paneTypeOf with the same paneId input, walking the arrange twice.
  const panelType = route.paneTypeOf(id);
  if (!panelType) return null;
  const compName = route.componentForPanel(panelType);
  if (!compName) return null;
  const comp = components[compName];
  if (!comp || !comp.panelTypes) return null;
  return comp.panelTypes[panelType] || null;
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
  // v0.6.4 Theme A Phase 5 — per-pane slice (panelType may be a paneId).
  const slice = sliceForPane(panelType, compName);
  const raw = def.getItems(slice);
  if (!def.filterable) return raw;
  if (def.customFilter) return raw;
  const mnav = require('../leaves/nav');
  // v0.6.3 post-arch-arc — translate paneId → panel-type for the
  // nav lookup (multi-panel files Component keys slice.nav by type).
  const typeKey = route.paneTypeOf(panelType) || panelType;
  const navEntry = mnav.entryOf(slice, typeKey);
  const filterText = (navEntry && navEntry.filter) || '';
  if (!filterText) return raw;
  const lc = filterText.toLowerCase();
  const fieldOf = typeof def.filterText === 'function' ? def.filterText : String;
  return raw.filter(item => fieldOf(item).toLowerCase().includes(lc));
}

// infoLinesFromFocus + selectedOrFocused relocated to ./nav-state (v0.6.5
// §1 Phase 2) — they read the nav chrome (getSel/multiSel), so they belong
// with the other panel-state accessors. Callers import them from nav-state.

/**
 * Fan a `refresh` Msg out to every Component's update(). Components that
 * drive their own polling (docker, files, config-status) self-arm via the
 * `tick` effect from their refresh handler; there's no framework poll
 * loop. Used at boot, on `r`, and on `:refresh`.
 */
async function refreshAll() {
  // Event log (PRINCIPLES.md §11). One record per tick — payload
  // empty because the tick itself is the input event; each
  // Component's refresh-Msg side-effects are responses.
  require('../io/event-log').record('refresh', null);
  panelHost.dispatchMsg({ type: 'refresh' });
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
 * implement `groupActions(group, groupName, config, model)` can inject
 * actions (e.g. docker synthesizes `up`/`down`/`logs` for groups with
 * `compose:`). Returns a flat object keyed by action name.
 *
 * `groupActions` is a PURE PROJECTION: same inputs → same outputs, no
 * IO, no mutation of group/config/model. Hot read paths (viewer_append,
 * render) call this transitively per frame; a Component that shells out
 * here would block the event loop on every line of stream output.
 *
 * ALWAYS ENFORCED via `panel/plugin-guard.js` (in production too): the args
 * are read-only-wrapped + the call is timed, so a mutation or a slow (IO-ish)
 * call is surfaced to the diagnostics window. A Component opts into a memoized
 * fast path with `groupActionsMemo: true` (guarded once per group, then
 * cached). See docs/PLUGINS.md §"The groupActions contract".
 *
 * v0.6.2 — `config` + `model` params added. Components that only declare
 * `(group)` / `(group, name)` / `(group, name, config)` ignore the extras
 * (JS arity slack).
 */
function getGroupActions(group, groupName) {
  const m = getModel();
  const result = {};
  const guard = require('./plugin-guard');
  for (const comp of Object.values(components)) {
    if (typeof comp.groupActions !== 'function') continue;
    try {
      // Always routed through the purity guard: read-only-wraps + times every
      // call so a mutating / IO-doing Component is surfaced to the diag window
      // (memoized Components are guarded once per group, then cached).
      Object.assign(result, guard.callGroupActions(comp, group, groupName, m.config, m) || {});
    } catch (e) {
      console.error(`[${comp.name}] groupActions error: ${e.message}`);
    }
  }
  return result;
}

/**
 * Canonical "what actions exist for this group?" accessor.
 *
 * Returns a fresh `{ ...plugin-synthesized, ...YAML }` object — YAML
 * wins on key collision (matches the parser-time precedence rule).
 *
 * Single source of truth — every reader that wants the actual action
 * set (tab strip, actions panel, leader resolver, group-info hover,
 * shadow check) routes through here. Pre-v0.6.2 this merge was done
 * three different ways across the codebase, and four other readers
 * went direct to `group.actions` and missed the plugin half (the
 * `pg:status` invisible-tab bug). TEA-correct — `config` is NOT
 * mutated (the pre-v0.6.2 `applyPluginGroupActions` boot trick is
 * retired).
 */
function getMergedActions(groupName) {
  const m = getModel();
  const g = m.config && m.config.groups && m.config.groups[groupName];
  if (!g) return {};
  return { ...getGroupActions(g, groupName), ...(g.actions || {}) };
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
 * Collect commands for `:` cmdline mode (framework verbs + Component
 * contributions). Thin wrapper over `./commands.collectCommands` — the
 * registry lives in panel/commands.js to keep api.js focused on the
 * Component lifecycle + dispatch core.
 */
function getCommands() {
  return require('./commands').collectCommands(Object.values(components), getModel());
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
function registerEffect(type, fn) { panelHost.registerEffect(type, fn); }

function setActiveTab(tab) {
  // viewer_set_tab is handled by the viewer Component's update —
  // routed via the Component fan-out. resolveTarget picks the focused/
  // sticky viewer so producers (historyReplay, etc.) hit the right
  // viewer rather than a hardcoded 'detail' singleton.
  // v0.6.3 Phase D1: thread the precomputed total + toTabKey so the
  // reducer arm stays pure of getModel() / pt.flatTabInfo /
  // _activeTabKey internally.
  const target = route.resolveTarget('viewer');
  if (!target) return;
  const slice = route.getInstanceSlice(target) || { tab: 0 };
  const model = getModel();
  const pt = require('../leaves/pane-tabs');
  const total = pt.flatTabInfo(slice, model, model.currentGroup).total;
  const toTabKey = pt.resolveTabKey((tab | 0), { ...slice, tab: (tab | 0) }, model);
  panelHost.dispatchMsg(wrap(target, { type: 'viewer_set_tab', tab, total, toTabKey }));
}
function leaveTerminalMode() {
  panelHost.applyMsg({ type: 'terminal_exit' });
}

// v0.6.3 Phase B — used by app/state.js#initState to walk placed
// panes and mint per-pane instance slices. Internal accessor; not
// part of the Component-facing surface.
function _componentsMap() { return components; }

module.exports = {
  // --- Component registry / lifecycle ---
  // dispatchMsg / dispatchKeyToFocused / setInstanceReconciler relocated to
  // dispatch/runtime/fanout.js (B/S6 — the runtime lives in the dispatch layer now).
  registerComponent, registerEffect, wrap,
  _components: _componentsMap,  // v0.6.3 Phase B — internal use by initState + fanout
  getComponent, getComponentOwningPanel, getFocus,
  // Tab-instance registry surface.
  setInstance, getInstance, getInstanceSlice, sliceForPane, setInstanceSlice,
  hasInstance, disposeInstance, instanceKind, eachInstance,
  setService, serviceSlice, isService, primarySliceOf,
  getPanelDef, getItems, idOf, selectedOrFocused, infoLinesFromFocus,
  refreshAll, cleanupComponents,
  getCommands, getMergedActions, statusFor,
  // viewContributions registry — footerLeft / footerRight contributors
  // compose through `collectViewContributions`.
  collectViewContributions, _resetViewContributions,

  // --- Subsystems ---
  hub,         // event hub (HUB.md) — pub/sub data bus

  // --- L0/L2 helpers re-exported as the Component-facing surface ---
  // ansi
  esc, visibleLen, stripMarkup, wrapColor,
  // themes
  theme,
  // panel
  renderPanel,
  // nav-state (read helpers — Components write via wrapped Msgs into their own slice)
  getSel, getScroll, isMultiSel,
  // filter
  getFilter, filterCurrentText,
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

// v0.6.5 §3 — inject the merged-actions provider into the pure pane-tabs
// leaf at load time, so the leaf doesn't `require('../panel/api')` itself
// (a leaf → panel inversion). This is the one wiring point that covers
// every consumer: anything touching the panel layer requires this module,
// and pane-tabs no longer imports back, so the edge is a clean downward
// panel → leaf one (no cycle).
require('../leaves/pane-tabs').setMergedActionsProvider(getMergedActions);
