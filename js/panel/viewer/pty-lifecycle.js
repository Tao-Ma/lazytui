/**
 * PTY-exit fan-out — the panel/viewer side effects that fire when a
 * shell session ends.
 *
 * Used to live inside `io/terminal.js#_onSessionExit` via lazy-requires
 * up to panel/viewer/tabs, panel/api, render/geometry — a layering
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
const { getModel } = require('../../model/store');
const { scheduleRender } = require('../../leaves/infra/render-queue');

// Injected dispatch host (set by install() from tui.js boot). handleExit is a
// boot-wired PTY-exit subscription — it holds dispatch the way a Hyperapp/Elmish
// subscription does, rather than importing the (relocating) fan-out upward.
// See docs/v0.6.5-dispatch-loop.md "formalize injection".
let _host = null;

function handleExit(id, exitCode) {
  // U2d — a `terminal` PANE (id == its tab-instance id, registered in the route
  // registry) exits via its own fan-out; the legacy viewer-content-tab ephemeral
  // (id == `${group}_${key}`, not an instance) falls through below (retired in
  // P3). getInstance is LITERAL, so a legacy id simply misses.
  const route = require('../../panel/route');
  const inst = route.getInstance(id);
  if (inst && inst.kind === 'terminal') { _handlePaneExit(id, exitCode, inst); return; }

  // v0.6.1 Phase 4 — resolve which viewer-kind instance hosts this
  // PTY session before reading per-pane state. For Phase 4 singleton
  // the answer is always 'detail'; Phase 5+ may have multiple viewer
  // panes each with their own ephemerals.
  const paneId = tabs.paneForSessionId(id) || 'detail';
  let anyChange = false;
  const wasActive = tabs.activeTerminalId(paneId) === id;
  const layoutSlice = api.getInstanceSlice('layout');
  // v0.6.3 P5.1 — clear terminalMode here when the user was actively
  // interacting with the just-exited PTY. Pre-P5 this fired via a
  // setImmediate from renderTerminalOverlay every render frame as a
  // poll; routing it through handleExit makes it event-driven and
  // closes one render-side dispatch (view → reducer impurity). Order:
  // dispatch BEFORE view_set so view_set's reducer sees terminalMode
  // already cleared (avoids the "drop full → normal while
  // terminalMode still true" intermediate state).
  if (wasActive && getModel().modes.terminalMode) {
    _host.applyMsg({ type: 'terminal_exit' });
    anyChange = true;
  }
  if (layoutSlice && layoutSlice.viewMode === 'full' && wasActive) {
    // view_set's reducer arm emits force_full_repaint on the full →
    // normal transition; the bare forceFullRepaint() that used to
    // follow here was a redundant double-invalidate (P5.5). For the
    // not-full case, the tab strip / viewer body changes show up as
    // different row text and the diff cache catches them naturally.
    _host.dispatchMsg(_host.wrap('layout', { type: 'view_set', mode: 'normal' }));
    anyChange = true;
  }
  if (exitCode === 0 && tabs.handleSessionCleanExit(id, paneId)) {
    anyChange = true;
  }
  if (anyChange) scheduleRender();
}

// U2d — exit fan-out for a `terminal` PANE (id == its tab-instance id). Mirror of
// the legacy body: clear terminalMode if the user was interacting with this
// (focused, active) terminal; drop a 'full' auto-zoom when the terminal's slot is
// focused; and on a CLEAN exit auto-close the tab via remove_tab (a non-zero exit
// stays so the code is readable — `x` dismisses it). The instance + PTY teardown
// then flows through reconcile's orphan-dispose (destroySession). `inst.paneId` is
// the owning COLUMN paneId (the back-ref stamped by reconcile).
function _handlePaneExit(id, exitCode, inst) {
  const route = require('../../panel/route');
  const mpane = require('../../leaves/wm/pane');
  const colPaneId = inst.paneId;
  const wasActive = colPaneId != null && route.activeInstanceOf(colPaneId) === id;
  const focused = colPaneId != null && route.getFocus() === colPaneId;
  let anyChange = false;
  if (wasActive && focused && getModel().modes.terminalMode) {
    _host.applyMsg({ type: 'terminal_exit' });
    anyChange = true;
  }
  const layoutSlice = api.getInstanceSlice('layout');
  if (layoutSlice && layoutSlice.viewMode === 'full' && focused) {
    _host.dispatchMsg(_host.wrap('layout', { type: 'view_set', mode: 'normal' }));
    anyChange = true;
  }
  if (exitCode === 0 && colPaneId != null) {
    _host.dispatchMsg(_host.wrap('layout',
      { type: 'remove_tab', paneId: colPaneId, tabPoolId: mpane.poolIdOf(id) }));
    anyChange = true;
  }
  if (anyChange) scheduleRender();
}

/** Boot wiring — called from tui.js after the panel layer is registered.
 *  Injects io/terminal.js's environment (it's a leaf — see its header):
 *  the exit fan-out, the post-output repaint hook (scheduleOverlay), and
 *  the jobs-registry adapter. */
function install(host) {
  _host = host;
  const term = require('../../io/terminal');
  term.setExitHandler(handleExit);
  term.setRenderHook(require('../../leaves/infra/render-queue').scheduleOverlay);
  term.setJobsHooks(require('../../feature/jobs'));
  // v0.6.6 replay arc — feed the terminal's off-model byte stream + lifecycle
  // into the session WAL (a near-no-op when recording is disabled, the default).
  term.setSessionRecorder(require('../../io/session-log').recordTerm);
}

module.exports = { handleExit, install };
