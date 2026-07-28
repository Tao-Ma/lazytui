/**
 * Mock agent backend — deterministic scripted events, the test double the
 * whole Phase-A pipeline builds against (docs/live-agent.md §"Phase-A build
 * plan", mock-backend-first). No subprocess, no Pi, no network: `send` plays
 * back a scripted turn, one event per setImmediate tick.
 *
 * One-event-per-tick matters: it makes the mock genuinely asynchronous (like
 * a real subprocess's stdout), so `interrupt` issued from inside an event
 * handler really does cancel the un-emitted tail — the re-entrancy A1/A3
 * must survive is exercised, not masked. Ordering stays deterministic
 * (setImmediate is FIFO).
 *
 * Scripting: `start({ script })` takes an array of turns; the i-th `send`
 * plays the i-th turn's events verbatim. Sends beyond the script (or with no
 * script at all) play a default echo turn. Script events are validated at
 * `start` and an invalid one THROWS — a scripted turn is authored config, so
 * it fails at load (house style), unlike runtime backend output which is
 * merely dropped.
 *
 * Semantics implemented (the delivery contract of js/agent/protocol.js):
 * - `start` emits nothing in its own tick, then `settled` (session ready).
 * - Queued sends play sequentially, never interleaved.
 * - `interrupt` drops everything un-emitted (including queued turns); if a
 *   turn was in flight it still terminates normally (`turn-end`, `settled`);
 *   idle interrupt is a no-op.
 * - `stop` drops everything un-emitted and emits the final `exit {code: 0}`;
 *   nothing follows it, and later send/interrupt/stop are no-ops.
 * - Events emitted while no handler is attached are dropped (the contract
 *   says attach in `start`'s tick — before delivery begins).
 *
 * Pure-io leaf (js/agent/): no lazytui imports beyond the protocol.
 */
'use strict';

const { validateEvent } = require('../protocol');

/** The turn a send beyond the script plays: visible round-trip of `message`. */
function echoTurn(message) {
  return [
    { type: 'turn-start' },
    { type: 'status', state: 'thinking' },
    { type: 'assistant-message', text: `echo: ${message}` },
    { type: 'turn-end' },
    { type: 'settled' },
  ];
}

function start(cfg) {
  const script = (cfg && cfg.script) || [];
  if (!Array.isArray(script)) throw new Error('mock backend script must be an array of turns');
  script.forEach((turn, ti) => {
    if (!Array.isArray(turn)) throw new Error(`mock backend script turn ${ti} must be an array of events`);
    turn.forEach((evt, ei) => {
      const err = validateEvent(evt);
      if (err) throw new Error(`mock backend script turn ${ti} event ${ei}: ${err}`);
    });
  });
  const h = {
    script,
    turn: 0,          // next script index a send consumes
    handler: null,
    queue: [],        // un-emitted events, all queued turns concatenated
    pumping: false,   // a setImmediate step is scheduled
    inTurn: false,    // emitted turn-start without its turn-end yet
    stopped: false,
    sent: [],         // every send's {message, opts}, for test introspection
  };
  enqueue(h, [{ type: 'settled' }]);   // session ready — next tick, per the contract
  return h;
}

function send(h, message, opts) {
  if (h.stopped) return;
  h.sent.push({ message, opts });
  const turn = h.turn < h.script.length ? h.script[h.turn] : echoTurn(message);
  h.turn++;
  enqueue(h, turn);
}

function interrupt(h) {
  if (h.stopped) return;
  const hadQueued = h.queue.length > 0;
  h.queue.length = 0;
  if (h.inTurn) enqueue(h, [{ type: 'turn-end' }, { type: 'settled' }]);
  else if (hadQueued) enqueue(h, [{ type: 'settled' }]);
}

function stop(h) {
  if (h.stopped) return;
  h.stopped = true;
  h.inTurn = false;
  h.queue.length = 0;
  enqueue(h, [{ type: 'exit', code: 0 }]);
}

function onEvent(h, handler) {
  h.handler = handler;
}

function enqueue(h, events) {
  h.queue.push(...events);
  pump(h);
}

/** Emit the queue one event per setImmediate tick. */
function pump(h) {
  if (h.pumping) return;
  h.pumping = true;
  setImmediate(() => {
    h.pumping = false;
    const evt = h.queue.shift();
    if (!evt) return;
    if (evt.type === 'turn-start') h.inTurn = true;
    else if (evt.type === 'turn-end') h.inTurn = false;
    if (h.handler) h.handler(evt);
    if (h.queue.length) pump(h);
  });
}

module.exports = { name: 'mock', start, send, interrupt, stop, onEvent };
