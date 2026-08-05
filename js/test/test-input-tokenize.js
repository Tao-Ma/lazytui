/**
 * Stdin chunk tokenizer (network-lag fix, 2026-08-05) — unit battery.
 *
 * The leaf splits a raw stdin chunk into complete input events so the
 * input ladder dispatches per EVENT instead of exact-matching the whole
 * chunk (which dropped batched arrow repeats and misparsed sequences
 * split across chunks). Pins the grammar: CSI / SS3 / Alt chords /
 * bare-Esc / plain code points, the tokens-are-exact-slices invariant,
 * and the carry rules (incomplete CSI/SS3 carries; bare Esc NEVER does).
 *
 * Run: node js/test/test-input-tokenize.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { tokenizeInput } = require('../leaves/input/tokenize');

const toks = (s) => tokenizeInput(s).tokens;
const carry = (s) => tokenizeInput(s).carry;

describe('plain chars', () => {
  it('single char → one token', () => {
    eq(JSON.stringify(tokenizeInput('j')), '{"tokens":["j"],"carry":""}');
  });
  it('autorepeat burst splits per char', () => {
    eq(toks('jjjjj').join('|'), 'j|j|j|j|j');
  });
  it('code points stay whole (CJK + surrogate pair)', () => {
    const t = toks('あ😀j');
    eq(t.length, 3);
    eq(t[0], 'あ');
    eq(t[1], '😀');
  });
});

describe('escape sequences', () => {
  it('batched arrow repeats → one CSI token each (the pre-fix whole-chunk drop)', () => {
    eq(toks('\x1b[B\x1b[B\x1b[B').join('|'), '\x1b[B|\x1b[B|\x1b[B');
  });
  it('keys interleaved with SGR mouse events', () => {
    eq(toks('jj\x1b[B\x1b[<0;5;6Mk').join('|'), 'j|j|\x1b[B|\x1b[<0;5;6M|k');
  });
  it('CSI with params + intermediates', () => {
    eq(toks('\x1b[1;3A').join('|'), '\x1b[1;3A');
    eq(toks('\x1b[5;2~x').join('|'), '\x1b[5;2~|x');
  });
  it('SS3 (F1-style) is a 3-byte token', () => {
    eq(toks('\x1bOPj').join('|'), '\x1bOP|j');
  });
});

describe('escape-key vs chords', () => {
  it('bare Esc at end tokenizes immediately (never carried — modal-close latency)', () => {
    eq(JSON.stringify(tokenizeInput('\x1b')), '{"tokens":["\\u001b"],"carry":""}');
  });
  it('the historical double-Esc form stays ONE token', () => {
    eq(toks('\x1b\x1b').join('|'), '\x1b\x1b');
  });
  it('Alt chord ESC+char is one token (drops whole, never Esc + stray char)', () => {
    eq(toks('\x1bj').join('|'), '\x1bj');
    eq(toks('\x1bjk').join('|'), '\x1bj|k');
  });
  it('Alt-arrow ESC+CSI is one token', () => {
    eq(toks('\x1b\x1b[A').join('|'), '\x1b\x1b[A');
  });
});

describe('carry — sequences split across chunks', () => {
  it('trailing partial CSI carries', () => {
    eq(carry('\x1b['), '\x1b[');
    eq(carry('j\x1b[1;3'), '\x1b[1;3');
    eq(toks('j\x1b[1;3').join('|'), 'j');
  });
  it('trailing lone \\x1bO (SS3 prefix) carries', () => {
    eq(carry('\x1bO'), '\x1bO');
  });
  it('carry + continuation rejoins into the full sequence', () => {
    const first = tokenizeInput('\x1b[');
    const second = tokenizeInput(first.carry + 'B');
    eq(second.tokens.join('|'), '\x1b[B');
    eq(second.carry, '');
  });
  it('split paste-open marker rejoins (the old accumulator residual gap)', () => {
    const first = tokenizeInput('\x1b[20');
    eq(first.carry, '\x1b[20');
    const second = tokenizeInput(first.carry + '0~content');
    eq(second.tokens[0], '\x1b[200~');
  });
  it('overlong unterminated CSI is emitted, not carried (cap)', () => {
    const s = '\x1b[' + '1;'.repeat(40);           // > 64 bytes, no final
    const r = tokenizeInput(s);
    eq(r.carry, '');
    eq(r.tokens.length, 1);
    eq(r.tokens[0], s);
  });
});

describe('terminator rule — ESC/C0 cancels a pending sequence (review 2026-08-05)', () => {
  it('ESC after SS3 prefix: orphan drops alone, the arrow survives (was: stray [ B typed)', () => {
    eq(toks('\x1bO\x1b[B').join('|'), '\x1bO|\x1b[B');
  });
  it('C0 after SS3 prefix is not absorbed', () => {
    eq(toks('\x1bO\x03').join('|'), '\x1bO|\x03');
  });
  it('ESC after CSI introducer: head drops alone, the arrow survives (was: rest-of-chunk swallowed)', () => {
    eq(toks('\x1b[\x1b[B').join('|'), '\x1b[|\x1b[B');
  });
  it('C0 inside a pending CSI: Ctrl-C and the keys after it survive', () => {
    eq(toks('\x1b[1\x03jjj').join('|'), '\x1b[1|\x03|j|j|j');
  });
});

describe('legacy encodings — payload must not type as keys (review 2026-08-05)', () => {
  it('X10 mouse report is ONE token: \\x1b[M + 3 coordinate bytes (a click at column 81 is q)', () => {
    eq(toks('\x1b[M !!').join('|'), '\x1b[M !!');
    eq(toks('\x1b[M !!j').join('|'), '\x1b[M !!|j');
  });
  it('split X10 report carries and rejoins', () => {
    const first = tokenizeInput('\x1b[M !');
    eq(first.carry, '\x1b[M !');
    eq(tokenizeInput(first.carry + '!').tokens.join('|'), '\x1b[M !!');
  });
  it('an ESC/C0 where a coordinate should be terminates the report (never absorbed)', () => {
    eq(toks('\x1b[M\x1b[B').join('|'), '\x1b[M|\x1b[B');
  });
  it('Linux-console F-key \\x1b[[A is ONE token (was: dropped CSI + stray typed A)', () => {
    eq(toks('\x1b[[A').join('|'), '\x1b[[A');
    eq(toks('\x1b[[Aj').join('|'), '\x1b[[A|j');
    eq(carry('\x1b[['), '\x1b[[');
    eq(toks('\x1b[[\x1b[B').join('|'), '\x1b[[|\x1b[B');
  });
});

describe('pathological floods (review 2026-08-05)', () => {
  it('an ESC flood tokenizes iteratively as one dropped run (was: stack-overflow crash)', () => {
    const r = tokenizeInput('\x1b'.repeat(5000));
    eq(r.tokens.length, 1);
    eq(r.tokens[0].length, 5000);
    eq(r.carry, '');
  });
  it('a flood ending in a partial CSI respects the carry cap (emitted, not carried)', () => {
    const s = '\x1b'.repeat(100) + '[';
    const r = tokenizeInput(s);
    eq(r.carry, '');
    eq(r.tokens.join(''), s);
  });
  it('a SHORT Alt-prefix stack on a partial still carries (\\x1b\\x1b[ + A → alt-arrow)', () => {
    eq(carry('\x1b\x1b['), '\x1b\x1b[');
    eq(tokenizeInput('\x1b\x1b[' + 'A').tokens.join('|'), '\x1b\x1b[A');
  });
});

describe('invariants', () => {
  it('tokens are exact contiguous slices: join(tokens) + carry === input', () => {
    const inputs = [
      'jjjjj', '\x1b[B\x1b[B', 'j\x1b[<0;5;6Mk\x1b[1;3', '\x1b\x1b[A',
      '\x1bOP\x1bO', '\x1b[200~abc', 'あ😀\x1b[A\x1b', '\r\n\x03\x12',
    ];
    for (const s of inputs) {
      const { tokens, carry: c } = tokenizeInput(s);
      eq(tokens.join('') + c, s, `slice invariant for ${JSON.stringify(s)}`);
    }
  });
  it('empty input → no tokens, no carry', () => {
    eq(JSON.stringify(tokenizeInput('')), '{"tokens":[],"carry":""}');
  });
  it('seeded fuzz: 2000 adversarial chunks — invariant holds, nothing throws', () => {
    // Deterministic LCG; the alphabet is escape-heavy on purpose — the
    // review findings all lived in ESC-interrupted / legacy shapes.
    let seed = 0x2f6e2b1;
    const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
    const abc = ['\x1b', '[', 'O', 'M', '~', ';', '1', '<', '2', '0', 'j', 'A',
                 'あ', '😀', '\x03', '\r', '\x7f', ' ', 'q'];
    let bad = null;
    for (let n = 0; n < 2000 && !bad; n++) {
      let s = '';
      const len = 1 + Math.floor(rnd() * 24);
      for (let k = 0; k < len; k++) s += abc[Math.floor(rnd() * abc.length)];
      const { tokens, carry: c } = tokenizeInput(s);
      if (tokens.join('') + c !== s) bad = s;
    }
    eq(bad, null, `slice invariant violated for ${JSON.stringify(bad)}`);
  });
  it('control chars pass through as plain tokens (\\r \\x03)', () => {
    eq(toks('\r\x03').join('|'), '\r|\x03');
    eq(toks('\n').join('|'), '\n');
  });
  it('CRLF is ONE token — one line ending, one return (review 2026-08-05)', () => {
    eq(toks('\r\n').join('|'), '\r\n');
    eq(toks('\r\n\r\n').join('|'), '\r\n|\r\n');
    eq(toks('j\r\nk').join('|'), 'j|\r\n|k');
    eq(toks('\n\r').join('|'), '\n|\r', 'LF-then-CR is NOT a CRLF');
  });
});

report();
