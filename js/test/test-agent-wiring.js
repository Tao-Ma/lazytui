/**
 * Live-agent boot wiring (Slice A3) — END TO END through the REAL dispatch
 * loop with the mock backend: agent_start/send/interrupt/stop effects →
 * io/agent → backend events → wireAgentHost's handler → dispatchMsg'd
 * `agent_event` (the recorded, replayable lane) → the agent Component folds
 * the pane slice. Plus the jobs registry (real feature/jobs this time), the
 * unknown-backend error path, closed-pane straggler drop, and stopAll (the
 * cleanup hook).
 * Run: node js/test/test-agent-wiring.js
 */
'use strict';

const { section, eq, assert, report } = require('./test-runner');
const route = require('../panel/route');
const api = require('../panel/api');
const effects = require('../dispatch/runtime/effects');
const { wireAgentHost } = require('../dispatch/runtime/host-wiring');
const agentComp = require('../panel/agent/agent');
const agentIo = require('../io/agent');
const jobs = require('../feature/jobs');
const diag = require('../io/diag-log');

const tick = () => new Promise(r => setImmediate(r));
async function until(pred, budget = 100) {
  for (let i = 0; i < budget && !pred(); i++) await tick();
  return pred();
}

// Harness: the wiring under test + the Component in the registry + synthetic
// pane instances (A4's mint path arrives with the pane; the loop routes by
// instance id either way).
jobs._reset();
wireAgentHost();
api.registerComponent(agentComp);
function mint(id) {
  route.setInstance(id, 'agent', agentComp.init(id, null));
  return () => route.getInstance(id).slice;
}
const jobFor = (id) => jobs.snapshot().find(j => j.owner && j.owner.agentId === id);

