/**
 * Replay-scrubber overlay — overlay-compositor migration (Release 2
 * Phase 2.d, docs/overlay-compositor-migration.md). Final overlay;
 * closes Phase 2.d AND closes the sig-tracker deletion arc — the
 * `prevReplayView` tracker retires here, making all four original
 * paint.js sig trackers gone.
 *
 * Four pins:
 *   1. Composite path (full view) mutates `targetRows` + writes zero stdout.
 *   2. Composite path (mini bar) mutates `targetRows` at the bottom rows.
 *   3. Stdout fallback still fires when invoked without `targetRows`.
 *   4. No `FULL_CLEAR` on the paneView transitions the retired
 *      `prevReplayView` sig tracker caught — specifically `full → mini`
 *      (different cell regions; this is where cell-diff proves itself
 *      end-to-end on the mode's SHAPE change).
 *
 * The replay-scrubber draws from a `data` snapshot (replay-control.js
 * renderData()); the tests synthesize that shape directly rather than
 * driving the full replay pipeline, keeping the pin on the paint
 * mechanism, not the controller state machine.
 *
 * Run: node js/test/test-replay-scrubber-overlay-composite.js
 */
'use strict';

process.stdout.columns = 100; process.stdout.rows = 30;

const { describe, it, assert, report } = require('./test-runner');
const term = require('../io/term');
const { render: renderReplayScrubber } = require('../overlay/replay-scrubber');
const { visibleLen } = require('../leaves/text/ansi');

const FULL_CLEAR = '\x1b[2J';

function _synthData(view) {
  const now = 1000;
  const t0 = now - 2000;
  return {
    paneView: view,
    diffMode: 'off',
    checkpoints: [
      { t: t0 + 0,    seq: 1 },
      { t: t0 + 1000, seq: 10 },
      { t: t0 + 2000, seq: 20 },
    ],
    cursor: 1,
    idx: 1,
    pos: 10,
    total: 20,
    t: t0 + 1000,
    firstT: t0,
    lastT: t0 + 2000,
    playing: null,
    ratio: 1,
    mode: 'even',
    idleCap: Infinity,
    diff: null,
    locked: false,
    lockedIdx: null,
  };
}

describe('[replay-scrubber-overlay-composite] composites both views into newRows', () => {
  // The overlay reads terminal dims via the dims-provider seam paint.js
  // wires at boot (same path renderOverlay / overlayBox take). Boot once
  // + resize so viewportDims() reports a known 100×30 for the composite
  // geometry below.
  const sm = require('./smoke/_helpers/smoke');
  sm.bootFresh();
  sm.resize(100, 30);

  it('full view: composite path mutates newRows and writes zero stdout bytes', () => {
    const COLS = 100;
    const ROWS_H = 29;   // availH = ROWS - 1
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderReplayScrubber(_synthData('full'), newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    const joined = newRows.join('\n');
    assert(joined.includes('Replay'),
      `expected title "Replay" to land in newRows`);
    assert(/seq\s+10/.test(joined),
      `expected the "seq 10" status row to land in newRows`);

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });

  it('mini view: composite path lands at the BOTTOM rows + writes zero stdout', () => {
    const COLS = 100;
    const ROWS_H = 29;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderReplayScrubber(_synthData('mini'), newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path (mini) wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    // Mini bar anchors at y=ROWS (overlayBox clamps offY to ROWS-menuH); the
    // bottom few rows carry the bar. Find the row with the playing symbol +
    // progress info.
    const bottomRows = newRows.slice(-5).join('\n');
    assert(/10\/20/.test(bottomRows),
      `expected the mini bar's "pos/total" (10/20) to land in the BOTTOM rows — got: ${JSON.stringify(bottomRows.slice(0, 300))}`);

    // Rows OUTSIDE the mini box's rect should be untouched blanks.
    const topMostlyBlank = newRows.slice(0, ROWS_H - 5)
      .every(r => visibleLen(r) === COLS && r.trim() === '');
    assert(topMostlyBlank,
      'mini bar leaked into non-anchor rows — expected top rows untouched');
  });

  it('hidden view: composite path writes nothing (overlay returns early)', () => {
    const COLS = 100;
    const ROWS_H = 29;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderReplayScrubber(_synthData('hidden'), newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      'hidden view wrote to stdout — expected zero bytes');
    const stillBlank = newRows.every(r => visibleLen(r) === COLS && r.trim() === '');
    assert(stillBlank, 'hidden view mutated newRows — expected a no-op');
  });
  // (The pre-cleanup "stdout fallback still fires" case retired —
  // end-of-Release-2 cleanup; the overlay fn no longer has a stdout path.)
});

describe('[replay-scrubber-overlay-composite] no FULL_CLEAR on paneView transitions through the paint pipeline', () => {
  // Wire a module-level replay source so paint.js's render() sees the
  // synthesized data; the real setReplaySource lives in paint.js, which
  // is loaded on sm.render's first import. We mutate the source by
  // swapping which synthData the thunk returns before each render.
  const { setReplaySource } = require('../render/paint');
  let currentView = 'hidden';
  setReplaySource(() => currentView === 'hidden' ? null : _synthData(currentView));

  process.stdout.columns = 100; process.stdout.rows = 30;
  const sm = require('./smoke/_helpers/smoke');

  sm.bootFresh();
  sm.resize(100, 30);
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('entering replay (hidden → full) does NOT emit a full-clear', () => {
    currentView = 'full';
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'hidden → full emitted a full-clear — the compositor migration promises the overlay rides on per-cell diff from newRows');
  });

  it('full → mini (shape change) does NOT emit a full-clear either — the retired prevReplayView territory', () => {
    sm.capture(sm.render);              // settle at full
    currentView = 'mini';
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'full → mini emitted a full-clear — the migration retires prevReplayView; cell-diff must handle the paneView mode change from the natural row delta');
  });

  it('mini → hidden (overlay vacates) does NOT emit a full-clear either', () => {
    sm.capture(sm.render);              // settle at mini
    currentView = 'hidden';
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'mini → hidden emitted a full-clear — the compositor path promises cell-diff clears the vacated mini-bar cells');
  });

  // Restore the seam so later tests in the file loader don't see our hook.
  setReplaySource(null);
});

report();
