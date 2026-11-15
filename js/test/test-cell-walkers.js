/**
 * Every walker that measures text column by column steps one CELL at a time —
 * a codepoint sequence the host draws as one glyph (❤️ 👍🏽 👨‍👩‍👧 🇺🇸 1️⃣ a tag
 * flag, e + combining acute) is kept or cut WHOLE, and is as wide as the host
 * draws it (char-width `nextCell`).
 *
 * Grapheme-cluster arc (2026-11-15). Each walker summed codepoint widths, so ❤️
 * measured 1 (❤ + VS16) where tmux draws 2, 👨‍👩‍👧 measured 6 where tmux draws 2,
 * and a cut (truncation, a popup edge, an occluding overlay, a selection drag,
 * a search match) could land between ❤ and its VS16 — leaving a different
 * glyph behind. One walker per section:
 *
 *   [1] cell-grid rowToCells — one cell per sequence, as wide as the host draws it
 *   [2] cell-grid diffRowToAnsi — a sequence that changes is rewritten whole
 *   [3] cell-diff highlightRow — the change tint never splits a sequence
 *   [4] draw.truncate — never cuts inside a sequence
 *   [5] row-compositor compositeRow — a popup edge never cuts a sequence (nor
 *       a CJK glyph: a wide glyph under either edge of a popup grew the row by
 *       1–2 columns since v0.6.51 — the right split counted from the glyph's
 *       start, not the popup's edge, and kept a glyph straddling its right edge)
 *   [6] occlusion sliceRuns — an overlay edge never cuts a sequence
 *   [7] select-core — a drag onto any column of a sequence selects it whole
 *   [8] match-core + search — a match inside a sequence highlights it whole
 *   [9] ansi esc — a tab stop is counted after the sequence's real width
 *
 * Run: node js/test/test-cell-walkers.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { richToAnsi, stripMarkup, visibleLen, esc } = require('../leaves/text/ansi');
const { cellsOf, stringWidth } = require('../leaves/text/char-width');
const { rowToCells, diffRowToAnsi } = require('../leaves/render/cell-grid');
const { highlightRow } = require('../leaves/render/cell-diff');
const { truncate } = require('../leaves/render/draw');
const { compositeRow } = require('../leaves/render/row-compositor');
const { sliceRuns } = require('../leaves/render/occlusion');
const { selectedTextFrom } = require('../leaves/text/select-core');
const { computeMatches } = require('../leaves/text/match-core');
const { decorateWindow } = require('../leaves/text/search');

// [label, sequence, host width] — tmux 3.4, measured 2026-11-15.
const SEQS = [
  ['❤️ heart + VS16', '❤️', 2],
  ['👍🏽 skin tone', '\u{1F44D}\u{1F3FD}', 2],
  ['👨‍👩‍👧 ZWJ family', '\u{1F468}‍\u{1F469}‍\u{1F467}', 2],
  ['🇺🇸 flag', '\u{1F1FA}\u{1F1F8}', 2],
  ['1️⃣ keycap', '1️⃣', 2],
  ['🏴󠁧󠁢󠁥󠁮󠁧󠁿 tag flag', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', 2],
  ['é (e + combining acute)', 'é', 1],
  ['中 (one wide codepoint)', '中', 2],
];

// The plain text of `s` breaks into cells that are each whole: every cell is
// either one of `allowed` or a single ASCII / space character.
function wholeCells(s, allowed) {
  return cellsOf(s).every((c) => allowed.includes(c) || /^[\x20-\x7e…]$/.test(c));
}

describe('[1] rowToCells: one cell per sequence, as wide as the host draws it', () => {
  for (const [label, seq, w] of SEQS) {
    it(label, () => {
      const cells = rowToCells(richToAnsi(`a${seq}b`));
      eq(cells[1].g, seq, 'the whole sequence in one cell');
      eq(cells[1].w, w, 'its host width');
      eq(cells.length, 2 + w, 'a + the sequence + b = the columns visibleLen counts');
      eq(cells.length, visibleLen(`a${seq}b`));
      eq(cells[1 + w].g, 'b', 'b lands after the sequence');
    });
  }
});

describe('[2] diffRowToAnsi: a sequence that changes is rewritten whole', () => {
  it('❤ → ❤️ (VS16 widens the cell): the diff writes ❤️ whole, then b one column later', () => {
    const out = diffRowToAnsi('a❤b', 'a❤️b', 0);
    assert(out.includes('\x1b[1;2H'), `moves to column 2: ${JSON.stringify(out)}`);
    assert(out.includes('❤️b'), `writes ❤️ whole, b right after it: ${JSON.stringify(out)}`);
  });
  it('👍 → 👍🏽: the diff rewrites the sequence, not the tone alone', () => {
    const out = diffRowToAnsi('a\u{1F44D}b', 'a\u{1F44D}\u{1F3FD}b', 0);
    assert(out.includes('\u{1F44D}\u{1F3FD}'), `writes 👍🏽 whole: ${JSON.stringify(out)}`);
  });
});

describe('[3] highlightRow: the change tint never splits a sequence', () => {
  for (const [label, seq] of SEQS) {
    it(label, () => {
      const out = highlightRow('axb', `a${seq}b`, 'cell', '<', '>');
      // `<` then the sequence intact: the tint opens before it, nothing inside it.
      assert(out.includes(`<${seq}`), `the tint opens before the whole sequence: ${JSON.stringify(out)}`);
    });
  }
});

describe('[4] truncate never cuts inside a sequence', () => {
  for (const [label, seq] of SEQS) {
    it(label, () => {
      const text = `ab${seq}cdef`;
      for (let n = 1; n <= visibleLen(text); n++) {
        const out = stripMarkup(truncate(text, n));
        assert(visibleLen(out) <= n, `n=${n}: fits (${JSON.stringify(out)})`);
        assert(wholeCells(out, [seq]), `n=${n}: only whole cells (${JSON.stringify(out)})`);
      }
    });
  }
});

describe('[5] compositeRow: a popup edge never cuts a sequence', () => {
  for (const [label, seq] of SEQS) {
    it(label, () => {
      const row = `ab${seq}cdefgh`;
      const width = visibleLen(row);
      for (let x = 0; x <= 6; x++) {
        const rows = [row];
        compositeRow(rows, width, 'PP', x, 0, 2);
        const plain = stripMarkup(rows[0]);
        eq(visibleLen(plain), width, `x=${x}: the row keeps its width (${JSON.stringify(plain)})`);
        assert(wholeCells(plain, [seq]), `x=${x}: only whole cells (${JSON.stringify(plain)})`);
      }
    });
  }
});

describe('[6] sliceRuns: an overlay edge never cuts a sequence', () => {
  for (const [label, seq] of SEQS) {
    it(label, () => {
      const runs = [{ sgr: '', text: `ab${seq}cd` }];
      const width = stringWidth(runs[0].text);
      for (let c0 = 0; c0 < width; c0++) {
        for (let c1 = c0 + 1; c1 <= width; c1++) {
          const text = sliceRuns(runs, c0, c1).map((r) => r.text).join('');
          eq(stringWidth(text), c1 - c0, `[${c0},${c1}): exactly the columns (${JSON.stringify(text)})`);
          assert(wholeCells(text, [seq]), `[${c0},${c1}): only whole cells (${JSON.stringify(text)})`);
        }
      }
    });
  }
});

describe('[7] select-core: a drag onto any column of a sequence selects it whole', () => {
  const sel = (a, b) => ({ active: true, kind: 'char', anchor: { line: 0, col: a }, cursor: { line: 0, col: b } });
  for (const [label, seq, w] of SEQS) {
    it(label, () => {
      const lines = [`a${seq}b`];
      for (let col = 1; col < 1 + w; col++) eq(selectedTextFrom(lines, sel(col, col)), seq, `column ${col}`);
      eq(selectedTextFrom(lines, sel(0, 1)), `a${seq}`, 'a and the sequence');
      eq(selectedTextFrom(lines, sel(1 + w, 1 + w)), 'b', 'the column after it is b');
    });
  }
});

describe('[8] search: a match inside a sequence highlights it whole', () => {
  it('a match covers the whole cell: ❤ inside ❤️ is columns [1, 3)', () => {
    eq(computeMatches(['x❤️y'], '❤'), [{ line: 0, col: 1, len: 2 }]);
  });
  it('a match after a sequence starts at its real column (y after ❤️ is column 3)', () => {
    eq(computeMatches(['x❤️y'], 'y'), [{ line: 0, col: 3, len: 1 }]);
  });
  it('a match after a ZWJ family starts 2 columns past it', () => {
    eq(computeMatches(['\u{1F468}‍\u{1F469}‍\u{1F467}ok'], 'ok'), [{ line: 0, col: 2, len: 2 }]);
  });
  it('the decoration wraps the whole sequence', () => {
    const lines = ['x❤️y'];
    const out = decorateWindow(lines, computeMatches(lines, '❤'), 0)[0];
    assert(/\]❤️\[\/\]/.test(out), `[tag]❤️[/]: ${JSON.stringify(out)}`);
  });
});

describe('[9] esc: a tab stop is counted after the sequence\'s real width', () => {
  for (const [label, seq, w] of SEQS) {
    it(label, () => {
      const out = esc(`a${seq}\tb`);
      eq(out, `a${seq}${' '.repeat(8 - 1 - w)}b`, 'the tab pads to column 8');
      eq(visibleLen(out), 9);
    });
  }
});

report();
