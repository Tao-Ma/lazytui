/**
 * PTY-exit fan-out — the panel/viewer side effects that fire when a
 * shell session ends.
 *
 * Used to live inside `io/terminal.js#_onSessionExit` via lazy-requires
 * up to panel/viewer/tabs, panel/api, render/layout — a layering
 * inversion (io is supposed to be a leaf). v0.6 inverts the dependency:
 * io/terminal.js takes an `setExitHandler(fn)` callback; this file
 * supplies the handler and tui.js wires it at boot.
 *
 * Two side effects:
 *   - If viewMode was 'full' AND this session was the active terminal
 *     tab, drop viewMode to 'normal' — user lands somewhere reachable
 *     instead of staring at an exited PTY (clean) or an unresponsive
 *     error screen (non-zero). 'half' is left alone (user-chosen).
 *   - On clean exit (exitCode === 0), auto-remove the ephemeral tab
 *     via `handleSessionCleanExit`. Non-zero stays put so the user can
 *     read the exit code; `x` closes it manually.
 *
 * When any state changed AND the exit was on the visible session, force
 * a full repaint — the PTY painted into cells the diff cache won't
 * touch, and dropping out of 'full' / closing the tab needs those cells
 * reclaimed by the chrome.
 */
'use strict';

const tabs = require('./tabs');
const api = require('../api');
const { scheduleRender } = require('../../render/render-queue');

function handleExit(id, exitCode) {
  let anyChange = false;
  const wasActive = tabs.activeTerminalId() === id;
  const layoutSlice = api.getComponentSlice('layout');
  if (layoutSlice && layoutSlice.viewMode === 'full' && wasActive) {
    api.dispatchMsg(api.wrap('layout', { type: 'view_set', mode: 'normal' }));
    anyChange = true;
  }
  if (exitCode === 0 && tabs.handleSessionCleanExit(id)) {
    anyChange = true;
  }
  if (anyChange) {
    if (wasActive) {
      const { forceFullRepaint } = require('../../render/layout');
      forceFullRepaint();
    }
    scheduleRender();
  }
}

/** Boot wiring — called from tui.js after the panel layer is
 *  registered. Installs `handleExit` as io/terminal.js's exit handler. */
function install() {
  require('../../io/terminal').setExitHandler(handleExit);
}

module.exports = { handleExit, install };
