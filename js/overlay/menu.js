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

// Scroll offset (in lines) that keeps the selected row `idx` visible — centered
// when possible, clamped at the ends. Pure fn of (idx, total lines, window
// height). Shared by renderMenu + hitTest so a click maps to the same row the
// paint drew. Derived (not stored): idx is already in the model, so replay
// reconstructs it. Without this a menu taller than the screen showed only its
// first screenful and the cursor drove off-screen with no way down.
function menuScroll(idx, total, innerH) {
  if (total <= innerH) return 0;
  return Math.max(0, Math.min(idx - Math.floor(innerH / 2), total - innerH));
}

function renderMenu() {
  const { items, idx, anchor, title } = getModel().modal.menu;
  const { lines, selPos, selCount } = _menuLines(items, idx);
  // v0.6.4 Theme F Phase 3 — a right-click threads a cursor anchor; the menu
  // opens there (clamped on-screen by renderOverlay). A null anchor (the
  // keyboard `x` verb) keeps the centered placement. `title` defaults to
  // 'Menu' (command list); the right-click context menu passes 'Actions'.
  const { menuH } = overlayBox({ linesLen: lines.length, anchor, maxWidth: MENU_MAX_WIDTH });
  const scrollOffset = menuScroll(idx, lines.length, Math.max(1, menuH - 2));
  renderOverlay({ lines, title: title || 'Menu', count: [selPos, selCount], anchor, maxWidth: MENU_MAX_WIDTH, scrollOffset });
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
  const { items, idx, anchor } = getModel().modal.menu;
  const { offX, offY, menuW, menuH } = overlayBox({ linesLen: items.length, anchor, maxWidth: MENU_MAX_WIDTH });
  if (mx < offX || mx >= offX + menuW || my < offY || my >= offY + menuH) return null;
  // Content rows sit one row below the top border (offY), for `menuH - 2` rows.
  // Reject border / outside-content clicks BEFORE applying scroll — otherwise a
  // scrolled menu's top/bottom border maps to a valid-but-OFF-SCREEN item index
  // (a silent wrong-item activation). Then add the SAME scroll offset renderMenu
  // used, so a click on a visible row maps to the right item (lines are
  // index-aligned with items).
  const contentH = menuH - 2;
  const row = my - (offY + 1);
  if (row < 0 || row >= contentH) return { itemIdx: null };              // border row
  const lineIdx = menuScroll(idx, items.length, Math.max(1, contentH)) + row;
  if (lineIdx < 0 || lineIdx >= items.length) return { itemIdx: null };
  if (items[lineIdx] === null) return { itemIdx: null };                 // separator
  return { itemIdx: lineIdx };
}

module.exports = { renderMenu, hitTest };
