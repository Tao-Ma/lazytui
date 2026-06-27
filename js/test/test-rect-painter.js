/**
 * test-rect-painter.js — composeRows + paintFrame (v0.6.3 P3.1).
 *
 * Unit tests for the new painter primitives. composeRows stamps
 * rects into screen rows; paintFrame row-diffs against prev.
 * Run: node js/test/test-rect-painter.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { composeRows, paintFrame } = require('../leaves/render/painter');

// A2 (v0.6.7): with LAZYTUI_CELL_DIFF=1 a changed row emits only its changed
// CELLS, not the whole row — so a shared trailing glyph isn't re-emitted. The
// row-positioning invariants hold either way; only the contiguous-content literal
// differs. (The cell-diff path has its own battery in test-cell-grid.js.)
const CELL = process.env.LAZYTUI_CELL_DIFF === '1';

const R = (x, y, w, h, lines) => ({ x, y, w, h, lines });

// ---------- composeRows -----------------------------------------

describe('[1] composeRows — single rect covering the whole screen', () => {
  it('rect spans (0,0)-(cols,rows): output is the rect lines verbatim', () => {
    const rows = composeRows(
      [R(0, 0, 4, 3, ['abcd', 'efgh', 'ijkl'])],
      4, 3,
    );
    eq(rows.length, 3);
    eq(rows[0], 'abcd');
    eq(rows[1], 'efgh');
    eq(rows[2], 'ijkl');
  });
});

describe('[2] composeRows — partial coverage pads with blanks', () => {
  it('single-row rect at top: lower rows are blank-of-width', () => {
    const rows = composeRows(
      [R(0, 0, 4, 1, ['ABCD'])],
      4, 3,
    );
    eq(rows.length, 3);
    eq(rows[0], 'ABCD');
    eq(rows[1], '    ');
    eq(rows[2], '    ');
  });

  it('rect narrower than cols: right side pads to cols', () => {
    const rows = composeRows(
      [R(0, 0, 4, 1, ['abcd'])],
      10, 1,
    );
    eq(rows[0], 'abcd      ');
  });

  it('rect starting mid-row: left side pads to rect.x', () => {
    const rows = composeRows(
      [R(3, 0, 4, 1, ['abcd'])],
      10, 1,
    );
    eq(rows[0], '   abcd   ');
  });
});

describe('[3] composeRows — multiple rects per row (left + right columns)', () => {
  it('two adjacent rects on same row: lines stitch together', () => {
    const rows = composeRows(
      [
        R(0, 0, 4, 1, ['LEFT']),
        R(4, 0, 4, 1, ['RGHT']),
      ],
      8, 1,
    );
    eq(rows[0], 'LEFTRGHT');
  });

  it('two rects with gap: blanks fill between', () => {
    const rows = composeRows(
      [
        R(0, 0, 4, 1, ['LEFT']),
        R(6, 0, 4, 1, ['RGHT']),
      ],
      10, 1,
    );
    eq(rows[0], 'LEFT  RGHT');
  });

  it('rects supplied out of x order: sorted before stitching', () => {
    const rows = composeRows(
      [
        R(4, 0, 4, 1, ['RGHT']),
        R(0, 0, 4, 1, ['LEFT']),
      ],
      8, 1,
    );
    eq(rows[0], 'LEFTRGHT');
  });

  it('column-shift scenario: short left column does NOT shift right', () => {
    // 6d9ad31's bug case: left column 1 row tall, right column 3.
    // Rows past row 0 in column 0 should be blank-of-leftW, with
    // right column properly placed at x=4.
    const rows = composeRows(
      [
        R(0, 0, 4, 1, ['XXXX']),               // left col, 1 row
        R(4, 0, 4, 3, ['RRR1', 'RRR2', 'RRR3']), // right col, 3 rows
      ],
      8, 3,
    );
    eq(rows.length, 3);
    eq(rows[0], 'XXXXRRR1', 'row 0: both columns');
    eq(rows[1], '    RRR2', 'row 1: left blank, right intact');
    eq(rows[2], '    RRR3', 'row 2: left blank, right intact');
  });
});

describe('[4] composeRows — rect.lines shorter than rect.h pads with empty rows', () => {
  it('rect declares h=3 but only supplies 2 lines: third row gets empty-string slot', () => {
    const rows = composeRows(
      [R(0, 0, 4, 3, ['a', 'b'])],   // lines.length < h
      4, 3,
    );
    // Row 2 → missing line → empty string → then padded with blanks
    // to reach cols=4. Same shape pre-P2 hit, now explicit.
    eq(rows[0], 'a   ');
    eq(rows[1], 'b   ');
    eq(rows[2], '    ');
  });
});

describe('[5] composeRows — multi-row rect contributes per-row line', () => {
  it('rect with h=3 contributes lines[0..2] to rows y..y+2', () => {
    const rows = composeRows(
      [R(0, 1, 3, 3, ['AAA', 'BBB', 'CCC'])],
      3, 5,
    );
    eq(rows[0], '   ', 'before rect: blank');
    eq(rows[1], 'AAA');
    eq(rows[2], 'BBB');
    eq(rows[3], 'CCC');
    eq(rows[4], '   ', 'after rect: blank');
  });
});

describe('[6] composeRows — empty rect list yields all-blank screen', () => {
  it('no rects, cols=5 rows=2 → two blank-of-5 rows', () => {
    const rows = composeRows([], 5, 2);
    eq(rows.length, 2);
    eq(rows[0], '     ');
    eq(rows[1], '     ');
  });
});

// ---------- paintFrame ------------------------------------------

describe('[7] paintFrame — full repaint when force=true', () => {
  it('emits clear + per-row cursor + content', () => {
    const out = paintFrame([], ['hello'], true);
    assert(out.didFull);
    assert(out.ansi.startsWith('\x1b[2J\x1b[H'), 'clear at top');
    assert(out.ansi.includes('\x1b[1;1H'), 'positions row 1');
    assert(out.ansi.includes('hello'));
  });
});

describe('[8] paintFrame — diff: only changed rows emit', () => {
  it('two rows, only row 1 changed: ANSI references row 2 only', () => {
    const prev = ['same', 'old1'];
    const next = ['same', 'NEW1'];
    const out = paintFrame(prev, next, false);
    assert(!out.didFull);
    assert(out.ansi.includes('\x1b[2;1H'), 'positions row 2');
    assert(!out.ansi.includes('\x1b[1;1H'), 'row 1 NOT emitted');
    // Row-level emits the whole 'NEW1'; cell-diff emits only the changed prefix
    // 'NEW' (the trailing '1' is shared with the prev row).
    assert(out.ansi.includes(CELL ? 'NEW' : 'NEW1'), 'emits the changed content');
  });

  it('no diff: returns empty ansi', () => {
    const prev = ['a', 'b'];
    const next = ['a', 'b'];
    const out = paintFrame(prev, next, false);
    eq(out.ansi, '');
    assert(!out.didFull);
  });
});

describe('[9] paintFrame — row count change forces full repaint', () => {
  it('prev had 2 rows, new has 3: didFull=true regardless of force', () => {
    const out = paintFrame(['a', 'b'], ['a', 'b', 'c'], false);
    assert(out.didFull, 'row count delta triggers full');
    assert(out.ansi.includes('\x1b[2J'));
  });
});

report();
