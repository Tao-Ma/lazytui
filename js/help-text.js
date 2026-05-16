/**
 * Per-context help text — Rich-marked-up lines describing the keys
 * available right now, derived from the focused panel + plugin
 * keyHints + collected `:` cmdline commands.
 *
 * Lives outside dispatch.js so the framework default `:help` command
 * (registered in plugins/api.js) can show help without dispatch
 * needing to import api back. dispatch.js's handleAction('show_help')
 * forwards to showHelp() here.
 *
 * Zero npm deps.
 */
'use strict';

const { S, allPanels, setDetail } = require('./state');
const { esc } = require('./ansi');
const { getCommands, getPanelDef } = require('./plugins/api');

/**
 * Build the help-text lines (Rich markup). Pure read of state +
 * plugin registry; doesn't paint.
 */
function helpLines() {
  const focusedPanel = allPanels().find(p => p.type === S.focus);
  const focusName = focusedPanel ? focusedPanel.title : 'TUI';
  const def = getPanelDef(S.focus);
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
    lines.push('', '[dim]Selection[/]',
      '  Space          Toggle multi-select on focused row',
      '  *              Select all visible',
      '  Esc            Clear multi-select',
    );
  }

  if (def && def.keyHints) {
    lines.push('', `[dim]Focused panel — ${esc(focusName)}[/]`,
      `  ${esc(def.keyHints)}`,
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
    '  :              Command mode',
    '  Enter          Activate terminal tab',
    `  Ctrl+\\         Exit terminal mode`,
    '  r              Refresh container status',
    '  ?              Show this help',
    '  q              Quit',
  );

  // Real plugin commands (skip dynamic theme×N / focus×N — those clutter
  // the help and are easier to discover via `:` cmdline anyway).
  const cmds = getCommands(S).filter(c =>
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
