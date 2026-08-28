/**
 * Time-axis labels (docs/STATS.md §1, §10) — the horizontal twin of the y-axis gutter.
 * Reserves ONE bottom row for span labels derived PURELY from the sample `ts` the
 * metrics-poll producer stamps. Four layers:
 *   1. `_timeAxisRows` truth table — the shared 0/1 reserve decision (off / auto min-height
 *      / always floor / needs `ts` / mode:multi + composite excluded).
 *   2. Paint — renderBody appends the label row LAST (`-<span>` … `now`), and the graph
 *      shrinks by exactly the reserved row.
 *   3. `_timeAxisRow` builder — live (now-anchored) vs frozen (range DURATION), and the
 *      y-axis gutter offset keeps the labels under the trace.
 *   4. The offset guard — with the row reserved, a hover on it resolves NOTHING while the
 *      graph rows still map to their samples (paint ↔ hit-test agree on the reduced height).
 *
 * Run: node js/test/test-stats-xaxis.js
 */
'use strict';

const { describe, it, assert, eq, report } = require('./test-runner');
const { getModel } = require('../app/runtime');
const api = require('../panel/api');
// Register layout first so a paneId'd spec's `_zoomFrozen` read (getInstanceSlice) is clean.
if (!api.getComponent('layout')) api.registerComponent(require('../panel/layout'));
if (!api.getComponent('stats')) api.registerComponent(require('../panel/monitor/stats'));
const stats = require('../panel/monitor/stats');

const BASE = 1_700_000_000_000;   // fixed epoch so span math is deterministic (no wall-clock read)
const STEP = 2000;                // 2 s between samples → a knowable span

function setMetric(topic, series, cols) {
  getModel().metrics = { ...(getModel().metrics || {}), [topic]: { series, schema: { columns: cols } } };
}
// 300 monotone CPU samples, each stamped `ts` STEP ms apart (oldest first). Span across the
// window = 299 * STEP = 598000 ms = 9m58s; half = 299000 ms = 4m59s.
function seedTs(topic = 'x.cpu') {
  setMetric(topic, { _: Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 100, ts: BASE + i * STEP })) }, { cpu: { type: 'percent' } });
}
// Same series with NO `ts` — a topic fed some other way; the time-axis has nothing to label.
function seedNoTs(topic = 'x.nots') {
  setMetric(topic, { _: Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 100 })) }, { cpu: { type: 'percent' } });
}
const SPAN = '9m58s';   // fmtDurationMs(299 * 2000)
const HALF = '4m59s';   // fmtDurationMs(299 * 1000)

