/**
 * Cmdline overlay — overlay-compositor migration (Release 2 Phase 2.b #3,
 * docs/overlay-compositor-migration.md). Final medium overlay; closes
 * Phase 2.b.
 *
 * Asymmetry vs the other Phase-2.b overlays: cmdline paints a
 * BORDERED DROPDOWN above the prompt row AND a PROMPT ROW on the very
 * bottom (row ROWS). The dropdown composites into newRows (so cell-
 * diff handles the shrink/close); the prompt row is the FOOTER row in
 * cmd mode (render/footer renderFooter → cmdlinePromptRow), emitted by
 * paint after the main frame; the cursor is terminal state, placed by
 * paint's terminal-surface pass.
 *
 * Pins:
 *   1. The overlay pass composites the dropdown into `newRows` and writes
 *      NOTHING to the screen (it wrote the prompt row mid-frame, before the
 *      main frame — a resize's full clear then erased it).
 *   2. The frame's cursor sits after the prompt text, by width.
 *   3. The typed text is drawn as text, not markup.
 *   4. No `FULL_CLEAR` on `cmdline_enter` through the real paint pipeline.
 *   5. A full repaint (resize) keeps the prompt row: it lands after the clear.
 *
 * Run: node js/test/test-cmdline-overlay-composite.js
 */
'use strict';

process.stdout.columns = 100; process.stdout.rows = 30;

const { describe, it, assert, eq, report } = require('./test-runner');
const term = require('../io/term');
const { renderCmdline } = require('../overlay/cmdline');
const { visibleLen } = require('../leaves/text/ansi');

const FULL_CLEAR = '\x1b[2J';

describe('[cmdline-overlay-composite] composites the dropdown into newRows; the prompt row is the footer\'s', () => {
  it('the overlay pass puts the dropdown in newRows and writes nothing to the screen', () => {
    const COLS = 100;
    const sm = require('./smoke/_helpers/smoke');
    sm.bootFresh();
    sm.resize(COLS, 30);
    // Open cmd mode and type a prefix so the match list has entries.
    // The default bootFresh config carries `:show-hidden` + the standard
    // panel commands; `:s` resolves to a non-empty match set.
    sm.applyMsg({ type: 'cmdline_enter' });
    sm.applyMsg({ type: 'cmdline_key', seq: 's' });

    const ROWS_H = 29;   // availH = 30 - 1 (footer row)
    const newRows = new Array(ROWS_H).fill(' '.repeat(COLS));

    const stdoutChunks = [];
    const origWrite = term.stdout.write;
    term.stdout.write = (s) => { stdoutChunks.push(String(s)); return true; };
    try {
      renderCmdline(newRows, COLS);
    } finally {
      term.stdout.write = origWrite;
    }

    const stdoutBytes = stdoutChunks.join('');
    // Nothing reaches the screen from the overlay pass: it runs BEFORE the main
    // frame, whose full repaint (a resize) clears the screen after it.
    eq(stdoutBytes, '', 'the overlay pass wrote no bytes');
    // The prompt row is the footer's, built from the model.
    const row = require('../render/footer').renderFooter(require('../model/store').getModel());
    assert(row.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').startsWith(' :s'), JSON.stringify(row.slice(0, 80)));

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
  // (The pre-cleanup "stdout fallback still fires" case retired —
  // end-of-Release-2 cleanup; the overlay fn no longer has a stdout path.)
  it('a frame ends with the cursor after the prompt text, by WIDTH (CJK, emoji), whatever the dropdown did', () => {
    // Pre-release review 2026-11-14: `2 + 1 + _text.length` put the cursor left
    // of the text end for anything wider than one column per UTF-16 unit. Round
    // 2: the cursor was written inside the overlay pass, and the main frame's
    // diff after it moved it on — it ended in the dropdown whenever that changed.
    const COLS = 100;
    const sm = require('./smoke/_helpers/smoke');
    const { render } = require('../render/paint');
    const { getModel } = require('../model/store');
    sm.bootFresh();
    sm.resize(COLS, 30);
    const lastMove = () => {
      const chunks = [];
      const origWrite = term.stdout.write;
      term.stdout.write = (s) => { chunks.push(String(s)); return true; };
      try { render(getModel()); } finally { term.stdout.write = origWrite; }
      const moves = [...chunks.join('').matchAll(/\x1b\[(\d+);(\d+)H/g)].map(m => [+m[1], +m[2]]);
      return moves[moves.length - 1];
    };
    sm.applyMsg({ type: 'cmdline_enter' });
    lastMove();
    for (const ch of ['o', 'p', 'e', 'n', ' ']) sm.applyMsg({ type: 'cmdline_key', seq: ch });
    eq(lastMove(), [30, 8], 'after `open ` (the dropdown changed): on the prompt, after the text');
    sm.applyMsg({ type: 'cmdline_key', key: 'paste', seq: '日本🚀' });   // wide text arrives by paste
    // ' :open 日本🚀' = 1 + 1 + 5 + 2 + 2 + 2 = 13 columns → the cursor at 14.
    eq(lastMove(), [30, 14], 'after the wide text');
    // Backspace takes the emoji whole (it cut its surrogate pair in half).
    sm.applyMsg({ type: 'cmdline_key', seq: '\x7f' });
    eq(getModel().modal.cmdline.text, 'open 日本', 'Backspace drops one codepoint');
  });
  it('the typed text is drawn as text, not markup', () => {
    // `open a[0].txt` showed as ` :open a.txt` (round-2 review 2026-11-14).
    const sm = require('./smoke/_helpers/smoke');
    sm.bootFresh();
    sm.resize(100, 30);
    sm.applyMsg({ type: 'cmdline_enter' });
    sm.applyMsg({ type: 'cmdline_key', key: 'paste', seq: 'open a[0].txt' });
    const row = require('../overlay/cmdline').cmdlinePromptRow(require('../model/store').getModel());
    const plain = row.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    assert(plain.includes(':open a[0].txt'), JSON.stringify(plain.trim().slice(0, 40)));
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

describe('[cmdline-overlay-composite] a full repaint keeps the prompt row', () => {
  it('a resize while `:` is open: the prompt row is written AFTER the clear', () => {
    // Review round 2 (2026-11-15): the prompt row was written from the overlay
    // pass, then the main frame's full repaint (\x1b[2J — a resize) erased it;
    // the row stayed blank until the next key.
    const sm = require('./smoke/_helpers/smoke');
    sm.bootFresh();
    sm.resize(100, 30);
    sm.applyMsg({ type: 'cmdline_enter' });
    sm.applyMsg({ type: 'cmdline_key', key: 'paste', seq: 'theme nord' });
    sm.capture(sm.render);
    sm.resize(90, 30);
    const out = sm.capture(sm.render).raw;
    const clear = out.lastIndexOf(FULL_CLEAR);
    assert(clear >= 0, 'the resize frame is a full repaint');
    const tail = out.slice(clear).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    assert(tail.includes(' :theme nord'), `the prompt row follows the clear: ${JSON.stringify(tail.slice(-120))}`);
  });
});

report();
