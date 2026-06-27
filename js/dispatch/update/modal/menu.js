/**
 * Command-menu sub-reducer (#D12). Items (action strings, no closures) are
 * threaded by the menu_open handler (built from the layout slice there); nav
 * skips null separators; activate emits a menu_action Cmd routing the chosen
 * verb back through dispatch.handleAction.
 * `update(model, msg) → [model, cmds]`.
 */
'use strict';

const { withModalMode: _withModalMode, withModal: _withModal } = require('../model-ops');

const TYPES = ['menu_open', 'menu_close', 'menu_nav', 'menu_activate'];

function update(model, msg) {
  switch (msg.type) {
    case 'menu_open':
      // v0.6.4 Theme F Phase 3 — `msg.anchor` ({x,y} 1-based, or null/absent)
      // is stored so the menu render can open at a right-click's cursor; null
      // (the keyboard `x` verb) keeps the menu centered. `msg.title` overrides
      // the overlay title (right-click context menu → 'Actions'); null = 'Menu'.
      return [_withModalMode(model, { menuOpen: true },
        { menu: { items: msg.items || [], idx: 0, anchor: msg.anchor || null, title: msg.title || null } }), []];
    case 'menu_close':
      if (!model.modes.menuOpen) return [model, []];
      return [_withModalMode(model, { menuOpen: false },
        { menu: { items: [], idx: 0, anchor: null, title: null } }), []];
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
      const next = _withModalMode(model, { menuOpen: false },
        { menu: { items: [], idx: 0, anchor: null, title: null } });
      if (!item) return [next, []];
      // item[2] (arg) rides along for verbs that take one (copy_text); bare
      // command verbs leave it undefined.
      return [next, [{ type: 'menu_action', action: item[1], arg: item[2] }]];
    }
    default:
      return [model, []];
  }
}

module.exports = { TYPES, update };
