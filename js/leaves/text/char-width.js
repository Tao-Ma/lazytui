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
 *                              them all Narrow. That includes the Regional
 *                              Indicators (flag halves): tmux draws a lone 🇦 2
 *                              wide, and a PAIR joins into one 2-wide flag (below).
 *   4. else               → 1  Ambiguous / Narrow / Halfwidth / Neutral — box
 *                              drawing (│ ╭ ─), arrows, ★ ✓ ⚠, text-presentation
 *                              symbols (❤ ☀ ✈) all stay 1.
 *
 * CELLS — what the host draws as ONE glyph. A host draws some codepoint
 * SEQUENCES as a single glyph in a single cell, whose width is not the sum of
 * the parts: ❤️ (❤ + VS16) is 2 where its parts sum to 1; 👍🏽, a ZWJ family
 * 👨‍👩‍👧 and a flag 🇺🇸 are 2 where they sum to 4, 6 and 4. `joinStep` is the one
 * rule for which codepoint JOINS the cell before it; `nextCell` / `stringWidth`
 * walk a string cell by cell with it, and the emulator's provider is the same
 * function — so a row the emulator lays out is the row the frame measures. A
 * codepoint joins the cell before it when it is:
 *   - zero-width (combining mark, ZWJ, VS15, tag character) — keeps the width;
 *   - VS16 (U+FE0F, emoji presentation) — the cell becomes 2 wide, whatever its
 *     base (tmux 3.4: `a️` `│️` `©️` `1️⃣` are all 2);
 *   - a skin tone (🏻–🏿) after an Emoji_Modifier_Base — the cell becomes 2
 *     wide (☝ alone is 1, ☝🏽 is 2 — tmux 3.4);
 *   - a pictograph right after a ZWJ in an emoji cell — keeps the width (so
 *     `❤‍🔥` without the VS16 stays 1, as tmux has it);
 *   - the second Regional Indicator of a flag — the pair is 2.
 * Everything else starts a new cell. Text clusters are NOT joined: tmux (and
 * glibc's `wcswidth`) give Devanagari क्षि 3 columns, Thai and conjoining jamo
 * their sums — so this is deliberately not UAX #29's extended grapheme cluster
 * (`Intl.Segmenter` would make क्षि one cell). Measured on tmux 3.4 (the
 * fixtures of test-char-width [7]), 49 sequences: this rule agrees on 44. The
 * 5 others are tmux joining what Unicode doesn't — adjacent flags 🇺🇸🇫🇷 and
 * 🇺🇸🇦, `中🏽`, `a‍👨`, `中‍中`; tmux also draws the 9 bare text-default
 * modifier bases (☝ ✌ ✍ ⛹ 🖐 🕴 🕵 🏋 🏌) 2 wide, where Unicode has 1.
 *
 * A cell spans an SGR: the host joins across one (tmux 3.4: `❤ ESC[31m VS16`
 * is one 2-wide ❤️, `👍 ESC[31m 🏽` one 👍🏽 — a per-character colourizer writes
 * exactly that), so the walkers over markup and ANSI carry the join state over
 * a tag or an SGR (cell-grid rowToCells, cell-diff, ansi markupCut; visibleLen
 * strips the markup, then measures), and the emulator keeps it across an SGR
 * too (io/term-screen). tmux joins POSITIONALLY — a joiner attaches to the cell
 * left of the cursor, even after a cursor move — which the emulator doesn't;
 * term-screen paints the parts it keeps apart so a row stays exact.
 *
 * The regexes use Unicode property escapes — the runtime's own Unicode data
 * (Node ≥ 18 with ICU, Bun), no dependency, synchronous, CommonJS; a runtime
 * without it falls back to the two tables (below). Results are memoised per
 * codepoint (the functions are pure), so the hot loops pay a typed-array read
 * after the first sight of each codepoint.
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
// module would fail to load, and every render with it. So all of them are built
// here, in try/catch; without them the width is the two tables' alone
// (`wcwidth` zero, `eastasianwidth` wide): emoji 1 column, newer combining marks
// 1 — the widths before 2026-11-14, still the host's for most text — and no
// pictograph joins a ZWJ or takes a skin tone (VS16, flags and zero-width
// joining still apply).
const _unicodeClass = (src) => { try { return new RegExp(src, 'u'); } catch (_) { return null; } };
const _ZERO_RE = _unicodeClass('^(?:[\\p{Mn}\\p{Me}]|(?=\\p{Cf})\\p{Default_Ignorable_Code_Point})$');
const _EMOJI_WIDE_RE = _unicodeClass('^\\p{Emoji_Presentation}$');
const _PICTO_RE = _unicodeClass('^\\p{Extended_Pictographic}$');
const _MOD_BASE_RE = _unicodeClass('^\\p{Emoji_Modifier_Base}$');

const _VS16 = 0xFE0F;
const _ZWJ = 0x200D;
// Emoji_Modifier is exactly the five skin tones; Regional_Indicator is 🇦..🇿.
// Both are closed sets (Unicode stability), so a range test needs no ICU.
const _isSkinTone = (cp) => cp >= 0x1F3FB && cp <= 0x1F3FF;
const _isRegional = (cp) => cp >= 0x1F1E6 && cp <= 0x1F1FF;

// Memo per codepoint: (width + 1) in bits 0-1, plus the two cell-join
// properties; 0 = not computed yet. The whole code space is 1.1 MB of zero pages
// until touched — bounded, unlike a Map keyed by input.
const _P_PICTO = 4;      // Extended_Pictographic: joins a ZWJ, starts an emoji cell
const _P_MOD_BASE = 8;   // Emoji_Modifier_Base: a skin tone may follow
const _memo = new Uint8Array(0x110000);

function _width(ch) {
  if (wcwidth(ch) === 0 || (_ZERO_RE && _ZERO_RE.test(ch))) return 0;
  const c = eastAsianWidth(ch);
  return (c === 'W' || c === 'F' || (_EMOJI_WIDE_RE && _EMOJI_WIDE_RE.test(ch))) ? 2 : 1;
}

function _props(cp) {
  const m = _memo[cp];
  if (m) return m;
  const ch = String.fromCodePoint(cp);
  const p = (_width(ch) + 1) |
    (_PICTO_RE && _PICTO_RE.test(ch) ? _P_PICTO : 0) |
    (_MOD_BASE_RE && _MOD_BASE_RE.test(ch) ? _P_MOD_BASE : 0);
  _memo[cp] = p;
  return p;
}

function charWidth(cp) {
  if (cp < 0x300) return 1;                          // below the first combining mark — all width 1
  return (_props(cp) & 3) - 1;
}

// joinStep's state bits — what the cell so far allows to join it.
const _S_EMOJI = 1;      // the cell is a pictograph (or a flag half)
const _S_MOD_BASE = 2;   // its base takes a skin tone
const _S_ZWJ = 4;        // it ends in a ZWJ (an emoji cell's: the next pictograph joins)
const _S_FLAG_HALF = 8;  // it is ONE Regional Indicator (the next one completes the flag)

// Packed exactly as the emulator's Unicode service packs a codepoint's
// properties (@xterm `UnicodeService.createPropertyValue`): state << 3 |
// width << 1 | join — so joinStep IS the emulator provider's `charProperties`.
const _pack = (state, width, join) => (state << 3) | (width << 1) | (join ? 1 : 0);

/**
 * One codepoint of a cell walk. `preceding` = the value this function returned
 * for the codepoint before (0 at the start, after an escape, or with nothing to
 * join). Returns `state << 3 | width << 1 | join`: `join` = 1 when `cp` belongs
 * to the cell before it, and then `width` is that cell's width WITH it (VS16 can
 * grow it 1 → 2); otherwise `cp` starts a new cell `width` columns wide.
 */
function joinStep(cp, preceding) {
  let w = 1, props = 0;
  if (cp >= 0x300) { props = _props(cp); w = (props & 3) - 1; }
  const prevW = (preceding >> 1) & 3;
  if (prevW !== 0) {                                 // a cell to join (a zero-width one can't be)
    const st = preceding >> 3;
    if (cp === _VS16) return _pack(st & ~_S_ZWJ, 2, true);
    if ((st & _S_ZWJ) && (props & _P_PICTO)) {
      return _pack(_S_EMOJI | (props & _P_MOD_BASE ? _S_MOD_BASE : 0), prevW, true);
    }
    // A skin tone makes an emoji-presentation sequence: 2 wide, like VS16 — the
    // text-default bases (☝ ✌ ✍ ⛹ 🖐 🕴 🕵 🏋 🏌) are 1 alone, ☝🏽 is 2.
    if ((st & _S_MOD_BASE) && _isSkinTone(cp)) return _pack(st & ~_S_ZWJ, 2, true);
    if ((st & _S_FLAG_HALF) && _isRegional(cp)) return _pack(_S_EMOJI, 2, true);
    if (w === 0) return _pack(cp === _ZWJ && (st & _S_EMOJI) ? st | _S_ZWJ : st & ~_S_ZWJ, prevW, true);
  }
  if (w === 0) return 0;                             // nothing to join: a zero-width cell of its own
  let st = 0;
  if (props & _P_PICTO) st |= _S_EMOJI;
  if (props & _P_MOD_BASE) st |= _S_MOD_BASE;
  if (_isRegional(cp)) st |= _S_EMOJI | _S_FLAG_HALF;
  return _pack(st, w, false);
}

// Can `cp` (≥ 0x300) join some cell before it? (joinStep's join cases, minus
// what they need of the cell: VS16 and ZWJ are zero-width.)
const _mayJoin = (cp) => (_props(cp) & 3) === 1 || _isSkinTone(cp) || _isRegional(cp);

/**
 * The cell (one host glyph) starting at UTF-16 index `i` of PLAIN text `s` (no
 * markup, no escapes — a walk over markup or ANSI carries `joinStep`'s state
 * across the tags instead: a cell spans an SGR). Returns the cell's width in
 * columns and sets `out.end` to the index just past it. A zero-width codepoint with no cell
 * before it is a cell of its own, width 0 — the caller folds it (or drops it)
 * the way it always has. The caller owns `out` (one object per walk), so the
 * hot loops allocate nothing per cell.
 */
function nextCell(s, i, out) {
  const cp = s.codePointAt(i);
  let j = i + (cp > 0xFFFF ? 2 : 1);
  // Fast path: the next codepoint can't join ANY cell (only a zero-width one, a
  // skin tone or a Regional Indicator ever does — a pictograph joins only after
  // a ZWJ, itself zero-width), so this cell is `cp` alone. Nothing below 0x300
  // joins. Box drawing, CJK and plain emoji all leave here.
  if (!(s.charCodeAt(j) >= 0x300) || !_mayJoin(s.codePointAt(j))) { out.end = j; return charWidth(cp); }
  let p = joinStep(cp, 0);
  while (j < s.length) {
    const c = s.codePointAt(j);
    if (c < 0x300) break;
    const q = joinStep(c, p);
    if (!(q & 1)) break;
    p = q;
    j += c > 0xFFFF ? 2 : 1;
  }
  out.end = j;
  return (p >> 1) & 3;
}

/** Display width of a PLAIN string (no markup, no escapes): the sum of its
 *  cells' widths — the one copy (the emulator's cell text, the occlusion
 *  splice, the text view's line width, the selection geometry, visibleLen). */
function stringWidth(s) {
  if (s.length === 1) return charWidth(s.charCodeAt(0));
  // Incremental (no lookahead): each codepoint either starts a cell (+ its
  // width) or joins the one before it (+ how much it grew it, VS16: 1 → 2) —
  // the same cells nextCell walks, at a hot-loop cost of one memo read each.
  let w = 0, p = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x300) { w++; p = 2; continue; }        // a 1-wide cell (state 0): nothing below 0x300 joins
    const q = joinStep(cp, p);
    w += (q & 1) ? ((q >> 1) & 3) - ((p >> 1) & 3) : (q >> 1) & 3;
    p = q;
  }
  return w;
}

