/**
 * jobs window — mouse (docs/mouse-hit-map.md Release 1).
 *
 *   [1] jobs_nav { to } — absolute, clamped, scroll follows
 *   [2] click a job row → cursor there; the header row is inert
 *   [3] double-click a row → cursor there + Enter (jump to job)
 *   [4] [Esc] chip closes; wheel steps; NO backdrop in R1 (chrome stays live)
 *
 * Run: node js/test/test-jobs-mouse.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const hc = require('./_helpers/hit-click');
const runtime = require('../app/runtime');
const dispatch = require('../dispatch/control/dispatch');
const { getModel } = runtime;

const O = 'jobs';
const JOBS = ['build', 'deploy', 'lint'].map((label, i) => ({ id: `j${i}`, kind: 'background', label, startedAt: 0, status: 'running' }));

function openJobs() {
  sm.bootFresh();
  sm.resize(120, 30);
  getModel().jobs = JOBS.slice();
  sm.capture(() => sm.applyMsg({ type: 'jobs_open', now: 0 }));
  hc.paint();
}
const cursor = () => getModel().modal.jobs.cursor;

describe('[1] jobs_nav { to }', () => {
  it('absolute + clamped; scroll keeps the cursor in view', () => {
    let m = runtime.init();
    [m] = runtime.update(m, { type: 'jobs_open', now: 0 });
    [m] = runtime.update(m, { type: 'jobs_nav', to: 4, count: 6, vh: 2 });
    eq(m.modal.jobs, { cursor: 4, scroll: 3 });
    [m] = runtime.update(m, { type: 'jobs_nav', to: -3, count: 6, vh: 2 });
    eq(m.modal.jobs, { cursor: 0, scroll: 0 }, 'clamped');
  });
});

describe('[2] row click', () => {
  it('a job row selects that job; the header row has no target', () => {
    openJobs();
    assert(hc.paintedText(O, 'row:3').includes('lint'), 'line 3 (header + 2) covers "lint"');
    eq(hc.region(O, 'row:0'), null, 'header line 0 publishes no row');
    hc.clickRegion(O, 'row:3');
    eq(cursor(), 2);
    eq(getModel().modes.jobsMode, true, 'still open');
  });
});

describe('[3] double-click', () => {
  it('moves the cursor and presses Enter', () => {
    openJobs();
    const keys = [];
    const real = dispatch.handleKey;
    dispatch.handleKey = (k, s) => keys.push(k);      // record, don't jump
    try { hc.dblclickRegion(O, 'row:2'); } finally { dispatch.handleKey = real; }
    eq(cursor(), 1, 'cursor on the double-clicked job');
    eq(keys, ['return'], 'Enter pressed once');
  });
});

describe('[4] chips / wheel / outside', () => {
  it('[Esc] chip closes; nav hints are inert', () => {
    openJobs();
    eq(hc.regions(O).filter(r => r.id.startsWith('chip:')).map(r => r.id), ['chip:escape']);
    hc.clickRegion(O, 'chip:escape');
    eq(getModel().modes.jobsMode, false);
  });
  it('wheel steps the cursor', () => {
    openJobs();
    hc.wheelRegion(O, 'box', 'down');
    eq(cursor(), 1);
  });
  it('no backdrop in R1: an outside click is left to the legacy path (still open)', () => {
    openJobs();
    eq(hc.region(O, 'backdrop'), null);
    hc.click(0, 25);                  // outside the box, not on chrome
    eq(getModel().modes.jobsMode, true, 'legacy T13 gate swallowed it, as before');
  });
});

report();
