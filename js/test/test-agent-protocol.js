/**
 * Live-agent protocol (Slice A0) — the normalized event vocabulary +
 * AgentBackend shape-check. This file PINS the contract of
 * docs/live-agent.md §"The backend-adapter seam": every backend (mock, Pi)
 * and the whole A1–A5 pipeline build against exactly these shapes.
 * Run: node js/test/test-agent-protocol.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { validateEvent, validateBackend, STATUS_STATES } = require('../agent/protocol');
const mock = require('../agent/backends/mock');

// One canonical valid sample per vocabulary type — the contract in data form.
const SAMPLES = {
  'turn-start':        { type: 'turn-start' },
  'assistant-delta':   { type: 'assistant-delta', text: 'tok' },
  'assistant-message': { type: 'assistant-message', text: 'hello' },
  'tool-call':         { type: 'tool-call', id: 't1', name: 'bash', args: { cmd: 'ls' } },
  'tool-result':       { type: 'tool-result', id: 't1', result: 'ok', isError: false },
  'status':            { type: 'status', state: 'thinking', tokens: 1200, cost: 0.03 },
  'turn-end':          { type: 'turn-end' },
  'settled':           { type: 'settled' },
  'error':             { type: 'error', message: 'boom' },
  'exit':              { type: 'exit', code: 0 },
};

describe('[agent] the 10-event vocabulary', () => {
  it('every vocabulary type validates', () => {
    for (const [t, evt] of Object.entries(SAMPLES)) {
      eq(validateEvent(evt), null, `${t} sample is valid`);
    }
  });
  it('the vocabulary is CLOSED — unknown types are invalid', () => {
    assert(validateEvent({ type: 'message_update' }) !== null, 'a backend-native type is rejected');
    assert(validateEvent({ type: 'bogus' }) !== null, 'an unknown type is rejected');
    assert(validateEvent({}) !== null, 'a missing type is rejected');
  });
  it('non-object events are invalid, never a crash', () => {
    assert(validateEvent(null) !== null, 'null');
    assert(validateEvent('settled') !== null, 'string');
    assert(validateEvent([{ type: 'settled' }]) !== null, 'array');
  });
  it('unknown EXTRA fields on a known type are allowed (adapter meta)', () => {
    eq(validateEvent({ type: 'settled', ts: 123, backend: 'pi' }), null);
  });
});

describe('[agent] per-type field contracts', () => {
  it('assistant-delta carries exactly one of text|thinking', () => {
    eq(validateEvent({ type: 'assistant-delta', thinking: 'hm' }), null, 'thinking-only ok');
    assert(validateEvent({ type: 'assistant-delta' }) !== null, 'neither rejected');
    assert(validateEvent({ type: 'assistant-delta', text: 'a', thinking: 'b' }) !== null, 'both rejected');
    assert(validateEvent({ type: 'assistant-delta', text: 5 }) !== null, 'non-string rejected');
  });
  it('assistant-message needs text (empty string ok — tool-only turns simply omit the event)', () => {
    eq(validateEvent({ type: 'assistant-message', text: '' }), null);
    assert(validateEvent({ type: 'assistant-message' }) !== null, 'missing text rejected');
  });
  it('tool-call needs id + name; args optional but an object when present', () => {
    eq(validateEvent({ type: 'tool-call', id: 't1', name: 'bash' }), null, 'args optional');
    assert(validateEvent({ type: 'tool-call', name: 'bash' }) !== null, 'missing id');
    assert(validateEvent({ type: 'tool-call', id: '', name: 'bash' }) !== null, 'empty id');
    assert(validateEvent({ type: 'tool-call', id: 't1' }) !== null, 'missing name');
    assert(validateEvent({ type: 'tool-call', id: 't1', name: 'bash', args: 'ls' }) !== null, 'string args');
    assert(validateEvent({ type: 'tool-call', id: 't1', name: 'bash', args: null }) !== null, 'null args');
  });
  it('tool-result needs id; isError a boolean when present', () => {
    eq(validateEvent({ type: 'tool-result', id: 't1' }), null, 'result itself is any JSON value, even absent');
    assert(validateEvent({ type: 'tool-result', result: 'ok' }) !== null, 'missing id');
    assert(validateEvent({ type: 'tool-result', id: 't1', isError: 'no' }) !== null, 'non-boolean isError');
  });
  it('status.state is the closed STATUS_STATES set', () => {
    for (const s of STATUS_STATES) {
      eq(validateEvent({ type: 'status', state: s }), null, `state '${s}' ok`);
    }
    assert(validateEvent({ type: 'status', state: 'busy' }) !== null, 'novel state rejected — adapters must map');
    assert(validateEvent({ type: 'status' }) !== null, 'missing state rejected');
  });
  it('status tokens/cost are finite numbers when present', () => {
    assert(validateEvent({ type: 'status', state: 'idle', tokens: 'many' }) !== null, 'string tokens');
    assert(validateEvent({ type: 'status', state: 'idle', tokens: NaN }) !== null, 'NaN tokens');
    assert(validateEvent({ type: 'status', state: 'idle', cost: Infinity }) !== null, 'Infinity cost');
  });
  it('error needs a non-empty message', () => {
    assert(validateEvent({ type: 'error' }) !== null, 'missing message');
    assert(validateEvent({ type: 'error', message: '' }) !== null, 'empty message');
  });
  it('exit needs code: number, or null when signal-killed', () => {
    eq(validateEvent({ type: 'exit', code: null }), null, 'signal-killed');
    eq(validateEvent({ type: 'exit', code: 137 }), null, 'nonzero code');
    assert(validateEvent({ type: 'exit' }) !== null, 'missing code');
    assert(validateEvent({ type: 'exit', code: '0' }) !== null, 'string code');
  });
});

describe('[agent] AgentBackend shape-check', () => {
  it('the mock backend satisfies the interface', () => {
    eq(validateBackend(mock), null);
  });
  it('rejects non-objects and a missing name', () => {
    assert(validateBackend(null) !== null, 'null');
    assert(validateBackend({}) !== null, 'no name');
  });
  it('names the missing method in the error', () => {
    const b = { name: 'partial', start() {}, send() {}, interrupt() {}, stop() {} };
    const err = validateBackend(b);
    assert(err && err.includes('onEvent'), `got: ${err}`);
  });
  it('optional setModel/setThinking must be functions when present', () => {
    const base = { name: 'x', start() {}, send() {}, interrupt() {}, stop() {}, onEvent() {} };
    eq(validateBackend({ ...base, setModel() {} }), null, 'function ok');
    assert(validateBackend({ ...base, setModel: true }) !== null, 'non-function rejected');
  });
});

report();
