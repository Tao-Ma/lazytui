/**
 * Printable-sequence predicate — shared by the fabric-field + fabric-form
 * key-arms (and anywhere else that gates a user keystroke against "would
 * this land as text content?").
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
 * Not called from a hot path — tested from `fabric_form_key` / `fabric_field_key`
 * on each keystroke only. The regex is cheap; a one-time compile at module
 * load keeps the predicate O(seq.length) per call.
 *
 * R3C-BUG1: pre-fix both arms used `charCodeAt(0) >= 32 && < 127 && length === 1`
 * which silently dropped every non-ASCII keystroke. CJK IME users got no text
 * input into the field; the slice-2 "free-type wins" guarantee held only in
 * ASCII. The fix widens the gate uniformly across both arms.
 */
'use strict';

// C0 + DEL only — reject these, accept everything else at or above U+0020.
const _CONTROL_CHAR = /[\x00-\x1f\x7f]/;

function isPrintableSeq(seq) {
  if (typeof seq !== 'string' || seq.length === 0) return false;
  return !_CONTROL_CHAR.test(seq);
}

module.exports = { isPrintableSeq };
