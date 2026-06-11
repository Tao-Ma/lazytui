/**
 * Intent layer (v0.6.4 Theme F) — the semantic middle between input
 * gestures (keys today; mouse in Phase 2) and reducer Msgs. Both input
 * sources build an *intent* (what the user wants); `realize` is the single
 * site that turns an intent into the existing dispatch — the pointer
 * analogue of `actions.handleAction` (the keyboard chokepoint). See
 * docs/v0.6.4-input.md.
 *
 * Phase 1 (this commit): keyboard's core nav keys route through here. The
 * keyboard (relative / directional) forms delegate to the existing
 * `handleAction` verbs, so the realization is byte-for-byte the prior
 * behavior — the seam is transparent (proven by test-intent.js). The
 * absolute forms (focus a specific paneId, select an absolute row) exist
 * for the Phase 2 mouse lift; no keyboard path constructs them yet, and
 * `context`'s cursor anchor is threaded in Phase 3.
 *
 * Module refs are resolved lazily + memoized: dispatch.js requires this
 * module, so a load-time require back would cycle. `realize` runs at
 * keystroke time, and the memoized getter pays the require cost once
 * (the Theme E lesson: an un-memoized inline require is ~70µs/call).
 */
'use strict';

let _api = null, _dispatch = null, _actions = null, _menu = null, _input = null;
const api      = () => _api      || (_api      = require('../panel/api'));
const dispatch = () => _dispatch || (_dispatch = require('./dispatch'));
const actions  = () => _actions  || (_actions  = require('./actions'));
const menu     = () => _menu     || (_menu     = require('../leaves/menu'));
const input    = () => _input    || (_input    = require('./input'));

// --- Intent constructors (the vocabulary) ---
// Tagged plain objects. Kept as factory functions (not bare literals at
// call sites) so the shape lives in one place and the vocabulary is
// greppable. Pure — no requires — so constructing an intent is safe at
// any load order.
const focusDir    = (dir)         => ({ kind: 'focus', dir });            // 'left' | 'right'
const focusHotkey = (hotkey)      => ({ kind: 'focus', hotkey });
// Absolute focus (mouse). `skipInfo` mirrors the click cascade's
// optimization: when the same click also selects a row, focus_set skips
// its own show_selected_info so navSelect's (against the new cursor) wins.
const focusPane   = (paneId, opts = {}) => ({ kind: 'focus', paneId, skipInfo: !!opts.skipInfo });
const selectBy    = (delta)       => ({ kind: 'select', delta });         // ±1 (keyboard)
const selectAt    = (paneId, idx) => ({ kind: 'select', paneId, idx });   // absolute (mouse)
const activate    = ()            => ({ kind: 'activate' });
const context     = (anchor = null) => ({ kind: 'context', anchor });     // anchor {x,y}|null
const scrollAt    = (mx, my, delta) => ({ kind: 'scroll', mx, my, delta }); // pointer (spatial)

// --- Realizer (the single intent → Msg site) ---
function realize(intent) {
  switch (intent.kind) {
    case 'focus':
      // Directional / hotkey forms (keyboard) delegate to the existing
      // verbs — neighbour resolution lives in handleAction, unchanged.
      if (intent.dir === 'left')  return actions().handleAction('focus_left');
      if (intent.dir === 'right') return actions().handleAction('focus_right');
      if (intent.hotkey != null)  return actions().handleAction('focus_panel', intent.hotkey);
      // Absolute form (mouse) — focus a specific pane by id, carrying the
      // click cascade's skipInfo flag (byte-identical to the prior inline
      // focus_set, which always stamped skipInfo).
      return api().dispatchMsg(api().wrap('layout',
        { type: 'focus_set', focus: intent.paneId, skipInfo: intent.skipInfo }));

    case 'select':
      // Relative form (keyboard) delegates to nav_up / nav_down.
      if (typeof intent.delta === 'number') {
        return actions().handleAction(intent.delta < 0 ? 'nav_up' : 'nav_down');
      }
      // Absolute form (mouse, Phase 2) — set the cursor to a specific row.
      return dispatch().navSelect(intent.paneId, intent.idx);

    case 'activate':
      return actions().handleAction('run_selected');

    case 'scroll':
      // Pointer scroll — spatial + per-pane heterogeneous: the resolution
      // (which pane is under the cursor) and the behavior (detail scrolls
      // its content; a list pane moves its own cursor, with focused / side /
      // groups variants) live in input._handleWheel. Routing it through the
      // realizer keeps handleMouse uniformly intent-driven; unifying the
      // list arm into `select` and the detail arm into a content-scroll Msg
      // is a later semantic pass (Theme F follow-on), not this no-op lift.
      // Returns whether anything changed (the caller gates its paint on it).
      return input()._handleWheel(intent.mx, intent.my, intent.delta);

    case 'context':
      // Build the menu items from the layout slice — identical to the `x`
      // key's prior inline dispatch (dispatch.js menu_open). v0.6.4 Phase 3:
      // `intent.anchor` ({x,y} 1-based SGR coords, or null for keyboard) is
      // threaded into menu_open so a right-click opens AT the cursor; a null
      // anchor keeps the menu centered (the keyboard `x` verb).
      return dispatch().applyMsg({
        type: 'menu_open',
        items: menu().buildItems(api().getInstanceSlice('layout')),
        anchor: intent.anchor || null,
      });

    default:
      throw new Error(`[intent] unknown intent kind: ${intent && intent.kind}`);
  }
}

module.exports = {
  realize,
  focusDir, focusHotkey, focusPane, selectBy, selectAt, activate, context, scrollAt,
};
