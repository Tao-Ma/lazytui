/**
 * Y-axis labels (docs/STATS.md §7, §10). Three layers:
 *   1. `_axisFor` truth table — the shared show/gutterW decision (auto ≤15% cap, always,
 *      off, min-height / min-trace guards).
 *   2. Paint — renderBody draws the tick gutter (`100% ┤` … `0% ┤`), the trace shrinks to
 *      the remaining width, and `invert` flips the label order.
 *   3. The offset guard — with a gutter present, hover in the label column resolves NOTHING
 *      while the trace edges still map to the oldest/newest sample (paint↔hit-test agree).
 *
 * Run: node js/test/test-stats-yaxis.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const stats = require('../panel/monitor/stats');
const api = require('../panel/api');

for (const c of ['stats']) if (!api.getComponent(c)) api.registerComponent(require('../panel/monitor/' + c));

function setMetric(topic, series, cols) {
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series, schema: { columns: cols } } };
}

// A monotone 0..299 CPU series → each column has a distinct, left-to-right ascending value.
function seedCpu() {
  setMetric('y.cpu', { _: Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 100 })) }, { cpu: { type: 'percent' } });
}
const G = stats._axisGutterW('percent');   // 6: `100%`(4) + ` ┤`(2)

describe('[stats-yaxis] _axisFor — the shared show/gutterW decision', () => {
  it('percent gutter is a stable per-type constant', () => eq(G, 6, 'percent gutter = 6'));

  it('auto shows only when the gutter stays ≤15% of the width', () => {
    eq(stats._axisFor('percent', 60, 6, 'auto').show, true, 'wide (60) → show');   // 6 ≤ 9
    eq(stats._axisFor('percent', 30, 6, 'auto').show, false, 'narrow (30) → hide'); // 6 > 4.5
    eq(stats._axisFor('percent', 60, 6, 'auto').gutterW, 6, 'gutterW when shown');
    eq(stats._axisFor('percent', 30, 6, 'auto').gutterW, 0, 'gutterW 0 when hidden');
  });

  it('always overrides the width cap but still needs a usable trace + height', () => {
    eq(stats._axisFor('percent', 30, 6, 'always').show, true, 'always shows on a narrow-but-usable pane');
    eq(stats._axisFor('percent', 10, 6, 'always').show, false, 'always still hides when the trace would be <8 cols');
    eq(stats._axisFor('percent', 60, 1, 'always').show, false, 'always hides with <2 graph rows');
  });

  it('off never shows; unknown mode defaults to auto', () => {
    eq(stats._axisFor('percent', 200, 8, 'off').show, false, 'off → never');
    eq(stats._axisFor('percent', 60, 6, undefined).show, true, 'missing mode → auto → shows when wide');
  });

  it('a wider label type demands a wider pane (auto scales to the gutter)', () => {
    assert(stats._axisGutterW('rate') > stats._axisGutterW('percent'), 'rate gutter wider than percent');
  });
});

describe('[stats-yaxis] paint — tick gutter + shrunk trace + invert', () => {
  it('always draws the axis ticks; off draws none', () => {
    seedCpu();
    const spec = (mode) => ({ topic: 'y.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: mode });
    const on = stats.renderBody(spec('always'), 60, 8, -1, null).lines.join('\n');
    const off = stats.renderBody(spec('off'), 60, 8, -1, null).lines.join('\n');
    assert(on.includes('┤') && on.includes('100%'), 'axis-on shows a tick + a 100% label');
    assert(!off.includes('┤'), 'axis-off draws no tick gutter');
  });

  it('the trace shrinks by the gutter width (fewer glyph columns)', () => {
    seedCpu();
    const spec = (mode) => ({ topic: 'y.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: mode });
    // The bottom graph row of the OFF pane is pure trace (width 60); the ON pane's is
    // gutter(6) + trace(54). Compare visible lengths via the shared width truth.
    const rowOf = (lines) => lines[lines.length - 1];   // last graph row (default header:top)
    const onRow = stats.renderBody(spec('always'), 60, 8, -1, null).lines;
    const offRow = stats.renderBody(spec('off'), 60, 8, -1, null).lines;
    eq(api.visibleLen(rowOf(offRow)), 60, 'off trace fills the full width');
    eq(api.visibleLen(rowOf(onRow)), 60, 'on row still fills the width (gutter + trace)');
  });

  it('invert flips the label order — max at the bottom', () => {
    seedCpu();
    const base = { topic: 'y.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: 'always' };
    const up = stats.renderBody(base, 60, 8, -1, null).lines;
    const inv = stats.renderBody({ ...base, invert: true }, 60, 8, -1, null).lines;
    // Non-invert: top graph row (after header+meter) carries the max (100%). Invert: it doesn't.
    const topGraph = (lines) => lines[2];        // [header, meter, graph…]
    assert(topGraph(up).includes('100%'), 'non-invert: max labels the TOP row');
    assert(!topGraph(inv).includes('100%'), 'invert: the top row is min, not max');
    assert(inv[inv.length - 1].includes('100%'), 'invert: max moves to the BOTTOM row');
  });
});

describe('[stats-yaxis] offset guard — hover/zoom stay aligned to the shrunk trace', () => {
  const spec = (mode) => ({ paneId: undefined, topic: 'y.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: mode });
  const gRow = 3;   // a graph row (header 0, meter 1, graph 2+)

  it('a hover in the label gutter resolves nothing', () => {
    seedCpu();
    for (let c = 0; c < G; c++) eq(stats.valueAt(spec('always'), 60, 8, c, gRow), null, `col ${c} is gutter → null`);
    assert(stats.valueAt(spec('always'), 60, 8, G, gRow), 'the first TRACE col (== gutterW) resolves a value');
  });

  it('the rightmost trace column reads the NEWEST sample regardless of the gutter', () => {
    seedCpu();
    // The newest sample sits at the right edge in both — the trace fills to innerW-1 either
    // way — so off and always must agree there (proves the gutter didn't shift the edge).
    const newestOff = stats.valueAt(spec('off'), 60, 8, 59, gRow).value;
    const newestOn = stats.valueAt(spec('always'), 60, 8, 59, gRow).value;
    eq(newestOn, newestOff, 'rightmost col = newest sample, gutter or not');
  });

  it('values ascend left→right across the shrunk trace (monotone series)', () => {
    seedCpu();
    const left = stats.valueAt(spec('always'), 60, 8, G, gRow).value;         // first trace col
    const right = stats.valueAt(spec('always'), 60, 8, 59, gRow).value;       // last trace col
    assert(right > left, `trace ascends across the gutter-offset width (${left} → ${right})`);
  });

  it('freezeRange maps gutter-relative drag columns without crashing', () => {
    seedCpu();
    // A drag from inside the gutter to a trace col still freezes a real range (the gutter
    // cols clamp to the trace start); innerH threaded so the gutter width matches the paint.
    const frozen = stats.freezeRange(spec('always'), 60, 8, 2, 50);
    assert(frozen && frozen.end > frozen.start, `a gutter→trace drag freezes a range (${JSON.stringify(frozen && [frozen.start, frozen.end])})`);
  });
});

report();
