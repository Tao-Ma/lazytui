/**
 * Cmdline overlay — overlay-compositor migration (Release 2 Phase 2.b #3,
 * docs/overlay-compositor-migration.md). Final medium overlay; closes
 * Phase 2.b.
 *
 * Asymmetry vs the other Phase-2.b overlays: cmdline paints a
 * BORDERED DROPDOWN above the prompt row AND a PROMPT ROW on the very
 * bottom (row ROWS). The dropdown composites into newRows (so cell-
 * diff handles the shrink/close); the prompt row + the cursor
 * positioning stay as direct writeOut because they sit OUTSIDE newRows
 * (which spans only availH = ROWS - 1 rows) and the cursor is terminal
 * state, not a cell.
 *
 * Four pins:
 *   1. Composite path mutates `targetRows` with the dropdown's rows.
 *   2. Composite path STILL writes the prompt row + cursor via writeOut
 *      — pins the mixed-path contract.
 *   3. Stdout fallback still fires when invoked without `targetRows`
 *      (migration-period compatibility).
 *   4. No `FULL_CLEAR` on `cmdline_enter` through the real paint pipeline.
 *
 * Run: node js/test/test-cmdline-overlay-composite.js
 */
'use strict';

process.stdout.columns = 100; process.stdout.rows = 30;

const { describe, it, assert, report } = require('./test-runner');
const term = require('../io/term');
const draw = require('../leaves/render/draw');
const { renderCmdline, _resetRenderState } = require('../overlay/cmdline');
const { visibleLen } = require('../leaves/text/ansi');

const FULL_CLEAR = '\x1b[2J';

describe('[cmdline-overlay-composite] composites dropdown into newRows + writes prompt via writeOut', () => {
  it('composite path puts dropdown title in newRows AND writes prompt bytes via the draw writer', () => {
    const COLS = 100;
    const sm = require('./smoke/_helpers/smoke');
    sm.bootFresh();
    sm.resize(COLS, 30);
    _resetRenderState();
    // Open cmd mode and type a prefix so the match list has entries.
    // The default bootFresh config carries `:show-hidden` + the standard
    // panel commands; `:s` resolves to a non-empty match set.
    sm.applyMsg({ type: 'cmdline_enter' });
    sm.applyMsg({ type: 'cmdline_key', seq: 's' });

    const ROWS_H = 29;   // availH = 30 - 1 (footer row)
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    // Capture BOTH stdout (prompt row writes land there via draw.setWriter
    // wiring from paint.js:_setDrawWriter) and the leaf's own writer seam.
    const stdoutChunks = [];
    const origWrite = term.stdout.write;
    term.stdout.write = (s) => { stdoutChunks.push(String(s)); return true; };
    try {
      renderCmdline(newRows, COLS);
    } finally {
      term.stdout.write = origWrite;
    }

    const stdoutBytes = stdoutChunks.join('');
    // The prompt row MUST have been written through writeOut (which
    // routes to the stdout writer wired in by paint.js / the
    // overlay-capture test helper). Looks for the `:` prompt.
    assert(stdoutBytes.includes(':s'),
      `expected prompt row ":s" to land via writeOut — got: ${JSON.stringify(stdoutBytes.slice(0, 160))}`);

    // The dropdown title MUST have landed in newRows.
    const joined = newRows.join('\n');
    assert(joined.includes('Commands'),
      `expected dropdown title "Commands" to land in newRows`);

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });

  it('stdout fallback still fires when invoked without targetRows', () => {
    const sm = require('./smoke/_helpers/smoke');
    sm.bootFresh();
    sm.resize(100, 30);
    _resetRenderState();
    sm.applyMsg({ type: 'cmdline_enter' });
    sm.applyMsg({ type: 'cmdline_key', seq: 's' });
    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderCmdline();
    } finally {
      term.stdout.write = orig;
    }
    const bytes = chunks.join('');
    assert(bytes.length > 0,
      'stdout fallback wrote nothing — the fallback keeps the pre-compositor path alive for migration-period callers');
    const stripped = bytes
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('Commands'),
      `stdout fallback must still paint the dropdown title — got: ${JSON.stringify(stripped.slice(0, 160))}`);
    assert(stripped.includes(':s'),
      `stdout fallback must still paint the prompt — got: ${JSON.stringify(stripped.slice(0, 160))}`);
  });
});

describe('[cmdline-overlay-composite] no FULL_CLEAR on cmdline_enter through the paint pipeline', () => {
  const sm = require('./smoke/_helpers/smoke');
  sm.bootFresh();
  sm.resize(100, 30);
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening cmd mode does NOT emit a full-clear', () => {
    const out = sm.capture(() => {
      sm.applyMsg({ type: 'cmdline_enter' });
      sm.render();
    }).raw;
    assert(!out.includes(FULL_CLEAR),
      'cmdline_enter emitted a full-clear — the compositor migration promises OPEN rides on per-cell diff from newRows, not a sig-tracker invalidation');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    // The empty prompt (just the `:` and footer colouring) should land
    // somewhere in the capture.
    assert(/:/.test(stripped),
      `expected a ":" prompt to land on-screen — got: ${JSON.stringify(stripped.slice(0, 200))}`);
  });
});

report();
