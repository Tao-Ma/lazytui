/**
 * Panel-routing leaf — the shared registry the root reducer and
 * `panel/api` both read from.
 *
 * Four concerns, one zero-dep module:
 *   - `wrap(kind, msg)` — the wrapped-Msg data constructor.
 *   - panel→Component ownership map (writer + reader).
 *   - Component slice store (nested: layout at the root, every other
 *     Component under `layout.panels[name]`).
 *   - Tab-instance registry (v0.6.1) — empty until Phase 4 populates;
 *     introduced in Phase 0 so downstream phases can compile against
 *     a stable surface. Address scheme is the tab id (string).
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

// --- Slice store ----------------------------------------------------------
//
// Phase 3 (api.js) introduced a nested store: layout owns its own slice,
// every other Component nests under `layout.panels[name]`. The pre-Phase-3
// fallback (`_flatFallback`) tolerates slices registered BEFORE layout
// exists; production order in tui.js + test-runner ensures layout first.

const _layoutRef = { current: null };
const _flatFallback = {};

function getSlice(name) {
  if (name === 'layout') return _layoutRef.current;
  const layout = _layoutRef.current;
  if (layout && layout.panels && name in layout.panels) return layout.panels[name];
  return _flatFallback[name];
}

function setSlice(name, slice) {
  if (name === 'layout') {
    // Repair the panels-map invariant: every layout.update branch is
    // *supposed* to shallow-spread `slice.panels` along with whatever
    // field it touches, but the invariant lives in convention — a
    // branch that ever returned a fresh `{ ... }` without spreading
    // would silently lose every non-layout Component's slice. Splice
    // the prior panels back on the new layout when missing. Cheap
    // insurance; common path (panels intact) early-returns through
    // the truthy check.
    if (slice && !slice.panels) {
      const prev = _layoutRef.current;
      slice.panels = (prev && prev.panels) || {};
    }
    _layoutRef.current = slice;
    return;
  }
  const layout = _layoutRef.current;
  if (layout) {
    if (!layout.panels) layout.panels = {};
    layout.panels[name] = slice;
  } else {
    _flatFallback[name] = slice;
  }
}

function hasSlice(name) {
  if (name === 'layout') return _layoutRef.current !== null;
  const layout = _layoutRef.current;
  if (layout && layout.panels && name in layout.panels) return true;
  return name in _flatFallback;
}

/** Focus read — the layout slice owns `focus` (Phase 1c). Pre-init returns null. */
function getFocus() {
  const s = _layoutRef.current;
  return s ? s.focus : null;
}

// --- Tab-instance registry (v0.6.1, Phase 0) ------------------------------
//
// Maps a tab id (string) to its instance: { id, kind, slice }. Empty in
// Phase 0; populated by Phase 4 onward when the slice store flips from
// name-keyed singletons to id-keyed instances. The surface lives here from
// Phase 0 so route.js can be the single import home for both registries
// without later module reshuffles.
//
// `id` is the tab identity (today: the v0.6 pool entry id, threaded through
// parser/state.js; future: with `<poolId>#n` synth for multi-mount).
// `kind` is the panel-type string ('detail' | 'groups' | 'files' | …) — the
// discriminator that lets resolveTarget filter by tab type without a slice
// shape inspection. `slice` is the per-instance state minted via
// `spec.init()`.

const _instances = Object.create(null);

function setInstance(id, kind, slice) {
  _instances[id] = { id, kind, slice };
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

function disposeInstance(id) { delete _instances[id]; }

function instanceKind(id) {
  const inst = _instances[id];
  return inst ? inst.kind : null;
}

/** Iterate all instances. Order is insertion order. Phase 3 uses this for
 *  broadcast fan-out (refresh / hub / action) once instances populate. */
function eachInstance(fn) {
  for (const id in _instances) fn(_instances[id]);
}

module.exports = {
  wrap,
  registerPanelOwner, componentForPanel,
  getSlice, setSlice, hasSlice,
  getFocus,
  setInstance, getInstance, getInstanceSlice, setInstanceSlice,
  hasInstance, disposeInstance, instanceKind, eachInstance,
};
