/**
 * Per-context help text — Rich-marked-up lines describing the keys
 * available right now, derived from the focused panel + plugin
 * keyHints + collected `:` cmdline commands.
 *
 * v0.6.2 N7 — moved from dispatch/ to overlay/. The file builds
 * viewer-bound content (setViewerContent(null, helpLines)) — a
 * render-side content producer, not a Msg dispatcher. Peer to
 * overlay/which-key.js (the leader-chord popup, another
 * help-flavored content surface). Pre-N7 the file was in dispatch/
 * "to dodge an api → dispatch → api cycle"; that's no longer a
 * concern because the file doesn't reach into dispatch/ at all
 * (only panel/nav-state, model/store, leaves/ansi, panel/api, leaves/pane,
 * panel/route, and the leaves/keybindings registry for chord enumeration).
 *
 * Zero npm deps.
 */
'use strict';

const { allPanels, setViewerContent } = require('../panel/nav-state');
const { getModel } = require('../model/store');
const { esc } = require('../leaves/text/ansi');
const {getCommands, getPanelDef, getInstanceSlice, getFocus, instanceKind } = require('../panel/api');
const kb = require('../leaves/input/keybindings');
const mpane = require('../leaves/wm/pane');
const route = require('../panel/route');

/** Walk the leader-tree depth-first, emitting `{seq, label}` for every
 *  LEAF (the actual bindings). Subtrees recurse; their internal labels
 *  are display-only (the popup uses them) — leaves carry the run target.
 *  Replaces the hand-rolled "Space ? / Space r / Space g g / …" stanza
 *  in helpLines() so a new chord registered via `keys:` YAML or by a
 *  Component shows up in help without a parallel edit. */
function _walkLeader(node, prefix, out) {
  for (const [tok, child] of kb.continuations(node)) {
    const seq = prefix.concat(tok);
    if (child.children) _walkLeader(child, seq, out);
    else out.push({ seq, label: child.label || `(${seq.join(' ')})` });
  }
}
function _leaderChordLines() {
  const items = [];
  _walkLeader(kb.rootNode(), [], items);
  if (items.length === 0) return [];
  return items.map(({ seq, label }) => {
    const left = `Space ${seq.join(' ')}`;
    const padded = left.length >= 15 ? left : left + ' '.repeat(15 - left.length);
    return `  ${padded} ${esc(label)}`;
  });
}

/**
 * Build the help-text lines (Rich markup). Pure read of state +
 * plugin registry; doesn't paint.
 */
function helpLines() {
  // v0.6.3 B3 — getFocus() is a paneId; resolve to the underlying
  // pane + its type so getPanelDef (keyed by panel-type) still hits.
  const focusedPanel = allPanels().find(p => mpane.paneMatchesFocus(p, getFocus()));
  const focusName = focusedPanel ? focusedPanel.title : 'TUI';
  const def = getPanelDef(focusedPanel ? focusedPanel.type : route.instanceKind(getFocus()));
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
    '  Esc            Cancel a pending leader sequence',
  );
  // Dynamic chord list — derived from the live keybinding registry so
  // user-declared `keys:` bindings AND chords from Components show up
  // here without a parallel edit to this file.
  lines.push(..._leaderChordLines());

  if (def && def.keyHints) {
    lines.push('', `[dim]Focused panel — ${esc(focusName)}[/]`,
      `  ${esc(def.keyHints)}`,
    );
  }

  if (instanceKind(getFocus()) === 'detail') {
    lines.push('', '[dim]Detail panel — reading mode[/]',
      '  j / k / arrows Scroll view ±1 line',
      '  , .            Page up / down',
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

/** Build help lines and dump them into the focused viewer. */
function showHelp() {
  setViewerContent(null, helpLines().join('\n'));
}

module.exports = { helpLines, showHelp };
