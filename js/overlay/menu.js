/**
 * Menu popup — overlay with a row list (the global command list via `x`, or
 * the right-click context menu via the context intent).
 *
 * Menu state + behavior live in the reducer (runtime.update: menu_open/nav/
 * activate/close; items built by leaves/menu (command list) or leaves/
 * context-menu (right-click)). This module is the render + hit-test side:
 * renderMenu paints model.modal.menu.{items,idx,title,anchor}; hitTest maps
 * a cursor cell back to a row (for click-to-activate / click-outside-close).
 */
'use strict';

const { esc } = require('../leaves/text/ansi');
const { renderOverlay, overlayBox } = require('../leaves/render/draw');
const { getModel } = require('../model/store');

const MENU_MAX_WIDTH = 44;  // shared by renderMenu + hitTest (must match)

// One screen line per menu item (separators → blank), index-aligned with
// `items` — so a content-row index maps straight back to an item index.
function _menuLines(items, idx) {
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
  return { lines, selPos, selCount };
}

function renderMenu() {
  const { items, idx, anchor, title } = getModel().modal.menu;
  const { lines, selPos, selCount } = _menuLines(items, idx);
  // v0.6.4 Theme F Phase 3 — a right-click threads a cursor anchor; the menu
  // opens there (clamped on-screen by renderOverlay). A null anchor (the
  // keyboard `x` verb) keeps the centered placement. `title` defaults to
  // 'Menu' (command list); the right-click context menu passes 'Actions'.
  renderOverlay({ lines, title: title || 'Menu', count: [selPos, selCount], anchor, maxWidth: MENU_MAX_WIDTH });
}

/**
 * Map a 0-based cursor cell to a menu row. Recomputes the SAME box geometry
 * renderMenu paints (shared `overlayBox`), so a click can't land on a cell
 * the box didn't draw. Returns:
 *   - null            → the cell is OUTSIDE the box (caller closes the menu)
 *   - { itemIdx: n }  → on selectable item n (caller activates it)
 *   - { itemIdx: null}→ inside the box but on a border / separator (no-op)
 */
function hitTest(mx, my) {
  const { items, anchor } = getModel().modal.menu;
  const { offX, offY, menuW, menuH } = overlayBox({ linesLen: items.length, anchor, maxWidth: MENU_MAX_WIDTH });
  if (mx < offX || mx >= offX + menuW || my < offY || my >= offY + menuH) return null;
  // Content rows sit one row below the top border (offY); each maps 1:1 to
  // items (lines are index-aligned with items, separators included).
  const lineIdx = my - (offY + 1);
  if (lineIdx < 0 || lineIdx >= items.length) return { itemIdx: null };  // border row
  if (items[lineIdx] === null) return { itemIdx: null };                 // separator
  return { itemIdx: lineIdx };
}

module.exports = { renderMenu, hitTest };
