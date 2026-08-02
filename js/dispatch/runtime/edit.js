/**
 * Edit-in-editor — launch the user's editor on a file, riding the SAME
 * embedded-PTY spawn seam as `type:spawn` actions (docs/global-config §editor):
 * mint a `terminal` tab into the content slot, focus + auto-zoom to 'full',
 * and let the existing exit fan-out return the user on quit (exit-0
 * auto-closes the tab and drops the zoom — panel/content/pty-lifecycle.js).
 *
 * Editor resolution: merged config `editor:` (project wins over global,
 * parser/global.js) → $VISUAL → $EDITOR → vi.
 *
 * The minted tab's config carries a SERIALIZABLE `onExit` descriptor
 * (`{ kind:'edit', path, isConfig }`, the E14 continuation shape) that the
 * exit fan-out realizes on a clean exit: refresh an open doc tab showing the
 * file, and print the restart hint after a config edit (no live reload —
 * deliberate, 2026-08-02).
 *
 * Under tmux the spawn goes to a `tmux new-window` we don't own — the editor
 * works, the continuation doesn't fire (same fork as action-runner's spawn).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { getModel } = require('../../model/store');

function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** The editor command string — merged config editor: → $VISUAL → $EDITOR → vi. */
function resolveEditor(config, env) {
  env = env || process.env;
  return (config && config.editor) || env.VISUAL || env.EDITOR || 'vi';
}

// A commented skeleton for a first-run global config (docs/global-config.md).
const GLOBAL_SKELETON = `# lazytui global config — app-behavior preferences for EVERY project.
# Honored sections: theme, keys, keymap, mouse, context-menu, selection, editor.
# A project's own config wins per key; project content (groups, layout, …)
# does not belong here. See docs/global-config.md.

# theme: nord
# editor: nvim            # else $VISUAL / $EDITOR / vi
# selection: true
# keymap:
#   normal:
#     G: cursor_bottom
# mouse:
#   right-click: context
`;

/**
 * Open `filepath` (absolute, or resolved against projectDir) in the editor.
 * `opts.isConfig` forces the restart-hint continuation; editing the project
 * or global config file by path gets it automatically.
 */
function editFile(filepath, opts) {
  opts = opts || {};
  const m = getModel();
  const base = m.projectDir || process.cwd();
  const abs = path.isAbsolute(filepath) ? filepath : path.resolve(base, filepath);
  const editor = resolveEditor(m.config, process.env);
  const cmd = `${editor} ${shQuote(abs)}`;
  const name = path.basename(abs);
  const globalPath = require('../../parser/global').globalConfigPath(process.env);
  const isConfig = Boolean(opts.isConfig || abs === m.configPath || (globalPath && abs === globalPath));

  const { appendViewerLines } = require('../../panel/nav-state');
  if (require('./action-runner')._spawnUsesTmux()) {
    appendViewerLines(`[dim]$ ${cmd}[/]\n[yellow]Editor opened in a new tmux window.[/]`
      + (isConfig ? '\n[yellow]Config changes apply on the next lazytui start.[/]' : ''));
    spawn('tmux', ['new-window', '-n', `edit:${name}`, cmd], { detached: true, stdio: 'ignore' });
    return;
  }

  const route = require('../../panel/route');
  const { getInstanceSlice } = require('../../panel/api');
  const container = route.resolveViewerPaneId()
    || (getInstanceSlice('layout') || {}).focus;
  if (!container) {
    appendViewerLines('[red]edit: no pane to open the editor in[/]');
    return;
  }
  const { dispatchMsg } = require('./loop');
  const { applyMsg } = require('../control/dispatch');
  const wrap = route.wrap;
  dispatchMsg(wrap('layout', {
    type: 'mint_tab', paneId: container, paneType: 'terminal', idPrefix: 'term',
    title: `✎ ${name}`,
    config: { cmd, label: `edit ${name}`, onExit: { kind: 'edit', path: abs, isConfig } },
    hint: { origin: 'edit', key: abs },
  }));
  dispatchMsg(wrap('layout', { type: 'focus_set', focus: container }));
  dispatchMsg(wrap('layout', { type: 'view_set', mode: 'full' }));
  applyMsg({ type: 'terminal_enter' });
}

/**
 * `:config [global]` — edit the project config, or the global user config
 * (created with a commented skeleton on first use).
 */
function editConfig(which) {
  const { appendViewerLines } = require('../../panel/nav-state');
  if (which === 'global') {
    const p = require('../../parser/global').globalConfigPath(process.env);
    if (!p) {
      appendViewerLines('[red]:config global — the global config is disabled (LAZYTUI_GLOBAL_CONFIG=\'\')[/]');
      return;
    }
    if (!fs.existsSync(p)) {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, GLOBAL_SKELETON);
    }
    editFile(p, { isConfig: true });
    return;
  }
  const cp = getModel().configPath;
  if (!cp) {
    appendViewerLines('[red]:config — no config file loaded[/]');
    return;
  }
  editFile(cp, { isConfig: true });
}

module.exports = { resolveEditor, editFile, editConfig };
