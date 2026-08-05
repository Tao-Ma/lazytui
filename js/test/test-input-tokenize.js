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
  it('control chars pass through as plain tokens (\\r \\x03)', () => {
    eq(toks('\r\n\x03').join('|'), '\r|\n|\x03');
  });
});

report();
