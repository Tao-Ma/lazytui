/**
 * What a single-line text field accepts — every field's key arm (cmdline,
 * filter, palette, search, rename, agent prompt, fabric field / form / choices
 * filter) asks `fieldInput(msg)` what a keystroke or a paste adds. Built on the
 * printable-sequence predicate below (isPrintableSeq) and `fieldText` (a paste
 * made single-line and control-free).
 *
 * Returns true when every code unit in `seq` is a legitimate text character:
 * everything at U+0020 and above EXCEPT DEL (0x7F). This accepts:
 *   - ASCII printables (space through `~`)
 *   - High-plane BMP (Latin-1 supplement, Cyrillic, Greek, CJK, Hangul, …)
 *   - Supplementary-plane surrogate pairs (emoji, less-common CJK extensions)
 *   - Combining marks that compose with the preceding grapheme
 *
 * Rejects:
 *   - C0 control chars (U+0000..U+001F): backspace, Tab, Enter, Esc, Ctrl+…
 *   - DEL (U+007F): the keyboard shortcut for backward-delete on many terms
 *   - Non-string / empty values (`null`, `undefined`, `''`)
 *
 * The C1 range (U+0080..U+009F) is NOT rejected here — modern terminals send
 * those as byte sequences in a UTF-8 encoding of a BMP character, so by the
 * time they reach a JS string they're already composed. A lone C1 code unit
 * is pathological and we tolerate the small blast radius.
 *
 * Not called from a hot path — tested from the field key arms on each
 * keystroke only. The regex is cheap; a one-time compile at module
 * load keeps the predicate O(seq.length) per call.
 *
 * R3C-BUG1: pre-fix both arms used `charCodeAt(0) >= 32 && < 127 && length === 1`
 * which silently dropped every non-ASCII keystroke. CJK IME users got no text
 * input into the field; the slice-2 "free-type wins" guarantee held only in
 * ASCII. The fix widens the gate uniformly across both arms.
 */
'use strict';

const { stripControls } = require('./ansi');

// C0 + DEL only — reject these, accept everything else at or above U+0020.
const _CONTROL_CHAR = /[\x00-\x1f\x7f]/;

function isPrintableSeq(seq) {
  if (typeof seq !== 'string' || seq.length === 0) return false;
  return !_CONTROL_CHAR.test(seq);
}

/** A paste as a single-line text field holds it: each run of line breaks and
 *  each tab becomes one space; terminal control sequences (SGR included), the
 *  other C0 controls, DEL and bidi overrides are dropped (ansi.stripControls).
 *  The field then holds exactly what it shows, so its row (esc) and its caret
 *  math (cell widths) measure the same text — a pasted tab was 1 column to the
 *  caret math and up to 8 on screen (esc expands it to the next stop), a pasted
 *  SGR coloured the row and put the caret 5 columns past the text. */
function fieldText(s) {
  if (typeof s !== 'string') return '';
  return stripControls(s.replace(/\x1b\[[0-9;]*m/g, '').replace(/[\r\n]+/g, ' ').replace(/\t/g, ' '));
}

/** The text one keystroke Msg adds to a single-line text field, or null when
 *  it adds none: a bracketed paste (`key: 'paste'`) as fieldText makes it; a
 *  typed sequence when it is printable — any script, an emoji, a lone joiner or
 *  skin tone (the tokenizer hands a typed 👍🏽 over as 👍 then 🏽: each appends
 *  and the field's cell walk joins them). Every field's input goes through
 *  here; the ASCII-only gates it replaced dropped IME commits (你好), emoji
 *  pickers and compose keys, and the filter's `length === 1` gate kept only the
 *  ZWJs of a typed family. Backspace / Ctrl+U / Tab are the caller's — it
 *  checks those first (none of them is printable, so they never reach here as
 *  text). */
function fieldInput(msg) {
  if (!msg) return null;
  if (msg.key === 'paste') return typeof msg.seq === 'string' ? fieldText(msg.seq) : null;
  return isPrintableSeq(msg.seq) ? msg.seq : null;
}

module.exports = { isPrintableSeq, fieldText, fieldInput };
