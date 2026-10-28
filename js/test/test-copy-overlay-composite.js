/**
 * Copy overlay — overlay-compositor migration (Release 2 Phase 2.a #2,
 * docs/overlay-compositor-migration.md). Same shape as
 * test-confirm-overlay-composite.js — one per migrated overlay.
 *
 * Three pins:
 *   1. Composite path mutates `targetRows` and writes zero stdout.
 *   2. Stdout fallback still fires when invoked without `targetRows`
 *      (migration-period callers + unit tests).
 *   3. No `FULL_CLEAR` on `copy_enter` through the real paint pipeline.
 *
 * Run: node js/test/test-copy-overlay-composite.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const term = require('../io/term');
const { freshOverlayModel } = require('./_helpers/overlay-capture');
const { renderCopyMenu } = require('../overlay/copy');
const { visibleLen } = require('../leaves/text/ansi');

const _OPTS = [
  { label: 'Container id',   content: 'abc123' },
  { label: 'Container name', content: 'web-1'  },
  { label: '— Cancel —',     cancel: true      },
];

describe('[copy-overlay-composite] composites into newRows when invoked with target buffer', () => {
  it('composite path mutates newRows and writes zero stdout bytes', () => {
    const COLS = 100;
    let m = freshOverlayModel({ cols: COLS, rows: 30 });
    [m] = runtime.update(m, { type: 'copy_enter', options: _OPTS });
    const store = require('../model/store');
    store.setModel(m);
    const ROWS_H = 24;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderCopyMenu(newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    const joined = newRows.join('\n');
    assert(joined.includes('Container id'),
      `expected option "Container id" to land in newRows`);
    assert(joined.includes('Container name'),
      `expected option "Container name" to land in newRows`);
    assert(joined.includes('Cancel'),
      `expected cancel row to land in newRows`);
    assert(joined.includes('Copy'),
      `expected title "Copy" to land in newRows`);

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });

  it('stdout fallback still fires when invoked without targetRows', () => {
    let m = freshOverlayModel();
    [m] = runtime.update(m, { type: 'copy_enter', options: _OPTS });
    const store = require('../model/store');
    store.setModel(m);
    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderCopyMenu();
    } finally {
      term.stdout.write = orig;
    }
    const bytes = chunks.join('');
    assert(bytes.length > 0,
      'stdout fallback wrote nothing — the fallback keeps the pre-compositor path alive for migration-period callers');
    const stripped = bytes
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('Container id'),
      `stdout fallback must still paint the option list — got: ${JSON.stringify(stripped.slice(0, 120))}`);
  });
});

describe('[copy-overlay-composite] no FULL_CLEAR on copy_enter', () => {
  process.stdout.columns = 100; process.stdout.rows = 30;
  const sm = require('./smoke/_helpers/smoke');
  const FULL_CLEAR = '\x1b[2J';

  sm.bootFresh();
  sm.resize(100, 30);
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening the copy overlay does NOT emit a full-clear', () => {
    sm.applyMsg({ type: 'copy_enter', options: _OPTS });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'copy_enter emitted a full-clear — the compositor migration promises OPEN rides on per-cell diff from newRows, not a sig-tracker invalidation');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('Container id'),
      `expected first option to land on-screen through the paint pipeline — got: ${JSON.stringify(stripped.slice(0, 120))}`);
  });
});

report();
