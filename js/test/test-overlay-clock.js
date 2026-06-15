/**
 * test-overlay-clock.js — blessed-exceptions Finding A (overlay frame-clock).
 *
 * The age-displaying overlays (jobs, diag-log) no longer read Date.now()
 * inside their render bodies. `now` is threaded from the paint frame, so
 * each render is a PURE function of (side-store, model, now): same inputs →
 * byte-identical output (idempotent / replayable), and a different `now`
 * advances the age column. The wall-clock read is concentrated to the one
 * frame boundary in paint.render(model, now).
 *
 * Run: node js/test/test-overlay-clock.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const sm = require('./smoke/_helpers/smoke');
const runtime = require('../app/runtime');
const jobs = require('../feature/jobs');
const { renderJobsOverlay } = require('../overlay/jobs');

function openJobsMode() {
  const m = runtime.getModel();
  runtime.setModel({
    ...m,
    modes: { ...m.modes, jobsMode: true },
    modal: { ...m.modal, jobs: { cursor: 0, scroll: 0 } },
  });
}

// Render the jobs overlay at a fixed `now`, capturing the bytes it writes.
function paintAt(now) {
  let buf = '';
  const orig = process.stdout.write;
  process.stdout.write = (s) => { buf += s; return true; };
  try { renderJobsOverlay(now); } finally { process.stdout.write = orig; }
  return buf;
}

describe('[1] jobs overlay render is pure of wall-clock (threaded now)', () => {
  it('same now → byte-identical output (idempotent / replayable)', () => {
    sm.bootFresh();
    sm.resize(100, 30);
    jobs._reset();
    jobs.register({ kind: 'stream', label: 'demo', pid: null, owner: {} });
    openJobsMode();

    const start = jobs.list()[0].startedAt;
    const a = paintAt(start + 5000);
    const b = paintAt(start + 5000);
    assert(a.length > 0, 'overlay actually painted');
    eq(a, b, 'identical (state, now) → identical bytes');
  });

  it('a later now advances the age column (now drives the display)', () => {
    sm.bootFresh();
    sm.resize(100, 30);
    jobs._reset();
    jobs.register({ kind: 'stream', label: 'demo', pid: null, owner: {} });
    openJobsMode();

    const start = jobs.list()[0].startedAt;
    const early = paintAt(start + 5000);       // ~5s
    const later = paintAt(start + 5 * 60000);  // ~5m
    assert(early !== later, 'different now → different age column');
  });
});

report();
