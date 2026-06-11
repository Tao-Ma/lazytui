/**
 * Panel-routing leaf — the shared registry the root reducer and
 * `panel/api` both read from.
 *
 * Five concerns, one zero-dep module:
 *   - `wrap(kind, msg)` — the wrapped-Msg data constructor.
 *   - panel→Component ownership map (writer + reader).
 *   - Instance-keyed slice store — every Component slice lives in
 *     `_instances` keyed by tab id (singletons today use `id === kind`).
 *   - Focus reader (`getFocus`) — pulls from the layout instance.
 *   - `resolveTarget(intent)` — the navigator → viewer routing chokepoint.
 *
 * Lives under `panel/` next to `hub.js` — the two stateful framework
 * registries (route owns `_instances`, the Component-slice store; hub
 * owns the pub/sub topic store). Despite the directory, route imports
 * NOTHING from `panel/api`/`runtime`: it must stay zero-dep there so
 * runtime can import it directly without a cycle (api → runtime via
 * `getModel`). `panel/api` re-exports route's public surface for
 * callers that want the cohesive "panel system" import path. (Moved
 * out of `leaves/` — it's a mutable registry, not a pure transform,
 * so the pure-leaves drawer was the wrong home.)
 */
'use strict';

// --- Wrapped-Msg ctor -----------------------------------------------------

function wrap(kind, msg) { return { kind, msg }; }

// --- Panel → Component ownership ------------------------------------------

const _panelOwner = Object.create(null);

function registerPanelOwner(panelType, componentName) {
  _panelOwner[panelType] = componentName;
}

/** Walk the layout's arrange for a pane whose paneId matches `id`, and
 *  return its panel-type. This is the "arm 3" shared by the three
 *  resolvers below — docker-style `panelTypes` Components don't get
 *  per-pane instances minted by state.js B1, so their panes are only
 *  reachable through the arrange. Returns null when nothing resolves.
 *
 *  v0.6.3 post-arch-arc consolidation — was duplicated three times,
 *  once per public resolver. Pre-consolidation, fixes to the walk had
 *  to land in each copy (e.g. commits 9bafd04 / 633acde / 009b946 /
 *  4ee00b7 each touched one resolver).
 *
 *  Pool-id → Component-name registry — instanceKind(non-default-pool-id)
 *  returning null is a v0.7 fixup per docs/v0.6.3.md §"Out of scope". */
function _typeByArrangePaneId(id) {
  const layoutInst = _instances[_primaryByKind['layout']];
  const arrange = layoutInst && layoutInst.slice && layoutInst.slice.arrange;
  if (!arrange || !Array.isArray(arrange.columns)) return null;
  for (const col of arrange.columns) {
    for (const p of (col.panels || [])) {
      if (p && p.paneId === id && _panelOwner[p.type]) return p.type;
    }
  }
  return null;
}

function componentForPanel(id) {
  // v0.6.3 post-arch-arc T3.5 — accepts paneId or panel-type. Direct
  // panel-type lookup first (production registrations); paneId input
  // falls through to the instance store and resolves via instance.kind.
  // Both forms are first-class — no "tolerant fallback" framing — the
  // helper is the canonical resolver and the only translation site.
  const direct = _panelOwner[id];
  if (direct) return direct;
  const inst = _instances[id];
  if (inst) {
    const ownerByKind = _panelOwner[inst.kind];
    if (ownerByKind) return ownerByKind;
  }
  // Docker-style `panelTypes` Components: paneId in arrange but no
  // per-pane instance.
  const arrangeType = _typeByArrangePaneId(id);
  return arrangeType ? _panelOwner[arrangeType] : undefined;
}

/** Strict panel-type lookup — true iff `id` is a registered panel-type
 *  (NOT a paneId that resolves via the instance store). Use this to
 *  distinguish "the caller gave me a type" from "the caller gave me
 *  a paneId" — both `componentForPanel` arms succeed for both forms. */
function isPanelType(id) { return _panelOwner[id] !== undefined; }

/** Resolve `id` to its panel-type form. Accepts paneId or panel-type;
 *  returns the panel-type string (the key under `comp.panelTypes` and
 *  the form mnav.entryOf uses for multi-panel Components). Used by
 *  `getPanelDef` and `_resolvePanelType` to get from
 *  paneId-or-type → panel-type. Returns null when nothing resolves. */