/** A PLAIN string split into its cells, left to right — the units a cursor or
 *  a window steps over (`cellsOf('a❤️🇺🇸')` → ['a', '❤️', '🇺🇸']). Each cell's
 *  width is `stringWidth(cell)`: a cell re-measured alone is the same cell. */
function cellsOf(s) {
  const out = [];
  const cell = { end: 0 };
  for (let i = 0; i < s.length; i = cell.end) {
    nextCell(s, i, cell);
    out.push(s.slice(i, cell.end));
  }
  return out;
}

// A character below U+0300 always STARTS a cell (nothing there joins one), so
// a walk to index `i` can begin at the nearest one at or before it instead of
// at 0 — a cut into a long paste stays local.
function _cellWalkFrom(s, i) {
  let a = i;
  while (a > 0 && !(s.charCodeAt(a) < 0x300)) a--;
  return a;
}

/** The last cell boundary at or before UTF-16 index `i`: where a cut at `i`
 *  lands without splitting a glyph (❤️ is cut before the ❤, never between ❤
 *  and its VS16 — nor between the halves of a surrogate pair). An editor's
 *  Backspace / ← is `cellFloor(text, cursor - 1)`; a length cap is
 *  `text.slice(0, cellFloor(text, max))`. */
function cellFloor(s, i) {
  if (i <= 0) return 0;
  if (i >= s.length) return s.length;
  const cell = { end: 0 };
  for (let at = _cellWalkFrom(s, i); at < s.length; at = cell.end) {
    nextCell(s, at, cell);
    if (cell.end > i) return at;
  }
  return s.length;
}

/** The first cell boundary at or after UTF-16 index `i`. An editor's Delete /
 *  → is `cellCeil(text, cursor + 1)`. */
function cellCeil(s, i) {
  if (i <= 0) return 0;
  if (i >= s.length) return s.length;
  const cell = { end: 0 };
  let at = _cellWalkFrom(s, i);
  while (at < i) { nextCell(s, at, cell); at = cell.end; }
  return at;
}

module.exports = { charWidth, stringWidth, nextCell, cellsOf, cellFloor, cellCeil, joinStep };
