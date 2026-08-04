/**
 * Themes — slot validity + gradient API (truecolor arc 1c,
 * docs/truecolor.md).
 *
 * Every slot value of every theme must COMPILE: richToAnsi on an unknown
 * atom collapses the tag to RESET, so a typo'd hex or a misspelled atom in
 * themes.js would silently render unstyled (exactly how the pre-1a
 * 'dim reverse' footer bug hid for six themes). Pinning compilation here
 * surfaces that at suite time. GRADS shape + the gradient() ramp
 * (endpoints, midpoint, clamping, unknown-name fallback, per-theme cache)
 * are pinned alongside.
 *
 * Run: node js/test/test-themes.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { richToAnsi, RESET } = require('../leaves/text/ansi');
const { THEMES, GRADS, DEFAULT_THEME, setTheme, theme, gradient, themeNames } = require('../leaves/infra/themes');

const HEX = /^#[0-9a-f]{6}$/i;

describe('[1] every slot of every theme compiles (no silent RESET)', () => {
  for (const [name, palette] of Object.entries(THEMES)) {
    it(`${name}: all ${Object.keys(palette).length} slots compile`, () => {
      for (const [slot, value] of Object.entries(palette)) {
        const out = richToAnsi(`[${value}]x`);
        assert(out !== `${RESET}x`, `${name}.${slot} ('${value}') compiled to RESET — unknown atom?`);
      }
    });
  }
});

describe('[2] GRADS shape — every theme has percent, anchors are hex triples', () => {
  it('themes and GRADS cover the same names', () => {
    eq(Object.keys(GRADS).sort().join(','), themeNames().sort().join(','));
  });
  for (const [name, grads] of Object.entries(GRADS)) {
    it(`${name}: well-formed anchors`, () => {
      assert(grads.percent, `${name} must define the percent gradient`);
      for (const [gname, anchors] of Object.entries(grads)) {
        eq(anchors.length, 3, `${name}.${gname} needs [start, mid, end]`);
        for (const a of anchors) assert(HEX.test(a), `${name}.${gname} anchor '${a}' is not #rrggbb`);
      }
    });
  }
});

describe('[3] gradient() — ramp endpoints, midpoint, clamping, fallback', () => {
  it('frac 0 / 0.5 / 1 hit start / mid / end exactly', () => {
    for (const name of themeNames()) {
      setTheme(name);
      const [s, m, e] = GRADS[name].percent;
      eq(gradient('percent', 0), s, `${name} start`);
      eq(gradient('percent', 0.5), m, `${name} mid`);
      eq(gradient('percent', 1), e, `${name} end`);
    }
    setTheme(DEFAULT_THEME);
  });
  it('out-of-range and non-finite fracs clamp', () => {
    setTheme(DEFAULT_THEME);
    eq(gradient('percent', -3), GRADS[DEFAULT_THEME].percent[0]);
    eq(gradient('percent', 42), GRADS[DEFAULT_THEME].percent[2]);
    eq(gradient('percent', NaN), GRADS[DEFAULT_THEME].percent[0]);
  });
  it('unknown gradient name falls back to percent', () => {
    setTheme(DEFAULT_THEME);
    eq(gradient('no_such_ramp', 1), GRADS[DEFAULT_THEME].percent[2]);
  });
  it('every step is a valid hex (whole ramp sweep)', () => {
    setTheme(DEFAULT_THEME);
    for (let i = 0; i <= 100; i++) {
      assert(HEX.test(gradient('percent', i / 100)), `step ${i}`);
    }
  });
  it('theme switch resolves against the new ramp', () => {
    setTheme('nord');
    eq(gradient('percent', 0), GRADS.nord.percent[0]);
    setTheme('dracula');
    eq(gradient('percent', 0), GRADS.dracula.percent[0]);
    setTheme(DEFAULT_THEME);
  });
});

describe('[4] palette contracts', () => {
  it("selected === 'reverse' in every theme (select-core PRINCIPLES §8; Phase 3 owns changing this)", () => {
    for (const [name, palette] of Object.entries(THEMES)) {
      eq(palette.selected, 'reverse', `${name}.selected`);
    }
  });
  it('minimal stays named-16 (the no-quantization theme)', () => {
    for (const [slot, value] of Object.entries(THEMES.minimal)) {
      assert(!value.includes('#'), `minimal.${slot} must stay non-hex, got '${value}'`);
    }
  });
});

report();
