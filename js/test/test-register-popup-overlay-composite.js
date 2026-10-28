/**
 * Register-popup overlay — overlay-compositor migration (Release 2
 * Phase 2.a #7, docs/overlay-compositor-migration.md). Same shape as
 * test-confirm-overlay-composite.js — one per migrated overlay.
 *
 * Three pins:
 *   1. Composite path mutates `targetRows` and writes zero stdout.
 *   2. Stdout fallback still fires when invoked without `targetRows`.
 *   3. No `FULL_CLEAR` on `register_popup_enter` through the real paint
 *      pipeline.
 *
 * Run: node js/test/test-register-popup-overlay-composite.js
 */
'use strict';

const { describe, it, assert, report } = require('./test-runner');
const runtime = require('../app/runtime');
const term = require('../io/term');
const { freshOverlayModel } = require('./_helpers/overlay-capture');
const { render: renderRegisterPopup } = require('../overlay/register-popup');
const { visibleLen } = require('../leaves/text/ansi');
const register = require('../leaves/register');

function _withEntry(m, text) {
  // Seed the register history directly through the leaf's pure `push`;
  // the production path mutates it via effect handlers for yank Cmds.
  const [next] = register.push(m.register || { history: [], cap: 100 }, text);
  return { ...m, register: next };
}

describe('[register-popup-overlay-composite] composites into newRows when invoked with target buffer', () => {
  it('composite path mutates newRows and writes zero stdout bytes', () => {
    const COLS = 100;
    let m = freshOverlayModel({ cols: COLS, rows: 30 });
    m = _withEntry(m, 'yanked line 1');
    m = _withEntry(m, 'yanked line 2');
    [m] = runtime.update(m, { type: 'register_popup_enter' });
    const store = require('../model/store');
    store.setModel(m);
    const ROWS_H = 24;
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderRegisterPopup(newRows, COLS);
    } finally {
      term.stdout.write = orig;
    }

    const anyBytes = chunks.join('');
    assert(anyBytes === '',
      `composite path wrote to stdout — expected zero bytes, got ${JSON.stringify(anyBytes.slice(0, 80))}…`);

    const joined = newRows.join('\n');
    assert(joined.includes('yanked line 1'),
      `expected older register entry to land in newRows`);
    assert(joined.includes('yanked line 2'),
      `expected newest register entry to land in newRows`);
    assert(joined.includes('Register history'),
      `expected title "Register history" to land in newRows`);

    for (let i = 0; i < newRows.length; i++) {
      const w = visibleLen(newRows[i]);
      assert(w === COLS,
        `row ${i} visible width = ${w}, expected ${COLS}; row:\n  ${JSON.stringify(newRows[i].slice(0, 80))}`);
    }
  });

  it('stdout fallback still fires when invoked without targetRows', () => {
    let m = freshOverlayModel();
    m = _withEntry(m, 'fallback entry');
    [m] = runtime.update(m, { type: 'register_popup_enter' });
    const store = require('../model/store');
    store.setModel(m);
    const chunks = [];
    const orig = term.stdout.write;
    term.stdout.write = (s) => { chunks.push(String(s)); return true; };
    try {
      renderRegisterPopup();
    } finally {
      term.stdout.write = orig;
    }
    const bytes = chunks.join('');
    assert(bytes.length > 0,
      'stdout fallback wrote nothing — the fallback keeps the pre-compositor path alive for migration-period callers');
    const stripped = bytes
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('fallback entry'),
      `stdout fallback must still paint the entry — got: ${JSON.stringify(stripped.slice(0, 120))}`);
  });
});

describe('[register-popup-overlay-composite] no FULL_CLEAR on register_popup_enter', () => {
  process.stdout.columns = 100; process.stdout.rows = 30;
  const sm = require('./smoke/_helpers/smoke');
  const FULL_CLEAR = '\x1b[2J';

  sm.bootFresh();
  sm.resize(100, 30);
  // Seed one register entry through the leaf — direct state write is
  // the simplest path (production emits a `register_yanked` Msg from the
  // yank effect; the end result is the same model shape).
  const { getModel } = require('../app/runtime');
  getModel().register = register.push(getModel().register || { history: [], cap: 100 }, 'synthetic yank')[0];
  sm.capture(sm.render);
  sm.capture(sm.render);

  it('opening the register popup does NOT emit a full-clear', () => {
    sm.applyMsg({ type: 'register_popup_enter' });
    const out = sm.capture(sm.render).raw;
    assert(!out.includes(FULL_CLEAR),
      'register_popup_enter emitted a full-clear — the compositor migration promises OPEN rides on per-cell diff from newRows, not a sig-tracker invalidation');
    const stripped = out
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
      .replace(/\x1b\][^\x07]*\x07/g, '');
    assert(stripped.includes('synthetic yank'),
      `expected the register entry to land on-screen through the paint pipeline — got: ${JSON.stringify(stripped.slice(0, 160))}`);
  });
});

report();
