/**
 * Kitty keyboard protocol CSI-u decoder (pure leaf).
 * Spec: https://sw.kovidgoyal.net/kitty/keyboard-protocol/ — implemented FROM
 * the spec (a protocol is a method of operation, not copyrightable); we never
 * copy kitty's GPL source. v0.6.14 arc (docs/kitty-keyboard.md).
 *
 * We push only the "disambiguate escape codes" flag (bit 1), so the only new
 * on-the-wire form we must handle is `CSI <code> ; <mods> u` (the "u"-terminated
 * events): the Escape key and ctrl/alt/… + key combos that legacy mode encoded
 * as bare control bytes. Modified FUNCTIONAL keys (arrows/Home/End/PageUp…)
 * keep their legacy `CSI 1 ; mods <letter>` and `CSI n ; mods ~` forms, which
 * the existing dispatch ladder already handles (shift+Page/Home/End) or drops
 * (modified arrows) — this decoder deliberately does not touch them.
 *
 * D4 (normalize): rather than invent new key names, translate a CSI-u event
 * back to the LEGACY byte the same keypress would have produced without the
 * protocol, and let the caller re-run the normal ladder on it. So Escape →
 * \x1b, Ctrl+C → \x03 (the existing quit arm), Ctrl+R → \x12 (redo), etc.
 *
 * kkpToLegacy(tok):
 *   - returns the legacy byte string to re-dispatch, or
 *   - null when `tok` is not a CSI-u key event, or has no legacy equivalent
 *     lazytui binds (Alt-chords, super/hyper/meta combos, keypad/PUA functional
 *     keys) — the caller drops it exactly as legacy mode dropped the matching
 *     escape sequence.
 *
 * Values are DERIVED, never a hand-typed table: the key number is the Unicode
 * codepoint (spec: always the unshifted form) and the modifier is `value - 1`
 * (spec: value = 1 + bitmask). This is why the oracle differential test exists
 * — hand-computed CSI-u numbers are error-prone (the spec review caught two).
 *
 * Pure: string in, string|null out. No I/O, no module state.
 */
'use strict';

const MOD_SHIFT = 1;
const MOD_ALT   = 2;
const MOD_CTRL  = 4;
// super | hyper | meta — combos lazytui does not bind.
const MOD_OTHER = 8 | 16 | 32;

function kkpToLegacy(tok) {
  // Shape: `\x1b[` <params> `u`. Reject private-prefix CSIs (`?`/`>`/`<`/`=`);
  // those are handshake replies / other reports, not key events.
  if (tok.length < 4 || tok.charCodeAt(0) !== 0x1b || tok[1] !== '['
      || tok[tok.length - 1] !== 'u') return null;
  const body = tok.slice(2, -1);
  if (body === '' || !/^[\d;:]*$/.test(body)) return null;

  const fields = body.split(';');
  const code = parseInt(fields[0].split(':')[0], 10);        // unicode-key-code
  const mods = fields[1] ? parseInt(fields[1].split(':')[0], 10) - 1 : 0;
  if (!Number.isFinite(code) || !Number.isFinite(mods) || mods < 0) return null;

  // Keypad / function keys live in the Unicode Private Use Area (57344–63743).
  // lazytui binds none of them → drop like a legacy unknown escape.
  if (code >= 57344 && code <= 63743) return null;

  // Alt / super / hyper / meta: legacy dropped these (alt-chords were logged +
  // dropped; the rest were never bound). Preserve that.
  if (mods & (MOD_ALT | MOD_OTHER)) return null;

  // Ctrl+key → the C0 control byte legacy produced (code & 0x1f). Covers
  // Ctrl+C (→ \x03, quit) and Ctrl+R (→ \x12, redo) with no per-key table.
  // Only the ASCII range has a clean C0 mapping lazytui relies on.
  if (mods & MOD_CTRL) {
    if (code >= 64 && code <= 127) return String.fromCharCode(code & 0x1f);
    return null;
  }

  // No modifier (or Shift alone): the base key. Named controls map to their
  // C0/DEL byte; anything else is its unshifted codepoint.
  switch (code) {
    case 27:  return '\x1b';   // Escape
    case 13:  return '\r';     // Enter
    case 9:   return '\t';     // Tab
    case 8:   return '\x08';   // Backspace (BS)
    case 127: return '\x7f';   // Backspace (DEL)
    default:
      if (code < 32) return null;                  // other bare C0: unbound
      try { return String.fromCodePoint(code); } catch { return null; }
  }
}

module.exports = { kkpToLegacy };
