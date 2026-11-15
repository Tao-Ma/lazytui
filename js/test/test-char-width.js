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
 * `eastasianwidth` (UAX #11) W/F ∪ Emoji_Presentation. Bugs here are width-source-vs-host disagreements: the kana bug (a
 * hand-rolled table omitted hiragana/katakana/hangul), the zero-width bug
 * (combining marks counted as 1 → the cell-diff drifted every MoveTo right on
 * NFD text), and the 2026-11-14 field report — every emoji was width 1 (the
 * `eastasianwidth` table predates Unicode 9's Wide emoji) while the host draws
 * them 2 wide: a ✅ in an action label pushed the Actions border off-screen,
 * LazyVim's ⚡/💤 pushed a terminal pane's row past its border.
 *
 * Block [4] pins HOST measurements (glibc 2.39 wcwidth + tmux 3.4 cursor
 * advance, 2026-11-14). Block [3] pins that the embedded emulator measures with
 * charWidth itself, codepoint by codepoint — the one-truth wiring. Block [7]
 * pins the CELLS — codepoint sequences the host draws as one glyph (❤️ 👍🏽 a ZWJ
 * family, a flag) — against tmux 3.4 (2026-11-15), for the frame and the
 * emulator alike.
 *
 * Run: node js/test/test-char-width.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { charWidth, visibleLen } = require('../leaves/text/ansi');
const { stringWidth, nextCell } = require('../leaves/text/char-width');
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
// Regional Indicators, which it keeps at 1 — tmux draws a lone one 2 wide, and
// a flag PAIR is one 2-wide cell ([7]).
describe('[4] emoji are as wide as the host draws them', () => {
  it('measured glyphs: the field report + common status emoji are 2', () => {
    const HOST_2 = [[0x26a1, '⚡'], [0x1f4a4, '💤'], [0x1f680, '🚀'], [0x2705, '✅'],
      [0x2b50, '⭐'], [0x2728, '✨'], [0x231a, '⌚'], [0x1f7e2, '🟢'], [0x1f600, '😀'],
      [0x274c, '❌'], [0x23f3, '⏳'], [0x1f525, '🔥'], [0x26d4, '⛔']];
    for (const [cp, g] of HOST_2) eq(cw(cp), 2, `${g} U+${cp.toString(16).toUpperCase()}`);
  });
  it('every Emoji_Presentation codepoint is 2', () => {
    const ep = /^\p{Emoji_Presentation}$/u;
    const wrong = [];
    for (let cp = 0x20; cp <= 0x10FFFF; cp++) {
      if (cp >= 0xD800 && cp <= 0xDFFF) continue;
      const ch = String.fromCodePoint(cp);
      if (!ep.test(ch)) continue;
      if (cw(cp) !== 2) { wrong.push(`U+${cp.toString(16).toUpperCase()}=${cw(cp)}`); if (wrong.length > 8) break; }
    }
    assert(wrong.length === 0, 'Emoji_Presentation → 2' + (wrong.length ? `: ${wrong.join(' ')}` : ''));
  });
  it('a lone Regional Indicator is 2; a flag (a pair) is one 2-wide cell', () => {
    eq(cw(0x1f1e6), 2, '🇦 alone (tmux 3.4: 2)');
    eq(visibleLen('🇺🇸'), 2, '🇺🇸');
  });
});

describe('[5] visibleLen sums cell widths (the render contract)', () => {
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
    // A cell, not a sum: tmux draws ❤️ as ONE 2-wide glyph (VS16 promotes it).
    eq(visibleLen('❤️'), 2, 'heart + VS16 = one 2-wide cell');
  });
  it('markup is stripped before measuring', () => {
    eq(visibleLen('[bold]あ[/]'), 2);                            // one wide glyph
  });
});