function paneTypeOf(id) {
  if (_panelOwner[id]) return id;
  const inst = _instances[id];
  if (inst && _panelOwner[inst.kind]) return inst.kind;
  // Docker-style: paneId in arrange but no per-pane instance minted.
  return _typeByArrangePaneId(id);
}

// --- Instance-keyed slice store ----------------------------------------
//
// Canonical storage is `_instances[id] = { id, kind, slice }`.
//
// - `id` is the instance identity. v0.6.3 Phase B1: placed singleton
//   panels mint with `id === paneId` (e.g. `pane-groups`); the
//   register-time fallback (chrome Components like 'layout', and
//   the docker `panelTypes` case where `components[p.type]` misses)
//   uses `id === Component.name` (e.g. 'docker', 'layout').
//
// - `kind` is the value passed by the writer. registerComponent
//   passes the Component name; the per-pane B1 mint in state.js
//   passes `p.type` (which for singleton Components equals the
//   Component name — they collapse — and for docker-style
//   `panelTypes` would differ, but that code path is currently
//   skipped). Treat `kind` as "the routing label the consumer of
//   this instance uses to find it" rather than strictly one or the
//   other; the two converge today.
//
// - `slice` is the per-instance state minted via `spec.init()` and
//   updated by the Component's `update`.
//
// `_primaryByKind[kind]` maps a kind to the id of its primary
// instance — the lookup `resolveTarget` and other consumers use to
// pick "the canonical instance of a kind." v0.6.3 post-arch-arc
// T1.4 routed every remaining `getInstanceSlice('detail')` consumer
// through `route.resolveTarget('viewer')`; the kind-name fallback
// now serves only the bootstrap auto-register helpers in
// `app/state.js` and the test harness. Multi-instance unlock is
// thus structurally clear; remaining work for v0.7 is allowing
// multiple paneIds of the same kind to coexist (today the per-pane
// mint in `state.js initState` is idempotent against an existing
// kind-keyed singleton).

const _instances = Object.create(null);
const _primaryByKind = Object.create(null);

function setInstance(id, kind, slice) {
  const existing = _instances[id];
  if (existing) {
    // Update in place — preserves the wrapper object identity. kind is
    // immutable per id; a mismatched kind on re-write is a caller bug.
    existing.slice = slice;
    return;
  }
  _instances[id] = { id, kind, slice };
  if (!_primaryByKind[kind]) _primaryByKind[kind] = id;
}

function getInstance(id) { return _instances[id]; }

function getInstanceSlice(id) {
  const inst = _instances[id];
  if (inst) return inst.slice;
  // v0.6.3 Phase B — backward-compat fallback: when id misses,
  // treat it as a kind name and resolve via _primaryByKind. Pre-B
  // singleton convention used id === kind, so this fallback was
  // unreachable; post-B (slices keyed by paneId), legacy callers
  // like `getInstanceSlice('detail')` still resolve via primary
  // until they're migrated to thread paneId explicitly.
  const primaryId = _primaryByKind[id];
  if (primaryId && _instances[primaryId]) return _instances[primaryId].slice;
  return undefined;
}

/** Read-path slice resolver: the slice the per-pane `id` should READ
 *  from. Prefers `id`'s own per-pane instance when `id` is a live
 *  paneId (multi-instance: each same-kind pane reads its own slice);
 *  falls back to the `kind`'s primary instance when `id` has no
 *  instance of its own (docker-style `panelTypes` panes that B1 mints
 *  kind-keyed, and legacy callers that pass a kind/Component name).
 *
 *  This is the read-path mirror of the wrapped-Msg DISPATCH path's
 *  `getInstance(kind)`-first resolution (`panel/api` dispatchMsg) and
 *  the key path's `hasInstance(focus) ? focus : primary` (api.js#
 *  dispatchKeyToFocused). v0.6.4 Theme A Phase 5 — closing the
 *  read-path half so render/getItems/getFilter/nav reads stop
 *  collapsing every same-kind pane onto the primary's slice.
 *
 *  No-op under single-pane configs: there `id === kind === primary`,
 *  so both arms return the same instance. */
function sliceForPane(id, kind) {
  if (id != null && _instances[id]) return _instances[id].slice;
  return getInstanceSlice(kind);
}

