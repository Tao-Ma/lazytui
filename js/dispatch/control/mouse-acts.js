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

const ACTS = {
  /** `[≡]` click on an available trigger → open that pane's menu. */
  'pane-menu-open'({ paneId }) {
    const msgs = require('../../overlay/pane-menu').openAt(paneId);
    if (msgs) for (const m of msgs) loop.dispatchMsg(api.wrap('layout', m));
  },
};

/** Realize an `{ act, ...args }` handler. Unknown act → no-op. */
function realize(h) {
  const fn = h && Object.prototype.hasOwnProperty.call(ACTS, h.act) ? ACTS[h.act] : null;
  if (fn) fn(h);
}

module.exports = { realize, ACTS };
