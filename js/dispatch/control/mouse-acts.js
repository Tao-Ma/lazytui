/**
 * Mouse acts — the named input-time actions behind the hit map's `{ act }`
 * handler form (docs/mouse-hit-map.md §Handler forms, Release 2).
 *
 * Most hit-map handlers are plain data fixed at paint (`{ key }`, `{ msg }`).
 * An act is for a click whose Msg must be computed against the state AT CLICK
 * TIME — exactly as the keyboard would — and whose target must still be shown:
 * a border control's `dispatch(action, pane)` (sort cycle from the current
 * sort, an item action on the current selection) and the `[≡]` open (cursor
 * seeded from the current tab). The region carries only the act's name and
 * arguments (data); the code lives here, registered by name — the same shape
 * Release 3's pointer-capture controllers take.
 *
 * Each act returns nothing; a target that is gone or no longer clickable is a
 * silent no-op (the click is still consumed by the region that drew it).
 */
'use strict';

const api = require('../../panel/api');
const loop = require('../runtime/loop');
const route = require('../../panel/route');
const mpool = require('../../leaves/wm/pool');
const mpane = require('../../leaves/wm/pane');
const { visibleBoundsFor } = require('../../leaves/wm/geometry');
const { getModel } = require('../../model/store');

/** What a border-control click dispatches NOW — `{ owner, msg }` or null. The
 *  control must still be shown for this pane (borderControlsFor with the current
 *  focus + mode: a legend click on a pane that lost focus resolves to nothing)
 *  and still offer `action`; then the spec's own `dispatch(action, pane)`
 *  computes the Msg against current state (sort cycle, selected item). */
function resolveBorderControl({ paneId, type, specId, action }) {
  const layout = api.getInstanceSlice('layout');
  const p = layout && layout.arrange && mpool.allPanesInColumns(layout.arrange).find(x => x.paneId === paneId);
  if (!p) return null;
  // Visible bounds, not `p.collapsed`: half / full view render a collapsed pane
  // expanded (with its controls); in normal view a collapsed pane is a 1-row bar
  // that draws none, so no region of it exists to click.
  const b = visibleBoundsFor(layout, paneId, route.resolveViewerPaneId());
  if (!b || b.h < 2) return null;
  const pane = { paneId, type, focused: mpane.paneMatchesFocus(p, layout.focus), innerW: b.w - 2 };
  const c = api.borderControlsFor(pane, getModel()).find(x => x.spec.id === specId);
  if (!c) return null;
  if (!(c.spec.regions(0, 0, c.visibleW, pane) || []).some(r => r.action === action)) return null;
  return c.spec.dispatch(action, pane) || null;
}

const ACTS = {
  /** `[≡]` click on an available trigger → open that pane's menu. */
  'pane-menu-open'({ paneId }) {
    const msgs = require('../../overlay/pane-menu').openAt(paneId);
    if (msgs) for (const m of msgs) loop.dispatchMsg(api.wrap('layout', m));
  },

  /** A border-control part (refresh `-`/`+`, sort `‹`/`›`, an item action …)
   *  → the spec's own Msg, resolved now (resolveBorderControl). */
  'border-control'(h) {
    const hit = resolveBorderControl(h);
    if (hit) loop.dispatchMsg(api.wrap(hit.owner, hit.msg));
  },
};

/** Realize an `{ act, ...args }` handler. Unknown act → no-op. */
function realize(h) {
  const fn = h && Object.prototype.hasOwnProperty.call(ACTS, h.act) ? ACTS[h.act] : null;
  if (fn) fn(h);
}

module.exports = { realize, resolveBorderControl };
