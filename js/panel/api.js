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

const hub = require('./hub');
const route = require('../panel/route');

// L0/L2 helpers re-exported as the Component-facing surface. Component
// authors should import only from `./api` so the surface is one diff
// away from any future API change. Direct imports from `../ansi` etc.
// still work but are not part of the contract.
const { esc, visibleLen, stripMarkup, wrapColor } = require('../io/ansi');
const { theme } = require('../render/themes');
const { renderPanel } = require('../render/panel');
const { getSel, getScroll, isMultiSel, syncPanelScroll } = require('../app/state');
const { getModel } = require('../app/runtime');
const mnav = require('../leaves/nav');
const geo = require('../leaves/geometry');
const mpool = require('../leaves/pool');
const { execAsync } = require('../app/exec');

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

const { streamCommand } = require('../dispatch/stream');
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
  // a later registration sees this one as registered; only setInstance
  // is skipped on throw.
  route.setInstance(comp.name, comp.name, comp.init());
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
    try { result = entry.fn(route.getInstanceSlice(entry.owner), ctx); }
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
 * Every Component-specific Msg MUST be wrapped (via api.wrap). An
 * unwrapped Component-specific Msg is logged as an error and dropped —
 * the missed wrap site needs fixing.
 *
 * Failures in one Component's update don't stop dispatch to the
 * others — error logged, that Component's slice is left as-is.
 *
 * Effects returned via `[slice, effects]` flow through the unified
 * effects registry regardless of shape.
 */
const BROADCAST_TYPES = new Set(['refresh', 'hub', 'action']);

// ——— Post-dispatch invariant pass (resize-as-Msg P2) ———————————————
//
// After the OUTERMOST dispatch completes, re-clamp every navigator
// pane's scroll so the selected row sits inside its viewport. The
// safety-net property the per-frame render clamp had ("catches
// cursor-off-viewport from ANY cause without enumerating Msgs")
// carries over because every state change IS a dispatch — cursor
// moves, list shrinks (refresh broadcasts), collapse, drag-resize,
// view-mode switches, and (since P1) terminal resize all arrive here.
//
// Freshness: the pass computes calcLayout itself and threads the
// Layout into getPanelViewportH — slice.paneBounds is the LAST
// RENDER's write at dispatch time, stale by exactly the one-frame
// class 8eea6e9 fixed on the render side.
//
// Depth counter: both top-level entries (dispatchMsg +
// dispatchKeyToFocused) share it, so effect-chained nested dispatches
// run the pass once, at depth-0 exit. The _inScrollFinalize flag makes
// the pass's own set_scroll dispatches (syncPanelScroll → _navDispatch
// → dispatchMsg) skip re-finalizing — explicit beats relying on
// bounded-depth convergence.
//
// Writes stay single-writer: syncPanelScroll routes a wrapped
// set_scroll Msg to the owning navigator's reducer (identity-
// preserving — no ping-pong).
let _dispatchDepth = 0;
let _inScrollFinalize = false;

// Layout memo for the finalizer. calcLayout's rects depend only on
// (arrange, dims) — and the reducers update both IMMUTABLY (spread
// per write; pinned by test-immutable-leaves), so reference equality
// is a correct cache key. Most dispatches (viewer appends, cursor
// moves, search) leave both refs untouched — the pass then costs a
// few map reads per pane instead of a full calcLayout (the bench-
// visible regression the memo exists for: ~135μs/Msg → ~μs).
// viewMode is in the key only because the Layout value carries it.
let _layoutMemo = null;

function _finalizeLayout(layoutSlice) {
  const m = _layoutMemo;
  if (m && m.arrange === layoutSlice.arrange && m.dims === layoutSlice.dims
        && m.viewMode === layoutSlice.viewMode) {
    return m.layout;
  }
  const layout = geo.calcLayout(layoutSlice, layoutSlice.dims);
  _layoutMemo = {
    arrange: layoutSlice.arrange, dims: layoutSlice.dims,
    viewMode: layoutSlice.viewMode, layout,
  };
  return layout;
}

