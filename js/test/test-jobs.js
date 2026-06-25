/**
 * v0.6.2 Phase 4.1 — feature/jobs.js registry API.
 *
 *   register / update / close / snapshot / clearCompleted lifecycle.
 *   Unique jobId generation, idempotent close, unknown-id no-ops,
 *   newest-first ordering. Plus the FIX-1 store-mirror seam + jobs_synced arm.
 *
 * Run: node js/test/test-jobs.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const jobs = require('../feature/jobs');
const runtime = require('../app/runtime');

function reset() { jobs._reset(); }

describe('[register] generates ids + seeds running state', () => {
  it('returns a unique jobId, status=running', () => {
    reset();
    const id = jobs.register({ kind: 'stream-routed', label: 'a', pid: 1, owner: {} });
    assert(typeof id === 'string' && id.length > 0, 'id is a non-empty string');
    assert(id.startsWith('job-'), 'id has expected prefix');
    const [j] = jobs.snapshot();
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
    const all = jobs.snapshot();
    eq(all[0].pid, null);
    eq(all[1].pid, null);
  });

  it('null/undefined owner normalises to {}', () => {
    reset();
    const id = jobs.register({ kind: 'pty', label: 'x', pid: 1 });
    const [j] = jobs.snapshot();
    eq(j.owner, {});
  });
});

describe('[update] shallow-merges, no-op on unknown id', () => {
  it('merges patch into the job', () => {
    reset();
    const id = jobs.register({ kind: 'pty', label: 'a', pid: 1, owner: { ptyId: 'g_a' } });
    jobs.update(id, { label: 'b' });
    const [j] = jobs.snapshot();
    eq(j.label, 'b');
    eq(j.pid, 1);
    eq(j.owner.ptyId, 'g_a', 'owner survives merge (not replaced)');
  });

  it('unknown id is a no-op', () => {
    reset();
    jobs.update('job-not-registered', { label: 'oops' });
    eq(jobs.snapshot().length, 0);
  });

  it('null/undefined patch is a no-op', () => {
    reset();
    const id = jobs.register({ kind: 'pty', label: 'a', pid: 1, owner: {} });
    jobs.update(id, null);
    jobs.update(id, undefined);
    eq(jobs.snapshot()[0].label, 'a');
  });
});

describe('[close] flips status, sets endedAt + exitCode, idempotent', () => {
  it('closes a running job', () => {
    reset();
    const id = jobs.register({ kind: 'stream-routed', label: 'a', pid: 1, owner: {} });
    jobs.close(id, { status: 'exited', exitCode: 0 });
    const [j] = jobs.snapshot();
    eq(j.status, 'exited');
    eq(j.exitCode, 0);
    assert(j.endedAt && j.endedAt >= j.startedAt, 'endedAt >= startedAt');
  });

  it('killed status path', () => {
    reset();
    const id = jobs.register({ kind: 'stream-routed', label: 'a', pid: 1, owner: {} });
    jobs.close(id, { status: 'killed' });
    const [j] = jobs.snapshot();
    eq(j.status, 'killed');
    eq(j.exitCode, null);
  });

  it('default args → status=exited, exitCode=null', () => {
    reset();
    const id = jobs.register({ kind: 'pty', label: 'a', pid: 1, owner: {} });
    jobs.close(id);
    const [j] = jobs.snapshot();
    eq(j.status, 'exited');
    eq(j.exitCode, null);
  });

  it('closing an already-closed job is a no-op', () => {
    reset();
    const id = jobs.register({ kind: 'pty', label: 'a', pid: 1, owner: {} });
    jobs.close(id, { status: 'exited', exitCode: 0 });
    const firstEndedAt = jobs.snapshot()[0].endedAt;
    jobs.close(id, { status: 'killed', exitCode: 99 });
    const [j] = jobs.snapshot();
    eq(j.status, 'exited', 'status frozen at first close');
    eq(j.exitCode, 0,       'exitCode frozen at first close');
    eq(j.endedAt, firstEndedAt, 'endedAt frozen');
  });

  it('unknown id is a no-op', () => {
    reset();
    jobs.close('job-no-such', { status: 'exited' });
    eq(jobs.snapshot().length, 0);
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
    const all = jobs.snapshot();
    eq(all.length, 2);
    eq(all[0].id, b, 'most-recent first');
    eq(all[1].id, a);
  });
});

// --- Reducer arms — jobs_open / jobs_close / jobs_nav ----------------------

function _newModel() {
  // Build a fresh root model. setModel re-installs it as the live ref.
  const m = runtime.init();
  runtime.setModel(m);
  return m;
}

describe('[jobs_open] flips jobsMode + resets cursor/scroll', () => {
  it('opens with cursor=0 scroll=0', () => {
    let m = _newModel();
    m = { ...m, modal: { ...m.modal, jobs: { cursor: 5, scroll: 3 } } };
    runtime.setModel(m);
    const [next, cmds] = runtime.update(m, { type: 'jobs_open', now: 123 });
    eq(next.modes.jobsMode, true);
    eq(next.modal.jobs.cursor, 0, 'cursor reset');
    eq(next.modal.jobs.scroll, 0, 'scroll reset');
    // Opening an age overlay seeds model.now; the frame clock ticks via the
    // model-conditional `clock` interval Sub (FIX-3 Phase 6), so the open arm
    // emits NO Cmd (was an arm_clock).
    eq(next.now, 123, 'now seeded from msg.now');
    eq(cmds.length, 0, 'no Cmd — the clock is a declared Sub, not an armed tick');
  });
  it('idempotent — opening when already open is a no-op', () => {
    let m = _newModel();
    m = { ...m, modes: { ...m.modes, jobsMode: true } };
    runtime.setModel(m);
    const [next, cmds] = runtime.update(m, { type: 'jobs_open' });
    assert(next === m, 'same ref');
    eq(cmds.length, 0);
  });
});

describe('[jobs_close] flips jobsMode off; idempotent', () => {
  it('closes from open', () => {
    let m = _newModel();
    m = { ...m, modes: { ...m.modes, jobsMode: true } };
    runtime.setModel(m);
    const [next, cmds] = runtime.update(m, { type: 'jobs_close' });
    eq(next.modes.jobsMode, false);
    eq(cmds.length, 0);
  });
  it('no-op when not open', () => {
    let m = _newModel();
    runtime.setModel(m);
    const [next, cmds] = runtime.update(m, { type: 'jobs_close' });
    assert(next === m, 'same ref');
  });
});

describe('[clock_tick] advances model.now (cadence is the `clock` interval Sub)', () => {
  it('advances model.now from msg.now — NO re-arm Cmd (FIX-3 Phase 6)', () => {
    let m = _newModel();
    m = { ...m, modes: { ...m.modes, jobsMode: true } };
    runtime.setModel(m);
    const [next, cmds] = runtime.update(m, { type: 'clock_tick', now: 5000 });
    eq(next.now, 5000, 'now advanced');
    eq(cmds.length, 0, 'no re-arm — the `clock` interval Sub drives cadence');
  });
  it('advances now regardless of overlay state (the Sub gates declaration, not the arm)', () => {
    let m = _newModel();   // both overlays closed
    runtime.setModel(m);
    const [next, cmds] = runtime.update(m, { type: 'clock_tick', now: 6000 });
    eq(next.now, 6000, 'now advances');
    eq(cmds.length, 0, 'no Cmd');
  });
});

describe('[clock Sub] declared only while an age overlay is open', () => {
  const state = require('../app/state');
  it('jobsMode → a `clock` interval Sub is in the desired set; closed → not', () => {
    const open = state._desiredSubs({ modes: { jobsMode: true } });
    assert(open.has('interval:clock:1000'), 'clock interval declared while jobs overlay open');
    const closed = state._desiredSubs({ modes: {} });
    assert(!closed.has('interval:clock:1000'), 'no clock interval when no age overlay is open');
  });
});

describe('[setOnChange] store-mirror seam (FIX-1)', () => {
  it('fires cb on every mutation (register/update/close/clearCompleted); null unregisters', () => {
    reset();
    let fires = 0;
    jobs.setOnChange(() => { fires++; });
    const id = jobs.register({ kind: 'pty', label: 'a', pid: 1, owner: {} });
    eq(fires, 1, 'register fired');
    jobs.update(id, { label: 'b' });
    eq(fires, 2, 'update fired');
    jobs.close(id, { status: 'exited', exitCode: 0 });
    eq(fires, 3, 'close fired');
    jobs.clearCompleted();
    eq(fires, 4, 'clearCompleted fired');
    jobs.setOnChange(null);             // unregister
    jobs.register({ kind: 'pty', label: 'c', pid: 2, owner: {} });
    eq(fires, 4, 'no fire after setOnChange(null)');
    jobs.setOnChange(null); reset();
  });
});

describe('[jobs_synced] arm lands the snapshot on model.jobs (FIX-1)', () => {
  it('whole-snapshot write + render Cmd', () => {
    const snap = [{ id: 'job-1', kind: 'pty', label: 'x', status: 'running' }];
    const [m, cmds] = runtime.update({ jobs: [] }, { type: 'jobs_synced', jobs: snap });
    eq(m.jobs, snap, 'model.jobs is the synced snapshot');
    // jobs_synced arrives via the store-mirror's ctx.applyMsg (no implicit
    // repaint); the render Cmd is what repaints the Running overlay / running-
    // glyph on an async status flip (v0.6.6 pre-release review regression fix).
    eq(cmds.length, 1, 'one Cmd'); eq(cmds[0].type, 'render', 'render Cmd repaints');
  });
});

describe('[jobs_nav] clamps + scrolls', () => {
  function withCursor(m, cursor, scroll = 0) {
    return { ...m, modal: { ...m.modal, jobs: { cursor, scroll } } };
  }
  it('dir=+1 advances cursor', () => {
    let m = _newModel();
    m = withCursor(m, 0);
    runtime.setModel(m);
    const [next] = runtime.update(m, { type: 'jobs_nav', dir: +1, count: 5, vh: 3 });
    eq(next.modal.jobs.cursor, 1);
  });
  it('clamps at top (cursor=0, dir=-1) → no-op', () => {
    let m = _newModel();
    m = withCursor(m, 0);
    runtime.setModel(m);
    const [next] = runtime.update(m, { type: 'jobs_nav', dir: -1, count: 5, vh: 3 });
    assert(next === m, 'no-op when clamped');
  });
  it('clamps at bottom (cursor + scroll both at end → no-op)', () => {
    let m = _newModel();
    m = withCursor(m, 4, 2);  // vh=3 → cursor visible at scroll=2..4
    runtime.setModel(m);
    const [next] = runtime.update(m, { type: 'jobs_nav', dir: +1, count: 5, vh: 3 });
    assert(next === m, 'no-op when at bottom');
  });
  it('to=top / to=bottom', () => {
    let m = _newModel();
    m = withCursor(m, 3);
    runtime.setModel(m);
    let [next] = runtime.update(m, { type: 'jobs_nav', to: 'top', count: 5, vh: 3 });
    eq(next.modal.jobs.cursor, 0);
    [next] = runtime.update(m, { type: 'jobs_nav', to: 'bottom', count: 5, vh: 3 });
    eq(next.modal.jobs.cursor, 4);
  });
  it('scroll advances when cursor leaves viewport', () => {
    let m = _newModel();
    m = withCursor(m, 2);  // vh=3 → scroll=0 fits cursor 0..2
    runtime.setModel(m);
    const [next] = runtime.update(m, { type: 'jobs_nav', dir: +1, count: 10, vh: 3 });
    eq(next.modal.jobs.cursor, 3);
    eq(next.modal.jobs.scroll, 1, 'scroll bumped so cursor stays visible');
  });
  it('scroll retreats when cursor moves above viewport', () => {
    let m = _newModel();
    m = withCursor(m, 4, 4);  // cursor==scroll, vh=3 → cursor is on first visible
    runtime.setModel(m);
    const [next] = runtime.update(m, { type: 'jobs_nav', dir: -1, count: 10, vh: 3 });
    eq(next.modal.jobs.cursor, 3);
    eq(next.modal.jobs.scroll, 3, 'scroll dragged with cursor');
  });
  it('to=pageup / to=pagedown jump by vh', () => {
    let m = _newModel();
    m = withCursor(m, 5, 3);
    runtime.setModel(m);
    let [next] = runtime.update(m, { type: 'jobs_nav', to: 'pagedown', count: 20, vh: 4 });
    eq(next.modal.jobs.cursor, 9, 'cursor += vh');
    [next] = runtime.update(m, { type: 'jobs_nav', to: 'pageup', count: 20, vh: 4 });
    eq(next.modal.jobs.cursor, 1, 'cursor -= vh');
  });
  it('empty list (count=0) → no-op', () => {
    let m = _newModel();
    runtime.setModel(m);
    const [next] = runtime.update(m, { type: 'jobs_nav', dir: +1, count: 0, vh: 3 });
    assert(next === m);
  });
});

// --- Tab-strip running indicator (Phase 4.4) -------------------------------

describe('[tab-strip indicator] ● prepended when a stream-routed job is running', () => {
  const widgets = require('../panel/viewer/tab-strip');
  const tabInfo = {
    actionTabs: [['make-check', { label: 'Test' }], ['lint', { label: 'Lint' }]],
    termTabs: [],
    contentTabs: [],
    // v0.6.2: total = 1 (Info) + 1 (Transcript) + 2 actions + 0 + 0 = 4
    total: 4,
  };

  it('no running jobs → no prefix', () => {
    const built = widgets.buildTabStrip(tabInfo, 0, 'd', new Set());
    eq(built.title, '\\[Info]─Transcript─Test─Lint');
  });

  it('one running → exactly that action tab gets the ● prefix', () => {
    const built = widgets.buildTabStrip(tabInfo, 0, 'd', new Set(['make-check']));
    eq(built.title, '\\[Info]─Transcript─[yellow]●[/]Test─Lint');
  });

  it('multiple running → both tabs prefixed', () => {
    const built = widgets.buildTabStrip(tabInfo, 0, 'd', new Set(['make-check', 'lint']));
    eq(built.title, '\\[Info]─Transcript─[yellow]●[/]Test─[yellow]●[/]Lint');
  });

  it('running set covers an inactive tab; running tab itself wears both ● + active wrap', () => {
    // tab idx 2 = make-check (Info=0, Transcript=1, make-check=2).
    const built = widgets.buildTabStrip(tabInfo, 2, 'd', new Set(['make-check']));
    eq(built.title, 'Info─Transcript─\\[[yellow]●[/]Test]─Lint');
  });

  it('omitting the set → no prefix (back-compat)', () => {
    const built = widgets.buildTabStrip(tabInfo, 0, 'd');
    eq(built.title, '\\[Info]─Transcript─Test─Lint');
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
    const all = jobs.snapshot();
    eq(all.length, 1);
    eq(all[0].id, b, 'only the running entry survives');
  });
});

report();
