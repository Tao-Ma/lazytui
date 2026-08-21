/**
 * renderBody — the border-less body seam the `composite` panel reuses
 * (docs/compact-panes.md §2). Sub-step 1 of the compact-pane arc split `stats`
 * and `gauge` render() into a pure body + a thin renderPanel wrapper. The
 * existing test-stats / test-gauge / chrome-hittest-agreement suites already pin
 * that the STANDALONE panes still render byte-identically (behaviour-preserving
 * refactor); this file pins the NEW seam directly — the shapes a composite calls,
 * and the cursor-less DISPLAY mode that no standalone-pane test exercises.
 *
 * Run: node js/test/test-render-body.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const { theme } = require('../leaves/infra/themes');
const stats = require('../panel/monitor/stats');
const gauge = require('../panel/monitor/gauge');

// The selection highlight is the theme's `selected` slot wrapping the whole row
// (a color/reverse token like `[#fff on #333]`), NOT a literal `[selected]`.
const SEL = () => `[${theme().selected}]`;
const isHighlighted = (line) => line.startsWith(SEL());

function setMetric(topic, series, cols) {
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series, schema: { columns: cols } } };
}

describe('[renderBody] stats — border-less body', () => {
  setMetric('t.cpu', { _: [{ cpu: 10 }, { cpu: 20 }, { cpu: 30 }] }, { cpu: { type: 'percent' } });

  it('returns { lines, rowKey } that fit innerH; first line is the metric header', () => {
    const { lines, rowKey } = stats.renderBody({ topic: 't.cpu', row: '_', metrics: ['cpu'] }, 28, 8);
    eq(rowKey, '_');
    assert(lines.length > 0 && lines.length <= 8, `lines fit innerH=8, got ${lines.length}`);
    assert(lines[0].includes('CPU'), `header first, got ${JSON.stringify(lines[0])}`);
  });

  it('empty/missing topic → one dim message line, rowKey "_"', () => {
    const { lines, rowKey } = stats.renderBody({ topic: 't.missing', row: '_', metrics: ['cpu'] }, 28, 8);
    eq(rowKey, '_');
    eq(lines.length, 1);
    assert(lines[0].includes('no data'), `dim message, got ${JSON.stringify(lines[0])}`);
  });

  it('too-short box → the (panel too short) degradation, not a crash', () => {
    const { lines } = stats.renderBody({ topic: 't.cpu', row: '_', metrics: ['cpu'] }, 28, 3);
    eq(lines.length, 1);
    assert(lines[0].includes('too short'), `degrades gracefully, got ${JSON.stringify(lines[0])}`);
  });

  it('render() wraps the SAME body inside its border (delegation contract)', () => {
    // Wide enough that no line overflows innerW (renderPanel would else truncate
    // the header, which legitimately can exceed innerW), so the body appears verbatim.
    const full = stats.panelTypes.stats.render(
      { topic: 't.cpu', row: '_', metrics: ['cpu'], title: 'CPU' }, 60, 10, {}, {});
    const { lines } = stats.renderBody({ topic: 't.cpu', row: '_', metrics: ['cpu'] }, 58, 8);
    assert(full.includes(lines[0]), 'the border-less header line appears verbatim inside render output');
  });
});

describe('[renderBody] stats — overlay mode (multi-series in one grid)', () => {
  setMetric('t.net',
    { _: [{ rx: 10, tx: 90 }, { rx: 40, tx: 60 }, { rx: 80, tx: 20 }] },
    { rx: { type: 'rate' }, tx: { type: 'rate' } });

  it('overlay:true → a coloured legend line + ONE shared grid (not a section per metric)', () => {
    const { lines } = stats.renderBody({ topic: 't.net', row: '_', metrics: ['rx', 'tx'], overlay: true }, 30, 8);
    assert(lines[0].includes('RX') && lines[0].includes('TX'), `legend names both series, got ${JSON.stringify(lines[0])}`);
    assert(lines[0].includes('[accent]') && lines[0].includes('[warning]'), 'legend colours each series distinctly');
    // Non-overlay would emit 2 headers ("RX"/"TX" on their OWN lines) + 2 grids;
    // overlay emits exactly ONE legend then grid rows — so RX/TX appear only in line 0.
    assert(!lines.slice(1).some((l) => l.includes('RX') || l.includes('TX')), 'no per-metric section headers in overlay mode');
  });

  it('the overlaid grid carries BOTH series colour runs (merged traces)', () => {
    const { lines } = stats.renderBody({ topic: 't.net', row: '_', metrics: ['rx', 'tx'], overlay: true }, 30, 8);
    const grid = lines.slice(1).join('');
    assert(grid.includes('[accent]') && grid.includes('[warning]'), 'both series drawn in the one grid');
  });

  it('too short for a legend+grid → graceful degradation', () => {
    const { lines } = stats.renderBody({ topic: 't.net', row: '_', metrics: ['rx', 'tx'], overlay: true }, 30, 2);
    eq(lines.length, 1);
    assert(lines[0].includes('too short'), `degrades, got ${JSON.stringify(lines[0])}`);
  });
});

describe('[renderBody] gauge — display mode vs interactive cursor', () => {
  setMetric('t.proc',
    { a: [{ cpu: 10, comm: 'a' }], b: [{ cpu: 90, comm: 'b' }], c: [{ cpu: 50, comm: 'c' }] },
    { cpu: { type: 'percent' }, comm: { type: 'string' } });
  // slice-shaped spec (what the composite normalizes a widget to).
  const spec = { topic: 't.proc', column: 'cpu', label: 'comm', sortDir: -1, barMax: 10 };

  it('DISPLAY mode (no ctx.sel) → one bar per row, sorted desc, NO highlight', () => {
    const { lines, rowCount } = gauge.renderBody(spec, 30, 5, {});
    eq(rowCount, 3);
    eq(lines.length, 3);
    assert(lines[0].includes('b'), 'sorted desc by cpu → highest (b) first');
    assert(!lines.some(isHighlighted), 'no cursor highlight in display mode');
  });

  it('INTERACTIVE (ctx.sel + focused) → exactly the sel row is highlighted', () => {
    const { lines, sel } = gauge.renderBody(spec, 30, 5, { sel: 0, scroll: 0, focused: true });
    eq(sel, 0);
    assert(isHighlighted(lines[0]), 'sel row highlighted');
    assert(!isHighlighted(lines[1]), 'other rows are not');
  });

  it('DISPLAY mode clips to innerH (top rows that fit)', () => {
    const { lines } = gauge.renderBody(spec, 30, 2, {});
    eq(lines.length, 2);
  });

  it('missing topic → one dim message line, rowCount 0', () => {
    const { lines, rowCount } = gauge.renderBody({ topic: 't.none', column: 'cpu' }, 30, 5, {});
    eq(rowCount, 0);
    eq(lines.length, 1);
  });
});

report();