function _finalizeDispatch() {
  if (_inScrollFinalize) return;
  const layoutSlice = route.getInstanceSlice('layout');
  if (!layoutSlice || !layoutSlice.dims || !layoutSlice.arrange) return;
  _inScrollFinalize = true;
  try {
    const layout = _finalizeLayout(layoutSlice);
    for (const p of mpool.allPanesInColumns(layoutSlice.arrange)) {
      if (mpool.isDetailPane(p) || p.collapsed) continue;
      syncPanelScroll(p.paneId,
        geo.getPanelViewportH(layoutSlice, p.paneId, layoutSlice.dims, layout));
    }
  } catch (e) {
    console.error(`[dispatch] post-dispatch scroll clamp error: ${e.message}`);
  } finally {
    _inScrollFinalize = false;
  }
}

function dispatchMsg(msg) {
  _dispatchDepth++;
  try { _dispatchMsgInner(msg); }
  finally {
    _dispatchDepth--;
    if (_dispatchDepth === 0) _finalizeDispatch();
  }
}

function _dispatchMsgInner(msg) {
  // Free-config freeze gate. While free-config mode is active, only
  // layout-wrapped Msgs flow (they drive the mode itself: free_config_*,
  // pool_*, focus_set, view_*, set_arrange). Broadcasts (refresh / hub
  // / action) and wrapped Msgs to non-layout components are dropped —
  // each Component renders its last snapshot until the mode exits, so
  // the canvas stays stable under drag / resize / pool mutations. Mode
  // entry/exit themselves ride apply_msg Cmds through the root reducer,
  // not through here, so they always reach the modes table.
  const m = require('../app/runtime').getModel();
  if (m && m.modes && m.modes.freeConfigMode) {
    const isLayoutWrap = msg && msg.kind === 'layout' && msg.type === undefined;
    // Narrow exception: the free-config tab-reorder gesture lives on
    // layout's slice but emits a viewer_reorder_content_tab dispatch_msg
    // back through this gate to permute detail's contentTabs. It's a
    // free-config-shape change (visible tab order), just within a panel
    // rather than across panels — same justification as pool_hide/show.
    const isTabReorder = msg && msg.kind === 'detail'
      && msg.msg && msg.msg.type === 'viewer_reorder_content_tab';
    if (!isLayoutWrap && !isTabReorder) return;
  }
  // Wrapped-Msg path. Routes to exactly one Component instance (the
  // primary instance for that kind today; multi-instance can pick a
  // specific id). Discriminator: `{ kind: string, msg: any }` AND no
  // top-level `type` field — rules out any flat Msg shape that happens
  // to also carry `kind` / `msg` properties.
  if (msg && typeof msg.kind === 'string' && msg.msg !== undefined && msg.type === undefined) {
    const kind = msg.kind;
    // v0.6.3 post-arch-arc — `kind` may be a Component name (legacy
    // form, primary-instance routing) OR a paneId (post-B3 form,
    // resolveTarget returns paneIds for multi-instance routing).
    // Try paneId lookup first — if an instance exists with this id,
    // route to it directly. Otherwise treat as a Component name and
    // route to the primary instance.
    let inst = route.getInstance(kind);
    let comp;
    if (inst) {
      // paneId form. Find the Component for this instance's kind —
      // either by direct Component-name match, or via the panel-type
      // → Component-name table (docker-style `panelTypes` Components).
      comp = components[inst.kind] || components[route.componentForPanel(inst.kind)];
    } else {
      // Component-name form. Look up via _primaryByKind for the
      // canonical instance.
      comp = components[kind];
      let primaryKind = kind;
      if (!comp) {
        // v0.6.4 multi-viewer — `kind` may be a paneId whose per-pane
        // instance wasn't minted (docker-style `panelTypes` panes, or a
        // kind-keyed singleton harness). Resolve the Component + panel-
        // type via the arrange, then route to the kind's primary. Mirrors
        // sliceForPane's read-path fallback so wrap(paneId) is robust.
        comp = components[route.componentForPanel(kind)];
        primaryKind = route.paneTypeOf(kind) || primaryKind;
      }
      const id = comp ? route.getPrimaryByKind(primaryKind) : undefined;
      if (id !== undefined) inst = route.getInstance(id);
    }
    if (!comp || !inst) {
      console.error(`[dispatch] wrapped Msg targeting unknown Component '${kind}'; dropped`);
      return;
    }
    _runInstance(inst, comp, msg.msg);
    return;
  }
  // Broadcast path. Only the 3 framework signals fan out; everything
  // else must arrive wrapped. Iterates instances (not specs) so a
  // Component with multiple instances has each one's update called
  // independently.
  if (msg && BROADCAST_TYPES.has(msg.type)) {
    route.eachInstance(inst => {
      // v0.6.4 Theme A Phase 5 Arc 2 — resolve panelType-aliased
      // instances (e.g. a `file-browser` instance, kind 'file-browser',
      // owned by the `files` Component) via the panel-type → Component
      // table, mirroring the wrapped-Msg path above. Was
      // `components[inst.kind]` only, which silently skipped aliased
      // instances on every broadcast (refresh never reached them).
      const comp = components[inst.kind] || components[route.componentForPanel(inst.kind)];
      if (!comp) return;  // defensive: orphan instance (Component unregistered)
      _runInstance(inst, comp, msg);
    });
    return;
  }
  // Any other flat Msg is a missed wrap site.
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
  _dispatchDepth++;
  try { return _dispatchKeyToFocusedInner(key, seq); }
  finally {
    _dispatchDepth--;
    if (_dispatchDepth === 0) _finalizeDispatch();
  }
}

