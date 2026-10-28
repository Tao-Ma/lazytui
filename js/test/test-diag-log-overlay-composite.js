/**
 * Diagnostics overlay — overlay-compositor migration (Release 2 Phase 2.a #3,
 * docs/overlay-compositor-migration.md). Same shape as
 * test-confirm-overlay-composite.js — one per migrated overlay.
 *
 * Three pins:
 *   1. Composite path mutates `targetRows` and writes zero stdout.
 *   2. Stdout fallback still fires when invoked without `targetRows`.
 *   3. No `FULL_CLEAR` on `diag_log_open` through the real paint pipeline.
 *
 * Run: node js/test/test-diag-log-overlay-composite.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const term = require('../io/term');
const { freshOverlayModel } = require('./_helpers/overlay-capture');
const { renderDiagLog } = require('../overlay/diag-log');
const { visibleLen } = require('../leaves/text/ansi');

function _withDiag(m, now) {
  // Thread one entry via the dedicated reducer arm — the same path the
  // store-sync Sub takes (reducer.js: 'diag_synced'), so the model shape
  // this test exercises is the production shape.
  const [m2] = runtime.update(m, { type: 'diag_synced',
    diagLog: [{ t: now - 2000, level: 'warn', code: 'TEST', message: 'synthetic diag' }] });
  return m2;
}

describe('[diag-log-overlay-composite] composites into newRows when invoked with target buffer', () => {
  it('composite path mutates newRows and writes zero stdout bytes', () => {
    const COLS = 100;
    const NOW = 100000;
    let m = freshOverlayModel({ cols: COLS, rows: 30 });
    m = _withDiag(m, NOW);
    [m] = runtime.update(m, { type: 'diag_log_open', now: NOW });
    const store = require('../model/store');
    store.setModel(m);
    const ROWS_H = 24;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderDiagLog(NOW, newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    const joined = newRows.join('\n');
    assert(joined.includes('synthetic diag'),
      `expected diag message to land in newRows`);
    assert(joined.includes('TEST'),
      `expected diag code "TEST" to land in newRows`);
    assert(joined.includes('Diagnostics'),
      `expected title "Diagnostics" to land in newRows`);

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });
  // (The pre-cleanup "stdout fallback still fires" case retired —
  // end-of-Release-2 cleanup; the overlay fn no longer has a stdout path.)
});

describe('[diag-log-overlay-composite] no FULL_CLEAR on diag_log_open', () => {
  process.stdout.columns = 100; process.stdout.rows = 30;
  const sm = require('./smoke/_helpers/smoke');
  const FULL_CLEAR = '\x1b[2J';

  sm.bootFresh();
  sm.resize(100, 30);
  // Seed one diag so the overlay has content to paint through the paint
  // pipeline — the sm helper drives sm.render(getModel()); setting diagLog
  // on the live model is what the diag_synced Sub would do in production.
  sm.applyMsg({ type: 'diag_synced',
    diagLog: [{ t: Date.now() - 1000, level: 'warn', code: 'TEST', message: 'synthetic diag' }] });
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening the diag-log overlay does NOT emit a full-clear', () => {
    sm.applyMsg({ type: 'diag_log_open', now: Date.now() });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'diag_log_open emitted a full-clear — the compositor migration promises OPEN rides on per-cell diff from newRows, not a sig-tracker invalidation');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('synthetic diag'),
      `expected the diag message to land on-screen through the paint pipeline — got: ${JSON.stringify(stripped.slice(0, 160))}`);
  });
});

report();
