/**
 * Pi backend (Slice A5) — the `pi --mode rpc` adapter, WITHOUT Pi installed:
 * unit tests pin the Pi-event → normalized mapping + the spawn argv; the
 * e2e half drives the whole backend (spawn / JSONL framing incl. the
 * U+2028-readline trap / prompt / abort / dialog auto-cancel / stop)
 * through a REAL subprocess speaking the wire protocol
 * (fixtures/fake-pi.js). Only LIVE validation needs the real pi.
 * Run: node js/test/test-agent-pi.js
 */
'use strict';

const path = require('path');
const { describe, it, section, eq, assert, report } = require('./test-runner');
const pi = require('../agent/backends/pi');
const { validateEvent, validateBackend } = require('../agent/protocol');

const FIXTURE = path.join(__dirname, 'fixtures', 'fake-pi.js');

// A minimal handle for driving _mapPiEvent purely (matches the fields the
// mapper touches; stdin.write collects the dialog auto-cancel).
function fakeHandle() {
  const writes = [];
  return {
    h: { running: false, stopping: false, exited: false,
         usage: { tokens: 0, cost: 0 }, streamBuf: '', streamLastEmit: 0,
         child: { stdin: { write: (s) => writes.push(s) } } },
    writes,
  };
}
function allValid(evts, label) {
  eq(evts.map(validateEvent).filter(Boolean), [], `${label}: all normalized events valid`);
}

describe('[pi] AgentBackend shape + spawn argv', () => {
  it('satisfies the backend interface', () => {
    eq(validateBackend(pi), null);
  });
  it('argv: bare, provider+model, provider parsed off a combined model', () => {
    eq(pi._argv({}), ['pi', '--mode', 'rpc'], 'no flags — Pi uses its own configured default');
    eq(pi._argv({ provider: 'anthropic', model: 'claude-x' }),
       ['pi', '--mode', 'rpc', '--provider', 'anthropic', '--model', 'claude-x']);
    eq(pi._argv({ model: 'openai/gpt-x' }),
       ['pi', '--mode', 'rpc', '--provider', 'openai', '--model', 'gpt-x'],
       'provider/model split on the FIRST slash');
    eq(pi._argv({ noSession: true, sessionDir: '/tmp/s' }),
       ['pi', '--mode', 'rpc', '--no-session', '--session-dir', '/tmp/s']);
    eq(pi._argv({ argv: ['node', 'fake.js'] }), ['node', 'fake.js'], 'argv override (test seam)');
  });
});

describe('[pi] event mapping: lifecycle + turns', () => {
  it('agent_start → status thinking (and marks the run live)', () => {
    const { h } = fakeHandle();
    eq(pi._mapPiEvent(h, { type: 'agent_start' }), [{ type: 'status', state: 'thinking' }]);
    eq(h.running, true);
  });
  it('turn_end → assistant-message (text parts only) + turn-end; usage accumulates', () => {
    const { h } = fakeHandle();
    const evts = pi._mapPiEvent(h, { type: 'turn_end', message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }, { type: 'thinking', thinking: 'hidden' },
                { type: 'text', text: 'world' }],
      usage: { input: 10, output: 5, cost: { total: 0.01 } },
    } });
    eq(evts, [{ type: 'assistant-message', text: 'hello\nworld' }, { type: 'turn-end' }]);
    eq(h.usage, { tokens: 15, cost: 0.01 });
    allValid(evts, 'turn_end');
  });
  it('turn_end with no text (aborted turn) → just turn-end', () => {
    const { h } = fakeHandle();
    eq(pi._mapPiEvent(h, { type: 'turn_end', message: { role: 'assistant', content: [] } }),
       [{ type: 'turn-end' }]);
  });
  it('a text_delta buffers + emits a throttled assistant-delta increment; thinking/other dropped', () => {
    const { h } = fakeHandle();
    h.streamLastEmit = 0;   // gate open (0 is far in the past)
    eq(pi._mapPiEvent(h, { type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Hel' } }),
      [{ type: 'assistant-delta', text: 'Hel' }], 'first delta emits');
    // Immediately after an emit the gate is closed → the next delta buffers.
    eq(pi._mapPiEvent(h, { type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'lo' } }), [], 'buffered within the throttle window');
    eq(h.streamBuf, 'lo', 'the buffered increment is held');
    // A thinking delta isn't streamed to the transcript.
    eq(pi._mapPiEvent(h, { type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'hm' } }), [], 'thinking not streamed');
    // turn_end discards the un-emitted tail (assistant-message carries the full text).
    const te = pi._mapPiEvent(h, { type: 'turn_end', message: { role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }] } });
    eq(h.streamBuf, '', 'buffer reset at turn_end');
    eq(te, [{ type: 'assistant-message', text: 'Hello' }, { type: 'turn-end' }]);
  });
  it('agent_settled → status idle carrying session usage, then settled', () => {
    const { h } = fakeHandle();
    h.running = true;
    h.usage = { tokens: 15, cost: 0.01 };
    const evts = pi._mapPiEvent(h, { type: 'agent_settled' });
    eq(evts, [{ type: 'status', state: 'idle', tokens: 15, cost: 0.01 }, { type: 'settled' }]);
    eq(h.running, false);
    allValid(evts, 'settled');
  });
  it('agent_settled with no usage yet omits the counters', () => {
    const { h } = fakeHandle();
    eq(pi._mapPiEvent(h, { type: 'agent_settled' }),
       [{ type: 'status', state: 'idle' }, { type: 'settled' }]);
  });
});

