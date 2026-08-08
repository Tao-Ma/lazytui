/**
 * action-status — the powerline-style action-status line on a text-view output
 * pane: a right-aligned status stamp floated at the end of the output
 * (live spinner + duration while running; a permanent `✓ Done · …` line on
 * completion, replacing the plain `Done.`/`Exit N` footer). Pins:
 *   - the pure derivation leaf (resolveConfig, jobForPane, statusLine forms),
 *   - the text-view `tv_status` reducer arm (append + record statusRows) and
 *     the tv_stream_start reset,
 *   - render() right-aligning stored status rows to the pane width,
 *   - the global-config wiring (schema validate + mergeGlobal lift),
 *   - end-to-end: a running action's live chip on the rendered frame.
 *
 * Run: node js/test/test-action-status.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const astatus = require('../leaves/infra/action-status');
const { stripMarkup } = require('../leaves/text/ansi');
const { validateGlobal } = require('../parser/schema');
const { mergeGlobal } = require('../parser/global');
const { update } = require('../dispatch/update/reducer');
const tv = require('../panel/text-view/text-view');

const TAGS = { success: 'green', warning: 'yellow', error: 'red' };
const line = (outcome, now, cfg) => stripMarkup(astatus.statusLine(outcome, now, cfg, TAGS));

const exited0 = { status: 'exited', exitCode: 0, startedAt: 1000, endedAt: 3300 };  // 2.3s
const exited2 = { status: 'exited', exitCode: 2, startedAt: 1000, endedAt: 1450 };  // 450ms
const killed = { status: 'killed', signal: 'SIGTERM', startedAt: 1000, endedAt: 2200 };
const running = { status: 'running', startedAt: 1000 };

describe('[action-status] resolveConfig', () => {
  it('defaults to all three segments, enabled + live', () => {
    eq(astatus.resolveConfig(undefined), { enabled: true, segments: ['status', 'duration', 'time'], live: true });
    eq(astatus.resolveConfig(true), { enabled: true, segments: ['status', 'duration', 'time'], live: true });
  });
  it('false disables entirely', () => {
    eq(astatus.resolveConfig(false), { enabled: false, segments: [], live: false });
  });
  it('honors enabled / live flags; filters unknown segments in order', () => {
    eq(astatus.resolveConfig({ enabled: false }).enabled, false);
    eq(astatus.resolveConfig({ live: false }).live, false);
    eq(astatus.resolveConfig({ segments: ['time', 'bogus', 'status'] }).segments, ['time', 'status']);
  });
});

describe('[action-status] jobForPane', () => {
  const jobs = [
    { kind: 'stream-routed', startedAt: 30, owner: { tabInstId: 'b' } },
    { kind: 'stream-unrouted', startedAt: 20, owner: { cmd: 'x' } },
    { kind: 'stream-routed', startedAt: 10, owner: { tabInstId: 'a' } },
  ];
  it('matches a routed tab by owner.tabInstId (newest first)', () => {
    eq(astatus.jobForPane(jobs, 'b', false).startedAt, 30);
    eq(astatus.jobForPane(jobs, 'a', false).startedAt, 10);
  });
  it('no match → null', () => {
    eq(astatus.jobForPane(jobs, 'zzz', false), null);
    eq(astatus.jobForPane(null, 'a', false), null);
  });
  it('Transcript matches the most-recent unrouted job by kind', () => {
    eq(astatus.jobForPane(jobs, 'transcript', true).startedAt, 20);
  });
});

describe('[action-status] statusLine', () => {
  it('exit 0 → ✓ · duration · finish time (glyph only, middot-joined)', () => {
    const s = line(exited0, 9999);
    assert(s.includes('✓'), s);
    assert(!/Done/.test(s), `no word: ${s}`);
    assert(s.includes(' · '), `middot separator: ${s}`);
    assert(s.includes('2.3s'), s);
    assert(/\d\d:\d\d:\d\d/.test(s), `has clock time: ${s}`);
  });
  it('non-zero exit → ✗ N (glyph + code, no word)', () => {
    const s = line(exited2, 9999);
    assert(s.includes('✗ 2') && !/Exit/.test(s), s);
    assert(s.includes('450ms'), s);
  });
  it('killed → ⊗ SIG (glyph + signal, no word)', () => {
    const s = line(killed, 9999);
    assert(s.includes('⊗ SIGTERM') && !/Killed/.test(s), s);
  });
  it('running → live duration from now, NO finish time yet', () => {
    const s = line(running, 2000);  // 2000-1000 = 1.0s
    assert(s.includes('1.0s'), s);
    assert(!/\d\d:\d\d:\d\d/.test(s), `no clock time while running: ${s}`);
  });
  it('duration rolls over to hours past 60m', () => {
    const longRun = { status: 'exited', exitCode: 0, startedAt: 0, endedAt: 3600000 + 5 * 60000 };  // 1h05m
    assert(line(longRun, 0, { segments: ['duration'] }).includes('1h05m'), line(longRun, 0, { segments: ['duration'] }));
  });
  it('status glyph is ALWAYS shown (never silent failure), even when segments omit it', () => {
    // A failing command with segments that drop 'status' must still show ✗.
    const f = line(exited2, 9999, { segments: ['duration'] });
    assert(f.includes('✗ 2'), `failure visible without status segment: ${f}`);
    // Running + time-only would suppress the time mid-run → glyph still floats.
    assert(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(line(running, 2000, { segments: ['time'] })), 'running spinner still shown');
  });
  it('segment order honored; disabled → empty', () => {
    const s = line(exited0, 9999, { segments: ['duration', 'status'] });
    assert(s.indexOf('2.3s') < s.indexOf('✓'), s);
    eq(line(exited0, 9999, false), '');
    eq(astatus.statusLine(null, 0, undefined, TAGS), '');
  });
});

describe('[action-status] clock_tick emits a render Cmd (live-line repaint)', () => {
  it('the reducer arm returns a render Cmd so the floating line repaints', () => {
    const [next, cmds] = update({ now: 0 }, { type: 'clock_tick', now: 5 });
    eq(next.now, 5);
    assert(Array.isArray(cmds) && cmds.some((c) => c && c.type === 'render'), `render Cmd present: ${JSON.stringify(cmds)}`);
  });
});

describe('[action-status] tv_status reducer arm', () => {
  it('appends the status line and records its buffer index', () => {
    let s = tv.init('p1');
    s = tv.update({ type: 'tv_append_lines', lines: ['$ build', 'compiling'] }, s);
    s = tv.update({ type: 'tv_status', line: '[green]✓ Done[/]' }, s);
    eq(s.lines.length, 3);
    eq(s.statusRows, [2]);
    // A second command in the same buffer (Transcript accretion) records another.
    s = tv.update({ type: 'tv_append', line: '$ test' }, s);
    s = tv.update({ type: 'tv_status', line: '[red]✗ Exit 1[/]' }, s);
    eq(s.statusRows, [2, 4]);
  });
  it('tv_stream_start (re-run reseed) clears statusRows', () => {
    let s = tv.init('p1');
    s = tv.update({ type: 'tv_status', line: '[green]✓ Done[/]' }, s);
    eq(s.statusRows.length, 1);
    s = tv.update({ type: 'tv_stream_start', header: '$ build' }, s);
    eq(s.statusRows, []);
    eq(s.lines, ['$ build']);
  });
});

describe('[action-status] render right-aligns status rows', () => {
  const render = tv.panelTypes['text-view'].render;
  it('a status row is flushed right; ordinary output stays left', () => {
    let s = tv.init('p1');
    s = tv.update({ type: 'tv_append_lines', lines: ['$ build', 'compiling'] }, s);
    s = tv.update({ type: 'tv_status', line: '[green]✓[/] · [dim]1.2s[/]' }, s);
    s = { ...s, scroll: 0 };  // show from the top (innerH isn't stamped in this unit context)
    const rows = render({ paneId: 'p1', hotkey: null }, 30, 8, s, {}).split('\n').map(stripMarkup);
    const statusRow = rows.find((r) => r.includes('1.2s'));
    const buildRow = rows.find((r) => r.includes('$ build'));
    assert(/ {10,}✓ · 1\.2s.$/.test(statusRow), `status right-aligned: ${JSON.stringify(statusRow)}`);
    assert(buildRow.indexOf('$ build') <= 1, `output stays left: ${JSON.stringify(buildRow)}`);
  });
});

describe('[action-status] global-config wiring', () => {
  it('validateGlobal honors action_status (mapping + boolean shorthands)', () => {
    const out = validateGlobal({ action_status: { enabled: true, segments: ['status', 'time'], live: false } }, []);
    eq(out.action_status.segments, ['status', 'time']);
    eq(validateGlobal({ action_status: false }, []).action_status, false);
  });
  it('rejects an unknown key, unknown segment, and non-boolean flag', () => {
    let threw = false;
    try { validateGlobal({ action_status: { segmnets: ['status'] } }, []); } catch (e) { threw = /unknown key/.test(e.message); }
    assert(threw, 'typo key must throw (checkUnknownKeys)');
    threw = false;
    try { validateGlobal({ action_status: { segments: ['status', 'nope'] } }, []); } catch (e) { threw = /unknown segment 'nope'/.test(e.message); }
    assert(threw, 'unknown segment must throw');
    threw = false;
    try { validateGlobal({ action_status: { enabled: 'yes' } }, []); } catch (e) { threw = /must be a boolean/.test(e.message); }
    assert(threw, 'non-boolean enabled must throw');
  });
  it('mergeGlobal lifts action_status onto the merged config (global-only key)', () => {
    eq(mergeGlobal({ groups: {} }, { action_status: { segments: ['status'] } }).action_status, { segments: ['status'] });
  });
});

// End-to-end through the real dispatch + render: a running action's live chip
// floats (right-aligned) at the end of its output pane. Proves the render glue
// in text-view._runningLine (route.activeInstanceOf → jobForPane by
// owner.tabInstId → statusLine → right-align → painted frame). Mirrors
// test-action-tab-route's boot; requiring test-runner (top) wires the host.
describe('[action-status] end-to-end: live running line', () => {
  const sm = require('./smoke/_helpers/smoke');
  const route = require('../panel/route');
  const { getModel } = require('../app/runtime');
  const { runAction, killAll } = require('../dispatch/runtime/action-runner');
  if (!sm.api.getComponent('text-view')) sm.api.registerComponent(require('../panel/text-view/text-view'));
  const ACT = { key: 'build', label: 'build', type: 'run', script: 'sleep 5', tab: true };

  it('shows a spinner + live 0ms duration on the running tab, no finish time yet', () => {
    sm.bootFresh({ groups: { g1: { name: 'g1', label: 'G1', containers: [], children: [], parent: null, depth: 0, quick: false, actions: { build: ACT } } } });
    sm.resize(100, 30);
    assert(route.resolveViewerPaneId(), 'a viewer slot resolves');

    runAction('build', ACT);
    const runningJob = (getModel().jobs || []).find((j) => j.kind === 'stream-routed' && j.status === 'running');
    assert(runningJob, 'a running stream job is registered + mirrored to model.jobs');

    const frame = sm.capture(sm.render).frame;
    const spinners = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    assert(frame.includes('0ms'), 'live running duration is on the frame');
    assert(spinners.some((s) => frame.includes(s)), 'running spinner glyph is on the frame');

    killAll();
  });
});

// Finding #1 regression (the top review defect): the frame-clock Sub must ARM
// while a stream job runs and TEAR DOWN when it ends — via the reconcile gate,
// which previously ignored model.jobs and so left the clock frozen-on-start /
// leaked-on-end. Driven directly (a running-job model → reconcile) rather than
// through the async jobs_synced dispatch, which drains a tick later.
describe('[action-status] reconcile arms/tears down the live clock', () => {
  const sm = require('./smoke/_helpers/smoke');
  const state = require('../app/state');
  const { getModel } = require('../app/runtime');
  const hasClock = () => state._liveSubKeys().some((k) => /clock/.test(k));

  it('a running stream job arms the clock; ending it tears the clock down', () => {
    sm.bootFresh({ groups: { g1: { name: 'g1', label: 'G1', containers: [], children: [], parent: null, depth: 0, quick: false, actions: {} } } });
    const m = getModel();
    assert(!hasClock(), 'idle: no clock sub');

    m.jobs = [{ id: 'j1', status: 'running', kind: 'stream-routed', startedAt: 1, owner: {} }];
    state.reconcileSubscriptions(m);
    assert(hasClock(), 'clock arms while a stream job runs');

    m.jobs = [{ id: 'j1', status: 'exited', kind: 'stream-routed', startedAt: 1, endedAt: 2, exitCode: 0, owner: {} }];
    state.reconcileSubscriptions(m);
    assert(!hasClock(), 'clock tears down when the job ends (no leaked idle tick)');
  });

  it('respects action_status.live=false (no clock even while running)', () => {
    const m = getModel();
    m.config = { action_status: { live: false } };
    m.jobs = [{ id: 'j2', status: 'running', kind: 'stream-routed', startedAt: 1, owner: {} }];
    state.reconcileSubscriptions(m);
    assert(!hasClock(), 'live:false → clock stays off');
    m.config = {};
  });
});

report();
