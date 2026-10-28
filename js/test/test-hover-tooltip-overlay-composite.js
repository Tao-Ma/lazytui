/**
 * Hover-tooltip overlay — overlay-compositor migration (Release 2
 * end-of-release cleanup `5349f9d5`, docs/overlay-compositor-migration.md).
 * The hover tooltip is unusual among overlays: it is INLINED at
 * `paint.js:961-974` (no dedicated `js/overlay/*.js` module) and reads
 * live state from `panel/hover-region`. The pre-migration path carried
 * `_prevHoverRows` + `_hoverBoxRows` + a pre-paint `invalidateRows`
 * reclaim — the exact Class-A workaround every other migrated overlay
 * retired. This test pins that the tooltip now rides the compositor
 * path like its peers.
 *
 * Three pins:
 *   1. Composite path mutates `targetRows` and writes zero stdout
 *      (direct call matching paint.js:967-972's shape).
 *   2. No `FULL_CLEAR` on hover MOVE through the real paint pipeline
 *      (hoverRegion stubbed to canned values across two frames).
 *   3. No `FULL_CLEAR` on hover VANISH through the real paint pipeline
 *      (hoverRegion stubbed, then nulled).
 *
 * Run: node js/test/test-hover-tooltip-overlay-composite.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const term = require('../io/term');
const draw = require('../leaves/render/draw');
const { visibleLen } = require('../leaves/text/ansi');

describe('[hover-tooltip-overlay-composite] composites into newRows when invoked with target buffer', () => {
  it('composite path mutates newRows and writes zero stdout bytes', () => {
    // Install writer to the real stdout path (what paint.js does at boot).
    draw.setWriter((s) => term.stdout.write(s));

    const COLS = 100;
    const ROWS_H = 24;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      // Mirror paint.js:967-972 exactly: markup + anchor + width budget +
      // compositor opts. `[accent]` is a semantic theme token resolved at
      // paint via ansi.js; `esc()` is matched by stripMarkup below.
      draw.renderOverlay({
        lines: ['[accent]cpu 42.3%[/]'],
        anchor: { x: 10, y: 5 },
        maxWidth: Math.min(60, 'cpu 42.3%'.length + 4),
        targetRows: newRows,
        targetCols: COLS,
      });
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    const joined = newRows.join('\n');
    assert(joined.includes('cpu 42.3%'),
      `expected hover text to land in newRows; got rows:\n  ${JSON.stringify(newRows.slice(4, 8))}`);

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });
});

describe('[hover-tooltip-overlay-composite] no FULL_CLEAR on hover MOVE or VANISH', () => {
  process.stdout.columns = 120; process.stdout.rows = 30;
  const sm = require('./smoke/_helpers/smoke');
  const hoverRegion = require('../panel/hover-region');
  const FULL_CLEAR = '\x1b[2J';

  // Stub `hoverRegion.get` to return canned values. The module's own
  // `clear()` (called at the top of every paint) nulls internal state,
  // but our stubbed `get` returns the test value regardless; `publish()`
  // during the pane pass is a no-op because the smoke config has no
  // stats pane.
  const origGet = hoverRegion.get;
  let canned = null;
  hoverRegion.get = () => canned;

  sm.bootFresh();
  sm.resize(120, 30);
  // Warmup frames so prevRows settles — mirrors every other composite
  // test's shape so the first "with hover" frame can't be the first
  // paint (which legitimately emits a FULL_CLEAR on initial resize).
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('hover MOVE does NOT emit a full-clear', () => {
    canned = { x: 10, y: 5, text: 'cpu 42.3%' };
    const out1 = sm.capture(sm.render).raw;
    assert(!out1.includes(FULL_CLEAR),
      'first hover frame emitted a full-clear — compositor migration promises the tooltip paints via per-cell diff on newRows, not a sig-tracker invalidation');

    canned = { x: 30, y: 10, text: 'mem 15.2%' };
    const out2 = sm.capture(sm.render).raw;
    assert(!out2.includes(FULL_CLEAR),
      'hover-move frame emitted a full-clear — cell-diff must handle the move: prevRows holds the box at position A, newRows at position B, diff emits per-cell for BOTH rects simultaneously');
  });

  it('hover VANISH does NOT emit a full-clear', () => {
    canned = { x: 10, y: 5, text: 'cpu 42.3%' };
    sm.capture(sm.render);                   // seed prev with hover

    canned = null;                           // vanish
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'hover-vanish frame emitted a full-clear — cell-diff must clear the vacated rect from the newRows delta (prevRows had it, newRows doesn\'t)');
  });

  // Restore stub so later test files that share the module see the
  // real impl. (Node caches modules; a stray stub leaks across files.)
  hoverRegion.get = origGet;
});

report();
