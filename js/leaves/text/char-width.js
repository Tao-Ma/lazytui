/**
 * charWidth — the width truth function. Display width of one codepoint in
 * terminal columns: the single source everything routes through (visibleLen,
 * viewer truncation/selection/search, chrome draw, the A2 cell-diff in
 * leaves/render/cell-grid) AND the embedded terminal emulator's own width
 * function (io/term-screen registers it as the emulator's Unicode provider, so
 * a program in a `terminal` pane is laid out with the same widths the frame is
 * painted with).
 *
 * THE AUTHORITY is the HOST terminal — the user's terminal (or tmux) that draws
 * every byte lazytui writes. The cell-diff emits ABSOLUTE per-cell MoveTo
 * columns and every pane border sits at a computed column, so a glyph the host
 * draws wider than charWidth says pushes the rest of its row — border included —
 * to the right. Modern hosts take their widths from the current Unicode data
 * (glibc's `wcwidth`; tmux uses it): measured on glibc 2.39 + tmux 3.4, ⚡ 💤 🚀
 * ✅ ⭐ 🟢 are 2 columns.
 *
 * Partitioned by axis, each from a STANDARD source — never a hand-maintained
 * range table (the v0.6.7 kana bug came from one):
 *   1. cp < 0x300         → 1  everything below the first combining mark
 *                              (ASCII / Latin / Latin-Ext). Fast path: one int
 *                              compare, no allocation.
 *   2. zero-width         → 0  a terminal advances the cursor 0 for these; the
 *                              cell-diff must too or it drifts every MoveTo:
 *                              `wcwidth` (POSIX table: combining marks, ZWJ, VS,
 *                              conjoining Hangul jamo) ∪ the runtime's Unicode
 *                              data — General_Category Mn/Me (every combining
 *                              mark, including those newer than the `wcwidth`
 *                              table) and default-ignorable format characters.
 *   3. wide               → 2  East Asian Wide/Fullwidth (`eastasianwidth`,
 *                              UAX #11) ∪ Emoji_Presentation (the runtime's
 *                              Unicode data). Since Unicode 9, UAX #11 makes every
 *                              Emoji_Presentation codepoint Wide; the
 *                              `eastasianwidth` table predates that and calls
 *                              them all Narrow. Regional Indicators (flag halves)
 *                              are the exception and stay 1: hosts draw a flag
 *                              PAIR 2 wide.
 *   4. else               → 1  Ambiguous / Narrow / Halfwidth / Neutral — box
 *                              drawing (│ ╭ ─), arrows, ★ ✓ ⚠, text-presentation
 *                              symbols (❤ ☀ ✈) all stay 1.
 *
 * Per-CODEPOINT, so a grapheme cluster the host draws as one glyph is measured
 * as the sum of its parts: ❤️ (base + VS16) = 1 where tmux draws 2; 👍🏽, a ZWJ
 * family, a flag pair sum to 4, 6, 2. Cluster widths are a separate concern
 * (queued as their own arc), not this function's.
 *
 * The two regexes use Unicode property escapes, built into every supported
 * runtime (Node ≥ 18, Bun) — no dependency, synchronous, CommonJS. Results are
 * memoised per codepoint (the function is pure), so the hot loops pay a typed-
 * array read after the first sight of each codepoint.
 */
'use strict';

const { eastAsianWidth } = require('eastasianwidth');
const wcwidth = require('wcwidth');

// One codepoint per test (anchored), so the alternation reads as set membership.
// Zero-width beyond the `wcwidth` table: any combining mark (Mn/Me), or a format
// character (Cf) that is default-ignorable (ZWJ, word joiner, bidi marks, the
// Tag characters). A Cf that is NOT default-ignorable keeps whatever width the
// rest of charWidth gives it: 0 where `wcwidth`'s own table says so (the older
// Arabic number signs U+0600–0603, U+06DD), else 1 (U+0605, the Egyptian
// hieroglyph format controls) — measured 2026-11-14.
//
// The `\p{…}` property classes read the runtime's Unicode data (ICU). A Node
// built without it (`--without-intl`) can't even PARSE a `\p` literal — this
// module would fail to load, and every render with it. So both are built here,
// in try/catch; without them the width is the two tables' alone (`wcwidth`
// zero, `eastasianwidth` wide): emoji 1 column, newer combining marks 1 — the
// widths before 2026-11-14, still the host's for most text.
const _unicodeClass = (src) => { try { return new RegExp(src, 'u'); } catch (_) { return null; } };
const _ZERO_RE = _unicodeClass('^(?:[\\p{Mn}\\p{Me}]|(?=\\p{Cf})\\p{Default_Ignorable_Code_Point})$');
const _EMOJI_WIDE_RE = _unicodeClass('^(?!\\p{Regional_Indicator})\\p{Emoji_Presentation}$');

// Memo: width + 1 per codepoint (0 = not computed yet). The whole code space is
// 1.1 MB of zero pages until touched — bounded, unlike a Map keyed by input.
const _memo = new Uint8Array(0x110000);

function _compute(cp) {
  const ch = String.fromCodePoint(cp);
  if (wcwidth(ch) === 0 || (_ZERO_RE && _ZERO_RE.test(ch))) return 0;
  const c = eastAsianWidth(ch);
  return (c === 'W' || c === 'F' || (_EMOJI_WIDE_RE && _EMOJI_WIDE_RE.test(ch))) ? 2 : 1;
}

function charWidth(cp) {
  if (cp < 0x300) return 1;                          // below the first combining mark — all width 1
  const m = _memo[cp];
  if (m) return m - 1;
  const w = _compute(cp);
  _memo[cp] = w + 1;
  return w;
}

module.exports = { charWidth };
