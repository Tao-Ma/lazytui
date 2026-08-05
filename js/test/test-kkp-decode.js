/**
 * Kitty keyboard protocol CSI-u decoder (leaves/input/kkp-decode).
 *
 * The decoder normalizes a `CSI <code> ; <mods> u` key event back to the LEGACY
 * byte the same keypress produced without the protocol (D4), so the existing
 * dispatch ladder handles it unchanged: Esc→\x1b, Ctrl+C→\x03 (quit),
 * Ctrl+R→\x12 (redo), etc. Events with no legacy equivalent lazytui binds
 * (Alt-chords, super/hyper/meta, keypad/PUA) return null → dropped like a
 * legacy unknown escape.
 *
 * Block [3] is the D6 oracle differential: an INDEPENDENT implementation
 * (the MIT `kitty-keyboard` package) parses the same byte sequences and we
 * assert it recovers the same (codepoint, modifier) — catching any misread of
 * the wire format. It's dev-only (not a runtime dep, not in package.json):
 * install with `npm i --no-save kitty-keyboard` (needs a recent Node). The
 * block SKIPS cleanly when the package is absent, so the durable spec vectors
 * in [1]/[2]/[4] are the always-on gate. Values are computed from codepoints,
 * never hand-typed — the spec review produced two wrong CSI-u numbers by hand.
 *
 * Run: node js/test/test-kkp-decode.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { kkpToLegacy } = require('../leaves/input/kkp-decode');

// Construct a CSI-u token from a codepoint + modifier value (spec: value =
// 1 + bitmask; omitted when 1). Mirrors what a kitty terminal sends.
const csu = (code, modVal) => `\x1b[${code}${modVal && modVal !== 1 ? ';' + modVal : ''}u`;
const CTRL = 4, ALT = 2, SHIFT = 1;
const mv = (...bits) => 1 + bits.reduce((a, b) => a | b, 0);   // modifier value

describe('[1] named keys + the quit/redo path (the contract)', () => {
  it('Escape → \\x1b', () => eq(kkpToLegacy(csu(27)), '\x1b'));
  it('Enter → \\r',    () => eq(kkpToLegacy(csu(13)), '\r'));
  it('Tab → \\t',      () => eq(kkpToLegacy(csu(9)),  '\t'));
  it('Backspace DEL 127 → \\x7f', () => eq(kkpToLegacy(csu(127)), '\x7f'));
  it('Backspace BS 8 → \\x08',    () => eq(kkpToLegacy(csu(8)),   '\x08'));
  it('Ctrl+C → \\x03 (the exact byte the quit arm matches)', () => {
    eq(kkpToLegacy(csu('c'.codePointAt(0), mv(CTRL))), '\x03');
  });
  it('Ctrl+R → \\x12 (the exact byte the redo arm matches)', () => {
    eq(kkpToLegacy(csu('r'.codePointAt(0), mv(CTRL))), '\x12');
  });
  it('every Ctrl+<letter> → its C0 control byte', () => {
    for (let c = 0x61; c <= 0x7a; c++) {           // a..z
      eq(kkpToLegacy(csu(c, mv(CTRL))), String.fromCharCode(c & 0x1f), `ctrl+${String.fromCharCode(c)}`);
    }
  });
});

describe('[2] modifier + codepoint handling', () => {
  it('no modifier → the base codepoint (plain letter)', () => {
    eq(kkpToLegacy(csu('a'.codePointAt(0))), 'a');
    eq(kkpToLegacy(csu('Z'.codePointAt(0))), 'Z');
  });
  it('Shift alone → base key (lazytui has no shift variant here)', () => {
    eq(kkpToLegacy(csu('a'.codePointAt(0), mv(SHIFT))), 'a');
  });
  it('Alt-chord → dropped (null), matching legacy \\x1b+key drop', () => {
    eq(kkpToLegacy(csu('j'.codePointAt(0), mv(ALT))), null);          // mod 3
    eq(kkpToLegacy(csu('c'.codePointAt(0), mv(CTRL, ALT))), null);    // ctrl+alt → drop
  });
  it('super/hyper/meta combos → dropped (null)', () => {
    eq(kkpToLegacy(csu('a'.codePointAt(0), mv(8))),  null);   // super
    eq(kkpToLegacy(csu('a'.codePointAt(0), mv(16))), null);   // hyper
    eq(kkpToLegacy(csu('a'.codePointAt(0), mv(32))), null);   // meta
  });
  it('ctrl+shift keeps the ctrl C0 byte (shift ignored)', () => {
    eq(kkpToLegacy(csu('c'.codePointAt(0), mv(CTRL, SHIFT))), '\x03');
  });
  it('keypad / PUA functional codes (57344–63743) → dropped', () => {
    eq(kkpToLegacy(csu(57399)), null);   // KP_0
    eq(kkpToLegacy(csu(57426)), null);   // KP_DELETE-ish
    eq(kkpToLegacy(csu(63743)), null);   // PUA end
  });
});

describe('[4] non-key inputs are not decoded (return null)', () => {
  it('handshake replies (private-prefix CSI) → null', () => {
    eq(kkpToLegacy('\x1b[?1u'), null);     // KKP flags report
    eq(kkpToLegacy('\x1b[?62;1;6c'), null);// DA1 — not even u-terminated
  });
  it('legacy functional forms (not u-terminated) → null', () => {
    eq(kkpToLegacy('\x1b[A'), null);       // plain arrow
    eq(kkpToLegacy('\x1b[1;5A'), null);    // modified arrow (existing ladder handles/drops)
    eq(kkpToLegacy('\x1b[5;2~'), null);    // shift+PageUp (existing ladder handles)
  });
  it('malformed / empty / non-CSI → null', () => {
    eq(kkpToLegacy('\x1b[u'), null);       // no code
    eq(kkpToLegacy('\x1b[abcu'), null);    // non-numeric params
    eq(kkpToLegacy('a'), null);            // plain char, not a sequence
    eq(kkpToLegacy('\x1b'), null);         // bare esc
    eq(kkpToLegacy(''), null);
  });
});

// --- [3] oracle differential (dev-only; skips cleanly when absent) ----------
(async () => {
  let oracle = null;
  try { oracle = await import('kitty-keyboard'); } catch { /* not installed */ }

  describe('[3] oracle differential vs kitty-keyboard (D6, dev-only)', () => {
    if (!oracle) {
      it('SKIPPED — kitty-keyboard not installed (npm i --no-save kitty-keyboard)',
        () => assert(true));
      return;
    }
    const { parseKeyEvents, buildKittyKeyboardEnableSequence,
            buildKittyKeyboardQuery, buildKittyKeyboardDisableSequence } = oracle;

    it('our term.js sequences match the reference builders', () => {
      eq(buildKittyKeyboardEnableSequence(1), '\x1b[>1u', 'enable(disambiguate)');
      eq(buildKittyKeyboardQuery(), '\x1b[?u', 'query');
      eq(buildKittyKeyboardDisableSequence(), '\x1b[<u', 'disable/pop');
    });

    it('reference recovers the same (codepoint, mods) from every sequence we build', () => {
      const codes = [27, 13, 9, 127, ...[]];
      for (let c = 0x21; c <= 0x7e; c++) codes.push(c);   // printable ASCII
      const modVals = [1, mv(SHIFT), mv(ALT), mv(CTRL), mv(CTRL, SHIFT), mv(CTRL, ALT)];
      let pairs = 0;
      for (const code of codes) {
        for (const modVal of modVals) {
          const tok = csu(code, modVal);
          const parsed = parseKeyEvents(tok);
          const ev = parsed && parsed.events && parsed.events[0];
          assert(ev, `oracle parsed ${JSON.stringify(tok)}`);
          eq(ev.codepoint, code, `codepoint for ${JSON.stringify(tok)}`);
          eq(ev.mods, modVal, `mods for ${JSON.stringify(tok)}`);
          pairs++;
        }
      }
      assert(pairs > 500, `exercised ${pairs} (code,mods) pairs`);
    });
  });

  report();
})();
