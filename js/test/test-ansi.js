/**
 * ansi.js — Rich-markup conversion + control-sequence sanitization.
 *
 * Most of this file is the T22 (round-5 SEVERE) regression: the
 * pre-fix esc() only escaped `[`, so streamed action output
 * containing \x1b[2J / \x1b[H / OSC52 / etc. could clear the host
 * screen, write to the OS clipboard, or flip to the alt buffer.
 * Verified terminal-takeover by repro on the audit.
 *
 * Run: node js/test/test-ansi.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { esc, richToAnsi, stripControls } = require('../leaves/text/ansi');

describe('[1] stripControls — preserves SGR, strips dangerous escapes', () => {
  it('strips CSI cursor-move / screen-clear (non-SGR)', () => {
    eq(stripControls('\x1b[2J\x1b[H\x07HACKED'), 'HACKED');
  });
  it('preserves SGR colors (terminated with m)', () => {
    eq(stripControls('\x1b[31mred\x1b[0m'), '\x1b[31mred\x1b[0m');
    eq(stripControls('\x1b[1;33mbold yellow\x1b[0m'), '\x1b[1;33mbold yellow\x1b[0m');
  });
  it('mixed dangerous + SGR: keeps SGR, strips dangerous', () => {
    eq(stripControls('\x1b[31m\x1b[2Jred\x1b[0m'), '\x1b[31mred\x1b[0m');
  });
  it('strips OSC52 clipboard write', () => {
    eq(stripControls('\x1b]52;c;aGk=\x07tail'), 'tail');
  });
  it('strips bare \\r (would reset cursor + wipe panel borders)', () => {
    eq(stripControls('hi\rworld'), 'hiworld');
  });
  it('strips \\b backspace (corrupts preceding cell)', () => {
    eq(stripControls('abc\bX'), 'abcX');
  });
  it('strips BEL \\x07', () => {
    eq(stripControls('beep\x07!'), 'beep!');
  });
  it('strips NUL', () => {
    eq(stripControls('a\x00b'), 'ab');
  });
  it('strips orphan \\x1b (chunk-split sequences)', () => {
    eq(stripControls('\x1bfoo'), 'foo');
  });
  it('preserves \\t and \\n', () => {
    eq(stripControls('a\tb\nc'), 'a\tb\nc');
  });
  it('strips alt-buffer flip', () => {
    eq(stripControls('\x1b[?1049hbad'), 'bad');
  });
  it('strips cursor-hide', () => {
    eq(stripControls('\x1b[?25lhidden'), 'hidden');
  });
});

describe('[2] esc — wraps stripControls + escapes [ for markup', () => {
  it('plain text round-trips through richToAnsi unchanged', () => {
    eq(richToAnsi(esc('hello world')), 'hello world');
  });
  it('SGR survives esc → richToAnsi roundtrip', () => {
    const sgr = '\x1b[31mred\x1b[0m';
    eq(richToAnsi(esc(sgr)), sgr);
  });
  it('dangerous bytes stripped before markup conversion', () => {
    eq(richToAnsi(esc('\x1b[2JHACK')), 'HACK');
  });
  it('literal [brackets] round-trip', () => {
    eq(richToAnsi(esc('[brackets]')), '[brackets]');
  });
});

describe('[3] T22 verified-repro pinning', () => {
  it('\\x1b[2J\\x1b[H (clear screen + cursor home) — fully stripped', () => {
    const out = esc('\x1b[2J\x1b[H');
    assert(!out.includes('\x1b'), 'no raw ESC bytes survive esc()');
  });
  it('\\x1b]52;c;<b64>\\x07 (OSC52 clipboard) — fully stripped', () => {
    const out = esc('\x1b]52;c;aGk=\x07');
    assert(!out.includes('\x1b'), 'no raw ESC bytes survive esc()');
  });
});

// T31 — tab expansion. visibleLen counts a tab as 1 col but the terminal
// advances to the next 8-col tab stop. Without expansion, padding +
// border calculations overrun the panel width and corrupt the next row
// (postgresql.conf line `#data_directory = 'ConfigDir'\t\t# ...`).
const { visibleLen } = require('../leaves/text/ansi');
describe('[3] esc() — expands \\t to spaces against 8-col tab stops', () => {
  it('two tabs after a col-29 prefix expand to 3+8 spaces', () => {
    const line = "#data_directory = 'ConfigDir'\t\t# use data";
    const out = esc(line);
    assert(!out.includes('\t'), 'no raw tab survives esc()');
    eq(out, "#data_directory = 'ConfigDir'           # use data",
       'tabs expanded to land at col 32 then col 40');
  });
  it('leading tab → 8 spaces', () => {
    eq(esc('\thello'), '        hello');
  });
  it('tab at col 7 → 1 space (lands at col 8)', () => {
    eq(esc('1234567\tX'), '1234567 X');
  });
  it('visibleLen matches actual terminal-rendered width post-esc', () => {
    const out = esc("abc\tdef\t1234567Z");
    // abc(3) → col 3, tab → col 8 (+5 spaces), def(3) → col 11,
    // tab → col 16 (+5 spaces), 1234567Z(8) → col 24
    eq(visibleLen(out), 24);
  });
  it('no-tab input is unchanged (hot-path early-out)', () => {
    eq(esc('plain ascii'), 'plain ascii');
  });
});

report();
