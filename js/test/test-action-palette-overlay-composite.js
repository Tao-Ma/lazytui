/**
 * Action palette overlay — overlay-compositor migration (Release 2
 * Phase 2.b #1, docs/overlay-compositor-migration.md). First migrated
 * MEDIUM overlay. This is also the first commit that RETIRES a paint.js
 * sig tracker (`prevPaletteSig`); the matching invariant inversion
 * lives in test-fabric-form-popover-repaint.js's "action palette"
 * block (per the plan's §Release 2 Test strategy).
 *
 * Four pins:
 *   1. Composite path mutates `targetRows` and writes zero stdout.
 *   2. Stdout fallback still fires when invoked without `targetRows`.
 *   3. No `FULL_CLEAR` on `palette_open` through the real paint pipeline.
 *   4. No `FULL_CLEAR` on `palette_filter` (filter narrow) — the
 *      transition the retired sig tracker caught.
 *
 * Run: node js/test/test-action-palette-overlay-composite.js
 */
'use strict';

process.stdout.columns = 100; process.stdout.rows = 30;

const { describe, it, assert, report } = require('./test-runner');
const term = require('../io/term');
const { freshOverlayModel } = require('./_helpers/overlay-capture');
const { renderActionPalette } = require('../overlay/action-palette');
const { visibleLen } = require('../leaves/text/ansi');

const FULL_CLEAR = '\x1b[2J';

describe('[action-palette-overlay-composite] composites into newRows when invoked with target buffer', () => {
  it('composite path mutates newRows and writes zero stdout bytes', () => {
    const COLS = 100;
    const sm = require('./smoke/_helpers/smoke');
    sm.bootFresh();
    sm.resize(COLS, 30);
    sm.applyMsg({ type: 'palette_open' });

    const ROWS_H = 24;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderActionPalette(newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    const joined = newRows.join('\n');
    assert(joined.includes('Action palette'),
      `expected title "Action palette" to land in newRows`);

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });
  // (The pre-cleanup "stdout fallback still fires" case retired —
  // end-of-Release-2 cleanup; the overlay fn no longer has a stdout path.)
});

describe('[action-palette-overlay-composite] no FULL_CLEAR on open/filter through the paint pipeline', () => {
  const sm = require('./smoke/_helpers/smoke');
  sm.bootFresh();
  sm.resize(100, 30);
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening the action palette does NOT emit a full-clear', () => {
    sm.applyMsg({ type: 'palette_open' });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'palette_open emitted a full-clear — the compositor migration promises OPEN rides on per-cell diff from newRows, not a sig-tracker invalidation');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(/Action palette/.test(stripped),
      `expected the palette title to land on-screen through the paint pipeline — got: ${JSON.stringify(stripped.slice(0, 200))}`);
  });

  it('typing a filter (shrink) does NOT emit a full-clear either — the retired prevPaletteSig territory', () => {
    // Palette is open from the previous step. Reach a steady state so
    // the baseline diff is tight, then narrow the filter and verify no
    // FULL_CLEAR fires. This is the SAME transition the pre-migration
    // sig tracker caught by invalidating prevRows.
    sm.capture(sm.render);
    sm.applyMsg({ type: 'palette_filter', seq: 'z' });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'palette_filter emitted a full-clear — the migration retires prevPaletteSig; cell-diff must handle the overlay shrink from the natural row delta');
  });
});

report();
