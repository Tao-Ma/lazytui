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
  const job = jobs.snapshot()[cursor] || null;
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

  it('stream-routed → closes overlay, focuses viewer (no flat-tab jump — U2c P2)', () => {
    setup({
      kind: 'stream-routed',
      label: 'make-check',
      pid: 1,
      owner: { tabKey: 'make-check', groupName: 'g', cmd: 'make check' },
    });
    const before = { ...api.getInstanceSlice('detail'), tab: 0 };
    require('../panel/route').setInstanceSlice('detail', before);
    _activate();
    eq(runtime.getModel().modes.jobsMode, false, 'overlay closed');
    // U2c P2 — action output lives in a text-view position-tab now; the flat action
    // tab (and its jump) is retired. Activating a stream-routed job focuses the
    // viewer without a flat-tab switch (jump-to-position-tab is a follow-on).
    eq(api.getInstanceSlice('detail').tab, 0, 'no flat-tab switch');
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

  it('pty → closes overlay, focuses viewer (no flat-tab jump — U2d P2)', () => {
    setup({
      kind: 'pty',
      label: 'bash',
      pid: 3,
      owner: { ptyId: 'g_shell', cmd: 'bash' },
    });
    _activate();
    eq(runtime.getModel().modes.jobsMode, false);
    // U2d P2 — the PTY's terminal is a `terminal` PANE now, not a viewer content-tab,
    // so the flat-tab jump + terminal_enter are retired (same treatment as the
    // stream-routed case above). Jumping to (and entering) the terminal's
    // position-tab is a follow-on.
    eq(runtime.getModel().modes.terminalMode, false, 'no content-tab jump → no terminal_enter');
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

  // U2c P2 — the 'cross-group routed → tab_switch carries the target group +
  // bottom-pins the routed actionTabBuffers' test was retired: stream-routed
  // activation no longer flat-tab-jumps (action output → a text-view position-tab)
  // and actionTabBuffers is gone. The cross-group currentGroup switch itself is
  // still covered by the preceding case.

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
