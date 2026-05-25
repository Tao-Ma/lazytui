/**
 * Terminal session management — PTY + xterm-headless per session.
 * Owns lifecycle (spawn / resize / kill / restart), input routing,
 * and screen buffer reads. No tab-arithmetic knowledge — that lives
 * in `./tabs`.
 *
 * Lazy-requires `./tabs` inside the PTY onExit handler so an
 * ephemeral tab can be cleaned up on its shell's clean exit (`exit 0`)
 * without forming a top-level cycle: tabs.js requires terminal.js for
 * destroySession, and terminal.js → tabs.js only fires when a real
 * PTY exit happens (after both modules are fully loaded).
 */
'use strict';

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { S } = require('./state');
const { scheduleOverlay, scheduleRender } = require('./render-queue');

const sessions = {};  // id -> { pty, xterm, cmd, exited, exitCode }

/**
 * Create or return existing session. Lazy — created on first access
 * (first render of the active terminal tab).
 */
function ensureSession(id, cmd, cols, rows) {
  if (sessions[id]) return sessions[id];
  const xterm = new Terminal({ cols, rows, allowProposedApi: true });
  const shell = process.env.SHELL || '/bin/bash';
  const p = pty.spawn(shell, ['-c', cmd], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: S.projectDir,
    env: process.env,
  });
  // Event-driven overlay refresh — render right after xterm finishes
  // parsing PTY output, so keystroke echo appears within ~16ms instead
  // of waiting for the polling tick. The write() callback fires after
  // each parse completes.
  p.onData(data => {
    xterm.write(data, () => scheduleOverlay());
  });
  const session = { pty: p, xterm, cmd, exited: false, exitCode: null };
  p.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    _onSessionExit(id, exitCode);
  });
  sessions[id] = session;
  return session;
}

/**
 * Handle a session's PTY exit. Extracted from the onExit closure
 * so tests can drive it directly without mocking node-pty.
 *
 * Two side effects, both lazy-requiring `./tabs` to avoid the
 * tabs.js ↔ terminal.js cycle at module load:
 * - If viewMode was 'full' and this session was the active terminal
 *   tab, drop viewMode to 'normal' — user lands somewhere reachable
 *   instead of staring at an exited PTY (clean) or an unresponsive
 *   error screen (non-zero). 'half' is left alone (user-chosen).
 * - On clean exit (exitCode === 0), auto-remove the ephemeral tab
 *   via handleSessionCleanExit. Non-zero stays put so the user
 *   can read the exit code; `x` closes it.
 */
function _onSessionExit(id, exitCode) {
  const tabs = require('./tabs');
  let anyChange = false;
  const wasActive = tabs.activeTerminalId() === id;
  if (S.viewMode === 'full' && wasActive) {
    S.viewMode = 'normal';
    anyChange = true;
  }
  if (exitCode === 0 && tabs.handleSessionCleanExit(id)) {
    anyChange = true;
  }
  if (anyChange) {
    // If the exiting session was the user-visible one, the PTY
    // had painted into cells the diff cache won't think to
    // repaint — viewMode dropping back to 'normal' (or the tab
    // going away on clean exit) means the underlying panel
    // renderer needs to reclaim those cells. Without this,
    // SIGQUIT'd children leave their last frame stuck on screen
    // while the chrome behind doesn't redraw. Same pattern as
    // the SIGCONT path in suspend.js.
    if (wasActive) {
      const { forceFullRepaint } = require('./layout');
      forceFullRepaint();
    }
    scheduleRender();
  }
}

/** Get an existing session by ID, or null. */
function getSession(id) {
  return sessions[id] || null;
}

/** Write data (keystrokes) to a session's PTY. */
function writeToSession(id, data) {
  const s = sessions[id];
  if (s && !s.exited) s.pty.write(data);
}

/** Resize a session's PTY and xterm. */
function resizeSession(id, cols, rows) {
  const s = sessions[id];
  if (!s) return;
  try { s.pty.resize(cols, rows); } catch {}
  s.xterm.resize(cols, rows);
  // Truncate diff cache rows that no longer fit (free memory on shrink)
  if (s.prevFrame && s.prevFrame.length > rows) s.prevFrame.length = rows;
}

/** Destroy a single session. No-op if id doesn't exist. */
function destroySession(id) {
  const s = sessions[id];
  if (!s) return;
  if (!s.exited) try { s.pty.kill(); } catch {}
  s.xterm.dispose();
  delete sessions[id];
}

/** Destroy all sessions (cleanup on TUI exit). */
function destroyAll() {
  for (const id of Object.keys(sessions)) {
    destroySession(id);
  }
}

/** Restart a session — kill old, spawn fresh with same cmd. */
function restartSession(id, cols, rows) {
  const old = sessions[id];
  if (!old) return null;
  const cmd = old.cmd;
  destroySession(id);
  return ensureSession(id, cmd, cols, rows);
}

/** Has the session exited? */
function isSessionDead(id) {
  const s = sessions[id];
  return !!(s && s.exited);
}

module.exports = {
  ensureSession, getSession, writeToSession,
  resizeSession, destroySession, destroyAll,
  restartSession, isSessionDead,
  _onSessionExit,  // exported for tests
};
