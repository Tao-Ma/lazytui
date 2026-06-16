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
 *  Pool-id → Component-name registry: resolves placed panes by paneId AND
 *  pool-only (unplaced/hidden) panes by their declared pool id, so
 *  instanceKind(declared-id) returns its kind even for a hidden pane (v0.6.5
 *  §5(b3) — closes the v0.6.3 §"Out of scope" defer). */
function _typeByArrangePaneId(id) {
  const layout = _layoutSvcSlice();
  const arrange = layout && layout.arrange;
  if (!arrange) return null;
  if (Array.isArray(arrange.columns)) {
    for (const col of arrange.columns) {
      for (const p of (col.panels || [])) {
        if (p && p.paneId === id && _panelOwner[p.type]) return p.type;
      }
    }
  }
  // Pool-only (unplaced / hidden) pane: pool entries are keyed by their
  // declared id (`panels: { d: { type: detail } }` → arrange.pool.d) and carry
  // `.type`. A hidden pane has no instance and is in no column, so this is the
  // only arm that resolves its kind.
  const entry = arrange.pool && arrange.pool[id];
  if (entry && _panelOwner[entry.type]) return entry.type;
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
//   panels mint with `id === paneId` (e.g. `pane-groups`); service
//   slots (chrome Components like 'layout', content owners like
//   'docker') and the plain register-time seeds use
//   `id === Component.name` (e.g. 'docker', 'layout').
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
// instance — "the canonical instance of a kind." Post split-arc its
// consumers are all EXPLICIT: `getPrimaryByKind` (the dispatch
// fallback for Component-name Msgs + key routing), `primarySliceOf`
// (the sanctioned kind-level slice read, incl. `sliceForPane` arm 2),
// and successor promotion on dispose. `setService` seeds it too so
// service kinds resolve uniformly. get/setInstanceSlice take INSTANCE
// ids only — the v0.6.3 Phase-B kind-name fallback (id misses →
// resolve via primary) is DELETED: it silently collapsed
// multi-instance kinds onto the primary pane, the root of every
// multi-instance bug shipped in 2026-06. A miss whose id names a
// known kind now records a `strict-miss` diagnostic (leader e) and
// returns undefined / no-ops.
//
// Multi-paneId-of-same-kind coexistence is DONE, not pending: the
// `state.js initState` mint loop creates one instance per PLACED
// paneId — it disposes the kind-keyed singleton on the first pane,
// then mints each later same-kind pane under its own paneId — so two
// same-kind panes get independent slices. Proven by
// `test-instance-registry` (Phase-1 key WRITE → focused pane;
// Phase-5 nav READS per-pane; multi-viewer two detail instances
// scroll independently). Service slots (chrome 'layout', docker's
// content owner) sit outside that loop entirely — see §Service slots.

const _instances = Object.create(null);
const _primaryByKind = Object.create(null);

// Monotonic version of the instance SET (ids + their kinds), bumped on
// every add/replace/dispose. resolveTarget / resolveViewerPaneId memoize
// on this (their tier-4 scan reads the set) plus the layout slice's
// focus/lastViewerTab/arrange — see the memo at resolveTarget. Mutating
// an existing instance's slice (setInstanceSlice, the per-Msg viewer
// append) does NOT bump it, so the memo stays valid across streamed
// appends — the whole point. Over-bumping only forces a recompute; it's
// never incorrect, so bump generously rather than reason finely.
let _instVer = 0;
// Memo cells for resolveTarget / resolveViewerPaneId (defined far below).
// Keyed on (intent, focus, lastViewerTab, arrange-ref, _instVer) — every
// input those two read. The per-Msg dispatch finalizer calls both; before
// this memo each call walked the arrange tiers and allocated short-lived
// arrays/closures (mpool.lastColumnPanels / findPaneLocation predicate),
// churning GC (~70-136µs/op amortized). The memo collapses the steady
// state (streamed appends: focus/arrange/instances all unchanged) to a
// few primitive compares.
let _rtMemo = null;
let _rvpMemo = null;

function setInstance(id, kind, slice) {
  _instVer++;
  const existing = _instances[id];
  if (existing) {
    // Service slots are written only via setService — refuse, so a
    // config-supplied paneId colliding with a service kind can't
    // overwrite kind-global content with a per-pane mint.
    if (existing.service) {
      console.error(`[route] setInstance('${id}') refused: '${id}' is a service slot — use setService`);
      return;
    }
    // Update in place — preserves the wrapper object identity. kind is
    // immutable per id; a mismatched kind on re-write is a caller bug.
    existing.slice = slice;
    return;
  }
  _instances[id] = { id, kind, slice };
  if (!_primaryByKind[kind]) _primaryByKind[kind] = id;
}

function getInstance(id) { return _instances[id]; }

// --- Service slots ---------------------------------------------------------
//
// A SERVICE is a kind-global instance registered once by
// `registerComponent` and never disposable: chrome Components (no
// `panelTypes` — e.g. 'layout') and placeable Components that opt in
// with `service: true` because their register-time instance owns
// kind-global content (docker: one daemon → one status/stats map + one
// events stream, shared by every placed pane, which carries nav only).
//
// Service wrappers live INSIDE `_instances` (id === kind === Component
// name) so the broadcast fan-out (`eachInstance`) and wrapped-Msg
// dispatch (`getInstance`) reach them unchanged; `_serviceByKind` is
// the direct handle plus the undisposable marker.
//
// Why undisposable: `state.js initState` disposes kind-keyed seeds when
// minting per-pane instances. Docker's content owner used to survive
// that loop only by ACCIDENT — its panel-type ('containers') differs
// from its Component name ('docker') — so any pane that resolved to
// kind 'docker' would have disposed the owner, repointed the kind
// primary at a nav-only pane, and silently killed all fetching (the
// update() owner-gate no-ops content Msgs on placed panes). The service
// slot makes that clobber impossible by construction: `disposeInstance`
// and `setInstance` both refuse service ids. (`setInstanceSlice` does
// NOT refuse — it's the dispatch write-back path; "undisposable" guards
// the slot's existence and identity, not every slice write.)

const _serviceByKind = Object.create(null);

function setService(kind, slice) {
  _instVer++;
  let inst = _instances[kind];
  if (inst) {
    // Re-registration (test harnesses re-run registerComponent): update
    // in place — preserves wrapper identity, same as setInstance.
    inst.slice = slice;
    inst.service = true;
  } else {
    inst = { id: kind, kind, slice, service: true };
    _instances[kind] = inst;
  }
  _serviceByKind[kind] = inst;
  // Services seed the kind primary too — `dispatchKeyToFocused` and
  // wrapped Component-name dispatch resolve via getPrimaryByKind, and
  // a panes-only _primaryByKind would regress key routing for
  // kind-keyed setups. Load-bearing; don't "clean up". First-writer-
  // wins (set-once like setInstance): a pane instance registered
  // BEFORE the service keeps the primary — production order
  // (registerComponent before initState) makes the service first.
  if (!_primaryByKind[kind]) _primaryByKind[kind] = kind;
}

/** Slice of the `kind` service slot, or undefined when none registered.
 *  The explicit read for kind-global content (docker's `_slice()`,
 *  layout boot helpers) — NOT a general kind-name resolver; per-pane
 *  reads thread a paneId, kind-level pane reads use the primary. */
function serviceSlice(kind) {
  const inst = _serviceByKind[kind];
  return inst ? inst.slice : undefined;
}

function isService(id) {
  const inst = _instances[id];
  return !!(inst && inst.service);
}

/** Direct handle on the layout service slice — the hottest registry
 *  read (getFocus per keystroke; resolveTarget per viewer write; the
 *  arrange walk per docker-style resolution). Pre-registration → null. */
function _layoutSvcSlice() {
  const inst = _serviceByKind['layout'];
  return inst ? inst.slice : null;
}

// Ids already flagged on a strict miss, so the diagnostic fires at
// most once per id (these reads can sit on per-frame paths). Process-
// lifetime dedup, deliberately — the retired pane-collapse warning
// re-armed per dispose/reconfigure; a tripwire doesn't need to.
const _warnedStrict = new Set();

// Split-arc P2 tripwire: a get/setInstanceSlice miss whose id names a
// KNOWN KIND is almost always a forgotten paneId — the bug class the
// deleted kind-name fallback used to absorb silently (every shipped
// multi-instance bug of 2026-06 was this collapse). Surface it once in
// the diagnostics window (leader e). A miss on an unknown id is a
// normal pre-init read and stays quiet.
function _strictMiss(fn, id) {
  if (_primaryByKind[id] === undefined || _warnedStrict.has(id)) return;
  _warnedStrict.add(id);
  try {
    require('../io/diag-log').warn('strict-miss',
      `${fn}('${id}') is a kind name, not an instance id — thread a paneId, or declare kind-level intent via primarySliceOf/serviceSlice.`);
  } catch (_) { /* diag-log unavailable (early boot / test) */ }
}

function getInstanceSlice(id) {
  const inst = _instances[id];
  if (inst) return inst.slice;
  // Strict store read — NO kind-name fallback (split-arc P2; the
  // v0.6.3 Phase-B compat fallback resolved missed ids via
  // _primaryByKind, silently collapsing multi-instance kinds onto the
  // primary pane). Kind-level reads are explicit now: primarySliceOf /
  // serviceSlice.
  _strictMiss('getInstanceSlice', id);
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
  // Arm 2 is the INTENTIONAL kind-level fallback (docker-style panes
  // whose content lives on the kind's canonical instance, and legacy
  // kind-name callers) — explicit primary read, not the (post-P2
  // deleted) getInstanceSlice fallback.
  return primarySliceOf(kind);
}

function setInstanceSlice(id, slice) {
  const inst = _instances[id];
  // Strict, mirroring getInstanceSlice: a missed write is a no-op (the
  // pinned contract), with the kind-name tripwire — a silent write to
  // "whichever pane is primary" was the worst flavor of the collapse.
  if (!inst) { _strictMiss('setInstanceSlice', id); return; }
  inst.slice = slice;
}

function hasInstance(id) { return id in _instances; }

function disposeInstance(id) {
  const inst = _instances[id];
  if (!inst) return;
  // Service slots live for the whole session — refusing here (not just
  // in initState) means NO caller can kill kind-global content.
  if (inst.service) {
    console.error(`[route] disposeInstance('${id}') refused: service slot (registered by registerComponent, never disposed)`);
    return;
  }
  delete _instances[id];
  _instVer++;
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

/** Slice of the kind's PRIMARY instance — the explicit kind-level read.
 *  Callers declare "I deliberately want the canonical instance of this
 *  kind" (boot/test seeds before per-pane mints, docker-style panes
 *  without their own instance, kind-level previews). This is the ONLY
 *  sanctioned kind-name slice read; getInstanceSlice takes instance ids
 *  and (post-P2) will not fall back. Resolves services too — setService
 *  seeds the kind primary. */
function primarySliceOf(kind) {
  const id = _primaryByKind[kind];
  return id !== undefined && _instances[id] ? _instances[id].slice : undefined;
}

/** TEST-ONLY: wipe the whole registry (instances, primaries, service
 *  slots, warning dedup). Test files reset via this instead of an
 *  eachInstance+dispose loop — dispose refuses service slots, so a
 *  loop would leak them across cases. */
function _resetRegistryForTest() {
  for (const k in _instances) delete _instances[k];
  for (const k in _primaryByKind) delete _primaryByKind[k];
  for (const k in _serviceByKind) delete _serviceByKind[k];
  _warnedStrict.clear();
  _instVer++;
  _rtMemo = null;
  _rvpMemo = null;
}

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
  const s = _layoutSvcSlice();
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

/** Map an arrange-walk hit (tab/pool id) to the MOUNTED instance id.
 *  Tab ids are pool ids ('detail'); initState mints instances keyed by
 *  the hosting pane's paneId ('pane-detail'). Pre-split, the
 *  getInstanceSlice kind-name fallback bridged that gap for singleton
 *  placements; post-P2 reads are strict, so resolveTarget must hand
 *  back an id that resolves. Prefers the tab id itself (per-tab
 *  instances + pre-init seeds), then the hosting pane's instance. */
function _mountedViewerId(tabId, pane) {
  if (_instances[tabId]) return tabId;
  if (pane && pane.paneId && _instances[pane.paneId]) return pane.paneId;
  return tabId;
}

function resolveTarget(intent, ctx) {
  ctx = ctx || {};
  // `focused` folds in the ctx override; the layout slice carries the
  // other inputs. These reads are cheap (object props) — the win is
  // skipping the tier-3 arrange walk + its allocation on a memo hit.
  const focused = ctx.focusedTabId != null ? ctx.focusedTabId : getFocus();
  const layout = _layoutSvcSlice();
  const lastViewerTab = layout ? layout.lastViewerTab : null;
  const arrange = layout ? layout.arrange : null;
  const m = _rtMemo;
  if (m && m.intent === intent && m.focused === focused
        && m.lastViewerTab === lastViewerTab && m.arrange === arrange
        && m.instVer === _instVer) {
    return m.value;
  }
  const value = _resolveTargetCompute(intent, focused, layout, lastViewerTab);
  _rtMemo = { intent, focused, lastViewerTab, arrange, instVer: _instVer, value };
  return value;
}

function _resolveTargetCompute(intent, focused, layout, lastViewerTab) {
  // (1) focused viewer-kind
  if (focused && isViewerKind(focused)) return focused;

  // (2) sticky lastViewerTab — only when it still RESOLVES. The sticky
  //     pointer survives the instance it names (reconfigure disposes,
  //     harness seed swaps); post-split reads are strict, so a stale id
  //     must fall through to the arrange walk / instance scan instead
  //     of strict-missing at the consumer.
  if (lastViewerTab && _instances[lastViewerTab]
      && isViewerKind(lastViewerTab)) {
    return lastViewerTab;
  }

  // (3) first viewer-kind in last-column arrange order. Walk each
  //     pane's tabs for a viewer-kind hit, then map it to the MOUNTED
  //     instance id via _mountedViewerId — tab/pool ids ('detail') and
  //     minted instance ids ('pane-detail') differ for singleton
  //     placements, and post-split reads are strict (no kind-name
  //     bridge), so the returned id must actually resolve.
  if (layout && layout.arrange && Array.isArray(layout.arrange.columns)) {
    const mpool = require('../leaves/pool');
    for (const p of mpool.lastColumnPanels(layout.arrange)) {
      if (!p) continue;
      const tabs = Array.isArray(p.tabs) ? p.tabs : null;
      if (tabs) {
        for (const t of tabs) {
          if (t && isViewerKind(t.id)) return _mountedViewerId(t.id, p);
        }
      } else if (isViewerKind(p.id)) {
        return _mountedViewerId(p.id, p);
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
  ctx = ctx || {};
  // Same memo key as resolveTarget — this result is a pure function of the
  // resolveTarget result (itself keyed on these) + layout.arrange. The
  // findPaneLocation walk below allocates a fresh predicate closure per
  // call, so memoizing matters even though resolveTarget is already cached.
  const focused = ctx.focusedTabId != null ? ctx.focusedTabId : getFocus();
  const layout = _layoutSvcSlice();
  const lastViewerTab = layout ? layout.lastViewerTab : null;
  const arrange = layout ? layout.arrange : null;
  const m = _rvpMemo;
  if (m && m.focused === focused && m.lastViewerTab === lastViewerTab
        && m.arrange === arrange && m.instVer === _instVer) {
    return m.value;
  }
  const value = _resolveViewerPaneIdCompute(ctx, arrange);
  _rvpMemo = { focused, lastViewerTab, arrange, instVer: _instVer, value };
  return value;
}

function _resolveViewerPaneIdCompute(ctx, arrange) {
  const tabId = resolveTarget('viewer', ctx);
  if (tabId == null) return null;
  if (!arrange) return null;
  const mpool = require('../leaves/pool');
  // resolveTarget may hand back a container paneId (tier-1 focus) OR a tab
  // id (tier-3 arrange scan) — match either against the pane's identity.
  const loc = mpool.findPaneLocation(arrange, (p) =>
    p.paneId === tabId || p.id === tabId || p.activeTabId === tabId ||
    (Array.isArray(p.tabs) && p.tabs.some(t => t && t.id === tabId)));
  return loc ? loc.pane.paneId : null;
}

module.exports = {
  wrap,
  registerPanelOwner, componentForPanel, paneTypeOf,
  getFocus,
  setInstance, getInstance, getInstanceSlice, sliceForPane, setInstanceSlice,
  hasInstance, disposeInstance, instanceKind, eachInstance,
  setService, serviceSlice, isService,
  getPrimaryByKind, primarySliceOf,
  _resetRegistryForTest,
  // Navigator → focused-viewer routing chokepoint.
  resolveTarget, resolveViewerPaneId, isViewerKind, VIEWER_KIND,
};
