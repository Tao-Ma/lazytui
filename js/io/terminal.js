/**
 * Terminal session management — PTY + an emulator screen per session.
 * Owns lifecycle (spawn / resize / kill / restart), input routing,
 * scrollback, and screen reads. No tab-arithmetic, no app model,
 * no panel/api, no render or jobs knowledge — those live in higher
 * layers and reach THIS module, never the reverse. Its only requires are
 * node-pty + the emulator screen PORT (`io/term-screen`), which is the one
 * module that knows the concrete emulator (xterm). Swapping the emulator =
 * reimplement that adapter; this file is unchanged.
 *
 * #D14 — this is the reference FOREIGN COMPONENT: an explicitly non-TEA region,
 * by design, implementing the foreign-component contract (docs/foreign-components.md
 * — read it before adding another). The terminal's screen state lives in the
 * emulator buffer (behind io/term-screen), NOT in the TEA model: PTY `onData`
 * writes the off-model screen and triggers a repaint via the injected
 * `_renderHook` directly, bypassing the Msg loop — because the emulator IS the
 * terminal and funnelling every PTY byte through a Msg into the model would be
 * heavy and redundant. The model holds the terminal pane's LIFECYCLE (which tab,
 * which cmd, placed/active); the emulator holds its CONTENTS.
 *
 * v0.6.6 replay arc: the PTY output byte stream is recorded as a side-channel
 * (the injected `setSessionRecorder` hook → io/session-log `term` entries), and
 * a checkpoint can materialize the screen via `snapshotSession` (text grid —
 * faithful to the monochrome-text render). Replaying re-feeds those bytes (or
 * restores a snapshot) into a PTY-less screen (`ensureReplaySession`/`feedReplay`).
 * Render reads the screen via `sessionViewportRows` (frame = read of the screen);
 * see model/store.js §Replayability boundary (#D5/#D14).
 *
 * Everything it needs FROM higher layers is injected at boot from
 * panel/viewer/pty-lifecycle.install (each unset = the effect is skipped,
 * so the module runs standalone in tests/scripts):
 *   - `setExitHandler(fn)` — the PTY-exit fan-out.
 *   - `setRenderHook(fn)` — repaint after the PTY writes (scheduleOverlay).
 *   - `setJobsHooks({register, close})` — the jobs-registry adapter.
 *   - `setSessionRecorder(fn)` — the replay WAL recorder (v0.6.6).
 */
'use strict';

const pty = require('node-pty');
const emu = require('./term-screen');   // the emulator screen port (only xterm importer)

const sessions = {};  // id -> { pty, screen, cmd, cwd, exited, exitCode, jobId }

// --- Injected environment (v0.6.5 §2) ------------------------------------
let _exitHandler = null;   // (id, exitCode) → panel-side exit fan-out
let _renderHook = null;    // () → repaint after the PTY writes (scheduleOverlay)
let _jobs = null;          // { register, close } → jobs-registry adapter
let _sessionRecorder = null; // (entry) → record a terminal WAL entry (replay side-channel)

/** Wire a fan-out handler invoked after each PTY session exit. Receives
 *  `(id, exitCode)`. Idempotent on re-registration. */
function setExitHandler(fn) { _exitHandler = (typeof fn === 'function') ? fn : null; }

/** Wire the post-output repaint hook (production: render-queue `scheduleOverlay`). */
function setRenderHook(fn) { _renderHook = (typeof fn === 'function') ? fn : null; }

/** Wire the jobs-registry adapter — `register({kind,label,pid,owner}) → id`
 *  and `close(id, {status,exitCode})`. Without it, sessions run untracked. */
function setJobsHooks(j) {
  _jobs = (j && typeof j.register === 'function' && typeof j.close === 'function') ? j : null;
}

/** Wire the replay session recorder — receives `{ id, ev, ... }` terminal WAL
 *  entries (`ev` ∈ spawn|resize|out|exit; `out` carries the PTY string `d`).
 *  Injected at boot (io stays a leaf — see header); unset = no recording. */
function setSessionRecorder(fn) { _sessionRecorder = (typeof fn === 'function') ? fn : null; }

/**
 * Create or return existing session. Lazy — created on first access
 * (first render of the active terminal tab).
 */
