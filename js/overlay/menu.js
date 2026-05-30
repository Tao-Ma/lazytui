/**
 * Menu popup — centered overlay with keybinding list.
 *
 * Menu state + behavior now live in the reducer (runtime.update: menu_open/
 * nav/activate/close; items built by the pure leaves/menu leaf). This module
 * is the render-side only: renderMenu paints model.modal.menu.{items,idx}.
 */
'use strict';

const { esc } = require('../io/ansi');
const { renderOverlay } = require('../render/panel');
const { getModel } = require('../app/runtime');

function renderMenu() {
  const { items, idx } = getModel().modal.menu;
  const lines = [];
  let selCount = 0, selPos = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i] === null) {
      lines.push('');
    } else {
      const label = esc(items[i][0]);
      if (i === idx) { lines.push(`[reverse]  ${label}`); selPos = selCount + 1; }
      else lines.push(`  ${label}`);
      selCount++;
    }
  }
  renderOverlay({ lines, title: 'Menu', count: [selPos, selCount] });
}

module.exports = { renderMenu };
