/**
 * border-controls — the pure geometry for the top-border control STRIP (the
 * generalization of the lone refresh-control slot). Pins reservedW / fits /
 * placeX0s, and — critically — cross-checks the REAL renderPanel output against
 * `fits` for a MULTI-control strip, so the paint ↔ hit-test agreement that
 * chrome-hittest relies on holds before any second control (sort, Phase 2) ships.
 *
 * Run: node js/test/test-border-controls.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const bc = require('../leaves/render/border-controls');

const GLYPH_W = 3;   // collapse [_] only (controls show in normal mode)

describe('[border-controls] reservedW', () => {
  it('single control = control + gap + glyphs + corner', () => {
    eq(bc.reservedW([6], GLYPH_W), 11);          // 6 + 1 + 3 + 1
  });
  it('two controls add each width + a gap each', () => {
    eq(bc.reservedW([6, 4], GLYPH_W), 16);        // (6+4) + 2 + 3 + 1
  });
  it('empty strip is just glyphs + corner', () => {
    eq(bc.reservedW([], GLYPH_W), 4);             // 0 + 0 + 3 + 1
  });
});

describe('[border-controls] fits mirrors renderPanel leftCap>=2', () => {
  it('single control needs innerW >= reservedW + 1', () => {
    eq(bc.fits(11, GLYPH_W, [6]), false);         // 11 <= 10? no
    eq(bc.fits(12, GLYPH_W, [6]), true);          // 11 <= 11? yes
  });
  it('two controls need more room', () => {
    eq(bc.fits(16, GLYPH_W, [6, 4]), false);      // 16 <= 15? no
    eq(bc.fits(17, GLYPH_W, [6, 4]), true);       // 16 <= 16? yes
  });
});

describe('[border-controls] placeX0s (last control nearest the glyphs)', () => {
  it('single control sits one gap-dash left of glyphX0', () => {
    eq(bc.placeX0s([6], 36), [29]);               // 36 - 1 - 6
  });
  it('a single control matches refreshControlBorderX0', () => {
    const mc = require('../leaves/render/monitor-control');
    eq(bc.placeX0s([6], 28), [mc.refreshControlBorderX0(28, 6)]);   // 28-1-6 = 21
  });
  it('two controls step left in registration order', () => {
    // glyphX0=36: B(last,w4) at 36-1-4=31; A(first,w6) at 31-1-6=24
    eq(bc.placeX0s([6, 4], 36), [24, 31]);
  });
});

// The phantom-click guard, generalized to a MULTI-control strip: renderPanel
// must draw BOTH synthetic controls on EXACTLY the widths where `fits` predicts,
// and at the x0s `placeX0s` computes — the same predicate + positions
// chrome-hittest gates on. If they diverge, a click lands where no control drew.
describe('[border-controls] render ↔ fits/placeX0s agreement (multi-control phantom guard)', () => {
  const draw = require('../leaves/render/draw');
  const { stripMarkup } = require('../leaves/text/ansi');
  const A = 'AAAAAA';   // visibleW 6
  const B = 'BBBB';     // visibleW 4
  it('draws both IFF fits predicts, w ∈ [8,48]', () => {
    for (let w = 8; w <= 48; w++) {
      const top = stripMarkup(draw.renderPanel({
        width: w, height: 4, lines: [], title: 'T', hotkey: 'd',
        chrome: { collapse: 'collapse' }, borderControls: [A, B],
      }).split('\n')[0]);
      const drawn = top.includes(A) && top.includes(B);
      const predicted = bc.fits(w - 2, GLYPH_W, [6, 4]);
      eq(drawn, predicted, `w=${w}: drawn=${drawn} predicted=${predicted} top=${JSON.stringify(top)}`);
    }
  });
  it('when drawn, each control sits at its placeX0s cell (glyphX0 = W-4)', () => {
    const W = 44;
    const top = stripMarkup(draw.renderPanel({
      width: W, height: 4, lines: [], title: 'T', hotkey: 'd',
      chrome: { collapse: 'collapse' }, borderControls: [A, B],
    }).split('\n')[0]);
    const [ax0, bx0] = bc.placeX0s([6, 4], W - 4);   // collapse [_] leftmost cell = W-4
    eq(top.indexOf(A), ax0, `A at x0 ${ax0}: ${JSON.stringify(top)}`);
    eq(top.indexOf(B), bx0, `B at x0 ${bx0}: ${JSON.stringify(top)}`);
    assert(ax0 + 6 < bx0, 'A fully left of B with a gap-dash between');
  });
});

// The bottom-legend paint ↔ geometry guard: renderPanel must draw the left-
// anchored bottom control on EXACTLY the widths bottomFits predicts, at the cell
// bottomX0 gives — the same predicate + position chrome-hittest gates on.
describe('[border-controls] bottom legend render ↔ bottomFits/bottomX0 agreement', () => {
  const draw = require('../leaves/render/draw');
  const { stripMarkup } = require('../leaves/text/ansi');
  const LEG = 'inspect stop kill';   // visibleW 17
  it('draws the legend on the bottom border IFF bottomFits, at bottomX0, w ∈ [8,40]', () => {
    for (let w = 8; w <= 40; w++) {
      const out = draw.renderPanel({ width: w, height: 4, lines: [], title: 'T', bottomControls: [LEG], count: [1, 3] });
      const row = stripMarkup(out.split('\n').pop());
      const drawn = row.includes(LEG);
      const predicted = bc.bottomFits(w - 2, 17);
      eq(drawn, predicted, `w=${w}: drawn=${drawn} predicted=${predicted} row=${JSON.stringify(row)}`);
      if (drawn) eq(row.indexOf(LEG), bc.bottomX0(0), `legend at bottomX0 (w=${w})`);
    }
  });
});

report();
