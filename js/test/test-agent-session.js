/**
 * io/agent session host (Slice A1) — lifecycle + the event edge, driven via
 * the mock backend: start registers a job and fans events to the injected
 * handler, interrupt cancels, stop closes the job, invalid backend events
 * are dropped (diag-logged), a throwing handler can't kill the pump, and
 * the module runs standalone with no hooks wired (io-leaf posture).
 * Run: node js/test/test-agent-session.js
 */
'use strict';

const { section, eq, assert, report } = require('./test-runner');
const host = require('../io/agent');
const mock = require('../agent/backends/mock');
const diag = require('../io/diag-log');

const tick = () => new Promise(r => setImmediate(r));
async function until(pred, budget = 100) {
  for (let i = 0; i < budget && !pred(); i++) await tick();
  return pred();
}
const types = evts => evts.map(e => e.evt.type);
const count = (evts, t) => evts.filter(e => e.evt.type === t).length;

/** Fresh hooks per section: event collector + fake jobs registry + render counter. */
function wire() {
  host._reset();
  const evts = [];              // { id, evt }
  const jobs = { registered: [], closed: [] };
  let renders = 0;
  host.setEventHandler((id, evt) => evts.push({ id, evt }));
  host.setJobsHooks({
    register(info) { jobs.registered.push(info); return `job-${jobs.registered.length}`; },
    close(id, info) { jobs.closed.push({ id, ...info }); },
  });
  host.setRenderHook(() => { renders++; });
  return { evts, jobs, renders: () => renders };
}

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}

