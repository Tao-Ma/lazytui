/**
 * Smoke — the live-agent pane (Slice A4), end-to-end through the REAL
 * input→dispatch→effect→io→event→reducer→render pipeline with the mock
 * backend: `:agent` mints the pane, Enter activates agent mode (idempotent
 * session start), typing composes the draft, Enter sends (echo turn folds
 * into the rendered transcript), Esc leaves, and closing the tab destroys
 * the session via orphan-dispose.
 *
 * Run: node js/scripts/run-smoke.js   (or node js/test/smoke/agent-pane.js)
 */
'use strict';

const { section, eq, assert, report } = require('../test-runner');
const sm = require('./_helpers/smoke');
const api = sm.api;
const route = sm.route;
const { getModel } = require('../../app/runtime');
const { dispatchMsg } = require('../../dispatch/runtime/loop');
const { wireAgentHost } = require('../../dispatch/runtime/host-wiring');
const paint = require('../../render/paint');
const agentIo = require('../../io/agent');
const jobs = require('../../feature/jobs');
const mpane = require('../../leaves/wm/pane');

const key = (k, seq) => sm.capture(() => sm.handleKey(k, seq || k));
const type = (s) => { for (const ch of s) key(ch, ch); };
// Full-frame content read (the cell-diff renderer emits sparse frames after
// the first paint — forceFullRepaint makes the next render complete).
const frame = () => { paint.forceFullRepaint(); return sm.capture(() => sm.render()).frame; };

const tick = () => new Promise(r => setImmediate(r));
async function until(pred, budget = 100) {
  for (let i = 0; i < budget && !pred(); i++) await tick();
  return pred();
}

// The agent Component isn't in the test-runner auto-set; register + wire the
// host seam exactly as production boot does.
if (!api.getComponent('agent')) api.registerComponent(require('../../panel/agent/agent'));
wireAgentHost();

sm.bootFresh();
sm.resize(120, 40);

function agentInstance() {
  let found = null;
  route.eachInstance(inst => { if (inst.kind === 'agent') found = inst; });
  return found;
}

(async () => {
  section('[agent smoke] :agent mints the pane; chrome renders status + draft ghost');
  type(':');
  type('agent');
  key('return');
  const inst = agentInstance();
  assert(!!inst, 'agent instance minted');
  eq(inst.slice.descriptor.backend, 'mock', 'default backend');
  assert(route.activeInstanceOf(route.getFocus()) === inst.id, 'mint focus-followed; agent tab active');
  let f = frame();
  assert(f.includes('· not started'), 'status line renders pre-start');
  assert(f.includes('› Enter to chat'), 'draft ghost renders');
  eq(agentIo.getSession(inst.id), null, 'no session yet — lazy start');

  section('[agent smoke] Enter activates: mode on, session starts, goes idle');
  key('return');
  eq(getModel().modes.agentMode, true, 'agent mode entered');
  assert(!!agentIo.getSession(inst.id), 'session started');
  assert(await until(() => inst.slice.status.state === 'idle'), 'ready settled folded');
  assert(frame().includes('· idle'), 'status line tracks the fold');

  section('[agent smoke] typing composes the draft; Enter sends; echo folds + renders');
  type('hi');
  eq(inst.slice.inputDraft.text, 'hi', 'draft composed');
  assert(frame().includes('› hi'), 'draft renders in the input row');
  key('return');
  eq(inst.slice.inputDraft.text, '', 'draft cleared on send');
  assert(await until(() => inst.slice.transcript.some(l => l.includes('echo: hi'))), 'echo turn folded');
  assert(await until(() => inst.slice.status.state === 'idle'), 'settled after the turn');
  f = frame();
  assert(f.includes('› hi'), 'user line rendered in the transcript');
  assert(f.includes('echo: hi'), 'assistant line rendered');

  section('[agent smoke] Esc leaves agent mode; keys fall back to the framework');
  key('escape');
  eq(getModel().modes.agentMode, false, 'mode left (idle → exit, not interrupt)');
  key('j', 'j');
  eq(inst.slice.inputDraft.text, '', 'j no longer types into the draft');

  section('[agent smoke] closing the tab destroys the session (orphan-dispose)');
  const jobEntry = () => jobs.snapshot().find(j => j.owner && j.owner.agentId === inst.id);
  eq(jobEntry().status, 'running', 'job live before close');
  dispatchMsg(api.wrap('layout', {
    type: 'remove_tab', paneId: inst.paneId, tabPoolId: mpane.poolIdOf(inst.id),
  }));
  assert(!agentInstance(), 'instance disposed');
  eq(agentIo.getSession(inst.id), null, 'session destroyed + forgotten');
  eq(jobEntry().status, 'killed', 'job closed as killed');

  report();
})();