function ensureSession(id, cmd, cols, rows, cwd) {
  if (sessions[id]) return sessions[id];
  const screen = emu.createScreen(cols, rows);
  const shell = process.env.SHELL || '/bin/bash';
  // cwd is injected by the caller (the spawn directory = model.projectDir).
  const spawnCwd = cwd || '.';
  const p = pty.spawn(shell, ['-c', cmd], {
    name: 'xterm-256color', cols, rows, cwd: spawnCwd, env: process.env,
  });
  // Declare `session` BEFORE registering `p.onData` so the closure's
  // `session.exited` read can't TDZ-throw on a synchronous data chunk.
  const session = { pty: p, screen, cmd, cwd: spawnCwd, exited: false, exitCode: null, _onDataSub: null };
  // T17 — node-pty's onData returns a disposable; hold it on the session so
  // destroySession can dispose the listener BEFORE the screen is disposed.
  session._onDataSub = p.onData(data => {
    if (session.exited) return;  // belt-and-braces: also drop if exited
    // Replay WAL: record the PTY output chunk (the foreign-component "diff")
    // BEFORE feeding the screen, so the side-channel captures it regardless of
    // the write callback's timing. Off-model — never enters the TEA model (#D14).
    if (_sessionRecorder) _sessionRecorder({ id, ev: 'out', d: data });
    emu.writeScreen(screen, data, () => { if (_renderHook) _renderHook(); });
  });
  p.onExit(({ exitCode }) => {
    session.exited = true;
    session.exitCode = exitCode;
    if (_sessionRecorder) _sessionRecorder({ id, ev: 'exit', code: exitCode });
    if (session.jobId && _jobs) {
      _jobs.close(session.jobId, { status: 'exited', exitCode });
      session.jobId = null;
    }
    _onSessionExit(id, exitCode);
  });
  session.jobId = _jobs ? _jobs.register({
    kind: 'pty', label: cmd, pid: p.pid, owner: { ptyId: id, cmd },
  }) : null;
  sessions[id] = session;
  // Replay WAL: record the session spawn (cmd + initial geometry).
  if (_sessionRecorder) _sessionRecorder({ id, ev: 'spawn', cmd, cols, rows });
  return session;
}

/** Invoke the registered exit handler (if any). Lifted out of the onExit
 *  closure so tests can drive it without spinning a real PTY. */
function _onSessionExit(id, exitCode) {
  if (_exitHandler) {
    try { _exitHandler(id, exitCode); }
    catch (e) { console.error(`[terminal] exit handler threw: ${e.message}`); }
  }
}

/** Get an existing session by ID, or null. (Callers read lifecycle fields —
 *  `exited`/`exitCode` and the render diff cache; the screen is reached via the
 *  accessors below, not `session.screen` directly.) */
function getSession(id) { return sessions[id] || null; }

/** The visible viewport as plain-text rows + viewportY (the render read). */
function sessionViewportRows(id, height, width) {
  const s = sessions[id];
  return s ? emu.readViewport(s.screen, height, width) : { viewportY: 0, rows: [] };
}

/** The session's cursor position within the viewport ({x, y}, 0-based), or null
 *  — render places the real screen cursor here in terminal mode. */
function sessionCursor(id) {
  const s = sessions[id];
  return s ? emu.screenCursor(s.screen) : null;
}

/** A session's screen geometry { cols, rows } (the finalizer's resize check). */
function sessionSize(id) {
  const s = sessions[id];
  return s ? emu.screenSize(s.screen) : null;
}

// --- Replay (v0.6.6 replay arc) ------------------------------------------
//
// During replay a session is backed by a PTY-less screen — reconstructed by
// re-feeding the recorded byte stream (`feedReplay`) or restoring a checkpoint
// snapshot (`restoreReplaySession`), per docs/foreign-components.md §Replay.

/** Replay: create (or return) a PTY-less session backed by an emulator screen. */
function ensureReplaySession(id, cols, rows) {
  if (sessions[id]) return sessions[id];
  sessions[id] = { pty: null, screen: emu.createScreen(cols, rows), cmd: null, cwd: null,
    exited: false, exitCode: null, _onDataSub: null, replay: true };
  return sessions[id];
}

/** Replay: write a recorded PTY output chunk to the session's screen. The
 *  optional `cb` fires after the emulator finishes parsing (tests flush with it). */
function feedReplay(id, data, cb) {
  const s = sessions[id];
  if (s) emu.writeScreen(s.screen, data, cb);
  else if (cb) cb();
}

/** Replay: mark a session exited. The exit FAN-OUT is replayed from the Msg
 *  log, so this only flips local state — it does NOT invoke the exit handler. */
function markReplayExit(id, code) {
  const s = sessions[id];
  if (s) { s.exited = true; s.exitCode = code; }
}

/** Checkpoint: materialize a session's screen (text grid + geometry + scroll). */
function snapshotSession(id) {
  const s = sessions[id];
  return s ? emu.serializeScreen(s.screen) : null;
}

/** Checkpoint: materialize every live session → { id: gridSnapshot }. */
function snapshotAllSessions() {
  const out = {};
  for (const id of Object.keys(sessions)) out[id] = emu.serializeScreen(sessions[id].screen);
  return out;
}

/** Replay: create a PTY-less session from a checkpoint snapshot (instant resume
 *  without re-feeding from spawn). `cb` fires once the screen is reconstructed.
 *  Disposes any existing session for `id` FIRST — reverseTo/replayTo restore over
 *  the same ids every frame/seek, and restoreLiveSessions restores over a live
 *  (PTY-backed) id; without this the old emulator screen (and, for a live id, its
 *  PTY + onData listener) would leak. */
