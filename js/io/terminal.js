/**
 * Terminal session management — PTY + xterm-headless per session.
 * Owns lifecycle (spawn / resize / kill / restart), input routing,
 * scrollback, and screen buffer reads. No tab-arithmetic, no app model,
 * no panel/api, no render or jobs knowledge — those live in higher
 * layers and reach THIS module, never the reverse. It is a true leaf:
 * its only requires are node-pty + @xterm/headless.
 *
 * #D14 — this is the reference FOREIGN COMPONENT: an explicitly non-TEA region,
 * by design, implementing the foreign-component contract (docs/foreign-components.md
 * — read it before adding another). The terminal's screen state lives in the
 * @xterm/headless buffer (this module, an isolated "island"), NOT in the TEA
 * model: PTY `onData` writes the off-model buffer and triggers a
 * repaint via the injected `_renderHook` directly, bypassing the Msg loop —
 * because xterm.js IS the terminal emulator and funnelling every PTY byte
 * through a Msg into the model would be heavy and redundant. The model holds the
 * terminal pane's LIFECYCLE (which tab, which cmd, placed/active); xterm holds
 * its CONTENTS. Consequence (bounded + documented): replaying the Msg log
 * reconstructs the model but NOT the terminal screen — see model/store.js
 * §Replayability boundary (#D5). The overlay's repaint is fully event-driven
 * (no wall-clock poll — #D15): `_renderHook` on write, dispatch render otherwise.
 *
 * Everything it needs FROM higher layers is injected at boot from
 * panel/viewer/pty-lifecycle.install (each unset = the effect is skipped,
 * so the module runs standalone in tests/scripts):
 *   - `setExitHandler(fn)` — the PTY-exit fan-out (active-tab check,
 *     viewMode 'full' drop, ephemeral-tab cleanup, force-full-repaint).
 *     Used to be inlined here via lazy-requires up to panel/viewer/tabs,
 *     panel/api, render/geometry — a documented inversion, inverted in v0.6.
 *   - `setRenderHook(fn)` — repaint after the PTY writes (scheduleOverlay).
 *   - `setJobsHooks({register, close})` — the jobs-registry adapter.
 * The spawn cwd rides in as an `ensureSession(..., cwd)` argument (the
 * caller passes model.projectDir); v0.6.5 §2 dropped the former direct
 * reaches into app/runtime, render/render-queue, and feature/jobs.
 */
'use strict';

const pty = require('node-pty');
const { Terminal } = require('@xterm/headless');

const sessions = {};  // id -> { pty, xterm, cmd, cwd, exited, exitCode, jobId }

// --- Injected environment (v0.6.5 §2) ------------------------------------
//
// io/terminal.js is a true leaf: it owns the PTY + xterm handles and knows
// nothing about the app model, the render queue, or the job registry. The
// three things it needs from higher layers are injected at boot (from
// panel/viewer/pty-lifecycle.install), mirroring `setExitHandler` — and the
// spawn cwd rides in as an ensureSession argument. When a hook is unset
// (tests / scripts that don't bring up the full stack) the corresponding
// effect is simply skipped, so the module still functions standalone.
let _exitHandler = null;   // (id, exitCode) → panel-side exit fan-out
let _renderHook = null;    // () → repaint after the PTY writes (scheduleOverlay)
let _jobs = null;          // { register, close } → jobs-registry adapter

/** Wire a fan-out handler invoked after each PTY session exit. Receives
 *  `(id, exitCode)`. Called once at boot from a higher layer; the io
 *  module itself stays a leaf. Idempotent on re-registration so test
 *  setup can swap handlers between runs. */
function setExitHandler(fn) { _exitHandler = (typeof fn === 'function') ? fn : null; }

/** Wire the post-output repaint hook (production: render-queue
 *  `scheduleOverlay`). Called once at boot; idempotent on re-registration. */
function setRenderHook(fn) { _renderHook = (typeof fn === 'function') ? fn : null; }

/** Wire the jobs-registry adapter — an object with `register({kind,label,
 *  pid,owner}) → id` and `close(id, {status,exitCode})`. Called once at
 *  boot; without it, sessions run without job tracking. */
function setJobsHooks(j) {
  _jobs = (j && typeof j.register === 'function' && typeof j.close === 'function') ? j : null;
}

/**
 * Create or return existing session. Lazy — created on first access
 * (first render of the active terminal tab).
 */
