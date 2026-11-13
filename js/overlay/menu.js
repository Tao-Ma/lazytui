/**
 * Menu popup — overlay with a row list (the global command list via `x`, or
 * the right-click context menu via the context intent).
 *
 * Menu state + behavior live in the reducer (runtime.update: menu_open/nav/
 * activate/close; items built by leaves/menu (command list) or leaves/
 * context-menu (right-click)). This module is the render side: renderMenu
 * paints model.modal.menu.{items,idx,title,anchor} and publishes its rows to
 * the hit map (docs/mouse-hit-map.md) — click-to-activate, wheel-to-move, and
 * the outside-click dismiss (the descriptor's backdrop) all resolve there; the
 * former hitTest + input.js menu mouse handler are gone.
 */
'use strict';

const { esc } = require('../leaves/text/ansi');
const { renderOverlay, overlayBox } = require('../leaves/render/draw');
const { getModel } = require('../model/store');

const MENU_MAX_WIDTH = 44;

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
// height). renderMenu passes it to renderOverlay, whose publishBox applies the
// same window to the hit map, so a click maps to the same row the paint drew. Derived (not stored): idx is already in the model, so replay
// reconstructs it. Without this a menu taller than the screen showed only its
// first screenful and the cursor drove off-screen with no way down.
function menuScroll(idx, total, innerH) {
  if (total <= innerH) return 0;
  return Math.max(0, Math.min(idx - Math.floor(innerH / 2), total - innerH));
}

// Overlay-compositor migration (Release 2 Phase 2.b #2 — second medium
// overlay). When `newRows` + `cols` are threaded in by paint.js, the
// overlay composites into the main-frame row buffer through
// `renderOverlay`'s `targetRows` path. THIS commit also deletes the
// `prevMenuItems` sig tracker from paint.js — the one that force-fulled
// on a menu-replace-in-place (right-click → "Send to port…" picker).
// Cell-diff now emits per-cell writes for the exact changed cells, so a
// menu-A → menu-B swap paints only the cells that differ (the two menus'
// disjoint rects + any shared-rect text that changed).
function renderMenu(newRows, cols) {
  const { items, idx, anchor, title } = getModel().modal.menu;
  const { lines, selPos, selCount } = _menuLines(items, idx);
  // v0.6.4 Theme F Phase 3 — a right-click threads a cursor anchor; the menu
  // opens there (clamped on-screen by renderOverlay). A null anchor (the
  // keyboard `x` verb) keeps the centered placement. `title` defaults to
  // 'Menu' (command list); the right-click context menu passes 'Actions'.
  const { menuH } = overlayBox({ linesLen: lines.length, anchor, maxWidth: MENU_MAX_WIDTH });
  const scrollOffset = menuScroll(idx, lines.length, Math.max(1, menuH - 2));
  // Hit map (docs/mouse-hit-map.md): lines are index-aligned with items, so
  // item i's row activates i (menu_activate's absolute idx). press / right /
  // middle all activate (the pre-hit-map behavior); `double` is deliberately
  // unhandled — the press already activated (and usually closed or replaced the
  // menu), so the second click is swallowed instead of activating whatever row
  // now sits under the pointer. Separators get no target; publishBox applies the
  // scroll window, so a border or off-screen row can never map to an item.
  const lineTargets = items.map((it, i) => {
    if (it === null) return null;
    const act = { msg: { type: 'menu_activate', idx: i } };
    return { press: act, right: act, middle: act };
  });
  renderOverlay({ lines, title: title || 'Menu', count: [selPos, selCount], anchor,
                  maxWidth: MENU_MAX_WIDTH, scrollOffset,
                  targetRows: newRows || null, targetCols: cols || 0,
                  hit: { lineTargets, box: { 'wheel-up': { key: 'up' }, 'wheel-down': { key: 'down' } } } });
}


// Overlay-compositor R3 descriptor. zIndex=100 preserves menu's
// historical position (tenth in the retired paint.js if-chain).
function registerSelf(compositor) {
  compositor.register({
    id: 'menu',
    isActive: (m) => !!(m && m.modes && m.modes.menuOpen),
    render: (m, newRows, cols) => renderMenu(newRows, cols),
    modal: true,
    zIndex: 100,
    // Outside click (any button) = Esc = menu_close — the dismiss the legacy
    // handler implemented, now the hit-map backdrop.
    mouse: { outside: { key: 'escape' } },
  });
}

module.exports = { renderMenu, registerSelf };
