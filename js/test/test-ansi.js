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
const themes = require('../leaves/infra/themes');

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

// Truecolor arc 1a (docs/truecolor.md) — the tag PARSER. Named atoms must
// stay byte-identical to the retired CODES table (P6); hex atoms always
// emit 38;2/48;2 (P3 — canonical truecolor, depth adapts at the write
// boundary, never here); any unknown atom collapses the whole tag to RESET.
describe('[N] tag parser — named atoms byte-identical to the CODES table', () => {
  const PINS = {
    bold: '\x1b[1m', dim: '\x1b[2m', reverse: '\x1b[7m',
    green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', blue: '\x1b[34m',
    magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m',
    'bold cyan': '\x1b[1;36m', 'bold yellow': '\x1b[1;33m', 'bold red': '\x1b[1;31m',
    'bold green': '\x1b[1;32m', 'bold magenta': '\x1b[1;35m', 'bold blue': '\x1b[1;34m',
    'bold white': '\x1b[1;37m', 'on dark_blue': '\x1b[44m',
  };
  for (const [tag, sgr] of Object.entries(PINS)) {
    it(`[${tag}] emits the exact pre-parser bytes`, () => {
      eq(richToAnsi(`[${tag}]x[/]`), `${sgr}x\x1b[0m`);
    });
  }
  it('[dim reverse] now compiles (was a CODES miss → RESET; footer slot in every theme)', () => {
    eq(richToAnsi('[dim reverse]x[/]'), '\x1b[2;7mx\x1b[0m');
  });
});

describe('[N+1] tag parser — hex atoms (canonical truecolor)', () => {
  it('hex fg', () => {
    eq(richToAnsi('[#ff8800]x[/]'), '\x1b[38;2;255;136;0mx\x1b[0m');
  });
  it('hex bg', () => {
    eq(richToAnsi('[on #282a36]x[/]'), '\x1b[48;2;40;42;54mx\x1b[0m');
  });
  it('attr + hex fg compound, atom order preserved', () => {
    eq(richToAnsi('[bold #f8f8f2]x[/]'), '\x1b[1;38;2;248;248;242mx\x1b[0m');
  });
  it('hex fg + hex bg pair', () => {
    eq(richToAnsi('[#f8f8f2 on #44475a]x[/]'), '\x1b[38;2;248;248;242;48;2;68;71;90mx\x1b[0m');
  });
  it('uppercase hex accepted', () => {
    eq(richToAnsi('[#FF8800]x[/]'), '\x1b[38;2;255;136;0mx\x1b[0m');
  });
  it('short/invalid hex is an unknown atom → whole tag RESET', () => {
    eq(richToAnsi('[#f80]x'), '\x1b[0mx');
    eq(richToAnsi('[#ff88zz]x'), '\x1b[0mx');
  });
  it('unknown atom poisons a compound → RESET', () => {
    eq(richToAnsi('[bold sparkle]x'), '\x1b[0mx');
    eq(richToAnsi('[on nothing]x'), '\x1b[0mx');
  });
  it('empty and orphan-on tags → RESET (pre-parser behavior)', () => {
    eq(richToAnsi('[]x'), '\x1b[0mx');
    eq(richToAnsi('[on]x'), '\x1b[0mx');
  });
  it('ESC excluded from tag interiors — raw SGR is not eaten by a later ]', () => {
    // Unescaped raw SGR followed by a literal ] elsewhere: the old [^\]]*
    // interior would swallow '\x1b[33mAB' into one bogus "tag".
    eq(richToAnsi('\x1b[33mAB]'), '\x1b[33mAB]');
  });
});

// Semantic theme tokens (truecolor arc 3b): an atom naming a palette slot expands
// to that slot's CURRENT value at paint, so STORED markup like `[warning]…` tracks
// a :theme change — the systemic fix for baked-color transcript content.
describe('[semantic theme tokens] a slot atom resolves to the LIVE palette + tracks :theme', () => {
  const hexSgr = (hex) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
  it('[warning] resolves to theme().warning, and re-resolves when the theme flips', () => {
    themes.setTheme('dracula');
    eq(richToAnsi('[warning]x[/]'), `${hexSgr(themes.theme().warning)}x\x1b[0m`);   // #f1fa8c
    themes.setTheme('monokai');
    eq(richToAnsi('[warning]x[/]'), `${hexSgr(themes.theme().warning)}x\x1b[0m`);   // #e6db74 — cache invalidated
    themes.setTheme('dracula');
    eq(richToAnsi('[warning]x[/]'), `${hexSgr(themes.theme().warning)}x\x1b[0m`);   // back
  });
  it('[error] / [success] / [accent] resolve too; a compound [bold warning] works', () => {
    themes.setTheme('dracula');
    eq(richToAnsi('[error]x[/]'), `${hexSgr(themes.theme().error)}x\x1b[0m`);
    eq(richToAnsi('[bold warning]x[/]'), `\x1b[1;38;2;241;250;140mx\x1b[0m`);
  });
  it('the fix does NOT touch attributes or named-16 colors (dim stays faint, red stays 31)', () => {
    eq(richToAnsi('[dim]x[/]'), '\x1b[2mx\x1b[0m');      // dim = ATTRIBUTE, never the `dim` slot
    eq(richToAnsi('[red]x[/]'), '\x1b[31mx\x1b[0m');     // named-16 wins over any same-named slot
  });
  it('a stored footer markup ([warning]Cancelled.) re-colors on :theme (the reported bug)', () => {
    const line = '[warning]Cancelled.[/]';   // exactly what stream.js now stores
    themes.setTheme('dracula'); const a = richToAnsi(line);
    themes.setTheme('monokai'); const b = richToAnsi(line);
    assert(a !== b && a.includes('Cancelled.') && b.includes('Cancelled.'),
      `stored footer re-colors on theme change: ${JSON.stringify([a, b])}`);
    themes.setTheme('dracula');
  });
});

report();
