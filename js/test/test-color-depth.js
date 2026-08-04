/**
 * Color depth — detection, write-boundary downgrade, config plumbing
 * (truecolor arc 1b, docs/truecolor.md P3).
 *
 * The pipeline is canonically truecolor: hex markup atoms always compile to
 * 38;2 (pinned in test-ansi.js) and the FRAME is depth-independent (the
 * subprocess pin below exercises the real require path under different
 * LAZYTUI_COLOR values). Depth adapts emitted bytes only, in
 * leaves/render/color-depth.js at paint's write funnel. Quantization is
 * pinned through the public downgradeAnsi surface — including the full
 * 6×6×6-cube + gray-ramp round-trip property (cube colors map to
 * themselves), so the hand-rolled math can't drift.
 *
 * Run: node js/test/test-color-depth.js
 */
'use strict';

const { spawnSync } = require('child_process');
const { describe, it, eq, assert, report } = require('./test-runner');
const { detectColorDepth, downgradeAnsi } = require('../leaves/render/color-depth');
const { mergeGlobal } = require('../parser/global');
const { validateGlobal } = require('../parser/schema');

describe('[1] detectColorDepth — override, then convention, then TERM', () => {
  it('LAZYTUI_COLOR wins over everything', () => {
    eq(detectColorDepth({ LAZYTUI_COLOR: '16', COLORTERM: 'truecolor', TERM: 'xterm-256color' }), '16');
    eq(detectColorDepth({ LAZYTUI_COLOR: 'truecolor', TERM: 'dumb' }), 'truecolor');
  });
  it('invalid LAZYTUI_COLOR falls through to detection', () => {
    eq(detectColorDepth({ LAZYTUI_COLOR: 'lots', COLORTERM: 'truecolor' }), 'truecolor');
  });
  it('COLORTERM truecolor/24bit → truecolor', () => {
    eq(detectColorDepth({ COLORTERM: 'truecolor', TERM: 'xterm-256color' }), 'truecolor');
    eq(detectColorDepth({ COLORTERM: '24bit', TERM: 'xterm' }), 'truecolor');
  });
  it('TERM direct/256color tiers; default 16', () => {
    eq(detectColorDepth({ TERM: 'xterm-direct' }), 'truecolor');
    eq(detectColorDepth({ TERM: 'xterm-256color' }), '256');
    eq(detectColorDepth({ TERM: 'xterm' }), '16');
    eq(detectColorDepth({}), '16');
  });
});

describe('[2] downgradeAnsi — truecolor identity, 256/16 quantization', () => {
  it('truecolor depth is the identity (same reference)', () => {
    const s = 'a\x1b[38;2;1;2;3mb';
    assert(downgradeAnsi(s, 'truecolor') === s, 'identity fast-path');
  });
  it('strings with no extended colors pass through untouched at 16/256', () => {
    const s = '\x1b[1;33mhi\x1b[0m\x1b[2J';
    assert(downgradeAnsi(s, '16') === s, 'no-extended fast-path');
  });
  it('38;2 → 38;5 at 256 (cube and gray)', () => {
    eq(downgradeAnsi('\x1b[38;2;255;0;0mx', '256'), '\x1b[38;5;196mx');
    eq(downgradeAnsi('\x1b[38;2;128;128;128mx', '256'), '\x1b[38;5;244mx');
  });
  it('38;2/48;2 → base 16 at 16 (fg 30-37/90-97, bg 40-47/100-107)', () => {
    eq(downgradeAnsi('\x1b[38;2;255;0;0mx', '16'), '\x1b[91mx');
    eq(downgradeAnsi('\x1b[48;2;0;0;0mx', '16'), '\x1b[40mx');
  });
  it('38;5 requantizes at 16, passes through at 256', () => {
    eq(downgradeAnsi('\x1b[38;5;196mx', '16'), '\x1b[91mx');
    eq(downgradeAnsi('\x1b[38;5;196mx', '256'), '\x1b[38;5;196mx');
  });
  it('surrounding params survive in place', () => {
    eq(downgradeAnsi('\x1b[1;38;2;255;0;0;7mx', '16'), '\x1b[1;91;7mx');
  });
  it('underline color (58): 58;5 at 256, dropped at 16', () => {
    eq(downgradeAnsi('\x1b[58;2;255;0;0mx', '256'), '\x1b[58;5;196mx');
    eq(downgradeAnsi('\x1b[58;2;255;0;0mx', '16'), 'x');
  });
  it('malformed extended tail drops the sequence when the pass runs (mirrors the H1 fold)', () => {
    eq(downgradeAnsi('\x1b[38;2;255;0;0m\x1b[38;9;31mx', '16'), '\x1b[91mx');
  });
  it('purely-malformed strings take the fast-path untouched (no well-formed marker)', () => {
    const s = '\x1b[38;9;31mx';
    assert(downgradeAnsi(s, '16') === s, 'fast-path identity');
  });
});

describe('[3] round-trip property — every 256-palette color maps to itself', () => {
  const CUBE = [0, 95, 135, 175, 215, 255];
  it('all 216 cube entries', () => {
    for (let i = 0; i < 216; i++) {
      const r = CUBE[(i / 36) | 0], g = CUBE[((i / 6) | 0) % 6], b = CUBE[i % 6];
      eq(downgradeAnsi(`\x1b[38;2;${r};${g};${b}m`, '256'), `\x1b[38;5;${16 + i}m`, `cube ${16 + i}`);
    }
  });
  it('all 24 gray-ramp entries', () => {
    for (let i = 0; i < 24; i++) {
      const v = 8 + 10 * i;
      eq(downgradeAnsi(`\x1b[38;2;${v};${v};${v}m`, '256'), `\x1b[38;5;${232 + i}m`, `gray ${232 + i}`);
    }
  });
});

describe('[4] the frame is depth-independent (P3 pin, real require path)', () => {
  it('richToAnsi emits identical bytes under every LAZYTUI_COLOR', () => {
    const probe = `process.stdout.write(require('${__dirname}/../leaves/text/ansi').richToAnsi('[#ff8800]x[/] [bold cyan]y[/]'))`;
    const outs = ['truecolor', '256', '16'].map((d) =>
      spawnSync(process.execPath, ['-e', probe], {
        env: { ...process.env, LAZYTUI_COLOR: d },
        encoding: 'utf8',
      }).stdout);
    eq(outs[0], outs[1], 'truecolor vs 256');
    eq(outs[1], outs[2], '256 vs 16');
    assert(outs[0].includes('38;2;255;136;0'), 'canonical truecolor bytes in the frame');
  });
});

describe('[5] config plumbing — color_depth key', () => {
  it("mergeGlobal: 'auto' counts as unset (global applies under it)", () => {
    eq(mergeGlobal({ color_depth: 'auto' }, { color_depth: '16' }).color_depth, '16');
  });
  it('mergeGlobal: an explicit project depth wins', () => {
    eq(mergeGlobal({ color_depth: '256' }, { color_depth: '16' }).color_depth, '256');
  });
  it('validateGlobal accepts auto/truecolor/256/16 (ints included), rejects junk', () => {
    validateGlobal({ color_depth: 'auto' });
    validateGlobal({ color_depth: 256 });          // YAML unquoted int
    validateGlobal({ color_depth: '16' });
    let threw = false;
    try { validateGlobal({ color_depth: 'lots' }); } catch (_) { threw = true; }
    assert(threw, "junk value must throw");
  });
});

report();
