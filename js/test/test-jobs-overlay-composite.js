/**
 * Jobs (Running) overlay — overlay-compositor migration (Release 2
 * Phase 2.a #4, docs/overlay-compositor-migration.md). Same shape as
 * test-confirm-overlay-composite.js — one per migrated overlay.
 *
 * Three pins:
 *   1. Composite path mutates `targetRows` and writes zero stdout.
 *   2. Stdout fallback still fires when invoked without `targetRows`.
 *   3. No `FULL_CLEAR` on `jobs_open` through the real paint pipeline.
 *
 * Run: node js/test/test-jobs-overlay-composite.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const term = require('../io/term');
const { freshOverlayModel } = require('./_helpers/overlay-capture');
const { renderJobsOverlay } = require('../overlay/jobs');
const { visibleLen } = require('../leaves/text/ansi');

function _withJob(m, now) {
  // The production path mirrors the feature/jobs registry into model.jobs via
  // the store-mirror Sub (jobs_synced). Drive the same reducer arm — same
  // shape the overlay reads.
  const [m2] = runtime.update(m, { type: 'jobs_synced',
    jobs: [{
      kind: 'stream-routed', id: 'j1',
      label: 'test-job',
      status: 'running',
      startedAt: now - 3000, endedAt: null, exitCode: null,
    }] });
  return m2;
}

describe('[jobs-overlay-composite] composites into newRows when invoked with target buffer', () => {
  it('composite path mutates newRows and writes zero stdout bytes', () => {
    const COLS = 100;
    const NOW = 100000;
    let m = freshOverlayModel({ cols: COLS, rows: 30 });
    m = _withJob(m, NOW);
    [m] = runtime.update(m, { type: 'jobs_open', now: NOW });
    const store = require('../model/store');
    store.setModel(m);
    const ROWS_H = 24;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderJobsOverlay(NOW, newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    const joined = newRows.join('\n');
    assert(joined.includes('test-job'),
      `expected job label "test-job" to land in newRows`);
    assert(joined.includes('running'),
      `expected status "running" to land in newRows`);
    assert(joined.includes('Running'),
      `expected title "Running" to land in newRows`);

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });

  it('stdout fallback still fires when invoked without targetRows', () => {
    const NOW = 200000;
    let m = freshOverlayModel();
    m = _withJob(m, NOW);
    [m] = runtime.update(m, { type: 'jobs_open', now: NOW });
    const store = require('../model/store');
    store.setModel(m);
    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderJobsOverlay(NOW);
    } finally {
      term.stdout.write = orig;
    }
    const bytes = chunks.join('');
    assert(bytes.length > 0,
      'stdout fallback wrote nothing — the fallback keeps the pre-compositor path alive for migration-period callers');
    const stripped = bytes
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('test-job'),
      `stdout fallback must still paint the job row — got: ${JSON.stringify(stripped.slice(0, 120))}`);
  });
});

describe('[jobs-overlay-composite] no FULL_CLEAR on jobs_open', () => {
  process.stdout.columns = 100; process.stdout.rows = 30;
  const sm = require('./smoke/_helpers/smoke');
  const FULL_CLEAR = '\x1b[2J';

  sm.bootFresh();
  sm.resize(100, 30);
  sm.applyMsg({ type: 'jobs_synced',
    jobs: [{
      kind: 'stream-routed', id: 'j1',
      label: 'test-job',
      status: 'running',
      startedAt: Date.now() - 3000, endedAt: null, exitCode: null,
    }] });
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening the jobs overlay does NOT emit a full-clear', () => {
    sm.applyMsg({ type: 'jobs_open', now: Date.now() });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'jobs_open emitted a full-clear — the compositor migration promises OPEN rides on per-cell diff from newRows, not a sig-tracker invalidation');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('test-job'),
      `expected job row to land on-screen through the paint pipeline — got: ${JSON.stringify(stripped.slice(0, 160))}`);
  });
});

report();
