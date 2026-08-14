/**
 * Live-agent replay (Slice A6) — the property docs/live-agent.md promises:
 * because the transcript + status are MODELED and every coarse event enters
 * the dispatch loop as a recorded `agent_event` Msg, folding the recorded
 * WAL reconstructs the agent pane WITHOUT re-calling any LLM — and effects
 * are suppressed, so `agent_start`/`agent_send` never spawn a backend
 * (no side-channel, no `agent` WAL kind, unlike the terminal's byte stream).
 *
 * Folds a synthetic-but-shape-exact WAL (comp-lane wrapped Msgs — exactly
 * what the recorder captures from a live session, incl. the agent_activate /
 * Enter-send whose LIVE dispatch spawned a session) through the REAL replay
 * path, forward and seeking back, asserting the reconstructed slice at each
 * frame AND that io/agent + jobs stay untouched.
 * Run: node js/test/test-agent-replay.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');   // wires panel-host
const route = require('../panel/route');
const api = require('../panel/api');
const replay = require('../dispatch/runtime/replay');
const { wireAgentHost } = require('../dispatch/runtime/host-wiring');
const agentComp = require('../panel/agent/agent');
const agentIo = require('../io/agent');
const jobs = require('../feature/jobs');

// Production-parity setup: the host seam wired, the Component registered.
wireAgentHost();
if (!api.getComponent('agent')) api.registerComponent(agentComp);

function seed(cfg) {
  agentIo._reset();
  wireAgentHost();          // _reset drops the hooks; re-wire like boot
  jobs._reset();
  route.setInstance('agent-1', 'agent', agentComp.init('agent-1', cfg ? { paneDef: { config: cfg } } : null));
}
const slice = () => route.getInstance('agent-1').slice;

// One recorded live session, as the WAL captures it: comp-lane wrapped Msgs.
// The activate + Enter-send entries are the ones whose LIVE dispatch ran
// agent_start / agent_send effects — under replay they must fold model-only.
const W = (msg) => ({ kind: 'msg', lane: 'comp', msg: { kind: 'agent-1', msg } });
const WAL = [
  W({ type: 'agent_activate', selfId: 'agent-1' }),
  W({ type: 'agent_event', evt: { type: 'settled' } }),
  W({ type: 'agent_input', key: 'h', seq: 'h', selfId: 'agent-1' }),
  W({ type: 'agent_input', key: 'i', seq: 'i', selfId: 'agent-1' }),
  W({ type: 'agent_input', key: 'return', seq: '\r', selfId: 'agent-1' }),      // ← live: spawned + sent
  W({ type: 'agent_event', evt: { type: 'turn-start' } }),
  W({ type: 'agent_event', evt: { type: 'tool-call', id: 't1', name: 'bash', args: { cmd: 'ls' } } }),
  W({ type: 'agent_event', evt: { type: 'tool-result', id: 't1', result: 'ok' } }),
  W({ type: 'agent_event', evt: { type: 'assistant-message', text: 'two files' } }),
  W({ type: 'agent_event', evt: { type: 'turn-end' } }),
  W({ type: 'agent_event', evt: { type: 'status', state: 'idle', tokens: 15, cost: 0.01 } }),
  W({ type: 'agent_event', evt: { type: 'settled' } }),
];
const FULL_TRANSCRIPT = [
  '[accent]› hi[/]',
  '[dim]→ bash({"cmd":"ls"})[/]',
  '[dim]← ok[/]',
  'two files',
];

describe('[agent-replay] the recorded Msg log reconstructs the pane, effect-free', () => {
  it('full fold: transcript + status + draft all reconstructed', () => {
    seed();
    replay.replayEntries(WAL);
    eq(slice().transcript, FULL_TRANSCRIPT);
    eq(slice().status, { state: 'idle', tokens: 15, cost: 0.01, tool: null });
    eq(slice().inputDraft, { text: '', cursor: 0 }, 'draft cleared by the replayed send');
  });
  it('THE property: no backend ever spawns — agent_start/agent_send are suppressed', () => {
    seed();
    replay.replayEntries(WAL);
    eq(agentIo.getSession('agent-1'), null, 'io/agent untouched');
    eq(jobs.snapshot(), [], 'no job registered');
  });
  it('mid-turn frame: the tool call is visible, the settled text is not yet', () => {
    seed();
    replay.replayEntries(WAL.slice(0, 8));   // through tool-result
    eq(slice().transcript, FULL_TRANSCRIPT.slice(0, 3));
    eq(slice().status.state, 'thinking', 'turn still in flight at this frame');
  });
  it('seeking BACK (re-fold a shorter prefix from base) rewinds the transcript', () => {
    seed();
    const base = replay.snapshotState();
    replay.replayEntries(WAL);
    eq(slice().transcript.length, 4, 'at the end');
    replay.replayEntries(WAL.slice(0, 5), { fromState: base });   // just after Enter
    eq(slice().transcript, ['[accent]› hi[/]'], 'only the user line at the earlier frame');
    eq(slice().status.state, 'idle', 'pre-turn status at that frame');
  });
});

describe('[agent-replay] throttled streaming deltas rebuild the preview, settle clears it', () => {
  const W2 = (evt) => ({ kind: 'msg', lane: 'comp', msg: { kind: 'agent-1', msg: { type: 'agent_event', evt } } });
  const deltas = [
    W2({ type: 'turn-start' }),
    W2({ type: 'assistant-delta', text: 'Hel' }),
    W2({ type: 'assistant-delta', text: 'lo' }),
  ];
  it('replaying delta Msgs reconstructs the streaming preview progressively', () => {
    seed();
    replay.replayEntries(deltas);
    eq(slice().streaming, 'Hello', 'the throttled increments re-folded into the preview');
    eq(slice().transcript, [], 'nothing settled yet');
  });
  it('folding the settle on top clears the preview + lands the transcript line', () => {
    seed();
    replay.replayEntries([...deltas, W2({ type: 'assistant-message', text: 'Hello' }), W2({ type: 'settled' })]);
    eq(slice().streaming, '', 'settle cleared the preview');
    eq(slice().transcript, ['Hello'], 'the settled text is the transcript line');
  });
});

describe('[agent-replay] the ring cap replays identically (checkpoints stay small)', () => {
  it('a capped transcript folds to the same last-N under replay', () => {
    seed({ cap: 3 });
    const msgs = Array.from({ length: 5 }, (_, i) =>
      W({ type: 'agent_event', evt: { type: 'assistant-message', text: `l${i}` } }));
    replay.replayEntries(msgs);
    eq(slice().transcript, ['l2', 'l3', 'l4'], 'front-dropped exactly as live');
  });
});

report();
