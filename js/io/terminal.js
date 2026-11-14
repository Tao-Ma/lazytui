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
 * a checkpoint can materialize the screen via `snapshotSession` (text +
 * attributes as SGR lines — faithful to the render). Replaying re-feeds those bytes (or
 * restores a snapshot) into a PTY-less screen (`ensureReplaySession`/`feedReplay`).
 * Render reads the screen via `sessionViewportRows` (frame = read of the screen);
 * see model/store.js §Replayability boundary (#D5/#D14).
 *
 * Everything it needs FROM higher layers is injected at boot from
 * panel/content/pty-lifecycle.install (each unset = the effect is skipped,
 * so the module runs standalone in tests/scripts):
 *   - `setExitHandler(fn)` — the PTY-exit fan-out.
 *   - `setRenderHook(fn)` — repaint after the PTY writes (scheduleOverlay).
 *   - `setJobsHooks({register, close})` — the jobs-registry adapter.
 *   - `setSessionRecorder(fn)` — the replay WAL recorder (v0.6.6).
 */
'use strict';

// node-pty is an OPTIONAL dependency: its native addon has no prebuild on some
// platforms (e.g. linux-arm64) and its source build needs toolchain (make/gcc),
// so `npm install` may legitimately skip it. Load it DEFENSIVELY — the dispatch
// runtime top-level-requires this module at boot (cleanup / finalize / actions),
// so a bare `require` would crash the whole TUI on a node-pty-less install. When
// it's absent, terminal panes degrade to a notice (ensureSession returns null;
// the terminal panel render shows why) and everything else works unchanged.
let pty = null;
try { pty = require('node-pty'); } catch (_) { /* optional dep absent — terminals disabled */ }
const emu = require('./term-screen');   // the emulator screen port (only xterm importer)

/** Whether node-pty loaded — false disables terminal/spawn panes (they show a
 *  notice instead of spawning). Read by the terminal panel render. */
function ptyAvailable() { return !!pty; }

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

// A PTY needs at least one cell. Callers size from a pane's interior, which
// the surface selector (panel/terminal-surfaces) only hands over when it is
// ≥ 1×1; this is the leaf's own floor (a non-positive size threw from
// resizeSession's prevFrame truncation, and node-pty / the emulator reject it).
const _validSize = (cols, rows) => Number.isInteger(cols) && Number.isInteger(rows) && cols >= 1 && rows >= 1;

/**
 * Create or return existing session. Lazy — the dispatch finalizer creates it
 * the first time the terminal is a visible surface with room (an active tab
 * with an interior), sized to that interior.
 */
function ensureSession(id, cmd, cols, rows, cwd) {
  if (sessions[id]) return sessions[id];
  if (!pty) return null;   // optional node-pty absent — no PTY sessions (the panel
                           // render shows a notice; the finalizer's null-safe reads skip).
  if (!_validSize(cols, rows)) return null;   // nothing spawned; a later call with room spawns it
  const screen = emu.createScreen(cols, rows);
  const shell = process.env.SHELL || '/bin/bash';
  // cwd is injected by the caller (the spawn directory = model.projectDir).
  const spawnCwd = cwd || '.';
  const p = pty.spawn(shell, ['-c', cmd], {
    name: 'xterm-256color', cols, rows, cwd: spawnCwd, env: process.env,
  });
  // Declare `session` BEFORE registering `p.onData` so the closure's
  // `session.exited` read can't TDZ-throw on a synchronous data chunk.
  const session = { pty: p, screen, cmd, cwd: spawnCwd, exited: false, exitCode: null, _onDataSub: null, _replySub: null };
  // T17 — node-pty's onData returns a disposable; hold it on the session so
  // destroySession can dispose the listener BEFORE the screen is disposed.
  // The emulator's answers to the child's terminal queries (DA, cursor position,
  // mode reports) and the mouse reports it encodes go back to the child's stdin,
  // as a real terminal's would. Unwired, every query went unanswered (field
  // report 2026-11-14: vim chooses its mouse encoding from the `ESC [ > c`
  // answer; nvim waits on `ESC [ c`).
  session._replySub = emu.onScreenReply(screen, (d, binary) => {
    if (session.exited) return;
    try { p.write(binary ? Buffer.from(d, 'latin1') : d); } catch {}
  });
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
    // A program WE stopped (destroySession: its tab closed, a restart, a replay
    // replacing the session) didn't exit on its own: no recorded exit, no exit
    // fan-out. The fan-out (pty-lifecycle) acts on whatever model is current —
    // a replay frame's, or the restarted session's tab under the same id.
    if (session.destroyed) return;
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

/** The visible viewport (the render read): `runs` = each row as styled runs
 *  `[{ sgr, text }]` exactly `width` columns wide, `rows` = their text, + viewportY. */
function sessionViewportRows(id, height, width) {
  const s = sessions[id];
  return s ? emu.readViewport(s.screen, height, width) : { viewportY: 0, rows: [], runs: [] };
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

// A replayed stream only ever reaches a PTY-less session. Session ids are
// deterministic (the pane's id), so a `:record-load` from the same config
// collides with the live sessions; the first replay entry for such an id
// REPLACES the live session (its program is stopped — the documented
// `:record-load` caveat: the pane comes back frozen at its live grid). Fed into
// the live session instead, the recorded bytes mixed with the live output, and
// its emulator answered the RECORDED queries (DA, cursor position, OSC 10/11)
// into the LIVE program's stdin; a recorded resize resized the live PTY.
function _replaySession(id, cols, rows) {
  const s = sessions[id];
  if (s && s.replay) return s;
  const size = (s && emu.screenSize(s.screen)) || { cols: 80, rows: 24 };   // a sizeless entry: xterm's default
  if (s) destroySession(id);
  sessions[id] = { pty: null, screen: emu.createScreen(cols || size.cols, rows || size.rows), cmd: null, cwd: null,
    exited: false, exitCode: null, _onDataSub: null, replay: true };
  return sessions[id];
}

/** Replay: create (or return) a PTY-less session backed by an emulator screen
 *  — replacing a live one with the same id. */
function ensureReplaySession(id, cols, rows) {
  return _replaySession(id, cols, rows);
}

/** Replay: write a recorded PTY output chunk to the session's screen (a live
 *  session with that id is replaced first). The optional `cb` fires after the
 *  emulator finishes parsing (tests flush with it). */
function feedReplay(id, data, cb) {
  if (sessions[id]) emu.writeScreen(_replaySession(id).screen, data, cb);
  else if (cb) cb();
}

/** Replay: a recorded resize (a live session with that id is replaced first). */
function resizeReplaySession(id, cols, rows) {
  if (sessions[id]) { _replaySession(id); resizeSession(id, cols, rows); }
}

/** Replay: mark a session exited. The exit FAN-OUT is replayed from the Msg
 *  log, so this only flips local state — it does NOT invoke the exit handler. */
function markReplayExit(id, code) {
  if (!sessions[id]) return;
  const s = _replaySession(id);
  s.exited = true; s.exitCode = code;
}

/** Checkpoint: materialize a session's screen (styled grid as SGR lines + geometry + scroll). */
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

/** Replay teardown (`:record-load` exit): put back what was live when replay
 *  began — `grids` is the `snapshotAllSessions()` map captured then. A live
 *  session the replay never touched is still the live one: it keeps running.
 *  One the replay replaced (its id collided with a recorded one — ids are
 *  deterministic, `pane-<poolId>`) had its program stopped then; it comes back
 *  PTY-less, frozen at its live grid and marked stopped (exited, code null), so
 *  Enter restarts it with its pane's command (see docs/v0.6.6-replay.md). A
 *  replay session with no live counterpart was spawned during replay → gone. */
function restoreLiveSessions(grids) {
  grids = grids || {};
  for (const id of Object.keys(sessions)) {
    if (!sessions[id].replay) continue;            // live, untouched: keeps running
    if (!(id in grids)) destroySession(id);        // spawned during replay
  }
  for (const id of Object.keys(grids)) {
    if (sessions[id] && !sessions[id].replay) continue;
    const s = restoreReplaySession(id, grids[id]);
    s.exited = true;                               // its program was stopped
    s.exitCode = null;
  }
}

/** Write data (keystrokes) to a session's PTY. */
function writeToSession(id, data) {
  const s = sessions[id];
  if (s && !s.exited && s.pty) s.pty.write(data);
}

/** Resize a session's PTY and screen. */
function resizeSession(id, cols, rows) {
  const s = sessions[id];
  if (!s || !_validSize(cols, rows)) return;   // keep the last size
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
  s.destroyed = true;   // its exit, when the kill lands, is ours — not the program's (onExit)
  // T17 — dispose the onData listener BEFORE disposing the screen.
  if (s._onDataSub) { try { s._onDataSub.dispose(); } catch {} s._onDataSub = null; }
  if (s._replySub) { try { s._replySub.dispose(); } catch {} s._replySub = null; }
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

/** Restart a session — kill old, spawn fresh with the same cmd. A session
 *  that knows none (one rebuilt PTY-less after a replay) takes `fallback`'s
 *  `{ cmd, cwd }` — the pane's own (terminal-surfaces: the surface's cmd). */
function restartSession(id, cols, rows, fallback) {
  const old = sessions[id];
  if (!old) return null;
  if (!_validSize(cols, rows)) return null;   // refuse BEFORE killing the old one
  const fb = fallback || {};
  const cmd = old.cmd || fb.cmd;
  const cwd = old.cwd || fb.cwd;
  if (!cmd) return null;                      // nothing to run
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

/** What the child asked of its terminal's input side (term-screen
 *  screenInputModes): { appCursor, sendFocus, bracketedPaste, altScreen }. */
function sessionInputModes(id) {
  const s = sessions[id];
  return s ? emu.screenInputModes(s.screen)
           : { appCursor: false, sendFocus: false, bracketedPaste: false, altScreen: false };
}

/** Send a mouse event to the child, encoded for the DEC protocol + encoding it
 *  asked for (the emulator tracks both); the report reaches the PTY through the
 *  reply wiring (ensureSession). `ev` = { col, row (0-based grid cell), button,
 *  action, shift, alt, ctrl } — see term-screen screenMouseReport. */
function reportMouse(id, ev) {
  const s = sessions[id];
  if (!s || s.exited || !s.pty) return false;
  return emu.screenMouseReport(s.screen, ev);
}

/** Scroll position: { atBottom, linesBelow }. */
function sessionScrollInfo(id) {
  const s = sessions[id];
  return s ? emu.screenScrollInfo(s.screen) : { atBottom: true, linesBelow: 0 };
}

module.exports = {
  ptyAvailable,
  ensureSession, getSession, writeToSession,
  sessionViewportRows, sessionCursor, sessionSize,
  resizeSession, destroySession, destroyAll,
  restartSession, isSessionDead,
  ensureReplaySession, feedReplay, resizeReplaySession, markReplayExit,
  snapshotSession, snapshotAllSessions, restoreReplaySession, restoreLiveSessions,
  setExitHandler, setRenderHook, setJobsHooks, setSessionRecorder,
  // v0.6.5 §5(a) — scrollback effects.
  scrollSession, scrollSessionPages, scrollSessionToTop, scrollSessionToBottom,
  sessionMouseMode, sessionInputModes, sessionScrollInfo, reportMouse,
  _onSessionExit,  // exported for tests (invokes the registered handler)
  // Test-only: inject a session (a `{ screen }` with an emulator screen handle)
  // so the scrollback effects can be exercised without spawning a PTY.
  _setSessionForTest(id, session) { sessions[id] = session; },
};
