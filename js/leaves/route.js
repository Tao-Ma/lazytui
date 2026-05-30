/**
 * Panel-routing leaf — the shared registry the root reducer and
 * `panel/api` both read from.
 *
 * Three concerns, one zero-dep module:
 *   - `wrap(kind, msg)` — the wrapped-Msg data constructor.
 *   - panel→Component ownership map (writer + reader).
 *   - Component slice store (nested: layout at the root, every other
 *     Component under `layout.panels[name]`).
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

module.exports = {
  wrap,
  registerPanelOwner, componentForPanel,
  getSlice, setSlice, hasSlice,
  getFocus,
};
