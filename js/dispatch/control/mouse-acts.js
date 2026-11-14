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
 * An act receives the handler and the event point `{ mx, my, x, y }` (0-based
 * mx/my, 1-based SGR x/y) — a pane body is ONE region, so the row under the
 * pointer is resolved at click time (Release 3). It returns nothing, or a
 * capture request `{ capture: name, ...args }` that the router hands to
 * ./pointer-capture (a press that starts a drag). Other modules register their
 * acts by name (`register`) — the pane-body acts live with the pane mouse code.
 *
 * A target that is gone or no longer clickable is a
 * no-op (the click is still consumed by the region that drew it). A border
 * control that paint drew but the act cannot find, or whose spec throws, is
 * recorded in the event log (a plugin contract problem, not a user one).
 */
'use strict';

const api = require('../../panel/api');
const loop = require('../runtime/loop');
const route = require('../../panel/route');
const mpool = require('../../leaves/wm/pool');
const mpane = require('../../leaves/wm/pane');
const { visibleBoundsFor } = require('../../leaves/wm/geometry');
const { getModel } = require('../../model/store');
const eventLog = require('../../io/event-log');

/** What a border-control click dispatches NOW — `{ owner, msg }` or null. The
 *  control must still be shown for this pane (borderControlsFor with the current
 *  focus + mode: a legend click on a pane that lost focus resolves to nothing)
 *  and still offer `action`; then the spec's own `dispatch(action, pane)`
 *  computes the Msg against current state (sort cycle, selected item). */
function resolveBorderControl({ paneId, type, spec, specId, action }) {
  const layout = api.getInstanceSlice('layout');
  const p = layout && layout.arrange && mpool.allPanesInColumns(layout.arrange).find(x => x.paneId === paneId);
  if (!p) return null;
  // Visible bounds, not `p.collapsed`: half / full view render a collapsed pane
  // expanded (with its controls); in normal view a collapsed pane is a 1-row bar
  // that draws none, so no region of it exists to click.
  const b = visibleBoundsFor(layout, paneId, route.resolveViewerPaneId());
  if (!b || b.h < 2) return null;
  const pane = { paneId, type, focused: mpane.paneMatchesFocus(p, layout.focus), innerW: b.w - 2 };
  // By spec identity (the region carries the spec object — ids are optional and
  // not unique across a plugin's specs); else by `id` when exactly one control
  // has it (a plugin whose getter builds fresh spec objects per read).
  const all = api.borderControlsFor(pane, getModel());
  let c = spec ? all.find(x => x.spec === spec) : null;
  if (!c && specId != null) {
    const byId = all.filter(x => x.spec.id === specId);
    if (byId.length === 1) c = byId[0];
  }
  if (!c) {
    // Shown for this pane but not found: e.g. fresh specs with no unique id.
    if (all.length) _record(paneId, specId, 'clicked control not found (fresh spec objects need a unique id)');
    return null;
  }
  try {
    const parts = c.spec.regions(0, 0, c.visibleW, pane);
    if (!Array.isArray(parts) || !parts.some(r => r && r.action === action)) return null;
    return c.spec.dispatch(action, pane) || null;
  } catch (e) {
    _record(paneId, specId, e && e.message, e && e.stack);
    return null;
  }
}

function _record(paneId, specId, message, stack) {
  try { eventLog.record('error', { where: 'border_control_act', paneId, control: specId, message, stack }); } catch (_) { /* event-log unavailable */ }
}

const ACTS = {
  /** `[≡]` click on an available trigger → open that pane's menu. */
  'pane-menu-open'({ paneId }) {
    const msgs = require('../../overlay/pane-menu').openAt(paneId);
    if (msgs) for (const m of msgs) loop.dispatchMsg(api.wrap('layout', m));
  },

  /** A click on a cell of the replay scrubber's mini progress bar → seek to
   *  that fraction. The replay controller paints its own frame (false = the
   *  router adds no paint). */
  'replay-seek'({ fraction }) {
    require('../runtime/replay-control').seekToFraction(fraction);
    return false;
  },

  /** A border-control part (refresh `-`/`+`, sort `‹`/`›`, an item action …)
   *  → the spec's own Msg, resolved now (resolveBorderControl). */
  'border-control'(h) {
    const hit = resolveBorderControl(h);
    if (hit) loop.dispatchMsg(api.wrap(hit.owner, hit.msg));
  },
};

/** Register a named act (`fn(handler, ev)`). Names are unique — a second
 *  registration under a taken name throws (two modules claiming one act). */
function register(name, fn) {
  if (Object.prototype.hasOwnProperty.call(ACTS, name)) throw new Error(`mouse act '${name}' already registered`);
  if (typeof fn !== 'function') throw new TypeError(`mouse act '${name}' must be a function`);
  ACTS[name] = fn;
}

/** Realize an `{ act, ...args }` handler at event point `ev`. Unknown act →
 *  no-op. Returns the act's capture request, if any. */
function realize(h, ev) {
  const fn = h && Object.prototype.hasOwnProperty.call(ACTS, h.act) ? ACTS[h.act] : null;
  return fn ? fn(h, ev || {}) : undefined;
}

module.exports = { realize, register, resolveBorderControl };
