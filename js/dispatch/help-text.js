/**
 * Per-context help text — Rich-marked-up lines describing the keys
 * available right now, derived from the focused panel + plugin
 * keyHints + collected `:` cmdline commands.
 *
 * Lives outside dispatch.js so the framework default `:help` command
 * (registered in panel/api.js) can show help without dispatch
 * needing to import api back. dispatch.js's handleAction('show_help')
 * forwards to showHelp() here.
 *
 * Zero npm deps.
 */
'use strict';

const { allPanels, setDetail } = require('../app/state');
const { getModel } = require('../app/runtime');
const { esc } = require('../io/ansi');
const {getCommands, getPanelDef, getComponentSlice, getFocus } = require('../panel/api');

/**
 * Build the help-text lines (Rich markup). Pure read of state +
 * plugin registry; doesn't paint.
 */
function helpLines() {
  const focusedPanel = allPanels().find(p => p.type === getFocus());
  const focusName = focusedPanel ? focusedPanel.title : 'TUI';
  const def = getPanelDef(getFocus());
  const isList = !!(def && typeof def.getItems === 'function');

  const lines = [
    `[bold]Keybindings — ${esc(focusName)}[/]`, '',
    '[dim]Navigation[/]',
    '  ↑/k  ↓/j      Navigate within panel',
    '  ←/h  →/l      Switch panel',
    '  , .            Page up / down in focused panel (or PgUp/PgDn)',
    '  < >            Top / bottom of focused panel',
  ];

  if (isList) {
    lines.push('', '[dim]Selection (v-mode)[/]',
      '  v              Enter/exit list-select mode',
      '  Space          Toggle row (in select mode) — else it is the leader',
      '  *              Select all visible (enters select mode)',
      '  Esc            Exit select mode / clear selection',
    );
  }

  lines.push('', '[dim]Leader (prefix key)[/]',
    '  Space          Open the leader namespace (outside v-mode)',
    '  Space ?        Help    ·  Space r  Refresh',
    '  Space g g      Top     ·  Space g e  Bottom',
    '  Esc            Cancel a pending leader sequence',
  );

  if (def && def.keyHints) {
    lines.push('', `[dim]Focused panel — ${esc(focusName)}[/]`,
      `  ${esc(def.keyHints)}`,
    );
  }

  if (getFocus() === 'detail') {
    lines.push('', '[dim]Detail panel — reading mode[/]',
      '  j / k / arrows Scroll view ±1 line',
      '  , .            Half-page up / down',
      '  < >            Top / bottom',
      '  wheel          Scroll panel under cursor (any panel, any time)',
      '',
      '[dim]Detail panel — search (vim-style regex, case-insensitive)[/]',
      '  /              Open search input',
      '  type           Live regex match; matches highlight in yellow',
      '  ↑ ↓ (typing)   Step prev / next match while still typing',
      '  Enter          Commit search; highlights stay',
      '  n / N          Next / prev match (committed)',
      '  Esc            Cancel typing; or clear committed search',
      '',
      '[dim]Detail panel — visual mode (selection)[/]',
      '  v              Start char-select at top of viewport',
      '  V              Start line-select at top of viewport',
      '  j / k / h / l  Move cursor (extends selection + autoscroll)',
      '  0 / $          Line start / end',
      '  y              Yank selection → register + clipboard',
      '  Esc            Cancel selection',
      '  click + drag   Mouse-drag selection (release to commit)',
    );
  }

  lines.push('', '[dim]Actions[/]',
    '  Enter          Run selected action',
    '  x              Open menu popup',
    `  ${esc('[')}  ${esc(']')}           Cycle detail tabs`,
    '  +              Expand view (normal→half→full)',
    '  _              Shrink view (full→half→normal)',
    '  /              Filter panel items',
    '  y              Copy menu (pick what to copy)',
    '  "              Yank-register history popup',
    '  :              Command mode',
    '  :show-hidden   Toggle dotfile visibility in file-browser panels',
    '  Enter          Activate terminal tab',
    `  Ctrl+\\         Exit terminal mode`,
    '  r              Refresh container status',
    '  ?              Show this help',
    '  q              Quit',
  );

  // Real plugin commands (skip dynamic theme×N / focus×N — those clutter
  // the help and are easier to discover via `:` cmdline anyway).
  const cmds = getCommands().filter(c =>
    !c.name.startsWith('theme ') && !c.name.startsWith('focus '));
  if (cmds.length) {
    lines.push('', '[dim]Command mode (`:`)[/]');
    for (const c of cmds) {
      const left = `:${c.name}`.padEnd(15);
      lines.push(`  ${esc(left)} ${esc(c.desc || '')}`);
    }
  }

  lines.push('', '[dim]Panels[/]');
  for (const p of allPanels()) {
    if (p.hotkey) lines.push(`  ${esc(`[${p.hotkey}]`)} ${esc(p.title)}`);
  }
  return lines;
}

/** Build help lines and dump them into the detail panel. */
function showHelp() {
  setDetail(helpLines().join('\n'));
}

module.exports = { helpLines, showHelp };