function ensureSession(id, cmd, cols, rows, cwd) {
  if (sessions[id]) return sessions[id];
  const xterm = new Terminal({ cols, rows, allowProposedApi: true });
  const shell = process.env.SHELL || '/bin/bash';
  // cwd is injected by the caller (the spawn directory = model.projectDir);
  // io/terminal.js does not read the app model. Defaults to '.' (matching
  // the old getModel().projectDir default) when unset.
  const spawnCwd = cwd || '.';
  const p = pty.spawn(shell, ['-c', cmd], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: spawnCwd,
    env: process.env,
  });
  // Declare `session` BEFORE registering `p.onData` so the closure's
  // `session.exited` read can't TDZ-throw if node-pty ever emits a
  // synchronous data chunk during spawn (today it doesn't, but a
  // future change would surface the latent hazard). Sub field gets
  // filled in immediately after subscription.
  const session = { pty: p, xterm, cmd, cwd: spawnCwd, exited: false, exitCode: null, _onDataSub: null };
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
    xterm.write(data, () => { if (_renderHook) _renderHook(); });
  });
  p.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    if (session.jobId && _jobs) {
      _jobs.close(session.jobId, { status: 'exited', exitCode });
      session.jobId = null;
    }
    _onSessionExit(id, exitCode);
  });
  session.jobId = _jobs ? _jobs.register({
    kind: 'pty',
    label: cmd,
    pid: p.pid,
    owner: { ptyId: id, cmd },
  }) : null;
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
  if (s.jobId && _jobs) {
    _jobs.close(s.jobId, { status: 'killed' });
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
  const cwd = old.cwd;
  destroySession(id);
  return ensureSession(id, cmd, cols, rows, cwd);
}

/** Has the session exited? */
function isSessionDead(id) {
  const s = sessions[id];
  return !!(s && s.exited);
}

// --- Scrollback (v0.6.5 §5(a)) -------------------------------------------
//
// The xterm buffer keeps a scrollback ring; `scrollLines`/`scrollPages`
// move its own viewport (`buffer.active.viewportY`), which the overlay
// render already reads. Scroll state lives on the session (out of TEA,
// like the buffer content itself) — these are direct effects, the same
// category as writeToSession. Each returns whether the viewport actually
// moved so the caller can gate its repaint. Writing new PTY output while
// scrolled up is sticky in xterm (baseY grows, viewportY stays), so the
// view holds until the user returns to the bottom.

/** Scroll a session's viewport by `amount` lines (negative = back into
 *  scrollback, positive = toward the live bottom). */
function scrollSession(id, amount) {
  const s = sessions[id];
  if (!s) return false;
  const before = s.xterm.buffer.active.viewportY;
  s.xterm.scrollLines(amount | 0);
  return s.xterm.buffer.active.viewportY !== before;
}

/** Scroll a session's viewport by `n` pages (negative = back). */
function scrollSessionPages(id, n) {
  const s = sessions[id];
  if (!s) return false;
  const before = s.xterm.buffer.active.viewportY;
  s.xterm.scrollPages(n | 0);
  return s.xterm.buffer.active.viewportY !== before;
}

/** Snap a session's viewport to the top of scrollback. */
function scrollSessionToTop(id) {
  const s = sessions[id];
  if (!s) return false;
  const before = s.xterm.buffer.active.viewportY;
  s.xterm.scrollToTop();
  return s.xterm.buffer.active.viewportY !== before;
}

/** Snap a session's viewport to the live bottom (resume following output). */
function scrollSessionToBottom(id) {
  const s = sessions[id];
  if (!s) return false;
  const before = s.xterm.buffer.active.viewportY;
  s.xterm.scrollToBottom();
  return s.xterm.buffer.active.viewportY !== before;
}

/** The child's DEC mouse-tracking mode: 'none' when it hasn't enabled
 *  mouse reporting (the framework owns the wheel for scrollback), else
 *  one of x10/vt200/drag/any (forward mouse bytes raw to the child). */
function sessionMouseMode(id) {
  const s = sessions[id];
  return s ? s.xterm.modes.mouseTrackingMode : 'none';
}

/** Scroll position: { atBottom, linesBelow } — linesBelow is how many
 *  rows the viewport sits above the live bottom (0 = following). */
function sessionScrollInfo(id) {
  const s = sessions[id];
  if (!s) return { atBottom: true, linesBelow: 0 };
  const buf = s.xterm.buffer.active;
  const linesBelow = Math.max(0, buf.baseY - buf.viewportY);
  return { atBottom: linesBelow === 0, linesBelow };
}

module.exports = {
  ensureSession, getSession, writeToSession,
  resizeSession, destroySession, destroyAll,
  restartSession, isSessionDead,
  setExitHandler, setRenderHook, setJobsHooks,
  // v0.6.5 §5(a) — scrollback effects.
  scrollSession, scrollSessionPages, scrollSessionToTop, scrollSessionToBottom,
  sessionMouseMode, sessionScrollInfo,
  _onSessionExit,  // exported for tests (invokes the registered handler)
  // Test-only: inject a session (a `{ xterm }` with a headless Terminal)
  // so the scrollback effects can be exercised without spawning a PTY.
  _setSessionForTest(id, session) { sessions[id] = session; },
};
