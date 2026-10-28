/**
 * Menu overlay — overlay-compositor migration (Release 2 Phase 2.b #2,
 * docs/overlay-compositor-migration.md). Second migrated MEDIUM overlay
 * + the second sig tracker retired (`prevMenuItems`).
 *
 * Four pins:
 *   1. Composite path mutates `targetRows` and writes zero stdout.
 *   2. Stdout fallback still fires when invoked without `targetRows`.
 *   3. No `FULL_CLEAR` on `menu_open` through the real paint pipeline.
 *   4. No `FULL_CLEAR` on a menu-REPLACE-in-place — the transition the
 *      retired `prevMenuItems` sig tracker caught (right-click → "Send
 *      to port…" picker swap in production).
 *
 * The companion SYMPTOM-level test test-menu-replace-repaint.js (which
 * uses @xterm/headless to verify the first menu's text is actually gone
 * from screen after the replace) still passes under the compositor path:
 * menu A's cells land in newRows for frame A, menu B's cells for frame
 * B, and cell-diff emits per-cell writes for every differing cell.
 *
 * Run: node js/test/test-menu-overlay-composite.js
 */
'use strict';

process.stdout.columns = 100; process.stdout.rows = 30;

const { describe, it, assert, report } = require('./test-runner');
const term = require('../io/term');
const { renderMenu } = require('../overlay/menu');
const { visibleLen } = require('../leaves/text/ansi');

const FULL_CLEAR = '\x1b[2J';

describe('[menu-overlay-composite] composites into newRows when invoked with target buffer', () => {
  it('composite path mutates newRows and writes zero stdout bytes', () => {
    const COLS = 100;
    const sm = require('./smoke/_helpers/smoke');
    sm.bootFresh();
    sm.resize(COLS, 30);
    sm.applyMsg({ type: 'menu_open', items: [
      ['First action',  'noop', null],
      ['Second action', 'noop', null],
      ['Third action',  'noop', null],
    ], anchor: null });

    const ROWS_H = 24;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderMenu(newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    const joined = newRows.join('\n');
    assert(joined.includes('First action'),
      `expected first item to land in newRows`);
    assert(joined.includes('Menu'),
      `expected default title "Menu" to land in newRows`);

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });
  // (The pre-cleanup "stdout fallback still fires" case retired —
  // end-of-Release-2 cleanup; the overlay fn no longer has a stdout path.)
});

describe('[menu-overlay-composite] no FULL_CLEAR on open / in-place replace through the paint pipeline', () => {
  const sm = require('./smoke/_helpers/smoke');
  sm.bootFresh();
  sm.resize(100, 30);
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening a menu does NOT emit a full-clear', () => {
    sm.applyMsg({ type: 'menu_open', items: [['Opt A', 'noop', null]], anchor: null });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'menu_open emitted a full-clear — the compositor migration promises OPEN rides on per-cell diff from newRows, not a sig-tracker invalidation');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(/Opt A/.test(stripped),
      `expected the menu item to land on-screen through the paint pipeline — got: ${JSON.stringify(stripped.slice(0, 200))}`);
  });

  it('a menu REPLACE-in-place does NOT emit a full-clear either — the retired prevMenuItems territory', () => {
    // Settle after the open so the baseline diff is tight.
    sm.capture(sm.render);
    // Swap items + anchor — same pattern the production right-click flow
    // takes (context menu → "Send to port…" picker). This is the EXACT
    // transition the pre-migration prevMenuItems sig tracker caught.
    sm.applyMsg({ type: 'menu_open', items: [['Replaced item', 'noop', null]], anchor: { x: 40, y: 5 } });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'menu replace-in-place emitted a full-clear — the migration retires prevMenuItems; cell-diff must handle the menu-A → menu-B swap from the natural row delta');
  });
});

report();