describe('[pi] event mapping: tools', () => {
  it('tool_execution_start/end → tool-call / tool-result (content text joined)', () => {
    const { h } = fakeHandle();
    const call = pi._mapPiEvent(h, { type: 'tool_execution_start',
      toolCallId: 'call_1', toolName: 'bash', args: { command: 'ls' } });
    eq(call, [{ type: 'tool-call', id: 'call_1', name: 'bash', args: { command: 'ls' } }]);
    const res = pi._mapPiEvent(h, { type: 'tool_execution_end',
      toolCallId: 'call_1', toolName: 'bash',
      result: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      isError: true });
    eq(res, [{ type: 'tool-result', id: 'call_1', result: 'a\nb', isError: true }]);
    allValid([...call, ...res], 'tools');
  });
});

describe('[pi] event mapping: compaction / retry / errors / responses', () => {
  it('compaction: start → compacting; end → thinking mid-run, idle at rest', () => {
    const { h } = fakeHandle();
    eq(pi._mapPiEvent(h, { type: 'compaction_start', reason: 'threshold' }),
       [{ type: 'status', state: 'compacting' }]);
    h.running = true;
    eq(pi._mapPiEvent(h, { type: 'compaction_end' }), [{ type: 'status', state: 'thinking' }]);
    h.running = false;
    eq(pi._mapPiEvent(h, { type: 'compaction_end' }), [{ type: 'status', state: 'idle' }]);
  });
  it('auto_retry: start → retrying; success → thinking; exhausted → error', () => {
    const { h } = fakeHandle();
    eq(pi._mapPiEvent(h, { type: 'auto_retry_start', attempt: 1 }),
       [{ type: 'status', state: 'retrying' }]);
    eq(pi._mapPiEvent(h, { type: 'auto_retry_end', success: true, attempt: 2 }),
       [{ type: 'status', state: 'thinking' }]);
    eq(pi._mapPiEvent(h, { type: 'auto_retry_end', success: false, finalError: '529 overloaded' }),
       [{ type: 'error', message: 'retries exhausted: 529 overloaded' }]);
  });
  it('a FAILED command response surfaces; success is ack noise', () => {
    const { h } = fakeHandle();
    eq(pi._mapPiEvent(h, { type: 'response', command: 'prompt', success: false, error: 'no model' }),
       [{ type: 'error', message: 'pi prompt failed: no model' }]);
    eq(pi._mapPiEvent(h, { type: 'response', command: 'prompt', success: true }), []);
  });
  it('extension_error → error', () => {
    const { h } = fakeHandle();
    const evts = pi._mapPiEvent(h, { type: 'extension_error', extensionPath: '/x.ts', error: 'boom' });
    eq(evts, [{ type: 'error', message: 'extension /x.ts: boom' }]);
  });
  it('unhandled event types map to nothing', () => {
    const { h } = fakeHandle();
    for (const t of ['agent_end', 'message_start', 'message_end', 'queue_update',
                     'bash_execution_update', 'summarization_retry_scheduled', 'unknown_future']) {
      eq(pi._mapPiEvent(h, { type: t }), [], `${t} ignored`);
    }
  });
});

