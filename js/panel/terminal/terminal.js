/**
 * terminal — the embedded PTY as a first-class pane type (U2d,
 * docs/one-tab-system.md). Minted into a slot's `tabs[]` at runtime (the
 * mint-into-slot primitive, like `text-view`); its config carries the shell
 * command to run.
 *
 * The PTY is a FOREIGN component (docs/foreign-components.md): the live xterm
 * grid lives in the io/terminal session store, NEVER in this slice, and is
 * painted by the terminal OVERLAY (render/paint.js#renderTerminalOverlay) over
 * this pane's inner bounds — render() here draws only the chrome (border +
 * title), exactly as the viewer's terminal-tab branch did. So the reducer holds
 * only foreign metadata (cmd/label); there are no content arms. The session's
 * lifecycle (lazy spawn + resize to the committed pane geometry) is reconciled
 * in the dispatch finalizer, keyed by this instance's id (== the PTY id), and
 * keystrokes are forwarded straight to the PTY (dispatch/control/input.js).
 */
'use strict';

const { renderPanel } = require('../api');

function init(paneId, seed) {
  const cfg = (seed && seed.paneDef && seed.paneDef.config) || {};
  return {
    // Self-identity: the COLUMN paneId (for geometry / bounds). The PTY session
    // id is this tab-instance's own id (== `pane-<poolId>`), derived where
    // needed (finalizer / overlay / input) — not stored here.
    paneId: paneId || null,
    cmd: cfg.cmd || process.env.SHELL || '/bin/bash',
    label: cfg.label || 'terminal',
    // Serializable spawn continuation (dispatch/runtime/edit.js): realized by
    // the exit fan-out on a clean exit. null for plain terminals.
    onExit: cfg.onExit || null,
  };
}

// The grid is foreign (read live by the overlay), so there is no reducer-managed
// content state to update. Kept as an explicit no-op for the Component contract.
function update(_msg, slice) { return slice; }

// U2e P1b parity (user-found 2026-08-05): in a MULTI-tab content slot the title
// is the slot's UNIFIED position-tab strip — info/text-view/agent all do this,
// but the terminal pane kept its plain pane title, so the moment a shell tab
// went active the Info/Transcript tabs VANISHED from the border (no way to see
// or click back to them while the shell ran). Single-tab → plain title.
function _slotTitle(panel) {
  const strip = require('../slot-strip').unifiedSlotStrip(panel);
  return strip ? strip.title : (panel && panel.title);
}

// Paint ONLY the chrome; the overlay fills the interior with the live PTY grid
// (empty `lines` — the interior is painted by renderTerminalOverlay). When the
// OPTIONAL node-pty dependency isn't installed, no session ever spawns and the
// overlay skips this pane (null session) — so draw a notice in the body instead
// of leaving a blank box (the overlay won't overwrite it: there's no session).
function render(panel, w, h, slice, opts) {
  const lines = require('../../io/terminal').ptyAvailable() ? [] : [
    '',
    '  [dim]Terminal unavailable[/]',
    '',
    '  [dim]the optional node-pty dependency is not installed[/]',
    '  [dim](reinstall on a platform with a prebuild, or with build tools)[/]',
  ];
  return renderPanel({
    width: w, height: h, lines,
    title: _slotTitle(panel), hotkey: panel.hotkey,
    panelType: 'terminal',
    focused: !!(opts && opts.focused),
    chrome: opts && opts.chrome,
  });
}

module.exports = {
  name: 'terminal',
  init,
  update,
  panelTypes: { terminal: { render } },
};
