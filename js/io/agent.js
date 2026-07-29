/**
 * Live-agent session host — one long-lived backend session per agent pane.
 * Owns lifecycle (start / send / interrupt / stop) and the event edge; it
 * knows NOTHING about panes, Msgs, jobs, or render — those live in higher
 * layers and reach THIS module through injected hooks, never the reverse
 * (the io/terminal.js posture; unwired hooks no-op, so the module runs
 * standalone in tests). See docs/live-agent.md §"The model".
 *
 * NOT a foreign component: the session entry here is an IO resource handle
 * (like stream.js's `procs` map), not un-modelable state. Everything the
 * user sees — transcript, status — is folded into the model by the injected
 * event handler (A3 wiring dispatches coarse Msgs), so `frame = f(model)`
 * holds and replay skips this module entirely (recorded Msgs re-fold the
 * transcript; `start` never runs under replay).
 *
 * The backend seam: `start` takes an AgentBackend OBJECT (js/agent/protocol
 * — resolved by the caller, so this host stays registry-free) and talks to
 * it only through the interface. Backend events are validated at this edge:
 * an invalid one is diag-logged and dropped — a misbehaving backend must
 * never crash the app (protocol.js's validation posture).
 *
 * Injected at boot by the A3 wiring (each unset = skipped):
 *   - `setEventHandler(fn)` — `(id, evt)` for every valid normalized event.
 *   - `setRenderHook(fn)`   — repaint after an event is delivered
 *                             (production: render-queue scheduleRender).
 *   - `setJobsHooks({register, close})` — the jobs-registry adapter, exactly
 *                             io/terminal.js's shape.
 */
'use strict';

const { validateEvent, validateBackend } = require('../agent/protocol');
const diag = require('./diag-log');

const sessions = {};  // id -> { backend, handle, cfg, exited, exitCode, jobId }

// --- Injected environment ---------------------------------------------------
let _eventHandler = null;  // (id, evt) → the A3 wiring (dispatch coarse Msgs)
let _renderHook = null;    // () → repaint after an event lands
let _jobs = null;          // { register, close } → jobs-registry adapter

/** Wire the normalized-event fan-out. Receives `(id, evt)`. */
function setEventHandler(fn) { _eventHandler = (typeof fn === 'function') ? fn : null; }

/** Wire the post-event repaint hook (production: scheduleRender). */
function setRenderHook(fn) { _renderHook = (typeof fn === 'function') ? fn : null; }

/** Wire the jobs-registry adapter — `register({kind,label,pid,owner}) → id`
 *  and `close(id, {status,exitCode})`. Without it, sessions run untracked. */
function setJobsHooks(j) {
  _jobs = (j && typeof j.register === 'function' && typeof j.close === 'function') ? j : null;
}

/**
 * Open a long-lived agent session. Idempotent while live — an existing
 * LIVE session for `id` is returned as-is (like terminal's ensureSession);
 * an exited one is replaced (its transcript lives in the model, so a
 * restart loses nothing). A malformed backend THROWS (a wire-up
 * programming error, not runtime input). cfg is passed through to the
 * backend; `cfg.label` names the job.
 */
function start(id, backend, cfg) {
  if (sessions[id] && !sessions[id].exited) return sessions[id];
  const err = validateBackend(backend);
  if (err) throw new Error(`agent session '${id}': ${err}`);
  const handle = backend.start(cfg || {});
  const session = { backend, handle, cfg: cfg || {}, exited: false, exitCode: null, jobId: null };
  // Attach in start's tick — the protocol's delivery contract guarantees
  // nothing is emitted before the next tick, so no event is missed.
  backend.onEvent(handle, (evt) => _deliver(id, session, evt));
  session.jobId = _jobs ? _jobs.register({
    kind: 'agent',
    label: (cfg && cfg.label) || `${backend.name} agent`,
    // A backend may expose the subprocess pid on its handle (Pi will); the
    // mock has none. Purely informational (jobs overlay display).
    pid: (handle && typeof handle.pid === 'number') ? handle.pid : null,
    owner: { agentId: id, backend: backend.name },
  }) : null;
  sessions[id] = session;
  return session;
}

/** Validate → track lifecycle → fan out → repaint. The one event edge. */
function _deliver(id, session, evt) {
  // Belt-and-braces (terminal onData's exited-guard posture): a superseded
  // or removed session's late events must not fan out. The protocol says
  // nothing follows `exit`, but a misbehaving backend must not misattribute
  // events onto a restarted id.
  if (sessions[id] !== session) return;
  const err = validateEvent(evt);
  if (err) {
    diag.warn('agent', `session '${id}' (${session.backend.name}): dropped ${err}`);
    return;
  }
  if (evt.type === 'exit') {
    session.exited = true;
    session.exitCode = evt.code;
    // Close the job BEFORE the fan-out (terminal's onExit ordering) — a
    // handler reading the registry sees the session already closed.
    if (session.jobId && _jobs) {
      _jobs.close(session.jobId, { status: 'exited', exitCode: evt.code });
      session.jobId = null;
    }
  }
  if (_eventHandler) {
    try { _eventHandler(id, evt); }
    catch (e) { diag.error('agent', `session '${id}' event handler threw: ${e.message}`); }
  }
  if (_renderHook) _renderHook();
}

/** Deliver a user message to a live session. Dead/unknown id → no-op
 *  (like terminal's writeToSession — the pane may outlive the session). */
function send(id, message, opts) {
  const s = sessions[id];
  if (s && !s.exited) s.backend.send(s.handle, message, opts);
}

/** Cancel the in-flight turn. Dead/unknown id → no-op. */
function interrupt(id) {
  const s = sessions[id];
  if (s && !s.exited) s.backend.interrupt(s.handle);
}

/** Tear a session down. The backend emits the final `exit`, which closes
 *  the job and marks the session dead via _deliver. The entry stays in the
 *  map (exited, like a dead terminal session) so the pane can still read
 *  its lifecycle until the map is reset/session replaced. */
function stop(id) {
  const s = sessions[id];
  if (s && !s.exited) s.backend.stop(s.handle);
}

/** Stop every live session (cleanup on TUI exit — the terminal destroyAll
 *  analog). Graceful: each backend tears its own subprocess down. */
function stopAll() {
  for (const id of Object.keys(sessions)) stop(id);
}

/** Tear down AND forget a session — the terminal destroySession analog, for
 *  a pane leaving the layout (orphan-dispose). The entry is removed FIRST so
 *  every further delivery (including the backend's own final `exit`) drops
 *  via the stale-session guard; the job closes here instead ('killed'). */
function destroy(id) {
  const s = sessions[id];
  if (!s) return;
  delete sessions[id];
  if (s.jobId && _jobs) {
    _jobs.close(s.jobId, { status: 'killed' });
    s.jobId = null;
  }
  if (!s.exited) {
    try { s.backend.stop(s.handle); }
    catch (e) { diag.warn('agent', `destroy '${id}': backend stop threw: ${e.message}`); }
  }
}

/** A session's lifecycle entry, or null (callers read exited/exitCode). */
function getSession(id) { return sessions[id] || null; }

/** Test-only — wipe sessions + hooks (module-local state, like jobs._reset). */
function _reset() {
  for (const id of Object.keys(sessions)) delete sessions[id];
  _eventHandler = null;
  _renderHook = null;
  _jobs = null;
}

module.exports = {
  start, send, interrupt, stop, stopAll, destroy, getSession,
  setEventHandler, setRenderHook, setJobsHooks,
  _reset,
};
