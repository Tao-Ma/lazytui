/**
 * charWidth — the width truth function. Display width of a codepoint in
 * terminal columns, the single source everything routes through (visibleLen,
 * viewer truncation/selection/search, chrome draw, the A2 cell-diff) and the
 * embedded terminal emulator's own width function. Because the cell-diff emits
 * ABSOLUTE per-cell MoveTo columns, charWidth MUST equal the HOST terminal's
 * cursor advance, or borders/glyphs land at the wrong column.
 *
 * charWidth is partitioned by axis (leaves/text/char-width.js): ZERO-WIDTH =
 * `wcwidth` (POSIX) ∪ the runtime's Mn/Me + default-ignorable Cf; WIDE =
 * `eastasianwidth` (UAX #11) W/F ∪ Emoji_Presentation (minus Regional
 * Indicators). Bugs here are width-source-vs-host disagreements: the kana bug (a
 * hand-rolled table omitted hiragana/katakana/hangul), the zero-width bug
 * (combining marks counted as 1 → the cell-diff drifted every MoveTo right on
 * NFD text), and the 2026-11-14 field report — every emoji was width 1 (the
 * `eastasianwidth` table predates Unicode 9's Wide emoji) while the host draws
 * them 2 wide: a ✅ in an action label pushed the Actions border off-screen,
 * LazyVim's ⚡/💤 pushed a terminal pane's row past its border.
 *
 * Block [4] pins HOST measurements (glibc 2.39 wcwidth + tmux 3.4 cursor
 * advance, 2026-11-14). Block [3] pins that the embedded emulator measures with
 * charWidth itself, codepoint by codepoint — the one-truth wiring.
 *
 * Run: node js/test/test-char-width.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { charWidth, visibleLen } = require('../leaves/text/ansi');
const { createScreen } = require('../io/term-screen');

// The embedded emulator's OWN width function, as io/term-screen configures it.
// `_core.unicodeService.wcwidth` is the synchronous primitive the parser uses to
// advance the cursor. Internal API by necessity — this is the wiring check, not
// shipped code; if it ever moves, this test fails loudly.
const _screen = createScreen(80, 24);
const emulator = (cp) => _screen._core.unicodeService.wcwidth(cp);

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
  it('hiragana / katakana are width 2 (the kana bug)', () => {
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
  it('text-presentation symbols stay width 1 (no Emoji_Presentation)', () => {
    eq(cw(0x2713), 1, '✓');
    eq(cw(0x2717), 1, '✗');
    eq(cw(0x26a0), 1, '⚠');
    eq(cw(0x2764), 1, '❤ (bare, no VS16)');
    eq(cw(0x2600), 1, '☀');
    eq(cw(0x2708), 1, '✈');
  });
  it('halfwidth katakana + ideographic half-fill stay width 1', () => {
    eq(cw(0xff71), 1, 'ｱ halfwidth katakana');
    eq(cw(0xff70), 1, 'ｰ halfwidth prolonged');
    eq(cw(0x303f), 1, '〿 ideographic half-fill (boundary: 3000–303E wide, 303F narrow)');
  });
});

describe('[2b] zero-width codepoints are width 0 (the v0.6.7 round-2 cell-diff bug)', () => {
  // The terminal advances the cursor 0 for these — they fold into the preceding
  // glyph. charWidth returning 1 here drifted every absolute MoveTo to the right.
  it('combining marks are width 0', () => {
    eq(cw(0x0301), 0, '◌́ combining acute (NFD: é = e + this)');
    eq(cw(0x0300), 0, 'combining grave');
    eq(cw(0x0951), 0, 'Devanagari stress sign');
    eq(cw(0x20E3), 0, 'combining enclosing keycap');
  });
  it('combining marks newer than the `wcwidth` table are width 0 (runtime Mn/Me)', () => {
    eq(cw(0x0487), 0, 'combining Cyrillic pokrytie');
    eq(cw(0x0616), 0, 'Arabic small high ligature');
    eq(cw(0x07fd), 0, 'NKo dantayalan');
    eq(cw(0x08ca), 0, 'Arabic small high farsi yeh');
  });
  it('visible format characters keep their width (Cf but not ignorable)', () => {
    eq(cw(0x0605), 1, 'Arabic number mark above (prepended concatenation mark)');
    eq(cw(0x110bd), 1, 'Kaithi number sign');
  });
  it('joiners + variation selectors are width 0', () => {
    eq(cw(0x200D), 0, 'ZWJ (family/profession emoji)');
    eq(cw(0xFE0F), 0, 'VS16 (❤️ ✈️ emoji presentation)');
    eq(cw(0xFE00), 0, 'VS1');
    eq(cw(0x200B), 0, 'zero-width space');
  });
});

// ---------------------------------------------------------------------------
// [3] the embedded emulator measures with charWidth — one width truth.
// ---------------------------------------------------------------------------
// io/term-screen registers charWidth as the emulator's Unicode provider, so a
// program in a terminal pane is laid out at the widths its row is painted at.
// Exhaustive: any codepoint where the two disagree is a row that over- or
// under-fills its pane.
describe('[3] the embedded emulator measures with charWidth (every codepoint)', () => {
  it('the lazytui width provider is the active one', () => {
    eq(_screen.unicode.activeVersion, 'lazytui');
  });
  it('emulator width == charWidth for every printable codepoint', () => {
    const unexpected = [];
    for (let cp = 0x20; cp <= 0x10FFFF; cp++) {
      if (cp >= 0x7F && cp <= 0x9F) continue;       // DEL + C1 controls (the emulator executes them)
      if (cp >= 0xD800 && cp <= 0xDFFF) continue;   // surrogate halves (not scalar values)
      const got = charWidth(cp), want = emulator(cp);
      if (got === want) continue;
      unexpected.push(`U+${cp.toString(16).toUpperCase()}: charWidth=${got} emulator=${want}`);
      if (unexpected.length > 12) break;
    }
    assert(unexpected.length === 0,
      'no width divergence between the frame and the emulator' +
      (unexpected.length ? ` — found:\n    ${unexpected.join('\n    ')}` : ''));
  });
  it('a wide emoji advances the emulator cursor 2 columns', () => {
    // The parser's synchronous entry (internal); the cell layout after it is what counts.
    const s = createScreen(20, 2);
    s._core._inputHandler.parse('⚡x💤y');
    eq(s.buffer.active.cursorX, 6, '⚡(2) x(1) 💤(2) y(1)');
  });
});

// ---------------------------------------------------------------------------
// [4] host measurements — what the user's terminal actually draws.
// ---------------------------------------------------------------------------
// Measured 2026-11-14: glibc 2.39 `wcwidth` (C.UTF-8) and tmux 3.4's cursor
// advance after printing the glyph alone. Every Emoji_Presentation codepoint is
// Wide since Unicode 9 (UAX #11); glibc agrees on all of them except the
// Regional Indicators, which it keeps at 1 (a flag PAIR draws 2 wide in tmux).
describe('[4] emoji are as wide as the host draws them', () => {
  it('measured glyphs: the field report + common status emoji are 2', () => {
    const HOST_2 = [[0x26a1, '⚡'], [0x1f4a4, '💤'], [0x1f680, '🚀'], [0x2705, '✅'],
      [0x2b50, '⭐'], [0x2728, '✨'], [0x231a, '⌚'], [0x1f7e2, '🟢'], [0x1f600, '😀'],
      [0x274c, '❌'], [0x23f3, '⏳'], [0x1f525, '🔥'], [0x26d4, '⛔']];
    for (const [cp, g] of HOST_2) eq(cw(cp), 2, `${g} U+${cp.toString(16).toUpperCase()}`);
  });
  it('every Emoji_Presentation codepoint except the Regional Indicators is 2', () => {
    const ep = /^\p{Emoji_Presentation}$/u, ri = /^\p{Regional_Indicator}$/u;
    const wrong = [];
    for (let cp = 0x20; cp <= 0x10FFFF; cp++) {
      if (cp >= 0xD800 && cp <= 0xDFFF) continue;
      const ch = String.fromCodePoint(cp);
      if (!ep.test(ch)) continue;
      const want = ri.test(ch) ? 1 : 2;
      if (cw(cp) !== want) { wrong.push(`U+${cp.toString(16).toUpperCase()}=${cw(cp)}`); if (wrong.length > 8) break; }
    }
    assert(wrong.length === 0, 'Emoji_Presentation → 2, Regional Indicator → 1' + (wrong.length ? `: ${wrong.join(' ')}` : ''));
  });
  it('a flag is a Regional Indicator pair: 1 + 1 = the 2 columns the host draws', () => {
    eq(cw(0x1f1e6), 1, '🇦 alone');
    eq(visibleLen('🇺🇸'), 2, '🇺🇸');
  });
});

describe('[5] visibleLen sums codepoint widths (the render contract)', () => {
  it('pure ASCII', () => eq(visibleLen('hello'), 5));
  it('mixed ASCII + CJK', () => eq(visibleLen('ab中文'), 6));   // 2 + 2×2
  it('katakana string (the kana bug scenario)', () => {
    // "テスト" = 3 katakana × 2 = 6 — previously mis-summed to 3.
    eq(visibleLen('テスト'), 6);
  });
  it('hangul string', () => eq(visibleLen('한국어'), 6));        // 3 × 2
  it('combining marks add 0 (NFD text measures the same as NFC)', () => {
    eq(visibleLen('é'), 1, 'e + combining acute = 1 column (é)');
    eq(visibleLen('café'.normalize('NFD')), 4, 'decomposed "café" still 4 columns');
    // Per-codepoint: tmux draws ❤️ as ONE 2-wide glyph (VS16 promotes it). Cluster
    // widths are not charWidth's (char-width.js); this pins today's sum.
    eq(visibleLen('❤️'), 1, 'heart + VS16 = 1 + 0');
  });
  it('markup is stripped before measuring', () => {
    eq(visibleLen('[bold]あ[/]'), 2);                            // one wide glyph
  });
});

report();
