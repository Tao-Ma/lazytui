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
 * Lives under `leaves/` (not `panel/`) because it has no dependencies
 * and is structurally a pure registry — runtime imports it directly,
 * and panel/api re-exports its public surface for callers that want
 * the cohesive "panel system" import path. Importing `panel/api`
 * from runtime would cycle (api → runtime via `getModel`), so the
 * routing bits live down here on their own.
 */
'use strict';

// --- Wrapped-Msg ctor -----------------------------------------------------

function wrap(kind, msg) { return { kind, msg }; }

// --- Panel → Component ownership ------------------------------------------

const _panelOwner = Object.create(null);

function registerPanelOwner(panelType, componentName) {
  _panelOwner[panelType] = componentName;
}

function componentForPanel(panelType) { return _panelOwner[panelType]; }

// --- Instance-keyed slice store ----------------------------------------
//
// Canonical storage is `_instances[id] = { id, kind, slice }`. `id` is
// the tab identity (singleton instances today use `id === kind`;
// multi-instance mints per-tab ids on top of this seed). `kind` is the
// Component name. `slice` is the per-instance state minted via
// `spec.init()` and updated by the Component's `update`.
//
// `_primaryByKind[kind]` maps a kind to the id of its primary
// instance — the lookup `resolveTarget` and other consumers use to
// pick "the canonical instance of a kind."

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
  return inst ? inst.slice : undefined;
}

function setInstanceSlice(id, slice) {
  const inst = _instances[id];
  if (!inst) return;
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
function instanceKind(id) {
  const inst = _instances[id];
  if (inst) return inst.kind;
  const compName = _panelOwner[id];
  if (compName) return compName;
  return null;
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
    const mpool = require('./pool');
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

module.exports = {
  wrap,
  registerPanelOwner, componentForPanel,
  getFocus,
  setInstance, getInstance, getInstanceSlice, setInstanceSlice,
  hasInstance, disposeInstance, instanceKind, eachInstance,
  getPrimaryByKind,
  // Navigator → focused-viewer routing chokepoint.
  resolveTarget, isViewerKind, VIEWER_KIND,
};
