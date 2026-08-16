/**
 * Themed screen colours (Approach B) — ansi.enableScreenColors().
 *
 * The app paints each theme's `screen` slot — a `<fg> on <bg>` PAIR — across
 * every cell by having richToAnsi prepend it and re-assert it after every reset,
 * so a `[/]` never drops a cell back to the terminal's own colours. This pins:
 *   - OFF by default → richToAnsi byte-identical to its pinned contract (so unit
 *     tests + the smoke render harness, which never boot tui.js, are unaffected);
 *   - ON → the fg+bg is prepended AND re-asserted after `[/]`;
 *   - the PAIR is load-bearing: plain / dim / reverse content carries an explicit
 *     FOREGROUND, never the terminal default (the minimal-invisible regression);
 *   - it tracks `:theme` (monokai/dracula/minimal each differ);
 *   - the cell-diff path inherits it — a changed cell (incl. a blank) re-emits
 *     with the pair folded into its style.
 *
 * Run: node js/test/test-screen-bg.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { richToAnsi, enableScreenColors, esc, RESET } = require('../leaves/text/ansi');
const { diffRowToAnsi } = require('../leaves/render/cell-grid');
const { setTheme } = require('../leaves/infra/themes');

const MONOKAI = '\x1b[38;2;248;248;242;48;2;39;40;34m';   // #f8f8f2 on #272822
const DRACULA = '\x1b[38;2;248;248;242;48;2;40;42;54m';   // #f8f8f2 on #282a36
const MINIMAL = '\x1b[37;40m';                            // white on black (named-16)
const SOLLIGHT = '\x1b[38;2;88;110;117;48;2;253;246;227m';// #586e75 on #fdf6e3 (dark ink on light)

describe('[1] OFF by default — richToAnsi is byte-identical to its pinned contract', () => {
  it('plain text carries no screen prefix', () => {
    eq(richToAnsi('hello'), 'hello');
  });
  it('a reset stays a bare \\x1b[0m', () => {
    eq(richToAnsi('[#ff8800]x[/]'), '\x1b[38;2;255;136;0mx\x1b[0m');
  });
});

describe('[2] ON — the fg+bg pair is prepended and re-asserted after every reset', () => {
  setTheme('monokai');
  enableScreenColors(true);

  it('plain text is prefixed with the theme fg+bg', () => {
    eq(richToAnsi('hello'), MONOKAI + 'hello');
  });
  it('a [/] resets to default AND re-asserts the pair (so the next cell keeps it)', () => {
    eq(richToAnsi('[#ff8800]x[/]y'),
       MONOKAI + '\x1b[38;2;255;136;0mx' + RESET + MONOKAI + 'y');
  });
  it('an unknown atom (compiles to reset) also re-asserts the pair', () => {
    eq(richToAnsi('[bogus]z'), MONOKAI + RESET + MONOKAI + 'z');
  });
  it('re-asserts the pair after a RAW reset embedded in content (colored command output)', () => {
    // streamed output keeps its own \x1b[0m; the run after it must return to the
    // theme, NOT the terminal default (the "whole surface" gap: visible as a
    // mismatched patch when terminal bg != theme bg, e.g. a light theme on a dark term)
    eq(richToAnsi('\x1b[34mdir\x1b[0m file'),
       MONOKAI + '\x1b[34mdir\x1b[0m' + MONOKAI + ' file');
  });
  it('...and via esc() — the real content path (SGR survives the sentinel round-trip)', () => {
    assert(richToAnsi(esc('\x1b[34mx\x1b[0my')).includes('\x1b[0m' + MONOKAI),
      'a content reset routed through esc() must still be followed by the theme pair');
  });

  enableScreenColors(false);   // restore the default for any later block in this file
});

describe('[3] the pair is load-bearing — plain/dim/reverse carry an explicit FG', () => {
  setTheme('minimal');   // the theme that leans hardest on the terminal default
  enableScreenColors(true);
  const FG = '37';       // white foreground param

  it('plain text carries the theme fg (was default-fg → invisible on forced bg)', () => {
    assert(richToAnsi('plain').includes(FG), `plain text must carry an explicit fg, got ${JSON.stringify(richToAnsi('plain'))}`);
  });
  it('dim text still carries the theme fg', () => {
    assert(richToAnsi('[dim]d[/]').includes(FG), 'dim content must sit on the themed fg, not the terminal default');
  });
  it('reverse content carries the themed pair (deterministic highlight, not terminal-dependent)', () => {
    const out = richToAnsi('[reverse]r[/]');
    assert(out.includes('7') && out.includes(FG) && out.includes('40'),
      `reverse must swap two EXPLICIT colours, got ${JSON.stringify(out)}`);
  });

  setTheme('monokai');
  enableScreenColors(false);
});

describe('[4] the pair tracks the active theme', () => {
  enableScreenColors(true);
  it('dracula', () => { setTheme('dracula'); eq(richToAnsi('a'), DRACULA + 'a'); });
  it('minimal uses the named-16 pair', () => { setTheme('minimal'); eq(richToAnsi('a'), MINIMAL + 'a'); });
  it('solarized-light is DARK ink on a LIGHT bg (the light-terminal theme)', () => {
    setTheme('solarized-light'); eq(richToAnsi('a'), SOLLIGHT + 'a');
  });
  setTheme('monokai');
  enableScreenColors(false);
});

describe('[5] the cell-diff path inherits the pair (folded per-cell)', () => {
  setTheme('monokai');
  enableScreenColors(true);

  it('a changed glyph re-emits with the theme fg+bg in its style', () => {
    const out = diffRowToAnsi('aXc', 'aYc', 0);
    assert(out.includes('48;2;39;40;34') && out.includes('38;2;248;248;242'),
      `cell-diff must carry the themed pair, got ${JSON.stringify(out)}`);
  });
  it('a changed BLANK cell also carries the pair (padding is themed, not transparent)', () => {
    const out = diffRowToAnsi('a c', 'a.c', 0);
    assert(out.includes('48;2;39;40;34'), `a themed blank must re-emit with the bg, got ${JSON.stringify(out)}`);
  });

  enableScreenColors(false);
});

describe('[6] a forced full-repaint clears to the themed bg (erase-flash guard)', () => {
  setTheme('monokai');
  enableScreenColors(true);
  it('the screen colours precede \\x1b[2J so the clear erases themed, not terminal-default', () => {
    const { paintFrame } = require('../leaves/render/painter');
    const { ansi } = paintFrame([], ['xx'], true);   // prev empty → forced full clear
    const i2j = ansi.indexOf('\x1b[2J');
    const ibg = ansi.indexOf('48;2;39;40;34');        // monokai bg param
    assert(ibg >= 0 && ibg < i2j, `themed bg must precede the 2J clear, got ${JSON.stringify(ansi.slice(0, 40))}`);
  });
  enableScreenColors(false);
  it('OFF: the clear stays a bare 2J (no prefix)', () => {
    const { paintFrame } = require('../leaves/render/painter');
    const { ansi } = paintFrame([], ['xx'], true);
    assert(ansi.startsWith('\x1b[2J'), `off must keep the bare clear, got ${JSON.stringify(ansi.slice(0, 20))}`);
  });
});

describe('[7] disabling restores pure output', () => {
  it('back to byte-identical after enable→disable', () => {
    enableScreenColors(true); setTheme('dracula');
    enableScreenColors(false);
    eq(richToAnsi('hello'), 'hello');
  });
});

report();
