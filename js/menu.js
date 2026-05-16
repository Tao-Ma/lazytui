/**
 * Menu popup — centered overlay with keybinding list.
 * Pure state + paint: callers (dispatch.js) own render() invocation so
 * layout.js can require this module without forming a cycle.
 */
'use strict';

const { esc } = require('./ansi');
const { renderOverlay } = require('./panel');
const { S, allPanels } = require('./state');

// Module-private mode state. S.menuOpen (the flag) stays on S so the
// render conductor / footer can detect overlay-active. The item list
// and selection index are transient per-popup and live here.
let _items = [];
let _idx = 0;

function openMenu() {
  if (S.menuOpen) { closeMenu(); return; }
  S.menuOpen = true;
  _idx = 0;
  _items = [
    ['↑ / k    Move up',            'nav_up'],
    ['↓ / j    Move down',          'nav_down'],
    ['← / h    Panel left',         'focus_left'],
    ['→ / l    Panel right',        'focus_right'],
    null,
  ];
  for (const p of allPanels()) {
    if (p.hotkey) _items.push([`[${p.hotkey}]       ${esc(p.title)}`, `focus_panel:${p.hotkey}`]);
  }
  _items.push(
    null,
    ['/        Filter panel items',  'filter'],
    ['Enter    Run / select',       'run_selected'],
    [']        Next detail tab',    'next_tab'],
    ['[        Prev detail tab',    'prev_tab'],
    [',        Page up (focused panel)',     'page_up'],
    ['.        Page down (focused panel)',   'page_down'],
    ['<        Top of focused panel',         'goto_top'],
    ['>        Bottom of focused panel',      'goto_bottom'],
    null,
    ['+        Expand view',        'view_expand'],
    ['_        Shrink view',        'view_shrink'],
    null,
    ...(S.designEnabled ? [[':design  Design mode', 'design']] : []),
    ['r        Refresh status',     'refresh'],
    ['?        Help in detail',     'show_help'],
    ['q        Quit',               'quit'],
  );
}

/**
 * Move selection by `delta` (typically -1 or +1), skipping null
 * separator entries. Returns true if the index changed (caller renders),
 * false otherwise (no-op at edges).
 */
function navMenu(delta) {
  if (!S.menuOpen) return false;
  if (delta < 0) {
    let idx = _idx - 1;
    while (idx >= 0 && _items[idx] === null) idx--;
    if (idx < 0) return false;
    _idx = idx;
    return true;
  }
  if (delta > 0) {
    let idx = _idx + 1;
    while (idx < _items.length && _items[idx] === null) idx++;
    if (idx >= _items.length) return false;
    _idx = idx;
    return true;
  }
  return false;
}

/**
 * Read the selected item's action string (the second tuple element)
 * and close the menu. Returns the action string or null if nothing to
 * activate. Caller dispatches the action.
 */
function activateMenu() {
  if (!S.menuOpen) return null;
  const item = _items[_idx];
  closeMenu();
  if (!item) return null;
  return item[1];
}

function renderMenu() {
  const lines = [];
  let selCount = 0, selPos = 0;
  for (let i = 0; i < _items.length; i++) {
    if (_items[i] === null) {
      lines.push('');
    } else {
      const label = esc(_items[i][0]);
      if (i === _idx) { lines.push(`[reverse]  ${label}`); selPos = selCount + 1; }
      else lines.push(`  ${label}`);
      selCount++;
    }
  }
  renderOverlay({ lines, title: 'Menu', count: [selPos, selCount] });
}

function closeMenu() {
  S.menuOpen = false;
  _items = [];
  _idx = 0;
}

module.exports = { openMenu, renderMenu, closeMenu, navMenu, activateMenu };