describe('[6] a runtime without Unicode property data still loads it', () => {
  // `\p{…}` needs ICU; a Node built --without-intl can't even parse a `\p`
  // regex LITERAL, so a literal in char-width.js would stop the module (and
  // every render) from loading. The classes are built with the RegExp
  // constructor, in try/catch, and fall back to the tables alone.
  const fs = require('fs');
  const path = require('path');
  const file = path.join(__dirname, '..', 'leaves', 'text', 'char-width.js');
  it('no \\p{…} regex literal in the source', () => {
    const code = fs.readFileSync(file, 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
    assert(!/\/[^/\n]*\\p\{[^/\n]*\/[a-z]*u/.test(code), 'a \\p literal would not parse without ICU');
  });
  it('the constructor throwing → the tables alone: CJK 2, combining 0, emoji 1, ASCII 1', () => {
    const { spawnSync } = require('child_process');
    const src = `const R = RegExp;
      global.RegExp = function (s, f) { if (String(s).includes('\\\\p{')) throw new SyntaxError('no ICU'); return new R(s, f); };
      const { charWidth, stringWidth } = require(${JSON.stringify(file)});
      process.stdout.write(JSON.stringify([...[0x4E00, 0x0301, 0x1F4A4, 0x41].map(charWidth),
        ...['❤️', '🇺🇸', '👨‍👩'].map(stringWidth)]));`;
    const r = spawnSync(process.execPath, ['-e', src], { encoding: 'utf8' });
    eq(r.status, 0, `loads: ${r.stderr}`);
    // VS16 and the flag pair still join without ICU (fixed codepoints / ranges);
    // a ZWJ sequence doesn't (Extended_Pictographic is property data): 1 + 0 + 1.
    eq(JSON.parse(r.stdout || 'null'), [2, 0, 1, 1, 2, 2, 2]);
  });
});

// ---------------------------------------------------------------------------
// [7] cells — codepoint sequences the host draws as ONE glyph.
// ---------------------------------------------------------------------------
// Measured 2026-11-15: tmux 3.4's cursor advance after printing each sequence
// alone. The frame (stringWidth) and the emulator (same joinStep) must both say
// what tmux draws — or the border lands early/late on any row carrying one.
const HOST_CELLS = [
  // [label, text, tmux 3.4 columns]
  ['ASCII', 'abc', 3], ['CJK', '中文', 4],
  ['❤️ heart + VS16', '❤️', 2], ['❤ bare heart', '❤', 1], ['☀️', '☀️', 2],
  ['✈️', '✈️', 2], ['©️ (base < U+0300)', '©️', 2], ['a + VS16', 'a️', 2],
  ['│ + VS16', '│️', 2], ['⚡ + VS16 (already wide)', '⚡️', 2],
  ['space + VS16', ' ️', 2], ['space + acute', ' ́', 1],
  ['☔︎ VS15 keeps 2', '☔︎', 2], ['👍︎ VS15 keeps 2', '\u{1F44D}︎', 2],
  ['1️⃣ keycap', '1️⃣', 2], ['#️⃣ keycap', '#️⃣', 2], ['1 + VS16', '1️', 2],
  ['👍🏽 skin tone', '\u{1F44D}\u{1F3FD}', 2], ['🏽 lone tone', '\u{1F3FD}', 2],
  ['👍🏽🏽 two tones', '\u{1F44D}\u{1F3FD}\u{1F3FD}', 2], ['a + tone (no base)', 'a\u{1F3FD}', 3],
  ['☺️ + tone (not a modifier base)', '☺️\u{1F3FD}', 4],
  ['👨‍👩‍👧 ZWJ family', '\u{1F468}‍\u{1F469}‍\u{1F467}', 2],
  ['👩🏽‍💻 tone + ZWJ', '\u{1F469}\u{1F3FD}‍\u{1F4BB}', 2],
  ['🏳️‍🌈 VS16 + ZWJ', '\u{1F3F3}️‍\u{1F308}', 2], ['🏳‍🌈 no VS16 keeps 1', '\u{1F3F3}‍\u{1F308}', 1],
  ['❤️‍🔥', '❤️‍\u{1F525}', 2], ['❤‍🔥 no VS16 keeps 1', '❤‍\u{1F525}', 1],
  ['👨‍a (ASCII never joins)', '\u{1F468}‍a', 3], ['a‍b', 'a‍b', 2],
  ['🇺🇸 flag', '\u{1F1FA}\u{1F1F8}', 2], ['🇦 lone RI', '\u{1F1E6}', 2],
  ['🏴󠁧󠁢󠁥󠁮󠁧󠁿 tag sequence', '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}', 2],
  ['e + acute', 'é', 1], ['e + VS16 + acute', 'e️́', 2], ['❤️x', '❤️x', 3],
  ['각 conjoining jamo', '각', 2], ['각 syllable', '각', 2],
  ['क्षि Devanagari (NOT one cell)', 'क्षि', 3], ['กำ Thai', 'กำ', 2],
];
// tmux 3.4 joins MORE than Unicode does on these; the rule follows Unicode (a
// host that draws them right — and tmux's own outer terminal — sees two glyphs).
const TMUX_OVERJOINS = [
  // [label, text, tmux 3.4, ours]
  ['🇺🇸🇫🇷 two flags (tmux merges every RI)', '\u{1F1FA}\u{1F1F8}\u{1F1EB}\u{1F1F7}', 2, 4],
  ['🇺🇸🇦 flag + lone RI', '\u{1F1FA}\u{1F1F8}\u{1F1E6}', 2, 4],
  ['中🏽 tone after a non-base', '中\u{1F3FD}', 2, 4],
  ['a‍👨 pictograph after a text ZWJ', 'a‍\u{1F468}', 1, 3],
  ['中‍中', '中‍中', 2, 4],
];
const _emuAdvance = (text) => {
  const s = createScreen(40, 2);
  s._core._inputHandler.parse(text);
  return s.buffer.active.cursorX;
};

describe('[7] cells: a sequence the host draws as one glyph is one cell', () => {
  it('the frame measures what tmux 3.4 draws (measured sequences)', () => {
    const wrong = HOST_CELLS.filter(([, t, host]) => stringWidth(t) !== host)
      .map(([l, t, host]) => `${l}: ${stringWidth(t)} (tmux ${host})`);
    assert(wrong.length === 0, 'frame width == tmux' + (wrong.length ? `:\n    ${wrong.join('\n    ')}` : ''));
  });
  it('where tmux over-joins, the rule follows Unicode (pinned)', () => {
    for (const [l, t, , ours] of TMUX_OVERJOINS) eq(stringWidth(t), ours, l);
  });
  it('the emulator advances exactly what the frame measures (every sequence)', () => {
    const wrong = [...HOST_CELLS, ...TMUX_OVERJOINS].filter(([, t]) => _emuAdvance(t) !== stringWidth(t))
      .map(([l, t]) => `${l}: emulator ${_emuAdvance(t)}, frame ${stringWidth(t)}`);
    assert(wrong.length === 0, 'emulator == frame' + (wrong.length ? `:\n    ${wrong.join('\n    ')}` : ''));
  });
  it('the emulator stores a joined sequence as ONE cell (its chars, its width)', () => {
    const s = createScreen(10, 2);
    s._core._inputHandler.parse('❤️x\u{1F468}‍\u{1F469}');
    const line = s.buffer.active.getLine(0);
    eq(line.getCell(0).getChars(), '❤️', '❤️ in cell 0');
    eq(line.getCell(0).getWidth(), 2, '❤️ is 2 wide');
    eq(line.getCell(2).getChars(), 'x', 'x after it at column 2');
    eq(line.getCell(3).getChars(), '\u{1F468}‍\u{1F469}', 'the ZWJ pair in one cell');
    eq(s.buffer.active.cursorX, 5);
  });
  it('nextCell walks cell by cell: width + where the next one starts', () => {
    const t = 'a❤️\u{1F1FA}\u{1F1F8}é';
    const out = { end: 0 }, cells = [];
    for (let i = 0; i < t.length; i = out.end) { const w = nextCell(t, i, out); cells.push([t.slice(i, out.end), w]); }
    eq(cells, [['a', 1], ['❤️', 2], ['\u{1F1FA}\u{1F1F8}', 2], ['é', 1]]);
  });
  it('stringWidth (incremental) == the sum of nextCell widths (lookahead) on random mixes', () => {
    // Two walks of the same cells — the hot-loop sum and the cell-by-cell one —
    // must never drift. Seeded, so a failure reproduces.
    const POOL = [0x61, 0x20, 0x2502, 0x4E2D, 0x0301, 0x094D, 0x0915, 0x093F, 0x2764, 0xFE0F, 0xFE0E,
      0x200D, 0x1F468, 0x1F469, 0x1F44D, 0x1F3FD, 0x1F1FA, 0x1F1F8, 0x1F3F4, 0xE0067, 0xE007F, 0x20E3,
      0x31, 0x1100, 0x1161, 0x00A9, 0x263A, 0x1F525, 0x200B];
    let seed = 12345;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    const out = { end: 0 };
    const wrong = [];
    for (let k = 0; k < 3000 && wrong.length < 5; k++) {
      let t = '';
      for (let n = 1 + rnd(8); n > 0; n--) t += String.fromCodePoint(POOL[rnd(POOL.length)]);
      let sum = 0;
      for (let i = 0; i < t.length; i = out.end) sum += nextCell(t, i, out);
      if (sum !== stringWidth(t)) wrong.push(`${JSON.stringify(t)}: cells ${sum}, stringWidth ${stringWidth(t)}`);
    }
    assert(wrong.length === 0, 'the two walks agree' + (wrong.length ? `:\n    ${wrong.join('\n    ')}` : ''));
  });
  it('a cell never spans an escape (the emulator drops the join state at a CSI too)', () => {
    const t = '❤\x1b[31m️';
    const out = { end: 0 };
    eq(nextCell(t, 0, out), 1, '❤ alone: the ESC stops the cell');
    eq(out.end, 1);
    const s = createScreen(10, 2);
    s._core._inputHandler.parse(t);
    eq(s.buffer.active.getLine(0).getCell(0).getWidth(), 1, 'the emulator: VS16 after an SGR does not widen ❤');
  });
});

report();
