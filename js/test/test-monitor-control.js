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

report();
