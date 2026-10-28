/**
 * Which-key overlay — overlay-compositor migration (Release 2 Phase 2.a #8,
 * docs/overlay-compositor-migration.md). Last of eight simple overlays.
 *
 * This commit also retires one more explicit `force_full_repaint` — the
 * `prefix_key` subtree-descend arm in js/dispatch/update/reducer.js. The
 * subtree-descend transition was Class-A workaround territory (prior
 * overlay border rows exposed when a subtree shrinks); cell-diff handles
 * it now via the compositor path.
 *
 * Four pins:
 *   1. Composite path mutates `targetRows` and writes zero stdout.
 *   2. Stdout fallback still fires when invoked without `targetRows`.
 *   3. No `FULL_CLEAR` on `enter_prefix` through the real paint pipeline.
 *   4. No `FULL_CLEAR` on `prefix_key` subtree descend — the migration-
 *      earned win mirroring panel-list's close pin (first/second
 *      Phase-2.a tests to pin a non-overlay-flag-drop transition).
 *
 * Run: node js/test/test-which-key-overlay-composite.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const term = require('../io/term');
const { freshOverlayModel } = require('./_helpers/overlay-capture');
const { renderWhichKey } = require('../overlay/which-key');
const { visibleLen } = require('../leaves/text/ansi');
const kb = require('../leaves/input/keybindings');

function _seedBindings() {
  // A tiny leader tree: a subtree `g` with children `g` (go top) + `G`
  // (go bottom), plus a plain leaf `?` so the root has at least two
  // continuations. The precise contents don't matter — the test just
  // needs SOMETHING to render.
  kb.clearBindings();
  kb.registerKeyBinding('g g', { label: 'top',    run: () => {} });
  kb.registerKeyBinding('g G', { label: 'bottom', run: () => {} });
  kb.registerKeyBinding('?',   { label: 'help',   run: () => {} });
}

describe('[which-key-overlay-composite] composites into newRows when invoked with target buffer', () => {
  it('composite path mutates newRows and writes zero stdout bytes', () => {
    const COLS = 100;
    _seedBindings();
    let m = freshOverlayModel({ cols: COLS, rows: 30 });
    [m] = runtime.update(m, { type: 'enter_prefix' });
    const store = require('../model/store');
    store.setModel(m);
    const ROWS_H = 24;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderWhichKey(newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    const joined = newRows.join('\n');
    assert(joined.includes('leader'),
      `expected title "leader" to land in newRows`);
    assert(joined.includes('help'),
      'expected `?` leaf label to land in newRows');

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });

  it('stdout fallback still fires when invoked without targetRows', () => {
    _seedBindings();
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'enter_prefix' });
    const store = require('../model/store');
    store.setModel(m);
    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderWhichKey();
    } finally {
      term.stdout.write = orig;
    }
    const bytes = chunks.join('');
    assert(bytes.length > 0,
      'stdout fallback wrote nothing — the fallback keeps the pre-compositor path alive for migration-period callers');
    const stripped = bytes
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('leader'),
      `stdout fallback must still paint the title — got: ${JSON.stringify(stripped.slice(0, 120))}`);
  });
});

describe('[which-key-overlay-composite] no FULL_CLEAR on enter + no FULL_CLEAR on subtree descend', () => {
  process.stdout.columns = 100; process.stdout.rows = 30;
  const sm = require('./smoke/_helpers/smoke');
  const FULL_CLEAR = '\x1b[2J';

  _seedBindings();
  sm.bootFresh();
  sm.resize(100, 30);
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening prefix mode does NOT emit a full-clear', () => {
    sm.applyMsg({ type: 'enter_prefix' });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'enter_prefix emitted a full-clear — the compositor migration promises OPEN rides on per-cell diff from newRows, not a sig-tracker invalidation');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(/leader/.test(stripped),
      `expected the leader overlay title to land on-screen — got: ${JSON.stringify(stripped.slice(0, 200))}`);
  });

  it('descending into a subtree (prefix_key `g`) does NOT emit a full-clear either', () => {
    // Prefix mode is still on from the previous step. Send `g` to
    // descend into the subtree. The reducer previously emitted a
    // force_full_repaint here (Class A); post-migration, cell-diff
    // handles the resize.
    sm.applyMsg({ type: 'prefix_key', key: 'g', seq: 'g' });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'prefix_key subtree-descend emitted a full-clear — the migration drops the explicit force_full_repaint from prefix_key; cell-diff must handle the overlay resize from the natural row delta');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    // After descent, the subtree's leaf labels (`top`, `bottom`) land in
    // newRows. The on-screen bytes come as a per-cell diff relative to
    // the previous frame, not a full repaint, so we match on the leaf
    // labels rather than a contiguous "leader g" substring (which the
    // paint pipeline splits across cell writes).
    assert(/top|bottom/.test(stripped),
      `expected one of the descended subtree's labels (top/bottom) to land on-screen — got: ${JSON.stringify(stripped.slice(0, 200))}`);
  });
});

report();
