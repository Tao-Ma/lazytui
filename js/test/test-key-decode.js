/**
 * leaves/input/key-decode — special keys on the wire (pure).
 *
 * decodeKey maps the forms terminals send (xterm normal/application cursor,
 * VT220 — what tmux and screen send — rxvt, the linux console, modified keys)
 * to one named key; encodeXtermKey writes a named key as xterm does. The
 * terminal pane needs the round trip: a program told TERM=xterm-256color must
 * get xterm's bytes (nvim ignores tmux's `CSI 1 ~` Home under xterm).
 *
 * Run: node js/test/test-key-decode.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const { decodeKey, encodeXtermKey, toXtermKey } = require('../leaves/input/key-decode');

const K = (key, mods = {}) => ({ key, shift: !!mods.shift, alt: !!mods.alt, ctrl: !!mods.ctrl });

describe('[1] decodeKey — every common form of each key', () => {
  it('arrows: CSI (normal cursor) and SS3 (application cursor)', () => {
    eq(decodeKey('\x1b[A'), K('up')); eq(decodeKey('\x1bOB'), K('down'));
    eq(decodeKey('\x1b[C'), K('right')); eq(decodeKey('\x1bOD'), K('left'));
  });
  it('Home / End: xterm CSI + SS3, VT220 (tmux/screen) 1~/4~, rxvt 7~/8~', () => {
    for (const t of ['\x1b[H', '\x1bOH', '\x1b[1~', '\x1b[7~']) eq(decodeKey(t), K('home'), JSON.stringify(t));
    for (const t of ['\x1b[F', '\x1bOF', '\x1b[4~', '\x1b[8~']) eq(decodeKey(t), K('end'), JSON.stringify(t));
  });
  it('editing + page keys', () => {
    eq(decodeKey('\x1b[2~'), K('insert')); eq(decodeKey('\x1b[3~'), K('delete'));
    eq(decodeKey('\x1b[5~'), K('pageup')); eq(decodeKey('\x1b[6~'), K('pagedown'));
  });
  it('function keys: SS3 P–S, VT220 11~–14~, linux console [A–[E, 15~…24~', () => {
    eq(decodeKey('\x1bOP'), K('f1')); eq(decodeKey('\x1b[11~'), K('f1')); eq(decodeKey('\x1b[[A'), K('f1'));
    eq(decodeKey('\x1bOS'), K('f4')); eq(decodeKey('\x1b[[E'), K('f5')); eq(decodeKey('\x1b[15~'), K('f5'));
    eq(decodeKey('\x1b[21~'), K('f10')); eq(decodeKey('\x1b[24~'), K('f12'));
  });
  it('modifiers ride as 1 + (shift 1 | alt 2 | ctrl 4)', () => {
    eq(decodeKey('\x1b[1;2A'), K('up', { shift: true }));
    eq(decodeKey('\x1b[1;5H'), K('home', { ctrl: true }));
    eq(decodeKey('\x1b[3;3~'), K('delete', { alt: true }));
    eq(decodeKey('\x1b[1;8P'), K('f1', { shift: true, alt: true, ctrl: true }));
    eq(decodeKey('\x1b[24;5~'), K('f12', { ctrl: true }));
  });
  it('Shift-Tab', () => eq(decodeKey('\x1b[Z'), K('backtab')));
  it('not a special key → null (passed through by the caller)', () => {
    for (const t of ['a', '\x1b', '\x1bx', '\x1b[I', '\x1b[O', '\x1b[200~', '\x1b[<0;1;1M',
                     '\x1b[1;9A', '\x1b[16~', '\x1b[27u', '\x1b[?1u', '\x1bOX'])
      eq(decodeKey(t), null, JSON.stringify(t));
  });
});

describe('[2] encodeXtermKey — what xterm sends', () => {
  it('normal cursor mode: CSI arrows / Home / End', () => {
    eq(encodeXtermKey(K('up')), '\x1b[A'); eq(encodeXtermKey(K('home')), '\x1b[H'); eq(encodeXtermKey(K('end')), '\x1b[F');
  });
  it('application cursor mode: SS3 arrows / Home / End', () => {
    const app = { appCursor: true };
    eq(encodeXtermKey(K('up'), app), '\x1bOA'); eq(encodeXtermKey(K('home'), app), '\x1bOH'); eq(encodeXtermKey(K('end'), app), '\x1bOF');
  });
  it('a modified key is CSI 1;m in either mode', () => {
    eq(encodeXtermKey(K('up', { ctrl: true }), { appCursor: true }), '\x1b[1;5A');
    eq(encodeXtermKey(K('end', { shift: true })), '\x1b[1;2F');
    eq(encodeXtermKey(K('f2', { alt: true })), '\x1b[1;3Q');
  });
  it('F1–F4 SS3, F5–F12 and the editing keys CSI n ~', () => {
    eq(encodeXtermKey(K('f1')), '\x1bOP'); eq(encodeXtermKey(K('f5')), '\x1b[15~'); eq(encodeXtermKey(K('f12')), '\x1b[24~');
    eq(encodeXtermKey(K('delete')), '\x1b[3~'); eq(encodeXtermKey(K('pagedown', { shift: true })), '\x1b[6;2~');
  });
});

describe('[3] toXtermKey — host form → xterm form for the program\'s mode', () => {
  it('tmux Home / End become xterm\'s', () => {
    eq(toXtermKey('\x1b[1~'), '\x1b[H'); eq(toXtermKey('\x1b[4~'), '\x1b[F');
    eq(toXtermKey('\x1b[1~', { appCursor: true }), '\x1bOH');
  });
  it('an xterm key in the right form is unchanged; anything else is unchanged', () => {
    for (const t of ['\x1b[A', '\x1b[3~', '\x1bOP', '\x1b[1;5C', 'x', '\x1bx', '\x1b[I'])
      eq(toXtermKey(t), t, JSON.stringify(t));
  });
});

report();