describe('[pi] extension UI: dialogs auto-cancel, notify-errors surface', () => {
  it('a confirm dialog gets cancelled:true written back + an error event', () => {
    const { h, writes } = fakeHandle();
    const evts = pi._mapPiEvent(h, { type: 'extension_ui_request', id: 'u1',
      method: 'confirm', title: 'Allow?' });
    eq(evts, [{ type: 'error', message: 'extension dialog auto-cancelled: Allow?' }]);
    eq(JSON.parse(writes[0]), { type: 'extension_ui_response', id: 'u1', cancelled: true });
  });
  it('notify error → error; notify info + fire-and-forget UI → nothing', () => {
    const { h, writes } = fakeHandle();
    eq(pi._mapPiEvent(h, { type: 'extension_ui_request', id: 'u2', method: 'notify',
       notifyType: 'error', message: 'blocked' }),
       [{ type: 'error', message: 'blocked' }]);
    eq(pi._mapPiEvent(h, { type: 'extension_ui_request', id: 'u3', method: 'notify',
       notifyType: 'info', message: 'fyi' }), []);
    eq(pi._mapPiEvent(h, { type: 'extension_ui_request', id: 'u4', method: 'setStatus',
       statusKey: 'x', statusText: 'y' }), []);
    eq(writes.length, 0, 'no response written for non-dialog methods');
  });
});

// --- e2e through a REAL subprocess (fixtures/fake-pi.js) --------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(pred, budgetMs = 5000) {
  const step = 5;
  for (let t = 0; t < budgetMs && !pred(); t += step) await sleep(step);
  return pred();
}
const types = evts => evts.map(e => e.type);
const count = (evts, t) => evts.filter(e => e.type === t).length;

function startFake() {
  const h = pi.start({ argv: [process.execPath, FIXTURE] });
  const evts = [];
  pi.onEvent(h, e => evts.push(e));
  return { h, evts };
}

