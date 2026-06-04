/**
 * v0.6.2 Phase 4.3 — Enter on a Running-overlay row jumps to the
 * job's tab/pane and closes the overlay.
 *
 * Walks each kind:
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
const dispatch = require('../dispatch/dispatch');
const api = require('../panel/api');

function _seedModel() {
  const m = runtime.init();
  // Config: one group with a tabbed action + a terminal.
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
  // Seed the layout instance slice via the layout Component update
  // (test-runner already registered detail/layout/groups Components).
  return m;
}

function _resetJobs() { jobs._reset(); }

describe('[handleJobsKey return] full cascade', () => {
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
    dispatch._handleJobsKey('return', '');
    eq(runtime.getModel().modes.jobsMode, false, 'overlay closed');
    const detailSlice = api.getInstanceSlice('detail');
    eq(detailSlice.tab, 1, 'tab_switch landed on action tab idx 1');
    const layoutSlice = api.getInstanceSlice('layout');
    eq(layoutSlice.focus, 'detail', 'focus on viewer pane');
  });

  it('stream-unrouted → closes overlay, focus moves to viewer; no tab change', () => {
    setup({
      kind: 'stream-unrouted',
      label: 'docker logs nginx',
      pid: 2,
      owner: { cmd: 'docker logs nginx' },
    });
    // Move detail tab off Info so we can verify it stays put.
    const detail = require('../panel/viewer/viewer');
    const sliceBefore = { ...api.getInstanceSlice('detail'), tab: 0 };
    require('../leaves/route').setInstanceSlice('detail', sliceBefore);
    dispatch._handleJobsKey('return', '');
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
    dispatch._handleJobsKey('return', '');
    eq(runtime.getModel().modes.jobsMode, false);
    const detailSlice = api.getInstanceSlice('detail');
    // Tab strip: [Info, make-check, shell, ...]. shell is termTab idx 0
    // → absolute tab 1 (actionTabs.length) + 1 = 2.
    eq(detailSlice.tab, 2, 'tab_switch landed on terminal tab idx 2');
    eq(runtime.getModel().modes.terminalMode, true, 'terminal_enter fired');
  });

  it('background → viewer shows info card, no tab switch', () => {
    setup({
      kind: 'background',
      label: 'bg-rsync',
      pid: 12345,
      owner: { cmd: 'rsync -av src/ dst/' },
    });
    dispatch._handleJobsKey('return', '');
    eq(runtime.getModel().modes.jobsMode, false);
    const lines = api.getInstanceSlice('detail').lines;
    assert(lines.length > 0, 'viewer has lines');
    assert(lines[0].includes('bg-rsync'), 'header has label');
    assert(lines.some(l => l.includes('pid:') && l.includes('12345')), 'pid line present');
    assert(lines.some(l => l.includes('rsync -av src/ dst/')), 'cmd line present');
    eq(api.getInstanceSlice('layout').focus, 'detail', 'focus moved to viewer');
  });

  it('tmux → viewer shows info card with window name', () => {
    setup({
      kind: 'tmux',
      label: 'worker',
      pid: null,
      owner: { tmuxWindowName: 'worker', cmd: 'long-job.sh' },
    });
    dispatch._handleJobsKey('return', '');
    eq(runtime.getModel().modes.jobsMode, false);
    const lines = api.getInstanceSlice('detail').lines;
    assert(lines.some(l => l.includes('window:') && l.includes('worker')), 'window line present');
    assert(lines.some(l => l.includes('long-job.sh')), 'cmd line present');
  });

  it('empty list (cursor on nothing) → close only, no crash', () => {
    _seedModel();
    _resetJobs();
    runtime.setModel({
      ...runtime.getModel(),
      modes: { ...runtime.getModel().modes, jobsMode: true },
      modal: { ...runtime.getModel().modal, jobs: { cursor: 0, scroll: 0 } },
    });
    dispatch._handleJobsKey('return', '');
    eq(runtime.getModel().modes.jobsMode, false);
  });
});

report();