describe('[stats-xaxis] _timeAxisRows — the shared 0/1 reserve decision', () => {
  const spec = (mode, over = {}) => ({ paneId: 'x1', topic: 'x.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: 'off', x_axis: mode, ...over });

  it('off never reserves; a tall auto/always pane reserves one row', () => {
    seedTs();
    eq(stats._timeAxisRows(spec('off'), 60, 8), 0, 'off → 0');
    eq(stats._timeAxisRows(spec('auto'), 60, 8), 1, 'auto (tall + wide + ts) → 1');
    eq(stats._timeAxisRows(spec('always'), 60, 8), 1, 'always → 1');
    eq(stats._timeAxisRows(spec(undefined), 60, 8), 1, 'missing mode → auto → 1 when it fits');
  });

  it('auto needs the min height; always drops that gate but keeps the graph floor', () => {
    seedTs();
    eq(stats._timeAxisRows(spec('auto'), 60, 5), 0, 'auto on a short (5-row) pane → keep full-height graph');
    eq(stats._timeAxisRows(spec('always'), 60, 5), 1, 'always still reserves on a short-but-usable pane');
    eq(stats._timeAxisRows(spec('always'), 60, 3), 0, 'always hides when reserving would starve the graph (<2 rows)');
  });

  it('a too-narrow pane never reserves (no room for two end labels)', () => {
    seedTs();
    eq(stats._timeAxisRows(spec('always'), 10, 8), 0, 'width < min → 0');
  });

  it('no `ts` in the data → no time-axis (nothing to label), even on always', () => {
    seedNoTs();
    const s = { paneId: 'x1', topic: 'x.nots', row: '_', metrics: ['cpu'], window: 300, y_axis: 'off', x_axis: 'always' };
    eq(stats._hasSampleTs('x.nots'), false, 'probe: no ts');
    eq(stats._timeAxisRows(s, 60, 8), 0, 'always but no ts → 0');
  });

  it('mode:multi and composite widgets (no paneId) are excluded outright', () => {
    seedTs();
    eq(stats._timeAxisRows(spec('always', { mode: 'multi' }), 60, 8), 0, 'mode:multi → 0');
    eq(stats._timeAxisRows(spec('always', { paneId: undefined }), 60, 8), 0, 'composite widget (no paneId) → 0');
  });
});

describe('[stats-xaxis] paint — the label row is appended last; the graph shrinks by it', () => {
  const spec = (mode) => ({ paneId: 'x1', topic: 'x.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: 'off', x_axis: mode });

  it('always draws `-<span> … now` on the LAST row; off draws none', () => {
    seedTs();
    const on = stats.renderBody(spec('always'), 60, 8, -1, null).lines;
    const off = stats.renderBody(spec('off'), 60, 8, -1, null).lines;
    const last = on[on.length - 1];
    assert(last.includes('now') && last.includes(`-${SPAN}`), `axis row shows the span + now (${JSON.stringify(last)})`);
    assert(last.includes(`-${HALF}`), 'a centred mid tick appears on a wide trace');
    assert(!off.some((l) => l.includes('now')), 'x_axis off draws no time-axis row');
  });

  it('the label row STEALS exactly one graph row (same total height)', () => {
    seedTs();
    const on = stats.renderBody(spec('always'), 60, 8, -1, null).lines;
    const off = stats.renderBody(spec('off'), 60, 8, -1, null).lines;
    eq(on.length, off.length, 'both panes fill innerH');
    // Bottom row: a graph glyph row when off, the label row when on.
    assert(!off[off.length - 1].includes('now'), 'off: bottom row is a graph row');
    assert(on[on.length - 1].includes('now'), 'on: bottom row is the label row');
    // The label row width equals innerW (labels padded across the trace).
    eq(api.visibleLen(on[on.length - 1]), 60, 'label row spans the full inner width');
  });
});

describe('[stats-xaxis] _timeAxisRow builder — live vs frozen; gutter offset', () => {
  const samples = Array.from({ length: 300 }, (_x, i) => ({ cpu: i % 100, ts: BASE + i * STEP }));

  it('live labels the span on the left and `now` on the right', () => {
    const row = stats._timeAxisRow(samples, 0, 60, false, 'dim');
    assert(row.includes(`-${SPAN}`) && row.includes('now'), 'live → -span … now');
    assert(!row.includes('‹'), 'live has no frozen-duration bracket');
  });

  it('frozen shows the range DURATION (not now) — the right edge is in the past', () => {
    const row = stats._timeAxisRow(samples, 0, 60, true, 'dim');
    assert(row.includes('‹') && row.includes(SPAN), `frozen → ‹ span › (${JSON.stringify(row)})`);
    assert(!row.includes('now'), 'frozen drops the now anchor');
  });

  it('a trace too narrow degrades gracefully — no mid-glyph garble', () => {
    // effW = innerW - gutter. Force a tiny trace: the live path suppresses the span label
    // (keeps `now`), the frozen path drops the duration whole. Neither writes a partial glyph.
    const live = stats._timeAxisRow(samples, 54, 60, false, 'dim');   // effW 6
    assert(live.includes('now') && !live.includes(SPAN), 'narrow live: keep now, drop the span (no overlap)');
    const froz = stats._timeAxisRow(samples, 54, 60, true, 'dim');    // effW 6 < `‹ 9m58s ›`
    assert(!froz.includes('‹') && !froz.includes(SPAN), 'narrow frozen: drop the duration whole');
    eq(api.visibleLen(froz), 60, 'row still spans the full width (blank trace region)');
  });

  it('the y-axis gutter blanks the left so labels sit under the trace', () => {
    const G = 6;   // percent gutter
    const row = stats._timeAxisRow(samples, G, 60, false, 'dim');
    // Strip the [dim]…[/] wrapper → the first G visible cells are blank (the gutter).
    const inner = row.replace(/^\[[^\]]*\]/, '').replace(/\[\/\]$/, '');
    eq(inner.slice(0, G), ' '.repeat(G), 'the gutter columns are blank');
    assert(inner.includes(`-${SPAN}`) && inner.includes('now'), 'labels still present in the trace region');
    eq(api.visibleLen(row), 60, 'row still spans the full inner width');
  });
});

describe('[stats-xaxis] offset guard — the reserved row carries no value; graph rows do', () => {
  const spec = { paneId: 'x1', topic: 'x.cpu', row: '_', metrics: ['cpu'], window: 300, y_axis: 'off', x_axis: 'always' };

  it('a hover on the reserved bottom row resolves nothing', () => {
    seedTs();
    eq(stats.valueAt(spec, 60, 8, 30, 7), null, 'row 7 (the label row, gH=7) → null');
  });

  it('the graph rows still map to their samples (reduced-height walk agrees with paint)', () => {
    seedTs();
    const v = stats.valueAt(spec, 60, 8, 30, 4);   // a graph row (header 0, meter 1, graph 2..6)
    assert(v && v.metric === 'cpu' && Number.isFinite(v.value), `graph row resolves cpu (${JSON.stringify(v)})`);
    // Rightmost trace col = newest sample; monotone series so it's the max end.
    const right = stats.valueAt(spec, 60, 8, 59, 4).value;
    const left = stats.valueAt(spec, 60, 8, 0, 4).value;
    assert(right > left, `trace ascends left→right over the reduced-height graph (${left} → ${right})`);
  });

  it('turning the axis OFF restores the taller graph (one more graph row addressable)', () => {
    seedTs();
    const off = { ...spec, x_axis: 'off' };
    // With the axis off, gH = innerH = 8, so the bottom-most graph row (row 7) now resolves.
    assert(stats.valueAt(off, 60, 8, 30, 7), 'off: row 7 is a graph row and resolves');
    eq(stats.valueAt(spec, 60, 8, 30, 7), null, 'always: row 7 is the reserved label row → null');
  });
});

report();
