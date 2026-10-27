/**
 * Confirm overlay — overlay-compositor migration (Release 2 Phase 2.a #1,
 * docs/overlay-compositor-migration.md).
 *
 * Two assertions beyond the stdout-path reducer+paint coverage in
 * test-confirm-overlay.js:
 *
 *   1. **Composite path mutates targetRows, writes zero stdout.** When the
 *      overlay is invoked with `newRows` + `cols`, its content lands in
 *      `newRows` via the row-compositor; no `_writer`/stdout call fires.
 *      This is the invariant the plan calls out for every Release-2
 *      overlay (`js/overlay/*.js` migration): the stdout path is the
 *      migration-period fallback; the compositor path is the default
 *      going forward.
 *
 *   2. **No `FULL_CLEAR` on `confirm_enter`.** Opening the overlay through
 *      the production paint pipeline composites into `newRows`, and the
 *      cell-diff emits per-cell ANSI for the overlay rect from the natural
 *      row delta. No sig tracker required for the OPEN transition. The
 *      CLOSE transition still rides on the overlay-flag-drop forceFull
 *      (paint.js line ~852 — that's the next sig-tracker site Release 2
 *      kills; left alone in this commit).
 *
 * Run: node js/test/test-confirm-overlay-composite.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const term = require('../io/term');
const draw = require('../leaves/render/draw');
const { freshOverlayModel } = require('./_helpers/overlay-capture');
const { renderConfirmOverlay } = require('../overlay/confirm');
const { visibleLen } = require('../leaves/text/ansi');

describe('[confirm-overlay-composite] composites into newRows when invoked with target buffer', () => {
  it('composite path mutates newRows and writes zero stdout bytes', () => {
    const COLS = 100;
    let m = freshOverlayModel({ cols: COLS, rows: 30 });
    [m] = runtime.update(m, { type: 'confirm_enter', message: 'Really delete widget?', cmd: null });
    const store = require('../model/store');
    store.setModel(m);
    // Blank main-frame buffer of the right geometry — mimics what
    // painter.composeRows hands render() mid-paint.
    const ROWS_H = 24;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    // Hijack stdout so we can observe any stray overlay write — the
    // composite path must emit nothing (the main-frame paintFrame emits
    // the composited cells one step later, outside this call).
    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderConfirmOverlay(newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    // At least ONE row was mutated (the overlay touches menuH consecutive
    // rows centred vertically). The prompt text itself must now live in
    // newRows (markup is preserved; prompt is literal ASCII so no esc
    // sentinel to decode).
    const joined = newRows.join('\n');
    assert(joined.includes('Really delete widget?'),
      `expected prompt text to land in newRows; got rows:\n${joined.split('\n').map((r, i) => `  ${i}: ${JSON.stringify(r.slice(0, 60))}`).join('\n')}`);
    assert(joined.includes('Confirm'),
      `expected title "Confirm" to land in newRows`);
    assert(joined.includes('y] confirm'),
      `expected y-hint to land in newRows`);

    // Row width invariant: composite must NOT grow the row's visible width.
    // (Markup/SGR added by the overlay are zero-visible; a width overrun
    //  would cascade through the cell-diff's absolute MoveTo columns and
    //  misalign the next frame — the exact class the compositor plumbing
    //  must not open.)
    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });

  it('stdout fallback still fires when invoked without targetRows (migration-period compatibility)', () => {
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'confirm_enter', message: 'Fallback?', cmd: null });
    const store = require('../model/store');
    store.setModel(m);
    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      // No newRows/cols — overlay must take the stdout path (preserved
      // until end of Release 2, needed for unit tests + the per-overlay
      // migration cadence).
      renderConfirmOverlay();
    } finally {
      term.stdout.write = orig;
    }
    const bytes = chunks.join('');
    assert(bytes.length > 0,
      'stdout fallback wrote nothing — the fallback keeps the pre-compositor path alive for migration-period callers; a regression here breaks the per-overlay cadence');
    const stripped = bytes
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('Fallback?'),
      `stdout fallback must still paint the prompt — got: ${JSON.stringify(stripped.slice(0, 120))}`);
  });
});

describe('[confirm-overlay-composite] no FULL_CLEAR on confirm_enter (compositor rect handles OPEN naturally)', () => {
  // Load the smoke harness here so the first describe above doesn't boot
  // the full paint pipeline (keeps its captureOverlay-shaped assertions
  // tight). This block drives the real `render()` through smoke.
  process.stdout.columns = 100; process.stdout.rows = 30;
  const sm = require('./smoke/_helpers/smoke');
  const FULL_CLEAR = '\x1b[2J';

  sm.bootFresh();
  sm.resize(100, 30);
  // Steady-state before the open gesture — initial frames clear & paint;
  // a no-op render after settles the diff baseline.
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening the confirm overlay does NOT emit a full-clear', () => {
    sm.applyMsg({ type: 'confirm_enter', message: 'Composite?', cmd: null });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'confirm_enter emitted a full-clear — the compositor migration promises OPEN rides on per-cell diff from newRows, not a sig-tracker invalidation');
    // Prompt text landed on screen.
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('Composite?'),
      `expected the prompt to land on-screen through the paint pipeline — got: ${JSON.stringify(stripped.slice(0, 120))}`);
  });
});

report();
