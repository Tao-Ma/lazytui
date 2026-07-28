/**
 * Mock agent backend (Slice A0) — deterministic scripted events behind the
 * AgentBackend seam, including the delivery contract every backend must
 * honor (nothing in start's tick, settled-on-ready, interrupt terminates the
 * turn, exit is last). Async by nature (one event per setImmediate tick), so
 * this file uses the section() + await style, report() after all awaits.
 * Run: node js/test/test-agent-mock.js
 */
'use strict';

const { section, eq, assert, report } = require('./test-runner');
const { validateEvent } = require('../agent/protocol');
const mock = require('../agent/backends/mock');

const tick = () => new Promise(r => setImmediate(r));
async function until(pred, budget = 100) {
  for (let i = 0; i < budget && !pred(); i++) await tick();
  return pred();
}
function attach(h) {
  const evts = [];
  mock.onEvent(h, e => evts.push(e));
  return evts;
}
const types = evts => evts.map(e => e.type);
const count = (evts, t) => evts.filter(e => e.type === t).length;
function allValid(evts, label) {
  const bad = evts.map(validateEvent).filter(Boolean);
  eq(bad, [], `${label}: every emitted event passes validateEvent`);
}
function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

(async () => {
  section('[mock] delivery contract: start');
  {
    const h = mock.start({});
    const evts = attach(h);
    eq(evts.length, 0, 'start emits NOTHING in its own tick');
    assert(await until(() => evts.length >= 1), 'ready signal arrives');
    eq(types(evts), ['settled'], 'session-ready is a settled event');
    await tick();
    eq(evts.length, 1, 'and nothing more until a send');
  }

  section('[mock] default echo turn');
  {
    const h = mock.start({});
    const evts = attach(h);
    mock.send(h, 'hi', { via: 'test' });
    assert(await until(() => count(evts, 'settled') === 2), 'turn completes');
    eq(types(evts),
       ['settled', 'turn-start', 'status', 'assistant-message', 'turn-end', 'settled'],
       'ready + the 5-event echo turn, in order');
    eq(evts[2].state, 'thinking', 'status is thinking during the turn');
    eq(evts[3].text, 'echo: hi', 'echoes the message');
    eq(h.sent, [{ message: 'hi', opts: { via: 'test' } }], 'send recorded for introspection');
    allValid(evts, 'echo');
  }

  section('[mock] scripted turns play verbatim, sequentially, then fall back to echo');
  {
    const script = [
      [ { type: 'turn-start' },
        { type: 'tool-call', id: 't1', name: 'bash', args: { cmd: 'ls' } },
        { type: 'tool-result', id: 't1', result: 'a.txt' },
        { type: 'assistant-message', text: 'one file' },
        { type: 'turn-end' },
        { type: 'settled' } ],
      [ { type: 'turn-start' },
        { type: 'assistant-message', text: 'second' },
        { type: 'turn-end' },
        { type: 'settled' } ],
    ];
    const h = mock.start({ script });
    const evts = attach(h);
    // Two sends back-to-back in one tick: turns must queue, never interleave.
    mock.send(h, 'first');
    mock.send(h, 'second');
    mock.send(h, 'third — beyond the script');
    assert(await until(() => count(evts, 'settled') === 4), 'ready + 3 turns settle');
    eq(types(evts), [
      'settled',
      'turn-start', 'tool-call', 'tool-result', 'assistant-message', 'turn-end', 'settled',
      'turn-start', 'assistant-message', 'turn-end', 'settled',
      'turn-start', 'status', 'assistant-message', 'turn-end', 'settled',
    ], 'scripted turn 0, scripted turn 1, echo fallback — no interleaving');
    eq(evts[2].args, { cmd: 'ls' }, 'scripted events pass through verbatim');
    eq(evts[13].text, 'echo: third — beyond the script', 'fallback echoes');
    allValid(evts, 'scripted');
  }

  section('[mock] invalid script throws at start (load error, not runtime drop)');
  {
    assert(throws(() => mock.start({ script: [[{ type: 'bogus' }]] })), 'unknown event type');
    assert(throws(() => mock.start({ script: [[{ type: 'status' }]] })), 'field-invalid event');
    assert(throws(() => mock.start({ script: { 0: [] } })), 'non-array script');
    assert(throws(() => mock.start({ script: [{ type: 'turn-start' }] })), 'a turn that is not an array');
  }

  section('[mock] interrupt mid-turn drops the tail but terminates the turn');
  {
    const script = [
      [ { type: 'turn-start' },
        { type: 'status', state: 'thinking' },
        { type: 'assistant-message', text: 'SHOULD NOT APPEAR' },
        { type: 'turn-end' },
        { type: 'settled' } ],
    ];
    const h = mock.start({ script });
    const evts = [];
    mock.onEvent(h, e => {
      evts.push(e);
      if (e.type === 'status') mock.interrupt(h);   // re-entrant, mid-turn
    });
    mock.send(h, 'go');
    mock.send(h, 'queued behind — must be dropped too');
    assert(await until(() => count(evts, 'settled') === 2), 'interrupted turn still settles');
    eq(types(evts), ['settled', 'turn-start', 'status', 'turn-end', 'settled'],
       'tail dropped, turn-end + settled emitted');
    eq(count(evts, 'assistant-message'), 0, 'the un-emitted message never appears');
    await tick(); await tick();
    eq(count(evts, 'turn-start'), 1, 'the queued second turn was dropped with the queue');
  }

  section('[mock] idle interrupt is a no-op');
  {
    const h = mock.start({});
    const evts = attach(h);
    assert(await until(() => count(evts, 'settled') === 1), 'ready');
    mock.interrupt(h);
    await tick(); await tick(); await tick();
    eq(types(evts), ['settled'], 'no extra events from an idle interrupt');
  }

  section('[mock] stop: exit is the LAST event, session goes dead');
  {
    const h = mock.start({});
    const evts = [];
    mock.onEvent(h, e => {
      evts.push(e);
      if (e.type === 'turn-start') mock.stop(h);    // stop mid-turn
    });
    mock.send(h, 'doomed');
    assert(await until(() => count(evts, 'exit') === 1), 'exit arrives');
    eq(evts[evts.length - 1], { type: 'exit', code: 0 }, 'exit code 0, last in the stream');
    eq(count(evts, 'assistant-message'), 0, 'turn tail dropped by stop');
    const before = evts.length;
    mock.send(h, 'after stop');
    mock.interrupt(h);
    mock.stop(h);
    await tick(); await tick(); await tick();
    eq(evts.length, before, 'NOTHING follows exit — send/interrupt/stop are no-ops');
    eq(h.sent.length, 1, 'the post-stop send was not even recorded');
    allValid(evts, 'stop');
  }

  report();
})();