(async () => {
  section('[wiring] agent_start: session + job, ready folds through the real loop');
  const s1 = mint('agent-1');
  effects.runEffects([{ type: 'agent_start', id: 'agent-1', cfg: { backend: 'mock', label: 'e2e agent' } }]);
  assert(!!agentIo.getSession('agent-1'), 'session opened');
  const j1 = jobFor('agent-1');
  eq([j1 && j1.kind, j1 && j1.label, j1 && j1.status], ['agent', 'e2e agent', 'running'],
     'REAL jobs registry carries the session');
  eq(s1().status.state, 'starting', 'nothing folded synchronously');
  assert(await until(() => s1().status.state === 'idle'),
         'ready settled reached the slice via dispatchMsg(agent_event)');

  section('[wiring] agent_send: the echo turn folds into the pane slice');
  effects.runEffects([{ type: 'agent_send', id: 'agent-1', text: 'hello fabric' }]);
  assert(await until(() => s1().transcript.some(l => l.includes('echo: hello fabric'))),
         'assistant text landed in the transcript');
  assert(await until(() => s1().status.state === 'idle'), 'status settled back to idle');

  section('[wiring] agent_interrupt mid-turn drops the un-folded tail');
  const s3 = mint('agent-3');
  const script = [[
    { type: 'turn-start' },
    { type: 'tool-call', id: 't', name: 'slowtool', args: {} },
    { type: 'assistant-message', text: 'SHOULD NOT FOLD' },
    { type: 'turn-end' },
    { type: 'settled' },
  ]];
  effects.runEffects([{ type: 'agent_start', id: 'agent-3', cfg: { backend: 'mock', script } }]);
  assert(await until(() => s3().status.state === 'idle'), 'ready');
  effects.runEffects([{ type: 'agent_send', id: 'agent-3', text: 'go' }]);
  assert(await until(() => s3().transcript.some(l => l.includes('slowtool'))), 'tool-call folded');
  effects.runEffects([{ type: 'agent_interrupt', id: 'agent-3' }]);   // same frame as the fold
  assert(await until(() => s3().status.state === 'idle'), 'interrupted turn still settles');
  eq(s3().transcript.some(l => l.includes('SHOULD NOT FOLD')), false, 'tail never folded');

  section('[wiring] stop (io-level): exit folds, job closes, session goes dead');
  agentIo.stop('agent-1');
  assert(await until(() => s1().status.state === 'exited'), 'exit folded to status');
  assert(s1().transcript.some(l => l.includes('Session ended (exit 0)')), 'end line in transcript');
  eq([jobFor('agent-1').status, jobFor('agent-1').exitCode], ['exited', 0], 'job closed');
  const len = s1().transcript.length;
  effects.runEffects([{ type: 'agent_send', id: 'agent-1', text: 'ghost' }]);
  await tick(); await tick(); await tick();
  eq(s1().transcript.length, len, 'send to a dead session folds nothing');

  section('[wiring] unknown backend: error folds into the pane, no session');
  diag.clear();
  const s2 = mint('agent-2');
  effects.runEffects([{ type: 'agent_start', id: 'agent-2', cfg: { backend: 'nope' } }]);
  assert(s2().transcript.some(l => l.includes("unknown agent backend 'nope'")),
         'the pane says WHY (synchronous error fold)');
  eq(agentIo.getSession('agent-2'), null, 'no session opened');
  assert(!jobFor('agent-2'), 'no job registered');
  assert(diag.snapshot().some(d => d.code === 'agent' && d.level === 'error'), 'diag-logged');

  section('[wiring] events for a pane with no instance are dropped silently');
  effects.runEffects([{ type: 'agent_start', id: 'nowhere-1', cfg: { backend: 'mock' } }]);
  effects.runEffects([{ type: 'agent_send', id: 'nowhere-1', text: 'into the void' }]);
  assert(await until(() => {
    const h = agentIo.getSession('nowhere-1').handle;
    return h.queue.length === 0;
  }), 'turn played to nobody, no crash');
  agentIo.stop('nowhere-1');
  assert(await until(() => agentIo.getSession('nowhere-1').exited), 'session still closes cleanly');

  section('[wiring] agent_event folds THROUGH the free-config gate (review MED)');
  {
    const s6 = mint('agent-6');
    effects.runEffects([{ type: 'agent_start', id: 'agent-6', cfg: { backend: 'mock' } }]);
    assert(await until(() => s6().status.state === 'idle'), 'ready');
    require('../model/store').getModel().modes.freeConfigMode = true;
    try {
      effects.runEffects([{ type: 'agent_send', id: 'agent-6', text: 'under free-config' }]);
      assert(await until(() => s6().transcript.some(l => l.includes('echo: under free-config'))),
             'the async event stream keeps folding (no transcript loss)');
      assert(await until(() => s6().status.state === 'idle'), 'lifecycle events pass too — no wedge');
      // The exemption is EVENTS-ONLY: a user-gesture agent Msg stays gated.
      const { dispatchMsg } = require('../dispatch/runtime/loop');
      dispatchMsg(route.wrap('agent-6', { type: 'agent_input', key: 'z', seq: 'z', selfId: 'agent-6' }));
      eq(s6().inputDraft.text, '', 'agent_input still gated under free-config');
    } finally {
      require('../model/store').getModel().modes.freeConfigMode = false;
    }
  }

  section('[wiring] jobs overlay: an agent job routes to its owning pane (review M1)');
  {
    // The pure jobs_routed arm — the jobs_route effect threads
    // agentPaneId/agentPoolId (resolved from owner.agentId); the arm emits
    // the jump cascade without any route read.
    const jobsModal = require('../dispatch/update/modal/jobs');
    const model0 = require('../model/store').getModel();
    const [, jcmds] = jobsModal.update(model0, {
      type: 'jobs_routed',
      job: { kind: 'agent', owner: { agentId: 'agent-1' } },
      agentPaneId: 'col-x', agentPoolId: 'agent-1',
    });
    eq(jcmds, [
      { type: 'msg', msg: { kind: 'layout', msg: { type: 'set_active_tab', paneId: 'col-x', tabPoolId: 'agent-1' } } },
      { type: 'msg', msg: { kind: 'layout', msg: { type: 'focus_set', focus: 'col-x' } } },
    ], 'jump cascade: activate the tab, focus the pane');
    const [, none] = jobsModal.update(model0, {
      type: 'jobs_routed', job: { kind: 'agent', owner: { agentId: 'ghost' } },
      agentPaneId: null, agentPoolId: null,
    });
    eq(none, [], 'an unresolvable owner (disposed pane) emits nothing');
  }

  section('[wiring] stopAll (the cleanup hook) stops every live session');
  const s4 = mint('agent-4');
  const s5 = mint('agent-5');
  effects.runEffects([
    { type: 'agent_start', id: 'agent-4', cfg: { backend: 'mock' } },
    { type: 'agent_start', id: 'agent-5', cfg: { backend: 'mock' } },
  ]);
  assert(await until(() => s4().status.state === 'idle' && s5().status.state === 'idle'), 'both ready');
  agentIo.stopAll();
  assert(await until(() => s4().status.state === 'exited' && s5().status.state === 'exited'),
         'both sessions exit-folded');
  eq([jobFor('agent-4').status, jobFor('agent-5').status], ['exited', 'exited'], 'both jobs closed');

  report();
})();