function restoreReplaySession(id, snap, cb) {
  if (sessions[id]) destroySession(id);
  sessions[id] = { pty: null, screen: emu.restoreScreen(snap, cb), cmd: null, cwd: null,
    exited: false, exitCode: null, _onDataSub: null, replay: true };
  return sessions[id];
}

/** Replay teardown (`:record-load` exit): restore the sessions that were live
 *  when replay began — `grids` is the `snapshotAllSessions()` map captured then.
 *  Sessions ids deterministically collide with live ones (`group_key`), so the
 *  fold writes replay bytes into live screens; without this, exit would leave
 *  those panes showing replay output. Sessions present now but NOT in the
 *  snapshot were spawned during replay → destroyed. Each snapshotted screen is
 *  rebuilt PTY-less (a `:record-load` over live terminals freezes them at the
 *  live grid rather than resurrecting the PTY — see docs/v0.6.6-replay.md). */
function restoreLiveSessions(grids) {
  grids = grids || {};
  for (const id of Object.keys(sessions)) if (!(id in grids)) destroySession(id);
  for (const id of Object.keys(grids)) restoreReplaySession(id, grids[id]);
}

/** Write data (keystrokes) to a session's PTY. */
function writeToSession(id, data) {
  const s = sessions[id];
  if (s && !s.exited && s.pty) s.pty.write(data);
}

/** Resize a session's PTY and screen. */
function resizeSession(id, cols, rows) {
  const s = sessions[id];
  if (!s) return;
  if (s.pty) { try { s.pty.resize(cols, rows); } catch {} }
  emu.resizeScreen(s.screen, cols, rows);
  if (_sessionRecorder) _sessionRecorder({ id, ev: 'resize', cols, rows });
  // Truncate diff cache rows that no longer fit (free memory on shrink)
  if (s.prevFrame && s.prevFrame.length > rows) s.prevFrame.length = rows;
}

/** Destroy a single session. No-op if id doesn't exist. */
function destroySession(id) {
  const s = sessions[id];
  if (!s) return;
  // T17 — dispose the onData listener BEFORE disposing the screen.
  if (s._onDataSub) { try { s._onDataSub.dispose(); } catch {} s._onDataSub = null; }
  if (!s.exited && s.pty) try { s.pty.kill(); } catch {}
  if (s.jobId && _jobs) {
    _jobs.close(s.jobId, { status: 'killed' });
    s.jobId = null;
  }
  emu.disposeScreen(s.screen);
  delete sessions[id];
}

/** Destroy all sessions (cleanup on TUI exit). */
function destroyAll() {
  for (const id of Object.keys(sessions)) destroySession(id);
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

// --- Scrollback (v0.6.5 §5(a)) — delegate to the screen port -------------
//
// The emulator keeps a scrollback ring; these move its viewport (read by the
// overlay render). Each returns whether the viewport actually moved so the
// caller can gate its repaint. Writing new output while scrolled up is sticky.

function scrollSession(id, amount) {
  const s = sessions[id];
  return s ? emu.scrollScreen(s.screen, amount) : false;
}
function scrollSessionPages(id, n) {
  const s = sessions[id];
  return s ? emu.scrollScreenPages(s.screen, n) : false;
}
function scrollSessionToTop(id) {
  const s = sessions[id];
  return s ? emu.scrollScreenToTop(s.screen) : false;
}
function scrollSessionToBottom(id) {
  const s = sessions[id];
  return s ? emu.scrollScreenToBottom(s.screen) : false;
}

/** The child's DEC mouse-tracking mode ('none' | x10 | vt200 | drag | any). */
function sessionMouseMode(id) {
  const s = sessions[id];
  return s ? emu.screenMouseMode(s.screen) : 'none';
}

/** Scroll position: { atBottom, linesBelow }. */
function sessionScrollInfo(id) {
  const s = sessions[id];
  return s ? emu.screenScrollInfo(s.screen) : { atBottom: true, linesBelow: 0 };
}

module.exports = {
  ensureSession, getSession, writeToSession,
  sessionViewportRows, sessionCursor, sessionSize,
  resizeSession, destroySession, destroyAll,
  restartSession, isSessionDead,
  ensureReplaySession, feedReplay, markReplayExit,
  snapshotSession, snapshotAllSessions, restoreReplaySession, restoreLiveSessions,
  setExitHandler, setRenderHook, setJobsHooks, setSessionRecorder,
  // v0.6.5 §5(a) — scrollback effects.
  scrollSession, scrollSessionPages, scrollSessionToTop, scrollSessionToBottom,
  sessionMouseMode, sessionScrollInfo,
  _onSessionExit,  // exported for tests (invokes the registered handler)
  // Test-only: inject a session (a `{ screen }` with an emulator screen handle)
  // so the scrollback effects can be exercised without spawning a PTY.
  _setSessionForTest(id, session) { sessions[id] = session; },
};