(async () => {
  section('[io/agent] leaf posture: runs standalone with no hooks wired');
  {
    host._reset();
    const s = host.start('a1', mock, {});
    assert(!!s && !s.exited, 'session starts untracked');
    host.send('a1', 'hi');
    assert(await until(() => s.handle.queue.length === 0), 'turn plays with nobody listening');
    await tick();
    eq(host.getSession('a1'), s, 'session reachable via getSession');
  }

  section('[io/agent] start: job registered, ready event fans out, render hook fires');
  {
    const { evts, jobs, renders } = wire();
    host.start('a1', mock, { label: 'helper agent' });
    eq(jobs.registered.length, 1, 'one job registered at start');
    eq(jobs.registered[0].kind, 'agent', 'kind agent');
    eq(jobs.registered[0].label, 'helper agent', 'cfg.label names the job');
    eq(jobs.registered[0].owner, { agentId: 'a1', backend: 'mock' }, 'owner carries id + backend');
    eq(jobs.registered[0].pid, null, 'mock has no pid');
    assert(await until(() => evts.length >= 1), 'ready event arrives');
    eq(evts[0], { id: 'a1', evt: { type: 'settled' } }, 'handler receives (id, evt)');
    assert(renders() >= 1, 'render hook fired on delivery');
  }

  section('[io/agent] start is idempotent while live; label defaults to backend name');
  {
    const { jobs } = wire();
    const s1 = host.start('a1', mock, {});
    const s2 = host.start('a1', mock, {});
    assert(s1 === s2, 'same live session returned');
    eq(jobs.registered.length, 1, 'no second job');
    eq(jobs.registered[0].label, 'mock agent', 'default label');
  }

  section('[io/agent] send routes to the backend; sessions are independent');
  {
    const { evts } = wire();
    host.start('a1', mock, {});
    host.start('a2', mock, {});
    host.send('a1', 'ping', { via: 'test' });
    assert(await until(() => count(evts, 'settled') === 3), 'two readies + one turn settle');
    const a1 = evts.filter(e => e.id === 'a1');
    const a2 = evts.filter(e => e.id === 'a2');
    eq(types(a1), ['settled', 'turn-start', 'status', 'assistant-message', 'turn-end', 'settled'],
       'the echo turn lands on a1 only');
    eq(types(a2), ['settled'], 'a2 saw nothing but its ready');
    eq(host.getSession('a1').handle.sent, [{ message: 'ping', opts: { via: 'test' } }],
       'message reached the backend');
    host.send('ghost', 'nobody home');   // unknown id → no-op, no throw
    eq(count(evts, 'settled'), 3, 'unknown-id send is a no-op');
  }

  section('[io/agent] interrupt cancels the in-flight turn through the host');
  {
    const { evts } = wire();
    const script = [[
      { type: 'turn-start' },
      { type: 'status', state: 'thinking' },
      { type: 'assistant-message', text: 'SHOULD NOT APPEAR' },
      { type: 'turn-end' },
      { type: 'settled' },
    ]];
    host.setEventHandler((id, evt) => {
      evts.push({ id, evt });
      if (evt.type === 'status') host.interrupt('a1');   // re-entrant, mid-turn
    });
    host.start('a1', mock, { script });
    host.send('a1', 'go');
    assert(await until(() => count(evts, 'settled') === 2), 'interrupted turn settles');
    eq(count(evts, 'assistant-message'), 0, 'tail dropped');
    eq(types(evts), ['settled', 'turn-start', 'status', 'turn-end', 'settled'], 'turn terminated cleanly');
  }

  section('[io/agent] stop: exit closes the job once, session goes dead, calls become no-ops');
  {
    const { evts, jobs } = wire();
    const s = host.start('a1', mock, {});
    assert(await until(() => count(evts, 'settled') === 1), 'ready');
    host.stop('a1');
    assert(await until(() => count(evts, 'exit') === 1), 'exit fans out');
    eq(jobs.closed, [{ id: 'job-1', status: 'exited', exitCode: 0 }], 'job closed with the exit code');
    eq([s.exited, s.exitCode], [true, 0], 'session marked dead');
    const before = evts.length;
    host.send('a1', 'after stop');
    host.interrupt('a1');
    host.stop('a1');
    await tick(); await tick(); await tick();
    eq(evts.length, before, 'send/interrupt/stop on a dead session are no-ops');
    eq(jobs.closed.length, 1, 'no double close');
  }

  section('[io/agent] restart after exit replaces the dead session');
  {
    const { evts, jobs } = wire();
    const s1 = host.start('a1', mock, {});
    host.stop('a1');
    assert(await until(() => count(evts, 'exit') === 1), 'first session exited');
    const s2 = host.start('a1', mock, {});
    assert(s1 !== s2, 'fresh session under the same id');
    eq(jobs.registered.length, 2, 'a second job for the restart');
    // The FIRST session's ready was legitimately dropped (stop landed before
    // its delivery tick; exit is last) — so exactly one settled: the new ready.
    assert(await until(() => count(evts, 'settled') === 1), 'fresh ready from the new session');
  }

  section('[io/agent] a misbehaving backend: invalid events dropped + diag-logged, valid pass');
  {
    const { evts } = wire();
    diag.clear();
    // An inline second backend — also proves the host is backend-agnostic.
    const rogue = {
      name: 'rogue',
      start() { return { cb: null }; },
      onEvent(h, cb) { h.cb = cb; },
      send(h) {
        setImmediate(() => {
          h.cb({ type: 'message_update', data: 'native idiom' });   // invalid: unknown type
          h.cb({ type: 'status' });                                 // invalid: missing state
          h.cb({ type: 'assistant-message', text: 'still alive' }); // valid
        });
      },
      interrupt() {}, stop() {},
    };
    host.start('r1', rogue, {});
    host.send('r1', 'go');
    assert(await until(() => evts.length >= 1), 'the valid event arrives');
    eq(types(evts), ['assistant-message'], 'both invalid events dropped');
    const warns = diag.snapshot().filter(d => d.code === 'agent');
    eq(warns.length, 2, 'each drop diag-logged');
    assert(warns[0].message.includes('rogue'), 'diag names the backend');
  }

  section('[io/agent] a throwing event handler cannot kill the pump');
  {
    const { evts } = wire();
    diag.clear();
    host.setEventHandler((id, evt) => {
      if (evt.type === 'turn-start') throw new Error('handler boom');
      evts.push({ id, evt });
    });
    host.start('a1', mock, {});
    host.send('a1', 'hi');
    assert(await until(() => count(evts, 'settled') === 2), 'later events still delivered');
    eq(count(evts, 'assistant-message'), 1, 'the turn completed past the throw');
    const errs = diag.snapshot().filter(d => d.code === 'agent' && d.level === 'error');
    eq(errs.length, 1, 'the throw is diag-logged');
  }

  section('[io/agent] a malformed backend throws at start (wire-up error)');
  {
    host._reset();
    assert(throws(() => host.start('x', { name: 'bad' })), 'missing methods rejected');
    assert(throws(() => host.start('x', null)), 'null backend rejected');
    eq(host.getSession('x'), null, 'nothing tracked after the throw');
  }

  host._reset();
  report();
})();
