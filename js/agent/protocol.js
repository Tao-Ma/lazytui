/**
 * Live-agent backend protocol — the normalized event vocabulary + the
 * AgentBackend interface every concrete backend (mock, Pi-RPC, an in-process
 * SDK loop, …) maps onto. See docs/live-agent.md §"The backend-adapter seam".
 *
 * This is THE contract of the live-agent feature: the runtime (io/agent.js,
 * the agent pane's reducer) speaks only this vocabulary and never a backend's
 * native idiom. Get an event into this shape in the backend adapter, or it
 * does not exist.
 *
 * Delivery contract (what every backend must honor):
 * - `start(cfg)` returns a handle synchronously and emits NOTHING in its own
 *   tick; the caller attaches the handler via `onEvent` in that same tick,
 *   and delivery begins no earlier than the next tick.
 * - The backend emits `settled` once the session is open and ready for input
 *   (and again whenever it returns to idle with nothing queued).
 * - After an `interrupt`, the in-flight turn still terminates normally:
 *   `turn-end` then `settled` — the UI always returns to input-ready.
 * - `exit` is the LAST event a session ever emits; nothing follows it.
 *
 * Validation posture (house style, cf. js/fabric/parse.js): a backend event
 * arrives at RUNTIME from a subprocess we don't control, so `validateEvent`
 * never throws — it returns an error string the caller diag-logs before
 * dropping the event. Unknown event TYPES are invalid (the vocabulary is
 * closed — that's what keeps backends from leaking idioms); unknown EXTRA
 * fields on a known type are allowed (adapters may attach meta).
 *
 * Pure, zero-dependency leaf (js/agent/).
 */
'use strict';

/**
 * @typedef {Object} AgentBackend
 * @property {string}                                name       Backend id for descriptors/diagnostics (e.g. 'mock', 'pi').
 * @property {(cfg: Object) => Object}               start      Spawn/open a long-lived session; returns an opaque handle.
 * @property {(h, message: string, opts?) => void}   send       Deliver a user message (opts: images, steer/followUp).
 * @property {(h) => void}                           interrupt  Cancel the in-flight turn.
 * @property {(h) => void}                           stop       Tear the session down (emits the final `exit`).
 * @property {(h, handler: (evt) => void) => void}   onEvent    Attach the normalized-event handler (one per session).
 * @property {(h, model: string) => void}            [setModel]     Optional: switch model mid-session.
 * @property {(h, level: string) => void}            [setThinking]  Optional: switch thinking level mid-session.
 */

/** `status.state` is a closed set — a backend with a novel state maps it onto
 *  one of these in its adapter (that's normalization, not information loss:
 *  the transcript carries the detail; `state` only drives the status line). */
const STATUS_STATES = ['idle', 'thinking', 'tool', 'compacting', 'retrying'];

// Per-type field validators. Each returns an error string or null. Shapes are
// FLAT (type + fields, like Msgs), kebab-case-typed (they are protocol events,
// not Msgs — A3's wiring maps them into Msgs).
const EVENT_CHECKS = {
  /** assistant turn began */
  'turn-start': () => null,
  /** streaming token(s) of the in-flight turn — exactly one of text|thinking
   *  (adapters split batched deltas). NOT folded into the model by default
   *  (spinner + settle; see docs/live-agent.md §Streaming). */
  'assistant-delta': (e) => {
    const hasText = typeof e.text === 'string';
    const hasThinking = typeof e.thinking === 'string';
    if (hasText === hasThinking) return 'needs exactly one of text|thinking (string)';
    return null;
  },
  /** a turn's assistant text settled (may be absent for tool-only turns) */
  'assistant-message': (e) =>
    typeof e.text === 'string' ? null : 'needs text (string)',
  /** agent invoked a tool */
  'tool-call': (e) => {
    if (typeof e.id !== 'string' || !e.id) return 'needs id (non-empty string)';
    if (typeof e.name !== 'string' || !e.name) return 'needs name (non-empty string)';
    if (e.args !== undefined && (typeof e.args !== 'object' || e.args === null)) {
      return 'args, when present, must be an object';
    }
    return null;
  },
  /** tool finished; `result` is any JSON value (typically display text) */
  'tool-result': (e) => {
    if (typeof e.id !== 'string' || !e.id) return 'needs id (non-empty string)';
    if (e.isError !== undefined && typeof e.isError !== 'boolean') {
      return 'isError, when present, must be a boolean';
    }
    return null;
  },
  /** coarse session state for the status line (+ optional usage counters) */
  'status': (e) => {
    if (!STATUS_STATES.includes(e.state)) {
      return `needs state in {${STATUS_STATES.join('|')}}, got ${JSON.stringify(e.state)}`;
    }
    if (e.tokens !== undefined && !Number.isFinite(e.tokens)) return 'tokens must be a finite number';
    if (e.cost !== undefined && !Number.isFinite(e.cost)) return 'cost must be a finite number';
    return null;
  },
  /** assistant turn completed (also after an interrupt) */
  'turn-end': () => null,
  /** session idle, nothing queued — drives input-ready */
  'settled': () => null,
  /** backend/turn error (session may still be alive; `exit` says otherwise) */
  'error': (e) =>
    (typeof e.message === 'string' && e.message) ? null : 'needs message (non-empty string)',
  /** session ended — the final event; code is the exit code, null if signal-killed */
  'exit': (e) =>
    (typeof e.code === 'number' || e.code === null) ? null : 'needs code (number, or null if signal-killed)',
};

/**
 * Validate one normalized event. Returns null when valid, else a
 * human-readable reason (caller diag-logs + drops — never crash on a
 * misbehaving backend).
 */
function validateEvent(evt) {
  if (!evt || typeof evt !== 'object' || Array.isArray(evt)) {
    return `agent event must be an object, got ${Array.isArray(evt) ? 'array' : typeof evt}`;
  }
  const check = EVENT_CHECKS[evt.type];
  if (!check) return `unknown agent event type ${JSON.stringify(evt.type)}`;
  const err = check(evt);
  return err ? `agent event '${evt.type}': ${err}` : null;
}

/**
 * Shape-check an AgentBackend at registration (a missing method is a
 * programming error caught at wire-up, not mid-session). Returns null when
 * valid, else the reason.
 */
function validateBackend(b) {
  if (!b || typeof b !== 'object') return `agent backend must be an object, got ${typeof b}`;
  if (typeof b.name !== 'string' || !b.name) return 'agent backend needs name (non-empty string)';
  for (const m of ['start', 'send', 'interrupt', 'stop', 'onEvent']) {
    if (typeof b[m] !== 'function') return `agent backend '${b.name}' missing method ${m}()`;
  }
  for (const m of ['setModel', 'setThinking']) {
    if (b[m] !== undefined && typeof b[m] !== 'function') {
      return `agent backend '${b.name}': optional ${m} must be a function when present`;
    }
  }
  return null;
}

module.exports = { validateEvent, validateBackend, STATUS_STATES };
