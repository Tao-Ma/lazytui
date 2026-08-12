/**
 * monitor-control — the pure refresh-rate control primitive (Phase 0 of the
 * btop-style `- 2s +` control for monitor panes). Pins the ladder/clamp, the
 * label formatter, the right-aligned layout + hit rects, and the hit predicate,
 * so the Component renderer + panel/chrome-hittest (Phase 3) share one geometry
 * source and can't drift.
 *
 * Run: node js/test/test-monitor-control.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const mc = require('../leaves/render/monitor-control');

describe('[monitor-control] ladder + clamp', () => {
  it('bounds are the ladder ends', () => {
    eq(mc.MIN_REFRESH_MS, mc.REFRESH_LADDER[0]);
    eq(mc.MAX_REFRESH_MS, mc.REFRESH_LADDER[mc.REFRESH_LADDER.length - 1]);
  });
  it('clampRefreshMs keeps in-range, clamps out-of-range, rounds', () => {
    eq(mc.clampRefreshMs(2000), 2000);
    eq(mc.clampRefreshMs(100), mc.MIN_REFRESH_MS);      // below min
    eq(mc.clampRefreshMs(999999), mc.MAX_REFRESH_MS);   // above max
    eq(mc.clampRefreshMs(3000.7), 3001);                // in-range, rounded
  });
  it('clampRefreshMs degrades a garbage value to the default (never-brick)', () => {
    eq(mc.clampRefreshMs(undefined), mc.DEFAULT_REFRESH_MS);
    eq(mc.clampRefreshMs(NaN), mc.DEFAULT_REFRESH_MS);
    eq(mc.clampRefreshMs('nope'), mc.DEFAULT_REFRESH_MS);
    eq(mc.clampRefreshMs(0), mc.DEFAULT_REFRESH_MS);    // ≤0 → default, NOT MIN (no 500ms poll storm)
    eq(mc.clampRefreshMs(-5), mc.DEFAULT_REFRESH_MS);
  });
});

describe('[monitor-control] stepRefreshMs', () => {
  it('steps to the adjacent ladder stop', () => {
    eq(mc.stepRefreshMs(2000, +1), 5000);   // + = slower (larger ms)
    eq(mc.stepRefreshMs(2000, -1), 1000);   // - = faster (smaller ms)
  });
  it('clamps at the ends', () => {
    eq(mc.stepRefreshMs(mc.MAX_REFRESH_MS, +1), mc.MAX_REFRESH_MS);
    eq(mc.stepRefreshMs(mc.MIN_REFRESH_MS, -1), mc.MIN_REFRESH_MS);
  });
  it('an off-ladder value snaps to the correct neighbouring stop', () => {
    eq(mc.stepRefreshMs(3000, +1), 5000);   // strictly-greater
    eq(mc.stepRefreshMs(3000, -1), 2000);   // strictly-less
  });
  it('dir 0 is a plain clamp', () => {
    eq(mc.stepRefreshMs(2000, 0), 2000);
    eq(mc.stepRefreshMs(100, 0), mc.MIN_REFRESH_MS);
  });
});

describe('[monitor-control] formatRefreshMs', () => {
  it('sub-second → Nms, ≥1s → N[.N]s with trailing .0 dropped', () => {
    eq(mc.formatRefreshMs(500), '500ms');
    eq(mc.formatRefreshMs(1000), '1s');
    eq(mc.formatRefreshMs(2000), '2s');
    eq(mc.formatRefreshMs(1500), '1.5s');
    eq(mc.formatRefreshMs(10000), '10s');
    eq(mc.formatRefreshMs(30000), '30s');
    eq(mc.formatRefreshMs(60000), '60s');       // new ladder ceiling
    eq(mc.formatRefreshMs(120000), '120s');     // a custom-ladder stop above 60s (formats as-given, no clamp)
  });
});

describe('[monitor-control] configurable ladder', () => {
  it('normalizeLadder sorts / dedupes / drops non-positive; garbage → default', () => {
    eq(mc.normalizeLadder([5000, 2000, 1000]), [1000, 2000, 5000]);   // sorted
    eq(mc.normalizeLadder([2000, 2000, 5000]), [2000, 5000]);         // deduped
    eq(mc.normalizeLadder([3000, -3, 6000, 'x', 0]), [3000, 6000]);   // drop non-positive / non-finite
    eq(mc.normalizeLadder('nope'), mc.REFRESH_LADDER);                // not an array → default
    eq(mc.normalizeLadder([2000]), mc.REFRESH_LADDER);                // <2 usable stops → default
    eq(mc.normalizeLadder(undefined), mc.REFRESH_LADDER);
  });
  it('clamp + step honor a custom ladder (incl. a lifted ceiling)', () => {
    const L = [3000, 6000, 120000];
    eq(mc.clampRefreshMs(1000, L), 3000);                   // below custom min
    eq(mc.clampRefreshMs(999999, L), 120000);               // above custom max — 60s ceiling lifted
    eq(mc.clampRefreshMs(undefined, L), mc.DEFAULT_REFRESH_MS);   // default 10s is in [3s,120s]
    eq(mc.clampRefreshMs(undefined, [3000, 6000]), 6000);        // default above custom max → clamped
    eq(mc.stepRefreshMs(3000, +1, L), 6000);
    eq(mc.stepRefreshMs(6000, +1, L), 120000);              // extended ceiling honored
    eq(mc.stepRefreshMs(120000, +1, L), 120000);            // clamp at custom max
    eq(mc.stepRefreshMs(6000, -1, L), 3000);
  });
});

describe('[monitor-control] refreshControlText', () => {
  it('markup + visible width for the label', () => {
    eq(mc.refreshControlText(2000), { text: '[dim]-[/] 2s [dim]+[/]', visibleW: 6 });   // "2s" + 4
    eq(mc.refreshControlText(10000).visibleW, 7);                                        // "10s" (3) + 4
    eq(mc.refreshControlText(500).visibleW, 9);                                          // "500ms" (5) + 4
  });
});

describe('[monitor-control] refreshControlHits + border x0', () => {
  it('two 2-cell buttons that never overlap the label span', () => {
    const h = mc.refreshControlHits(14, 0, 6);
    eq(h.minus, { x0: 14, x1: 15, y: 0 });
    eq(h.plus,  { x0: 18, x1: 19, y: 0 });
    assert(h.minus.x1 < h.plus.x0, 'minus fully left of plus (label gap between)');
  });
  it('the border x0 is one gap-dash left of the leftmost glyph', () => {
    eq(mc.refreshControlBorderX0(28, 6), 21);   // 28 - 1 - 6
  });
});

describe('[monitor-control] refreshControlDir (hit predicate)', () => {
  const h = mc.refreshControlHits(14, 0, 6);
  it('maps a click on each button to its direction', () => {
    eq(mc.refreshControlDir(14, 0, h), -1);   // on `-`
    eq(mc.refreshControlDir(15, 0, h), -1);   // the button's second cell
    eq(mc.refreshControlDir(18, 0, h), 1);    // on `+`
    eq(mc.refreshControlDir(19, 0, h), 1);
  });
  it('a click on the label / off-row / missing hits is a miss', () => {
    eq(mc.refreshControlDir(16, 0, h), 0);    // label cell
    eq(mc.refreshControlDir(14, 1, h), 0);    // wrong row
    eq(mc.refreshControlDir(14, 0, null), 0); // no hits
  });
});

// The phantom-click guard (review HIGH): renderPanel must draw the control on
// EXACTLY the widths where refreshControlFits() says so — the predicate
// chrome-hittest gates on. If they ever diverge, a click lands on the title/border
// where no control drew (or a real control is un-clickable). Cross-check the REAL
// renderPanel output against the predicate across every width.
describe('[monitor-control] render ↔ refreshControlFits agreement (phantom-click guard)', () => {
  const draw = require('../leaves/render/draw');
  const { stripMarkup } = require('../leaves/text/ansi');
  const GLYPH_W = 3;   // collapse [_] only (the control shows in normal mode)
  it('renderPanel draws the control IFF refreshControlFits predicts it, w ∈ [8,60]', () => {
    const { text, visibleW } = mc.refreshControlText(10000);   // "10s"
    for (let w = 8; w <= 60; w++) {
      const top = stripMarkup(draw.renderPanel({
        width: w, height: 4, lines: [], title: 'Containers', hotkey: 'd',
        chrome: { collapse: 'collapse' }, monitorControl: text,
      }).split('\n')[0]);
      const drawn = top.includes('- 10s +');
      const predicted = mc.refreshControlFits(w - 2, GLYPH_W, visibleW);
      eq(drawn, predicted, `w=${w}: drawn=${drawn} predicted=${predicted} top=${JSON.stringify(top)}`);
    }
  });
  it('a longer title does NOT change presence (title-independent) — same first-shown width', () => {
    const { text, visibleW } = mc.refreshControlText(10000);
    const firstShown = (title) => {
      for (let w = 8; w <= 60; w++) {
        const top = stripMarkup(draw.renderPanel({ width: w, height: 4, lines: [], title, hotkey: 'd',
          chrome: { collapse: 'collapse' }, monitorControl: text }).split('\n')[0]);
        if (top.includes('- 10s +')) return w;
      }
      return null;
    };
    let predFirst = null;
    for (let w = 8; w <= 60; w++) if (mc.refreshControlFits(w - 2, GLYPH_W, visibleW)) { predFirst = w; break; }
    eq(firstShown('C'), predFirst);
    eq(firstShown('a very long containers panel title'), predFirst);   // title length is irrelevant
  });
});

report();
