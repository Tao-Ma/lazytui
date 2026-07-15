/**
 * Command-menu sub-reducer (#D12). Items (action strings, no closures) are
 * threaded by the menu_open handler (built from the layout slice there); nav
 * skips null separators; activate emits a menu_action Cmd routing the chosen
 * verb back through dispatch.handleAction. The fixed `menu_action` base is
 * staged on `model.modal.continuation` (E14) and patched with the chosen
 * verb/arg at activate. `update(model, msg) → [model, cmds]`.
 *
 * Multi-level menus: a submenu (e.g. the right-click "Send selection to port…"
 * → port picker) is opened with `back` = a snapshot of the menu it replaces.
 * `menu_back` (a "← Back" row, or the Backspace key) restores that snapshot; it
 * carries its own `back`, so nesting works. When a menu with an anchor is
 * activated, that menu's snapshot rides the menu_action Cmd as `from`, so the
 * handler opening the submenu can pass it straight to `menu_open`'s `back`.
 */
'use strict';

const { withModalMode: _withModalMode, withModal: _withModal } = require('../model-ops');

const TYPES = ['menu_open', 'menu_close', 'menu_nav', 'menu_activate', 'menu_back'];

const CLOSED_MENU = { items: [], idx: 0, anchor: null, title: null, back: null };

// Reopen a previous-menu snapshot (menu_back / "← Back"), or close if there's
// none to go back to. A snapshot is { items, anchor?, title?, back? }.
function _restoreOrClose(model, back) {
  if (back && Array.isArray(back.items)) {
    return [_withModalMode(model, { menuOpen: true }, {
      menu: { items: back.items, idx: 0, anchor: back.anchor || null, title: back.title || null, back: back.back || null },
      continuation: { type: 'menu_action' },
    }), []];
  }
  return [_withModalMode(model, { menuOpen: false }, { menu: { ...CLOSED_MENU }, continuation: null }), []];
}

function update(model, msg) {
  switch (msg.type) {
    case 'menu_open':
      // v0.6.4 Theme F Phase 3 — `msg.anchor` ({x,y} 1-based, or null/absent)
      // is stored so the menu render can open at a right-click's cursor; null
      // (the keyboard `x` verb) keeps the menu centered. `msg.title` overrides
      // the overlay title. `msg.back` (or null) is the menu to restore on
      // menu_back — set when opening a submenu (the port picker).
      return [_withModalMode(model, { menuOpen: true },
        { menu: { items: msg.items || [], idx: 0, anchor: msg.anchor || null, title: msg.title || null, back: msg.back || null },
          continuation: { type: 'menu_action' } }), []];
    case 'menu_close':
      if (!model.modes.menuOpen) return [model, []];
      return [_withModalMode(model, { menuOpen: false },
        { menu: { ...CLOSED_MENU }, continuation: null }), []];
    case 'menu_back':
      // Backspace / a "← Back" row dispatched as a Msg — restore the previous
      // menu, or close if this is a top-level menu.
      if (!model.modes.menuOpen) return [model, []];
      return _restoreOrClose(model, model.modal.menu.back);
    case 'menu_nav': {
      const mm = model.modal.menu;
      const items = mm.items;
      let i = mm.idx + (msg.dir < 0 ? -1 : 1);
      if (msg.dir < 0) { while (i >= 0 && items[i] === null) i--; if (i < 0) return [model, []]; }
      else { while (i < items.length && items[i] === null) i++; if (i >= items.length) return [model, []]; }
      if (i === mm.idx) return [model, []];
      return [_withModal(model, { menu: { ...mm, idx: i } }), []];
    }
    case 'menu_activate': {
      if (!model.modes.menuOpen) return [model, []];
      const mm = model.modal.menu;
      // Absolute idx (a mouse click on a specific row) overrides the cursor;
      // keyboard Enter omits it and activates the highlighted row.
      const i = (typeof msg.idx === 'number') ? msg.idx : mm.idx;
      const item = mm.items[i];
      // A "← Back" row is handled INLINE (not via a menu_action → handleAction
      // round-trip): the round-trip would run after the menu is cleared, losing
      // mm.back. Restore the previous menu, or close.
      if (item && item[1] === 'menu_back') return _restoreOrClose(model, mm.back);
      const cont = model.modal.continuation;
      const next = _withModalMode(model, { menuOpen: false },
        { menu: { ...CLOSED_MENU }, continuation: null });
      if (!item) return [next, []];
      // item[2] (arg) rides along for verbs that take one (copy_text); bare
      // command verbs leave it undefined. A menu with an anchor (a right-click
      // menu) also rides a `from` snapshot of itself, so a verb that opens a
      // SUBMENU (send_to_port's port picker) can reopen it at the same cursor
      // spot AND offer a "← Back" to it. Omitted for an unanchored (keyboard) menu.
      const emit = { ...cont, action: item[1], arg: item[2] };
      if (mm.anchor) emit.from = { items: mm.items, anchor: mm.anchor, title: mm.title || null, back: mm.back || null };
      return [next, [emit]];
    }
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
