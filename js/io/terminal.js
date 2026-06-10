/**
 * Terminal session management — PTY + xterm-headless per session.
 * Owns lifecycle (spawn / resize / kill / restart), input routing,
 * and screen buffer reads. No tab-arithmetic, no panel/api or
 * render/geometry knowledge — those live in higher layers and reach
 * THIS module, never the reverse.
 *
 * The PTY-exit fan-out (active-tab check, viewMode 'full' drop,
 * ephemeral-tab cleanup, force-full-repaint) used to be inlined here
 * via lazy-requires up to panel/viewer/tabs, panel/api, render/geometry
 * — a documented layering inversion. v0.6 routes those side effects
 * through a registered handler (`setExitHandler`) wired at boot from
 * panel/viewer/pty-lifecycle.js. io/terminal.js stays a true leaf;
 * if no handler is registered (tests / scripts that don't bring up
 * the full panel layer), PTY exits silently update session state.
 */
'use strict';

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');
const { getModel } = require('../app/runtime');
const { scheduleOverlay } = require('../render/render-queue');
const jobs = require('../feature/jobs');

const sessions = {};  // id -> { pty, xterm, cmd, exited, exitCode }

let _exitHandler = null;

/** Wire a fan-out handler invoked after each PTY session exit. Receives
 *  `(id, exitCode)`. Called once at boot from a higher layer; the io
 *  module itself stays a leaf. Idempotent on re-registration so test
 *  setup can swap handlers between runs. */
function setExitHandler(fn) { _exitHandler = (typeof fn === 'function') ? fn : null; }

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
    cwd: getModel().projectDir,
    env: process.env,
  });
  // Declare `session` BEFORE registering `p.onData` so the closure's
  // `session.exited` read can't TDZ-throw if node-pty ever emits a
  // synchronous data chunk during spawn (today it doesn't, but a
  // future change would surface the latent hazard). Sub field gets
  // filled in immediately after subscription.
  const session = { pty: p, xterm, cmd, exited: false, exitCode: null, _onDataSub: null };
  // Event-driven overlay refresh — render right after xterm finishes
  // parsing PTY output, so keystroke echo appears within ~16ms instead
  // of waiting for the polling tick. The write() callback fires after
  // each parse completes.
  // T17 — node-pty's onData returns a disposable. We hold it on the
  // session so destroySession can dispose the listener BEFORE
  // xterm.dispose(); otherwise an in-flight data chunk could fire
  // xterm.write on a disposed Terminal (undefined behavior in
  // @xterm/headless — likely throws and unwinds out of node-pty's
  // emitter).
  session._onDataSub = p.onData(data => {
    if (session.exited) return;  // belt-and-braces: also drop if exited
    xterm.write(data, () => scheduleOverlay());
  });
  p.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    if (session.jobId) {
      jobs.close(session.jobId, { status: 'exited', exitCode });
      session.jobId = null;
    }
    _onSessionExit(id, exitCode);
  });
  session.jobId = jobs.register({
    kind: 'pty',
    label: cmd,
    pid: p.pid,
    owner: { ptyId: id, cmd },
  });
  sessions[id] = session;
  return session;
}

/** Invoke the registered exit handler (if any). Lifted out of the
 *  onExit closure so tests can drive it without spinning a real PTY. */
function _onSessionExit(id, exitCode) {
  if (_exitHandler) {
    try { _exitHandler(id, exitCode); }
    catch (e) { console.error(`[terminal] exit handler threw: ${e.message}`); }
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
  // T17 — dispose the onData listener BEFORE xterm.dispose() so a
  // chunk in flight (kernel-buffered between SIGTERM and pipe close)
  // can't call xterm.write on a disposed Terminal.
  if (s._onDataSub) { try { s._onDataSub.dispose(); } catch {} s._onDataSub = null; }
  if (!s.exited) try { s.pty.kill(); } catch {}
  if (s.jobId) {
    jobs.close(s.jobId, { status: 'killed' });
    s.jobId = null;
  }
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
  setExitHandler,
  _onSessionExit,  // exported for tests (invokes the registered handler)
};
