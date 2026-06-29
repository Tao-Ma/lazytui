/**
 * charWidth — the width truth function. Display width of a codepoint in
 * terminal columns, the single source everything routes through (visibleLen,
 * viewer truncation/selection/search, chrome draw, the A2 cell-diff). Because
 * the cell-diff emits ABSOLUTE per-cell MoveTo columns, charWidth MUST equal the
 * terminal's actual cursor advance, or borders/glyphs land at the wrong column.
 *
 * charWidth is partitioned by axis, each axis resolved by a standard library:
 * `wcwidth` (POSIX) for the ZERO-WIDTH axis (combining marks / ZWJ / variation
 * selectors → 0) and `eastasianwidth` (UAX #11) for the WIDE axis (W/F → 2).
 * Two bugs came from getting this wrong: the kana bug (a hand-rolled table
 * omitted hiragana/katakana/hangul → rendered half-width) and the zero-width bug
 * (combining marks counted as width 1 → the cell-diff drifted every MoveTo right
 * on NFD text and ZWJ/VS emoji). Both are width-source-vs-terminal disagreements.
 *
 * THE AUTHORITY for column math is the embedded terminal (@xterm/headless): it's
 * the thing interpreting our cursor commands, so "column N" is defined by ITS
 * width function. Block [3] is an EXHAUSTIVE differential oracle — charWidth is
 * compared against the terminal's own `wcwidth` for every codepoint, so any new
 * divergence (a lib bump, an emulator change) fails here instead of shipping as
 * silent render corruption. The residual divergences are pinned in EXCEPTIONS
 * (all archaic / unhittable in real TUI content).
 *
 * Run: node js/test/test-char-width.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { charWidth, visibleLen } = require('../leaves/text/ansi');
const { Terminal } = require('@xterm/headless');

const cw = (cp) => charWidth(cp);

// The embedded terminal's OWN width function — the authority for column math.
// `_core.unicodeService.wcwidth` is the synchronous primitive the parser uses to
// advance the cursor (so it needs no async `write`). Internal API by necessity:
// this is the oracle, not shipped code; if it ever moves, this test fails loudly.
const _term = new Terminal({ allowProposedApi: true });
const oracle = (cp) => _term._core.unicodeService.wcwidth(cp);

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

describe('[2b] zero-width codepoints are width 0 (the v0.6.7 round-2 cell-diff bug)', () => {
  // The terminal advances the cursor 0 for these — they fold into the preceding
  // glyph. charWidth returning 1 here drifted every absolute MoveTo to the right.
  it('combining marks are width 0', () => {
    eq(cw(0x0301), 0, '◌́ combining acute (NFD: é = e + this)');
    eq(cw(0x0300), 0, 'combining grave');
    eq(cw(0x0951), 0, 'Devanagari stress sign');
    eq(cw(0x20E3), 0, 'combining enclosing keycap');
  });
  it('joiners + variation selectors are width 0', () => {
    eq(cw(0x200D), 0, 'ZWJ (family/profession emoji)');
    eq(cw(0xFE0F), 0, 'VS16 (❤️ ✈️ emoji presentation)');
    eq(cw(0xFE00), 0, 'VS1');
    eq(cw(0x200B), 0, 'zero-width space');
  });
});

// ---------------------------------------------------------------------------
// [3] exhaustive differential oracle — charWidth vs the terminal's OWN wcwidth.
// ---------------------------------------------------------------------------
// Pinned divergences between charWidth (newer-Unicode libs) and @xterm/headless
// V6. Each row: [lo, hi, charWidth, terminalV6]. All archaic / unassigned /
// astral — unhittable in real TUI content; pinned so a NEW divergence (or one of
// these vanishing) surfaces as a test failure rather than a silent render drift.
const EXCEPTIONS = [
  // charWidth=1, terminal=2 — codepoints @xterm V6 treats Wide that are
  // reserved/unassigned (or narrowed) in the libs' newer Unicode vintage.
  [0x2E9A, 0x2E9A, 1, 2], [0x2EF4, 0x2EFF, 1, 2], [0x2FD6, 0x2FEF, 1, 2],
  [0x2FFC, 0x2FFF, 1, 2], [0x3040, 0x3040, 1, 2], [0x3097, 0x3098, 1, 2],
  [0x3100, 0x3104, 1, 2], [0x312E, 0x3130, 1, 2], [0x318F, 0x318F, 1, 2],
  [0x31BB, 0x31BF, 1, 2], [0x31E4, 0x31EF, 1, 2], [0x321F, 0x321F, 1, 2],
  [0x3248, 0x324F, 1, 2], [0x32FF, 0x32FF, 1, 2], [0x4DC0, 0x4DFF, 1, 2], // Yijing hexagrams
  [0xA48D, 0xA48F, 1, 2], [0xA4C7, 0xA4CF, 1, 2], [0xFE53, 0xFE53, 1, 2],
  [0xFE67, 0xFE67, 1, 2], [0xFE6C, 0xFE6F, 1, 2], [0xFF00, 0xFF00, 1, 2],
  // charWidth=2, terminal=1 — Wide blocks added after V6 (Hangul Jamo Ext-A/B,
  // Kana Supplement, Enclosed Ideographic Supplement).
  [0xA960, 0xA97C, 2, 1], [0xD7B0, 0xD7C6, 2, 1], [0xD7CB, 0xD7FB, 2, 1],
  [0x1B000, 0x1B001, 2, 1], [0x1F200, 0x1F202, 2, 1], [0x1F210, 0x1F23A, 2, 1],
  [0x1F240, 0x1F248, 2, 1], [0x1F250, 0x1F251, 2, 1],
  // charWidth=1, terminal=0 — ASTRAL combining marks `wcwidth`'s table misses
  // (Kharoshthi, Musical Symbols, Tai Xuan Jing). The only residual zero-width
  // gap; ancient scripts / musical notation, never in TUI content.
  [0x10A01, 0x10A03, 1, 0], [0x10A05, 0x10A06, 1, 0], [0x10A0C, 0x10A0F, 1, 0],
  [0x10A38, 0x10A3A, 1, 0], [0x10A3F, 0x10A3F, 1, 0], [0x1D167, 0x1D169, 1, 0],
  [0x1D173, 0x1D182, 1, 0], [0x1D185, 0x1D18B, 1, 0], [0x1D1AA, 0x1D1AD, 1, 0],
  [0x1D242, 0x1D244, 1, 0],
];

function expectedDivergence(cp) {
  for (const [lo, hi, cwv, tv] of EXCEPTIONS) if (cp >= lo && cp <= hi) return { cwv, tv };
  return null;
}

describe('[3] exhaustive differential oracle vs the embedded terminal', () => {
  it('charWidth equals the terminal’s own wcwidth for every codepoint (except the pinned set)', () => {
    const unexpected = [];
    for (let cp = 0x20; cp <= 0x3FFFF; cp++) {
      if (cp >= 0x7F && cp <= 0x9F) continue;       // DEL + C1 controls (stripped before render)
      if (cp >= 0xD800 && cp <= 0xDFFF) continue;   // surrogate halves (not scalar values)
      const got = charWidth(cp), want = oracle(cp);
      if (got === want) continue;
      const ex = expectedDivergence(cp);
      if (!ex || ex.cwv !== got || ex.tv !== want) {
        unexpected.push(`U+${cp.toString(16).toUpperCase()}: charWidth=${got} term=${want}`);
        if (unexpected.length > 12) break;
      }
    }
    assert(unexpected.length === 0,
      `no UNEXPECTED width divergence from the terminal` +
      (unexpected.length ? ` — found:\n    ${unexpected.join('\n    ')}` : ''));
  });

  it('every pinned exception still diverges exactly as recorded (none silently changed)', () => {
    const stale = [];
    for (const [lo, hi, cwv, tv] of EXCEPTIONS) {
      for (let cp = lo; cp <= hi; cp++) {
        if (charWidth(cp) !== cwv || oracle(cp) !== tv) { stale.push(`U+${cp.toString(16).toUpperCase()}`); break; }
      }
    }
    assert(stale.length === 0,
      `pinned EXCEPTIONS all still hold` + (stale.length ? ` — stale (resolved/changed): ${stale.join(', ')}` : ''));
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
    eq(visibleLen('❤️'), 1, 'heart + VS16 = 1 column');
  });
  it('markup is stripped before measuring', () => {
    eq(visibleLen('[bold]あ[/]'), 2);                            // one wide glyph
  });
});

report();
