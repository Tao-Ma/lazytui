/**
 * v0.6.2 Phase 4.1 — feature/jobs.js registry API.
 *
 *   register / update / close / list / clearCompleted lifecycle.
 *   Unique jobId generation, idempotent close, unknown-id no-ops,
 *   newest-first ordering.
 *
 * Run: node js/test/test-jobs.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const jobs = require('../feature/jobs');

function reset() { jobs._reset(); }

describe('[register] generates ids + seeds running state', () => {
  it('returns a unique jobId, status=running', () => {
    reset();
    const id = jobs.register({ kind: 'stream-routed', label: 'a', pid: 1, owner: {} });
    assert(typeof id === 'string' && id.length > 0, 'id is a non-empty string');
    assert(id.startsWith('job-'), 'id has expected prefix');
    const [j] = jobs.list();
    eq(j.id, id);
    eq(j.kind, 'stream-routed');
    eq(j.label, 'a');
    eq(j.pid, 1);
    eq(j.status, 'running');
    eq(j.exitCode, null);
    eq(j.endedAt, null);
    assert(typeof j.startedAt === 'number' && j.startedAt > 0, 'startedAt is a ms timestamp');
  });

  it('two registers in the same ms still produce distinct ids', () => {
    reset();
    const a = jobs.register({ kind: 'pty', label: 'x', pid: 100, owner: {} });
    const b = jobs.register({ kind: 'pty', label: 'y', pid: 101, owner: {} });
    assert(a !== b, 'sequence counter disambiguates ids generated in the same ms');
  });

  it('pid=null and missing pid both normalise to null', () => {
    reset();
    jobs.register({ kind: 'tmux', label: 't', pid: null, owner: {} });
    jobs.register({ kind: 'tmux', label: 't2', owner: {} });
    const all = jobs.list();
    eq(all[0].pid, null);
    eq(all[1].pid, null);
  });

  it('null/undefined owner normalises to {}', () => {
    reset();
    const id = jobs.register({ kind: 'pty', label: 'x', pid: 1 });
    const [j] = jobs.list();
    eq(j.owner, {});
  });
});

describe('[update] shallow-merges, no-op on unknown id', () => {
  it('merges patch into the job', () => {
    reset();
    const id = jobs.register({ kind: 'pty', label: 'a', pid: 1, owner: { ptyId: 'g_a' } });
    jobs.update(id, { label: 'b' });
    const [j] = jobs.list();
    eq(j.label, 'b');
    eq(j.pid, 1);
    eq(j.owner.ptyId, 'g_a', 'owner survives merge (not replaced)');
  });

  it('unknown id is a no-op', () => {
    reset();
    jobs.update('job-not-registered', { label: 'oops' });
    eq(jobs.list().length, 0);
  });

  it('null/undefined patch is a no-op', () => {
    reset();
    const id = jobs.register({ kind: 'pty', label: 'a', pid: 1, owner: {} });
    jobs.update(id, null);
    jobs.update(id, undefined);
    eq(jobs.list()[0].label, 'a');
  });
});

describe('[close] flips status, sets endedAt + exitCode, idempotent', () => {
  it('closes a running job', () => {
    reset();
    const id = jobs.register({ kind: 'stream-routed', label: 'a', pid: 1, owner: {} });
    jobs.close(id, { status: 'exited', exitCode: 0 });
    const [j] = jobs.list();
    eq(j.status, 'exited');
    eq(j.exitCode, 0);
    assert(j.endedAt && j.endedAt >= j.startedAt, 'endedAt >= startedAt');
  });

  it('killed status path', () => {
    reset();
    const id = jobs.register({ kind: 'stream-routed', label: 'a', pid: 1, owner: {} });
    jobs.close(id, { status: 'killed' });
    const [j] = jobs.list();
    eq(j.status, 'killed');
    eq(j.exitCode, null);
  });

  it('default args → status=exited, exitCode=null', () => {
    reset();
    const id = jobs.register({ kind: 'pty', label: 'a', pid: 1, owner: {} });
    jobs.close(id);
    const [j] = jobs.list();
    eq(j.status, 'exited');
    eq(j.exitCode, null);
  });

  it('closing an already-closed job is a no-op', () => {
    reset();
    const id = jobs.register({ kind: 'pty', label: 'a', pid: 1, owner: {} });
    jobs.close(id, { status: 'exited', exitCode: 0 });
    const firstEndedAt = jobs.list()[0].endedAt;
    jobs.close(id, { status: 'killed', exitCode: 99 });
    const [j] = jobs.list();
    eq(j.status, 'exited', 'status frozen at first close');
    eq(j.exitCode, 0,       'exitCode frozen at first close');
    eq(j.endedAt, firstEndedAt, 'endedAt frozen');
  });

  it('unknown id is a no-op', () => {
    reset();
    jobs.close('job-no-such', { status: 'exited' });
    eq(jobs.list().length, 0);
  });
});

describe('[list] newest-first ordering', () => {
  it('orders by startedAt desc', () => {
    reset();
    // Spaced out so startedAt is monotonically increasing per call.
    const a = jobs.register({ kind: 'pty', label: 'a', pid: 1, owner: {} });
    // tiny busy-wait so Date.now() advances at least 1ms
    const t0 = Date.now(); while (Date.now() === t0) { /* spin */ }
    const b = jobs.register({ kind: 'pty', label: 'b', pid: 2, owner: {} });
    const all = jobs.list();
    eq(all.length, 2);
    eq(all[0].id, b, 'most-recent first');
    eq(all[1].id, a);
  });
});

describe('[clearCompleted] drops closed entries, keeps running', () => {
  it('keeps running + drops exited/killed', () => {
    reset();
    const a = jobs.register({ kind: 'pty', label: 'a', pid: 1, owner: {} });
    const b = jobs.register({ kind: 'pty', label: 'b', pid: 2, owner: {} });
    const c = jobs.register({ kind: 'pty', label: 'c', pid: 3, owner: {} });
    jobs.close(a, { status: 'exited' });
    jobs.close(c, { status: 'killed' });
    jobs.clearCompleted();
    const all = jobs.list();
    eq(all.length, 1);
    eq(all[0].id, b, 'only the running entry survives');
  });
});

report();
