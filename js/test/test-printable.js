/**
 * `isPrintableSeq` — the shared text-input gate used by fabric-field +
 * fabric-form key arms. Pins the predicate directly so a future tightening
 * (e.g. "reject C1 range too") lands behind a visible test, not a silent
 * character-set regression. R3C-BUG1 (slice-2 R3 review).
 *
 * Run: node js/test/test-printable.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { isPrintableSeq } = require('../leaves/text/printable');

describe('[printable] ASCII printables accepted', () => {
  it('space, letter, digit, punct', () => {
    for (const c of [' ', 'a', 'A', '9', '~', ';', '[', ']', '{', '}']) {
      assert(isPrintableSeq(c), `expected printable: ${JSON.stringify(c)}`);
    }
  });
});

describe('[printable] C0 + DEL rejected', () => {
  it('rejects every C0 control char', () => {
    for (let i = 0; i < 32; i++) {
      assert(!isPrintableSeq(String.fromCharCode(i)),
        `C0 U+${i.toString(16).padStart(4, '0')} must be rejected`);
    }
  });
  it('rejects DEL (0x7f)', () => {
    assert(!isPrintableSeq('\x7f'));
  });
  it('rejects null / undefined / empty / non-string', () => {
    assert(!isPrintableSeq(null));
    assert(!isPrintableSeq(undefined));
    assert(!isPrintableSeq(''));
    assert(!isPrintableSeq(42));
  });
});

describe('[printable] non-ASCII accepted (R3C-BUG1 regression)', () => {
  it('Latin-1 supplement', () => {
    for (const c of ['é', 'ñ', 'ø', 'ß']) assert(isPrintableSeq(c));
  });
  it('CJK (the actual reported IME regression)', () => {
    for (const c of ['あ', '日', '語', '한', '글']) assert(isPrintableSeq(c), `CJK rejected: ${c}`);
  });
  it('Cyrillic, Greek, Arabic, Hebrew', () => {
    for (const c of ['д', 'λ', 'ا', 'ש']) assert(isPrintableSeq(c));
  });
  it('emoji surrogate pair (seq.length === 2)', () => {
    assert(isPrintableSeq('🎉'), '4-byte emoji must be accepted');
    eq('🎉'.length, 2, 'sanity: surrogate pair is 2 code units');
  });
  it('combining marks', () => {
    assert(isPrintableSeq('é'));
  });
  it('a mixed-plane string from a paste-like event', () => {
    assert(isPrintableSeq('hello 日本 🎉'));
  });
});

describe('[printable] a seq containing EVEN ONE control char is rejected', () => {
  it('string with embedded \\n rejected', () => {
    assert(!isPrintableSeq('line1\nline2'),
      'any C0 char anywhere in the seq → reject (prevents newline injection via key arm)');
  });
  it('string with embedded DEL rejected', () => {
    assert(!isPrintableSeq('ok\x7fbad'));
  });
  it('string with embedded ESC rejected', () => {
    assert(!isPrintableSeq('text\x1b[31m'));
  });
});

report();
