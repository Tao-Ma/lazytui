/**
 * What a single-line text field accepts. Every field's key arm (cmdline,
 * filter, palette, search, rename, agent prompt, fabric field / form / choices
 * filter) asks `fieldInput(msg)` what a keystroke or a paste adds, and tests a
 * key byte with `pressed(msg, byte)` — never true for a paste. `fieldText` is a
 * paste (or any text a field paints) made single-line and control-free.
 *
 * `isPrintableSeq(seq)` — the keystroke predicate under fieldInput: true when
 * no code unit of `seq` is a control. It accepts:
 *   - ASCII printables (space through `~`)
 *   - BMP text past U+009F (Latin-1 letters, Cyrillic, Greek, CJK, Hangul, …)
 *   - Supplementary-plane surrogate pairs (emoji, less-common CJK extensions)
 *   - Combining marks, joiners, skin tones (they join the preceding glyph)
 *
 * Rejects:
 *   - C0 control chars (U+0000..U+001F): backspace, Tab, Enter, Esc, Ctrl+…
 *   - DEL (U+007F): the keyboard shortcut for backward-delete on many terms
 *   - C1 controls (U+0080..U+009F): U+009B is CSI, U+0085 NEL — a field that
 *     echoed one wrote a raw control to the host (tmux draws it 0 wide, so the
 *     caret drifted a column)
 *   - Non-string / empty values (`null`, `undefined`, `''`)
 *
 * Not called from a hot path — the field key arms call it once per keystroke.
 *
 * R3C-BUG1: the fabric field / form arms once used `charCodeAt(0) >= 32 &&
 * < 127 && length === 1`, which silently dropped every non-ASCII keystroke
 * (CJK IME users could type nothing). This module was born to fix that; since
 * 2026-11-15 every text field goes through it.
 */
'use strict';

const { stripControls } = require('./ansi');

// C0, DEL and C1 — reject these, accept everything else.
const _CONTROL_CHAR = /[\x00-\x1f\x7f-\x9f]/;

function isPrintableSeq(seq) {
  if (typeof seq !== 'string' || seq.length === 0) return false;
  return !_CONTROL_CHAR.test(seq);
}

/** Text as a single-line field holds and shows it: each run of line breaks
 *  and each tab becomes one space; terminal control sequences, the other C0
 *  controls, DEL, C1 controls and bidi overrides are dropped (ansi.stripControls,
 *  then the SGRs it keeps, then — the guarantee — any ESC left at all: removing
 *  one sequence can join its neighbours into another, `ok ESC[ ESC[m 8m` →
 *  `ESC[8m`, which hid the rest of a fabric value on the host). A field then
 *  holds exactly what it shows, so its row (esc) and its caret math (cell
 *  widths) measure the same text — a pasted tab was 1 column to the caret math
 *  and up to 8 on screen, a pasted SGR coloured the row and put the caret 5
 *  columns past the text. Painters window a seeded value (a resolved inject,
 *  `default:`, a pane title) through it too: the value keeps its tabs, the row
 *  shows spaces. */
function fieldText(s) {
  if (typeof s !== 'string') return '';
  return stripControls(s.replace(/[\r\n]+/g, ' ').replace(/\t/g, ' '))
    .replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b/g, '');
}

/** The text one keystroke Msg adds to a single-line text field, or null when
 *  it adds none: a bracketed paste (`key: 'paste'`) as fieldText makes it; a
 *  typed sequence when it is printable — any script, an emoji, a lone joiner or
 *  skin tone (the tokenizer hands a typed 👍🏽 over as 👍 then 🏽: each appends
 *  and the field's cell walk joins them). Every field's input goes through
 *  here; the ASCII-only gates it replaced dropped IME commits (你好), emoji
 *  pickers and compose keys, and the filter's `length === 1` gate kept only the
 *  ZWJs of a typed family. A typed character goes through fieldText too, so
 *  typed and pasted text are cleaned alike (a typed bidi override is dropped,
 *  as a pasted one is: '' — the arm then changes nothing). Backspace / Ctrl+U /
 *  Tab are the caller's — it checks those first with `pressed` (none of them is
 *  printable, so they never reach here as text). */
function fieldInput(msg) {
  if (!msg) return null;
  if (msg.key === 'paste') return typeof msg.seq === 'string' ? fieldText(msg.seq) : null;
  return isPrintableSeq(msg.seq) ? fieldText(msg.seq) : null;
}

/** The key whose byte is `byte` (Backspace \x7f, Ctrl+U \x15, Tab, Space, a
 *  nav letter…) — never a paste whose text happens to equal it. A bracketed
 *  paste arrives as `key: 'paste'` with its text in `seq`, so `seq === '\t'`
 *  alone took a pasted tab for Tab (the form moved focus), a pasted space
 *  closed the choices popover, a pasted `k` moved the filter's cursor, a
 *  pasted Ctrl+U cleared a field. */
function pressed(msg, byte) {
  return !!msg && msg.key !== 'paste' && msg.seq === byte;
}

module.exports = { isPrintableSeq, fieldText, fieldInput, pressed };
