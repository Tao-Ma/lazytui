/**
 * Pure builder for the command-menu item list (the menu's sub-model).
 *
 * Dependency-free leaf (only imports `io/ansi` for `esc`). Caller
 * (runtime.update's menu_open branch) threads the layout slice in —
 * the menu needs the current panel arrangement (for hotkeys). No
 * `panel/api` reach-around.
 *
 * Each item is `[label, actionString]` or `null` (a separator). The
 * action strings are handleAction verbs (`nav_up`, `focus_panel:7`,
 * `free_config`, …); `menu_activate` routes the chosen one back through
 * dispatch as a Cmd.
 */
'use strict';

const { esc } = require('../io/ansi');
const mpool = require('./pool');

function buildItems(layoutSlice) {
  const arrange = (layoutSlice && layoutSlice.arrange) || { columns: [] };
  const items = [
    ['↑ / k    Move up',            'nav_up'],
    ['↓ / j    Move down',          'nav_down'],
    ['← / h    Panel left',         'focus_left'],
    ['→ / l    Panel right',        'focus_right'],
    null,
  ];
  const panels = mpool.allPanesInColumns(arrange);
  for (const p of panels) {
    if (p.hotkey) items.push([`[${p.hotkey}]       ${esc(p.title)}`, `focus_panel:${p.hotkey}`]);
  }
  items.push(
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
    [':free-config  Edit layout + pool', 'free_config'],
    ['r        Refresh status',     'refresh'],
    ['?        Help in detail',     'show_help'],
    ['q        Quit',               'quit'],
  );
  return items;
}

module.exports = { buildItems };