function setInstanceSlice(id, slice) {
  let inst = _instances[id];
  if (!inst) {
    // v0.6.3 Phase B — kind-name → primary-by-kind fallback so legacy
    // callers writing via `setInstanceSlice('detail', ...)` resolve
    // to the paneId-keyed instance post-B.
    const primaryId = _primaryByKind[id];
    inst = primaryId ? _instances[primaryId] : null;
    if (!inst) return;
  }
  inst.slice = slice;
}

function hasInstance(id) { return id in _instances; }

function disposeInstance(id) {
  const inst = _instances[id];
  if (!inst) return;
  delete _instances[id];
  // If this was the primary for its kind, demote and pick a successor
  // (insertion order). Singleton kinds never trip this.
  if (_primaryByKind[inst.kind] === id) {
    delete _primaryByKind[inst.kind];
    for (const otherId in _instances) {
      if (_instances[otherId].kind === inst.kind) {
        _primaryByKind[inst.kind] = otherId;
        break;
      }
    }
  }
}

/** Kind of the tab at `id`. Accepts two shapes:
 *
 *   - instance id  — direct `_instances[id].kind` read.
 *   - panel-type   — fallback via `componentForPanel(id)` returning the
 *                    Component name (the kind for singleton instances).
 *
 *  Dual-acceptance lets `getFocus()` return either a panel-type string
 *  or a tab id without breaking the comparison sites that ask "what
 *  kind is the focused tab?". For docker (name='docker',
 *  panelType='containers') the fallback resolves 'containers' to
 *  'docker' so kind comparisons see the Component identity
 *  consistently. Returns null when neither lookup succeeds. */
/** Returns the panel-type for `id` (paneId, panel-type, or registered
 *  Component-name). Three arms, all returning the SAME space (panel-
 *  type, NOT Component name) — the post-arch-arc convention:
 *
 *  - arm 1 (per-pane instance): `inst.kind` = `p.type` (B1 mint
 *    stored panel-type there).
 *  - arm 2 (registered panel-type): `id` itself (caller already
 *    passed a panel-type literal).
 *  - arm 3 (arrange walk for docker-style panes B1 skipped):
 *    `p.type` from the matching pane.
 *
 *  Callers compare against the panel-type literal (`'containers'`,
 *  `'groups'`, etc.), NOT the Component name (`'docker'`). For most
 *  Components the two collapse (Component name == panel-type for
 *  singleton kinds); for docker they differ — see docker.js#render. */
function instanceKind(id) {
  const inst = _instances[id];
  if (inst) return inst.kind;
  if (_panelOwner[id]) return id;
  return _typeByArrangePaneId(id);
}

/** Iterate all instances. Order is insertion order. Used by the broadcast
 *  fan-out so refresh / hub / action reach every instance, not every spec. */
function eachInstance(fn) {
  for (const id in _instances) fn(_instances[id]);
}

/** Primary instance id for a kind, or undefined if none registered. */
function getPrimaryByKind(kind) { return _primaryByKind[kind]; }

/** Focus read — the layout instance's slice owns `focus`. Pre-init
 *  returns null.
 *
 *  `focus` is a tab id (the placement identity, e.g. 'detail',
 *  'groups', 'containers'). For singleton placements the tab id
 *  coincides with the panel type, so `getFocus() === 'detail'`
 *  comparisons work today; kind-intent comparisons should go through
 *  `instanceKind(getFocus()) === '<kind>'` (resilient to multi-instance,
 *  where tab id ≠ kind). */
function getFocus() {
  const id = _primaryByKind['layout'];
  if (id === undefined) return null;
  const s = _instances[id].slice;
  return s ? s.focus : null;
}

// --- resolveTarget chokepoint -------------------------------------------
//
// The single helper that turns a navigator-side "write the viewer" call
// into a concrete instance id. Every site that today would have wrapped
// 'detail' hardcoded routes through here so multi-viewer / future
// workflow producer APIs can swap the resolution without touching call
// sites.
//
//   resolveTarget(intent, ctx = {}) → tabId | null
//
// `intent` is a closed enum:
//   'viewer'         — replace body / show info
//   'viewer_tab_add' — add a content tab (file open, etc.)
//   'terminal'       — spawn ephemeral terminal tab
//
// All three target viewer-kind tabs (today: kind === 'detail'). The
// distinction is reserved for when intents diverge (e.g. terminal
// could prefer panes that already host a terminal session); today
// they share one body.
//
// `ctx.focusedTabId` is an optional override for the focus read.
// Default reads getFocus().
//
// Resolution order (kind-based; no role flag):
//   1. focused viewer-kind tab
//   2. layout.slice.lastViewerTab (sticky)
//   3. first viewer-kind tab in right-column arrange order
//   4. any viewer-kind instance (insertion order)
//   5. null — caller becomes a no-op

