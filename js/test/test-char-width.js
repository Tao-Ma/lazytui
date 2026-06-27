/**
 * charWidth / visibleLen — Unicode East-Asian display width.
 *
 * Regression guard for the v0.6.7 kana bug: the previous hand-picked range
 * table in ansi.js omitted hiragana/katakana/hangul (and more) entirely, so
 * those rendered at HALF their true width. That misaligned every pane border on
 * a row containing such text, and — because the A2 cell-diff emits ABSOLUTE
 * per-cell MoveTo columns computed from charWidth — drifted glyphs to the wrong
 * column under the default render path. charWidth is now backed by the
 * `eastasianwidth` library (UAX #11) with our "Wide/Fullwidth → 2, else → 1"
 * locale policy.
 *
 * The ORACLE column below is the actual cursor advance measured against
 * @xterm/headless — the embedded terminal the cell-diff must agree with (it is
 * also the replay screen). Baked as a static table because @xterm/headless's
 * write is async and the test harness's it() is synchronous; regenerate via the
 * scratchpad A/B harness (cell-diff-ab.js / oracle.js) if the emulator changes.
 *
 * Run: node js/test/test-char-width.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { charWidth, visibleLen } = require('../leaves/text/ansi');

const cw = (cp) => charWidth(cp);

describe('[1] width policy by script — the contract', () => {
  it('ASCII + Latin-1 are width 1', () => {
    eq(cw(0x41), 1, 'A');
    eq(cw(0x7e), 1, '~');
    eq(cw(0xe9), 1, 'é (Latin-1, EAW=Ambiguous)');
  });
  it('CJK ideographs are width 2', () => {
    eq(cw(0x4e00), 2, '一 (CJK Unified start)');
    eq(cw(0x884c), 2, '行');
    eq(cw(0x9fff), 2, 'CJK Unified end');
    eq(cw(0x3400), 2, 'Ext-A start');
    eq(cw(0x20000), 2, 'Ext-B start');
  });
  it('hiragana / katakana are width 2 (the v0.6.7 bug)', () => {
    eq(cw(0x3042), 2, 'あ hiragana');
    eq(cw(0x30c6), 2, 'テ katakana');
    eq(cw(0x30b9), 2, 'ス katakana');
    eq(cw(0x30fb), 2, '・ katakana middle dot');
    eq(cw(0x30fc), 2, 'ー prolonged sound mark');
  });
  it('hangul is width 2 (syllables + jamo + compat-jamo)', () => {
    eq(cw(0xac00), 2, '가 Hangul Syllable start');
    eq(cw(0xd7a3), 2, 'Hangul Syllable end');
    eq(cw(0x1100), 2, 'ᄀ Hangul Jamo');
    eq(cw(0x3131), 2, 'ㄱ Hangul Compatibility Jamo');
  });
  it('fullwidth forms + bopomofo + enclosed-CJK are width 2', () => {
    eq(cw(0xff21), 2, 'Ａ Fullwidth A');
    eq(cw(0xff60), 2, 'Fullwidth Forms end');
    eq(cw(0xffe6), 2, '￦ Fullwidth Won sign');
    eq(cw(0x3105), 2, 'ㄅ Bopomofo');
    eq(cw(0x3280), 2, '㊀ Enclosed CJK');
    eq(cw(0x3000), 2, 'ideographic space');
  });
});

describe('[2] width-1 categories that must NOT widen', () => {
  it('box-drawing + blocks stay width 1 (all of lazytui chrome)', () => {
    // These are EAW=Ambiguous; widening them would shatter every pane border.
    eq(cw(0x2502), 1, '│');
    eq(cw(0x2500), 1, '─');
    eq(cw(0x256d), 1, '╭');
    eq(cw(0x2590), 1, '▐ right half block');
    eq(cw(0x2591), 1, '░ light shade');
  });
  it('Ambiguous (arrows / enclosed digits / symbols) stay width 1', () => {
    eq(cw(0x2192), 1, '→');
    eq(cw(0x2460), 1, '① circled digit');
    eq(cw(0x2605), 1, '★ black star');
    eq(cw(0xa7), 1, '§');
  });
  it('emoji / pictographs are width 1 (match the terminal cursor advance)', () => {
    eq(cw(0x1f680), 1, '🚀');
    eq(cw(0x1f600), 1, '😀');
    eq(cw(0x2728), 1, '✨');
    eq(cw(0x231a), 1, '⌚');
  });
  it('halfwidth katakana + ideographic half-fill stay width 1', () => {
    eq(cw(0xff71), 1, 'ｱ halfwidth katakana');
    eq(cw(0xff70), 1, 'ｰ halfwidth prolonged');
    eq(cw(0x303f), 1, '〿 ideographic half-fill (boundary: 3000–303E wide, 303F narrow)');
  });
});

describe('[3] matches the @xterm/headless oracle (the cell-diff target)', () => {
  // [name, codepoint, terminal cursor-advance measured vs @xterm/headless].
  // charWidth MUST equal this so the cell-diff's absolute MoveTo columns track
  // the real cursor. Covers every script in the table + the width-1 traps.
  const ORACLE = [
    ['ASCII', 0x41, 1], ['Latin é', 0xe9, 1],
    ['box │', 0x2502, 1], ['block ▐', 0x2590, 1],
    ['CJK 行', 0x884c, 2], ['Ext-A', 0x3400, 2], ['Ext-B', 0x20000, 2],
    ['hiragana', 0x3042, 2], ['katakana', 0x30c6, 2], ['kata ・', 0x30fb, 2],
    ['halfwidth-kata', 0xff71, 1], ['halfwidth ｰ', 0xff70, 1],
    ['hangul', 0xac00, 2], ['jamo', 0x1100, 2], ['compat-jamo', 0x3131, 2],
    ['bopomofo', 0x3105, 2], ['fullwidth A', 0xff21, 2], ['fullwidth ￦', 0xffe6, 2],
    ['enclosed', 0x3280, 2], ['ideo-space', 0x3000, 2], ['half-fill', 0x303f, 1],
    ['yi', 0xa000, 2], ['kangxi', 0x2f00, 2], ['radical', 0x2e80, 2],
    ['vert-form', 0xfe10, 2], ['small-form', 0xfe50, 2],
    ['ambiguous ①', 0x2460, 1], ['ambiguous →', 0x2192, 1], ['ambiguous ★', 0x2605, 1],
    ['emoji 🚀', 0x1f680, 1], ['emoji 😀', 0x1f600, 1], ['emoji ✨', 0x2728, 1],
  ];
  for (const [name, cp, want] of ORACLE) {
    it(`${name} (U+${cp.toString(16).toUpperCase()}) → ${want}`, () => {
      eq(cw(cp), want, name);
    });
  }
});

describe('[4] known, accepted divergences from this terminal (archaic ranges)', () => {
  // Three ranges where eastasianwidth's Unicode vintage and @xterm/headless
  // disagree. All are archaic/unhittable in real TUI content; pinned so a future
  // lib/emulator change surfaces here rather than as a silent render drift.
  it('Yijing hexagrams: we say 1, this terminal renders 2', () => {
    eq(cw(0x4dc0), 1, '䷀ Yijing (lib: not W; terminal: 2)');
  });
  it('Hangul Jamo Ext-A: we say 2, this terminal renders 1', () => {
    eq(cw(0xa960), 2, 'Hangul Jamo Ext-A (lib: W; terminal: 1)');
  });
  it('Kana Supplement: we say 2, this terminal renders 1', () => {
    eq(cw(0x1b000), 2, 'Kana Supplement (lib: W; terminal: 1)');
  });
});

describe('[5] visibleLen sums codepoint widths (the render contract)', () => {
  it('pure ASCII', () => eq(visibleLen('hello'), 5));
  it('mixed ASCII + CJK', () => eq(visibleLen('ab中文'), 6));   // 2 + 2×2
  it('katakana string (the bug scenario)', () => {
    // "テスト" = 3 katakana × 2 = 6 — previously mis-summed to 3.
    eq(visibleLen('テスト'), 6);
  });
  it('hangul string', () => eq(visibleLen('한국어'), 6));        // 3 × 2
  it('markup is stripped before measuring', () => {
    eq(visibleLen('[bold]あ[/]'), 2);                            // one wide glyph
  });
});

report();