(async () => {
  const open = [];

  section('[pi e2e] spawn: nothing sync, then the session-ready settled');
  const a = startFake(); open.push(a.h);
  eq(a.evts.length, 0, 'nothing emitted in start\'s tick');
  assert(typeof a.h.pid === 'number', 'handle exposes the subprocess pid (jobs display)');
  assert(await until(() => a.evts.length >= 1), 'ready arrives');
  eq(types(a.evts), ['settled'], 'session-open settled');

  section('[pi e2e] prompt → full echo run, streamed delta, usage on the idle status');
  pi.send(a.h, 'hello', { streamingBehavior: 'steer' });
  assert(await until(() => count(a.evts, 'settled') === 2), 'run settles');
  // The fixture's echo run emits two synchronous text_deltas; the throttle
  // emits the first as an increment and folds the tail into the settle, so the
  // sequence carries assistant-delta(s) before the tool-call. Assert the
  // stable spine order and read settle facts by TYPE (delta count is timing-
  // dependent, so it's not pinned to an index).
  const spine = types(a.evts).filter(t => t !== 'assistant-delta');
  eq(spine, [
    'settled',           // session ready
    'status',            // agent_start → thinking
    'turn-start',
    'tool-call', 'tool-result',
    'assistant-message', 'turn-end',
    'status',            // agent_settled → idle + usage
    'settled',
  ], 'the spine order (deltas interleave before the tool-call)');
  assert(count(a.evts, 'assistant-delta') >= 1, 'at least one throttled delta streamed');
  eq(a.evts.find(e => e.type === 'assistant-message').text, 'pi-echo: hello', 'settled text = text parts only');
  eq(a.evts.find(e => e.type === 'status' && e.state === 'idle'),
     { type: 'status', state: 'idle', tokens: 15, cost: 0.01 }, 'session usage rides the idle status');
  allValid(a.evts, 'echo e2e');

  section('[pi e2e] framing: \\r\\n + split-chunk partial line + U+2028 inside a string');
  const b = startFake(); open.push(b.h);
  assert(await until(() => count(b.evts, 'settled') === 1), 'ready');
  pi.send(b.h, 'framing');
  assert(await until(() => count(b.evts, 'settled') === 2), 'framing run settles');
  eq(types(b.evts), ['settled', 'status', 'turn-start', 'assistant-message', 'turn-end', 'status', 'settled'],
     '\\r\\n line + two-chunk record both parsed whole');
  assert(b.evts[3].text.includes('\u2028'), 'U+2028 survived INSIDE the string (no readline split)');
  allValid(b.evts, 'framing e2e');

  section('[pi e2e] dialog auto-cancel round-trips through the real pipe');
  const c = startFake(); open.push(c.h);
  assert(await until(() => count(c.evts, 'settled') === 1), 'ready');
  pi.send(c.h, 'dialog');
  assert(await until(() => count(c.evts, 'settled') === 2),
         'fake settles ONLY after receiving the cancelled response');
  eq(count(c.evts, 'error'), 1, 'the auto-cancel is surfaced');
  assert(c.evts.find(e => e.type === 'error').message.includes('auto-cancelled'), 'says why');

  section('[pi e2e] a failed command response surfaces as an error');
  pi.send(c.h, 'badcmd');
  assert(await until(() => count(c.evts, 'error') === 2), 'failure response mapped');
  eq(c.evts[c.evts.length - 1].message, 'pi prompt failed: model not configured');

  section('[pi e2e] interrupt → abort → the turn terminates, then settles');
  const d = startFake(); open.push(d.h);
  assert(await until(() => count(d.evts, 'settled') === 1), 'ready');
  pi.send(d.h, 'hang');
  assert(await until(() => count(d.evts, 'turn-start') === 1), 'hung mid-turn');
  pi.interrupt(d.h);
  assert(await until(() => count(d.evts, 'settled') === 2), 'abort terminated the run');
  eq(count(d.evts, 'assistant-message'), 0, 'no text from the aborted turn');
  eq(types(d.evts).slice(-3), ['turn-end', 'status', 'settled'], 'clean termination tail');
  allValid(d.evts, 'interrupt e2e');

  section('[pi e2e] stop: exit is the LAST event; session goes quiet');
  const before = a.evts.length;
  pi.stop(a.h);
  assert(await until(() => count(a.evts, 'exit') === 1), 'exit arrives');
  const exitEvt = a.evts[a.evts.length - 1];
  eq(exitEvt.type, 'exit', 'exit last');
  assert(exitEvt.code === 0 || exitEvt.code === null, 'clean stdin-close exit or SIGTERM');
  assert(a.evts.length >= before, 'sanity');
  await sleep(30);
  eq(a.evts[a.evts.length - 1].type, 'exit', 'NOTHING follows exit');
  allValid(a.evts, 'stop e2e');

  section('[pi e2e] framing: a Buffer split INSIDE a multi-byte codepoint survives');
  const m = startFake(); open.push(m.h);
  assert(await until(() => count(m.evts, 'settled') === 1), 'ready');
  pi.send(m.h, 'mbsplit');
  assert(await until(() => count(m.evts, 'settled') === 2), 'mbsplit run settles');
  eq(m.evts.find(e => e.type === 'assistant-message').text, 'héllo 多字节 done',
     'the StringDecoder healed the split codepoint (no U+FFFD)');

  section('[pi e2e] streaming: text_deltas arrive as throttled assistant-delta increments');
  const strm = startFake(); open.push(strm.h);
  assert(await until(() => count(strm.evts, 'settled') === 1), 'ready');
  pi.send(strm.h, 'stream');
  assert(await until(() => count(strm.evts, 'settled') === 2), 'streaming turn settles');
  const deltas = strm.evts.filter(e => e.type === 'assistant-delta');
  assert(deltas.length >= 1, `got ${deltas.length} throttled deltas`);
  assert(deltas.every(d => typeof d.text === 'string' && d.text.length), 'each delta is a non-empty increment');
  // Increments concatenate toward (a prefix of) the settled text — the throttle
  // never drops content that isn't superseded by the settle.
  const streamed = deltas.map(d => d.text).join('');
  assert('Streaming one token at a time.'.startsWith(streamed) || streamed === '',
         `increments are a prefix of the settled text (got "${streamed}")`);
  eq(strm.evts.find(e => e.type === 'assistant-message').text, 'Streaming one token at a time.',
     'the settled message carries the full text');
  allValid(strm.evts, 'streaming e2e');

  section('[pi e2e] stdin EPIPE (child dies with pipe data pending) cannot crash');
  const k = startFake();
  assert(await until(() => count(k.evts, 'settled') === 1), 'ready');
  // 'die' exits the child while the chasing 1MiB write is still in flight —
  // the async stdin 'error' (EPIPE) was an app-killing uncaughtException
  // before the review-H1 fix (stdin error listener in start()).
  pi.send(k.h, 'die');
  pi.send(k.h, 'x'.repeat(1 << 20));
  assert(await until(() => count(k.evts, 'exit') === 1), 'lifecycle still terminates');
  eq(k.evts[k.evts.length - 1].type, 'exit', 'exit last — and the process is alive to assert it');

  section('[pi e2e] spawn failure (pi not installed): error says why, then exit');
  const bad = pi.start({ argv: ['/nonexistent-pi-binary-xyz'] });
  const badEvts = [];
  pi.onEvent(bad, e => badEvts.push(e));
  assert(await until(() => count(badEvts, 'exit') === 1), 'lifecycle still terminates');
  eq(types(badEvts), ['error', 'exit'], 'error first, exit last');
  assert(badEvts[0].message.includes('pi spawn failed'), 'names the failure');
  eq(badEvts[1].code, null, 'no exit code — it never ran');
  allValid(badEvts, 'spawn-failure');

  // Teardown — don't orphan fixture children past the test process.
  for (const h of open) pi.stop(h);
  await sleep(50);
  report();
})();