function _dispatchKeyToFocusedInner(key, seq) {
  const focus = route.getFocus();
  const compName = route.componentForPanel(focus);
  if (!compName) return false;
  const comp = components[compName];
  if (!comp) return false;
  // v0.6.4 Theme A Phase 1 — route the keystroke to the FOCUSED
  // instance: prefer the focused paneId directly (per-pane mint — the
  // multi-instance path), else fall back to the kind's primary
  // (docker-style `panelTypes` panes mint kind-keyed, not per-pane, so
  // their paneId has no instance). No-op under single-pane configs —
  // there the focused paneId IS the kind's primary. Was
  // getPrimaryByKind unconditionally, which sent keys to the FIRST
  // instance of the kind regardless of which same-kind pane was focused.
  const id = route.hasInstance(focus) ? focus : route.getPrimaryByKind(compName);
  if (id === undefined) return false;
  const inst = route.getInstance(id);

  let claimed = false;
  try {
    // v0.6.3 Phase D1 — thread terminalMode + focusKind so the
    // viewer's `key` arm doesn't need to call getModel() / getFocus()
    // (chain modes are already filtered upstream by _dispatchActiveMode;
    // terminalMode is non-chain so the arm needs the flag to bail).
    const _m = getModel();
    const result = comp.update({
      type: 'key', key, seq,
      terminalMode: !!_m.modes.terminalMode,
      focusKind: route.instanceKind(route.getFocus()),
    }, inst.slice);
    if (result === undefined) return false;
    if (Array.isArray(result)) {
      const [next, effects] = result;
      if (next !== undefined) route.setInstanceSlice(inst.id, next);
      const filtered = [];
      for (const e of (effects || [])) {
        if (e && e.type === '_claimed') claimed = true;
        else if (e) filtered.push(e);
      }
      if (filtered.length) require('../dispatch/effects').runEffects(filtered);
    } else {
      route.setInstanceSlice(inst.id, result);
    }
  } catch (e) {
    console.error(`[component:${compName}] key update error: ${e.message}`);
    _recordError({ where: 'component_key', component: compName, instance: inst.id,
      message: e && e.message, stack: e && e.stack });
  }
  return claimed;
}