const VIEWER_KIND = 'detail';

function isViewerKind(id) {
  return instanceKind(id) === VIEWER_KIND;
}

function resolveTarget(intent, ctx) {
  ctx = ctx || {};
  // (1) focused viewer-kind
  const focused = ctx.focusedTabId != null ? ctx.focusedTabId : getFocus();
  if (focused && isViewerKind(focused)) return focused;

  // (2) sticky lastViewerTab
  const layoutId = _primaryByKind['layout'];
  const layout = layoutId !== undefined ? _instances[layoutId].slice : null;
  if (layout && layout.lastViewerTab && isViewerKind(layout.lastViewerTab)) {
    return layout.lastViewerTab;
  }

  // (3) first viewer-kind in last-column arrange order. Walk each
  //     pane's tabs and return the first viewer-kind tab id; this is
  //     the actually-mounted slice identity (instance keyed by id),
  //     not the kind literal. For singleton placements the answer
  //     happens to equal VIEWER_KIND, but multi-instance panes mint
  //     distinct ids and the literal would be wrong.
  if (layout && layout.arrange && Array.isArray(layout.arrange.columns)) {
    const mpool = require('../leaves/pool');
    for (const p of mpool.lastColumnPanels(layout.arrange)) {
      if (!p) continue;
      const tabs = Array.isArray(p.tabs) ? p.tabs : null;
      if (tabs) {
        for (const t of tabs) {
          if (t && isViewerKind(t.id)) return t.id;
        }
      } else if (isViewerKind(p.id)) {
        return p.id;
      }
    }
  }

  // (4) any viewer-kind instance
  for (const id in _instances) {
    if (_instances[id].kind === VIEWER_KIND) return id;
  }

  // (5) no viewer registered — caller no-ops
  return null;
}

// v0.6.4 — the CONTAINER paneId hosting the target viewer. resolveTarget
// returns a viewer *tab/instance* id (singleton: 'detail'); paneBounds +
// boundsFor are keyed by the *container* paneId ('pane-detail'), which is
// the only key rebuilt per-view-mode and therefore the only one carrying
// half/full visible bounds (rects always describe the normal column
// layout). This bridges the two so viewer-geometry readers (terminal
// overlay, viewer innerH, tab-drag/select bounds) get half/full-correct
// geometry without depending on the type-aliased tab-id key. Under multi-
// viewer each focused viewer resolves to its own hosting pane. Returns
// null when no viewer is placed (caller no-ops, same as a missing pane).
function resolveViewerPaneId(ctx) {
  const tabId = resolveTarget('viewer', ctx);
  if (tabId == null) return null;
  const layoutId = _primaryByKind['layout'];
  const layout = layoutId !== undefined ? _instances[layoutId].slice : null;
  if (!layout || !layout.arrange) return null;
  const mpool = require('../leaves/pool');
  // resolveTarget may hand back a container paneId (tier-1 focus) OR a tab
  // id (tier-3 arrange scan) — match either against the pane's identity.
  const loc = mpool.findPaneLocation(layout.arrange, (p) =>
    p.paneId === tabId || p.id === tabId || p.activeTabId === tabId ||
    (Array.isArray(p.tabs) && p.tabs.some(t => t && t.id === tabId)));
  return loc ? loc.pane.paneId : null;
}

module.exports = {
  wrap,
  registerPanelOwner, componentForPanel, isPanelType, paneTypeOf,
  getFocus,
  setInstance, getInstance, getInstanceSlice, sliceForPane, setInstanceSlice,
  hasInstance, disposeInstance, instanceKind, eachInstance,
  getPrimaryByKind,
  // Navigator → focused-viewer routing chokepoint.
  resolveTarget, resolveViewerPaneId, isViewerKind, VIEWER_KIND,
};
