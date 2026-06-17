/**
 * v0.6.2 Phase 4.3 — Enter on a Running-overlay row jumps to the
 * job's tab/pane and closes the overlay.
 *
 * Drives the `jobs_activate` Msg directly (the handler is a one-liner;
 * everything happens in the reducer cascade). Walks each kind:
 *   stream-routed   → tab_switch to action tab + focus viewer
 *   stream-unrouted → focus viewer (no tab change)
 *   pty             → tab_switch to terminal tab + terminal_enter
 *   background      → viewer set to info card (kind/pid/age/cmd)
 *   tmux            → viewer set to info card (window name)
 *
 * Run: node js/test/test-jobs-activate.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const runtime = require('../app/runtime');
const jobs = require('../feature/jobs');
const dispatch = require('../dispatch/control/dispatch');
const api = require('../panel/api');

const NOW = 1717420000000;  // fixed timestamp for deterministic age math

function _seedModel() {
  const m = runtime.init();
  m.config = {
    groups: {
      g: {
        label: 'G',
        actions: {
          'make-check': { label: 'Test', script: 'make check', tab: 'Test' },
        },
        terminals: { shell: { cmd: 'bash', label: 'Shell' } },
      },
    },
  };
  m.currentGroup = 'g';
  runtime.setModel(m);
  return m;
}

function _resetJobs() { jobs._reset(); }

function _activate() {
  // R2 — production handler resolves the cursor's job entry and threads
  // it via msg.job (reducer stays pure). Mirror that here in tests so
  // the reducer arm receives msg.job, not the bare cursor lookup.
  const m = runtime.getModel();
  const cursor = (m.modal && m.modal.jobs && m.modal.jobs.cursor | 0) || 0;
  const job = jobs.list()[cursor] || null;
  dispatch.applyMsg({ type: 'jobs_activate', now: NOW, job });
}

describe('[jobs_activate] full cascade — one Msg, reducer-driven', () => {
  function setup(jobInfo) {
    _seedModel();
    _resetJobs();
    runtime.setModel({
      ...runtime.getModel(),
      modes: { ...runtime.getModel().modes, jobsMode: true },
      modal: { ...runtime.getModel().modal, jobs: { cursor: 0, scroll: 0 } },
    });
    return jobs.register(jobInfo);
  }

  it('stream-routed → closes overlay, switches to action tab', () => {
    setup({
      kind: 'stream-routed',
      label: 'make-check',
      pid: 1,
      owner: { tabKey: 'make-check', groupName: 'g', cmd: 'make check' },
    });
    _activate();
    eq(runtime.getModel().modes.jobsMode, false, 'overlay closed');
    eq(api.getInstanceSlice('detail').tab, 2, 'tab_switch landed on action tab idx 2 (Info=0, Transcript=1, make-check=2)');
    eq(api.getInstanceSlice('layout').focus, 'detail', 'focus on viewer pane');
  });

  it('stream-unrouted → closes overlay, focus moves to viewer; no tab change', () => {
    setup({
      kind: 'stream-unrouted',
      label: 'docker logs nginx',
      pid: 2,
      owner: { cmd: 'docker logs nginx' },
    });
    const sliceBefore = { ...api.getInstanceSlice('detail'), tab: 0 };
    require('../panel/route').setInstanceSlice('detail', sliceBefore);
    _activate();
    eq(runtime.getModel().modes.jobsMode, false);
    eq(api.getInstanceSlice('detail').tab, 0, 'tab unchanged');
    eq(api.getInstanceSlice('layout').focus, 'detail', 'focus on viewer');
  });

  it('pty → tab_switch to terminal tab + terminal_enter', () => {
    setup({
      kind: 'pty',
      label: 'bash',
      pid: 3,
      owner: { ptyId: 'g_shell', cmd: 'bash' },
    });
    _activate();
    eq(runtime.getModel().modes.jobsMode, false);
    // v0.6.2 tab strip: [Info, Transcript, make-check, shell, ...]. shell
    // is termTab idx 0 → absolute tab = 2 + actionTabs.length(1) = 3.
    eq(api.getInstanceSlice('detail').tab, 3, 'tab_switch landed on terminal tab idx 3');
    eq(runtime.getModel().modes.terminalMode, true, 'terminal_enter fired');
  });

  it('background → viewer shows info card, no tab switch', () => {
    setup({
      kind: 'background',
      label: 'bg-rsync',
      pid: 12345,
      owner: { cmd: 'rsync -av src/ dst/' },
    });
    _activate();
    eq(runtime.getModel().modes.jobsMode, false);
    // v0.6.2 T2c — job-info card writes slice.viewerOverride via
    // setViewerContent; render's viewerLines() consults override first.
    const ov = api.getInstanceSlice('detail').viewerOverride;
    assert(ov && Array.isArray(ov.lines) && ov.lines.length > 0, 'viewer has override lines');
    assert(ov.lines[0].includes('bg-rsync'), 'header has label');
    assert(ov.lines.some(l => l.includes('pid:') && l.includes('12345')), 'pid line present');
    assert(ov.lines.some(l => l.includes('rsync -av src/ dst/')), 'cmd line present');
    eq(api.getInstanceSlice('layout').focus, 'detail', 'focus moved to viewer');
  });

  it('tmux → viewer shows info card with window name', () => {
    setup({
      kind: 'tmux',
      label: 'worker',
      pid: null,
      owner: { tmuxWindowName: 'worker', cmd: 'long-job.sh' },
    });
    _activate();
    eq(runtime.getModel().modes.jobsMode, false);
    const ov = api.getInstanceSlice('detail').viewerOverride;
    assert(ov && Array.isArray(ov.lines), 'override populated');
    assert(ov.lines.some(l => l.includes('window:') && l.includes('worker')), 'window line present');
    assert(ov.lines.some(l => l.includes('long-job.sh')), 'cmd line present');
  });

  it('empty list (cursor on nothing) → close only, no crash', () => {
    _seedModel();
    _resetJobs();
    runtime.setModel({
      ...runtime.getModel(),
      modes: { ...runtime.getModel().modes, jobsMode: true },
      modal: { ...runtime.getModel().modal, jobs: { cursor: 0, scroll: 0 } },
    });
    _activate();
    eq(runtime.getModel().modes.jobsMode, false);
  });

  it('cross-group routed → set_current_group fires with msg.name (not msg.group)', () => {
    // Regression for B1: jobs_activate's cross-group cascade emitted
    // { type: 'set_current_group', group: ... } but the reducer reads
    // msg.name, so cross-group activation silently set currentGroup to ''.
    _seedModel();
    _resetJobs();
    // Add a second group `g2` with its own action.
    const m = runtime.getModel();
    m.config.groups.g2 = {
      label: 'G2',
      actions: { 'g2-action': { label: 'G2', script: 'echo g2', tab: 'g2-action' } },
    };
    runtime.setModel({
      ...m,
      modes: { ...m.modes, jobsMode: true },
      modal: { ...m.modal, jobs: { cursor: 0, scroll: 0 } },
    });
    jobs.register({
      kind: 'stream-routed',
      label: 'g2-action',
      pid: 1,
      owner: { tabKey: 'g2-action', groupName: 'g2', cmd: 'echo g2' },
    });
    _activate();
    eq(runtime.getModel().currentGroup, 'g2', 'currentGroup switched to g2 (B1: msg.name, not msg.group)');
  });

  it('cross-group routed → tab_switch carries the TARGET group, not the captured currentGroup', () => {
    // Round-5 regression: Phase-3d threaded `currentGroup: model.currentGroup`
    // into the tab_switch Cmd, captured at the OLD value before the
    // queued set_current_group Cmd applied. When that Cmd ran first,
    // tab_switch reduced with the stale msg.currentGroup → the leaf
    // looked up slice.actionTabBuffers[OLD_GROUP][actionKey] (undefined)
    // → scroll fell to 0 instead of bottom-pinning the routed buffer.
    _seedModel();
    _resetJobs();
    const m = runtime.getModel();
    m.config.groups.g2 = {
      label: 'G2',
      actions: { 'g2-act': { label: 'G2', script: 'echo g2', tab: 'g2-act' } },
    };
    runtime.setModel({
      ...m,
      modes: { ...m.modes, jobsMode: true },
      modal: { ...m.modal, jobs: { cursor: 0, scroll: 0 } },
    });
    // Seed a routed buffer for g2/g2-act with bottom-pin worth of lines.
    // Also force slice.tab to 0 so the tab_switch arm doesn't early-return
    // on same-tab (slice.tab leaks from prior tests in the same file).
    const detail = api.getInstanceSlice('detail');
    detail.actionTabBuffers = { g2: { 'g2-act': { lines: Array.from({ length: 90 }, (_, i) => `l${i}`) } } };
    detail.innerH = 10;
    detail.tab = 0;
    detail.scroll = 0;
    jobs.register({
      kind: 'stream-routed',
      label: 'g2-act',
      pid: 1,
      owner: { tabKey: 'g2-act', groupName: 'g2', cmd: 'echo g2' },
    });
    _activate();
    eq(runtime.getModel().currentGroup, 'g2', 'currentGroup switched to g2');
    eq(api.getInstanceSlice('detail').tab, 2, 'tab_switch landed on g2-act (idx 2 in g2)');
    // The smoking gun: scroll should bottom-pin against the 90-line
    // routed buffer (lines=90, innerH=10 → scroll=80). Pre-fix it
    // landed at 0 because msg.currentGroup was the OLD group 'g'.
    eq(api.getInstanceSlice('detail').scroll, 80, 'scroll bottom-pinned against routed buffer (g2)');
  });

  it('non-jobsMode → activate is a no-op (defensive)', () => {
    _seedModel();
    _resetJobs();
    // Don't set jobsMode. Register a job, dispatch activate — nothing happens.
    jobs.register({ kind: 'stream-routed', label: 'x', pid: 1, owner: { tabKey: 'x', groupName: 'g' } });
    const before = api.getInstanceSlice('layout').focus;
    _activate();
    eq(api.getInstanceSlice('layout').focus, before, 'focus untouched');
  });
});

report();