// Inner helper — runs ONE instance's update, handles the
// undefined / slice / [slice, effects] return contract, and isolates
// throws. Shared by the wrapped and broadcast dispatch paths. Reads
// inst.slice and writes back via route.setInstanceSlice(inst.id, …)
// so multi-instance kinds update only their own slice.
function _runInstance(inst, comp, msg) {
  try {
    const result = comp.update(msg, inst.slice);
    if (result === undefined) return;
    if (Array.isArray(result)) {
      const [next, effects] = result;
      if (next !== undefined) route.setInstanceSlice(inst.id, next);
      require('../dispatch/effects').runEffects(effects);
    } else {
      route.setInstanceSlice(inst.id, result);
    }
  } catch (e) {
    console.error(`[component:${inst.kind}] update error: ${e.message}`);
    _recordError({ where: 'component_update', component: inst.kind, instance: inst.id,
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
const { componentForPanel: getComponentOwningPanel, getFocus } = route;

// Tab-instance registry surface. `getInstanceSlice(tabId)` is the
// slice-read primitive every reader uses. See `panel/route.js` for
// the data model.
const {
  setInstance, getInstance, getInstanceSlice, sliceForPane, setInstanceSlice,
  hasInstance, disposeInstance, instanceKind, eachInstance,
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

/**
 * Resolve the focused Navigator's selected-item info lines, or null when
 * the focused pane has no getInfo / no selection (the caller should skip
 * its viewer_show_info dispatch — same net effect as the old arm-side
 * bail). viewer-lines-selector P0: this is the dispatcher-side compute
 * that `dispatch.showSelectedInfo` threads as `msg.lines`, so the
 * viewer_show_info reducer arm stays pure of plugin reads (the v0.7
 * candidate noted at the old viewer._infoFromFocus).
 */
function infoLinesFromFocus() {
  const focus = getFocus();
  const def = getPanelDef(focus);
  if (!def || typeof def.getItems !== 'function' || typeof def.getInfo !== 'function') return null;
  const items = getItems(focus);
  const item = items[getSel(focus)];
  if (!item) return null;
  // Thread the focused paneId so a multi-panelType Component (files)
  // reads THIS pane's browser/config. Arity-ignored by single-panel defs.
  const out = def.getInfo(item, focus);
  // P4 review fix — EMPTY getInfo output returns [] (not null): the old
  // arm yanked to Info whenever def+item existed without inspecting the
  // content, so the dispatch (and yank) must still happen for an
  // empty-info item; only no-def/no-selection skips. (Old display then
  // showed STALE previous content via the slice.lines fixed point;
  // blank is the honest rendering.)
  if (!out || !out.length) return [];
  return out.join('\n').split('\n');
}

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
 * implement `groupActions(group, groupName, config, model)` can inject
 * actions (e.g. docker synthesizes `up`/`down`/`logs` for groups with
 * `compose:`). Returns a flat object keyed by action name.
 *
 * `groupActions` is a PURE PROJECTION: same inputs → same outputs, no
 * IO, no mutation of group/config/model. Hot read paths (viewer_append,
 * render) call this transitively per frame; a plugin that shells out
 * here would block the event loop on every line of stream output.
 *
 * v0.6.2 — `config` + `model` params added. Existing plugins that only
 * declare `(group)` / `(group, name)` / `(group, name, config)` ignore
 * the extras (JS arity slack).
 */
function getGroupActions(group, groupName) {
  const m = getModel();
  const result = {};
  for (const comp of Object.values(components)) {
    if (typeof comp.groupActions !== 'function') continue;
    try {
      Object.assign(result, comp.groupActions(group, groupName, m.config, m) || {});
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
  // nav chrome lives on the owning Component's slice — use the state.js
  // helpers so this stays in lockstep with how renderers and navigation
  // read the same values.
  const state = require('../app/state');
  const sel = state.getSel(panelType);
  if (state.multiSelCount(panelType) > 0) {
    return items.filter(item => state.isMultiSel(panelType, idOf(panelType, item)));
  }
  return items[sel] ? [items[sel]] : [];
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
function registerEffect(type, fn) { require('../dispatch/effects').registerEffect(type, fn); }

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
  dispatchMsg(wrap(target, { type: 'viewer_set_tab', tab, total, toTabKey }));
}
function leaveTerminalMode() {
  require('../dispatch/dispatch').applyMsg({ type: 'terminal_exit' });
}

// v0.6.3 Phase B — used by app/state.js#initState to walk placed
// panes and mint per-pane instance slices. Internal accessor; not
// part of the Component-facing surface.
function _componentsMap() { return components; }

module.exports = {
  // --- Component registry / lifecycle ---
  registerComponent, registerEffect, dispatchMsg, dispatchKeyToFocused, wrap,
  _components: _componentsMap,  // v0.6.3 Phase B — internal use by initState
  getComponent, getComponentOwningPanel, getFocus,
  // Tab-instance registry surface.
  setInstance, getInstance, getInstanceSlice, sliceForPane, setInstanceSlice,
  hasInstance, disposeInstance, instanceKind, eachInstance,
  getPanelDef, getItems, idOf, selectedOrFocused, infoLinesFromFocus,
  refreshAll, cleanupComponents,
  getCommands, getGroupActions, getMergedActions, statusFor,
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
  // state (read helpers — Components write via wrapped Msgs into their own slice)
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
