/**
 * refresh-control — the pure refresh-rate control primitive (Phase 0 of the
 * btop-style `- 2s +` control for monitor panes). Pins the ladder/clamp, the
 * label formatter, the `-`/`+` hit rects, and that the spec's click regions sit
 * on what renderPanel actually drew (clicks resolve on the hit map, published at
 * the x renderPanel reports — docs/mouse-hit-map.md Release 2).
 *
 * Run: node js/test/test-refresh-control.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const mc = require('../leaves/render/refresh-control');

describe('[refresh-control] ladder + clamp', () => {
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

describe('[refresh-control] stepRefreshMs', () => {
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

describe('[refresh-control] formatRefreshMs', () => {
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

describe('[refresh-control] configurable ladder', () => {
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

describe('[refresh-control] refreshControlText', () => {
  it('markup + visible width for the label', () => {
    eq(mc.refreshControlText(2000), { text: '[dim]-[/] 2s [dim]+[/]', visibleW: 6 });   // "2s" + 4
    eq(mc.refreshControlText(10000).visibleW, 7);                                        // "10s" (3) + 4
    eq(mc.refreshControlText(500).visibleW, 9);                                          // "500ms" (5) + 4
  });
});

describe('[refresh-control] refreshControlHits', () => {
  it('two 2-cell buttons that never overlap the label span', () => {
    const h = mc.refreshControlHits(14, 0, 6);
    eq(h.minus, { x0: 14, x1: 15, y: 0 });
    eq(h.plus,  { x0: 18, x1: 19, y: 0 });
    assert(h.minus.x1 < h.plus.x0, 'minus fully left of plus (label gap between)');
  });
});

// The phantom-click guard (review HIGH), hit-map form: the click regions are the
// spec's regions() at the x renderPanel REPORTS drawing the control (the chrome
// sink — render/paint publishes exactly that). Cross-check the REAL renderPanel
// output against its own report across every width: reported iff drawn, at the
// painted cell, and the `-` / `+` regions sit on the painted `-` / `+`.
describe('[refresh-control] render ↔ reported placement (phantom-click guard)', () => {
  const draw = require('../leaves/render/draw');
  const { stripMarkup } = require('../leaves/text/ansi');
  let lastRec = null;
  draw.setChromeSink((rec) => { lastRec = rec; });
  const spec = mc.refreshControlSpec({ owner: 'docker', currentMs: () => 10000 });
  const { text, visibleW } = mc.refreshControlText(10000);   // "- 10s +"
  const control = { spec, text, visibleW, pane: { paneId: 'p', type: 'containers' } };
  const top = (w, title) => {
    lastRec = null;
    const row = stripMarkup(draw.renderPanel({ width: w, height: 4, lines: [], title, hotkey: 'd',
      chrome: { collapse: 'collapse' }, topControls: [control] }).split('\n')[0]);
    return { row, rec: lastRec };
  };
  it('reported IFF drawn, at the painted cell; regions sit on - and +, w ∈ [8,60]', () => {
    let drew = 0;
    for (let w = 8; w <= 60; w++) {
      const { row, rec } = top(w, 'Containers');
      const drawn = row.includes('- 10s +');
      eq(!!(rec && rec.controls), drawn, `w=${w}: reported iff drawn — ${JSON.stringify(row)}`);
      if (!drawn) continue;
      drew++;
      const x0 = rec.controls[0].x0;
      eq(x0, row.indexOf('- 10s +'), `w=${w}: x0 is the painted cell`);
      const rs = spec.regions(x0, 0, visibleW);
      const dec = rs.find(r => r.action === 'dec'), inc = rs.find(r => r.action === 'inc');
      eq(row[dec.x0], '-', `w=${w}: the dec region starts on the painted -`);
      eq(row[inc.x1], '+', `w=${w}: the inc region ends on the painted +`);
      assert(!row.slice(dec.x1 + 1, inc.x0).includes('-') && !row.slice(dec.x1 + 1, inc.x0).includes('+'),
        'the label between the buttons is in neither region');
    }
    assert(drew > 0, 'the sweep drew the control at some width');
  });
  it('a longer title does NOT change presence (title-independent) — same first-shown width', () => {
    const firstShown = (title) => {
      for (let w = 8; w <= 60; w++) if (top(w, title).rec && top(w, title).rec.controls) return w;
      return null;
    };
    const short = firstShown('C');
    assert(short != null);
    eq(firstShown('a very long containers panel title'), short);   // title length is irrelevant
  });
});

report();
