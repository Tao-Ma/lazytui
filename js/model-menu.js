/**
 * Pure builder for the command-menu item list (the menu's sub-model).
 *
 * Extracted as a dependency-free leaf (imports only the ansi leaf for esc)
 * so runtime.update can build the menu inline on `menu_open` without a cycle
 * — menu.js imports runtime for the shim, so the reducer can't call back into
 * it (same rationale as model-groups / model-search).
 *
 * Each item is `[label, actionString]` or `null` (a separator). The action
 * strings are handleAction verbs (`nav_up`, `focus_panel:7`, `design`, …);
 * menu_activate routes the chosen one back through dispatch as a Cmd.
 */
'use strict';

const { esc } = require('./ansi');

function buildItems(model) {
  const items = [
    ['↑ / k    Move up',            'nav_up'],
    ['↓ / j    Move down',          'nav_down'],
    ['← / h    Panel left',         'focus_left'],
    ['→ / l    Panel right',        'focus_right'],
    null,
  ];
  // allPanels() lives in state.js (a cycle from here); the panel list is just
  // both layout columns, so read it off the model directly.
  const panels = [...model.layout.leftPanels, ...model.layout.rightPanels];
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
    ...(model.designEnabled ? [[':design  Design mode', 'design']] : []),
    ['r        Refresh status',     'refresh'],
    ['?        Help in detail',     'show_help'],
    ['q        Quit',               'quit'],
  );
  return items;
}

module.exports = { buildItems };
