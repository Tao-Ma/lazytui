/**
 * Metrics value formatter (js/leaves/metrics/format.js) — the shared compact
 * cell formatter used by the `table` and `gauge` panels. Pure; the inverse of
 * extract.coerce. Pins each schema-type branch so the two panels can't drift.
 *
 * Run: node js/test/test-metrics-format.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const { fmt } = require('../leaves/metrics/format');

describe('[metrics/format] fmt(v, type)', () => {
  it('percent → one decimal + %', () => { eq(fmt(47.2, 'percent'), '47.2%'); eq(fmt(100, 'percent'), '100.0%'); });
  it('bytes → compact K/M/G ladder', () => {
    eq(fmt(512, 'bytes'), '512B');
    eq(fmt(1536, 'bytes'), '2K');            // 1.5K rounds to 2 in the K range (0 decimals)
    eq(fmt(1.5 * 1024 ** 2, 'bytes'), '1.5M');
    eq(fmt(1.5 * 1024 ** 3, 'bytes'), '1.5G');
  });
  it('rate → the bytes ladder with a /s suffix', () => {
    eq(fmt(512, 'rate'), '512B/s');
    eq(fmt(1.5 * 1024 ** 2, 'rate'), '1.5M/s');
  });
  it('number → integer as-is, else one decimal', () => { eq(fmt(128, 'number'), '128'); eq(fmt(3.14159, 'number'), '3.1'); });
  it('string → passthrough, null → empty', () => { eq(fmt('postgres', 'string'), 'postgres'); eq(fmt(null, 'string'), ''); });
  it('non-finite → em dash (any numeric type)', () => { eq(fmt(NaN, 'percent'), '—'); eq(fmt(Infinity, 'bytes'), '—'); eq(fmt(NaN, 'rate'), '—'); });
});

// The two panels re-export the shared fn as `_fmt` — guard they didn't diverge.
describe('[metrics/format] table + gauge share this exact formatter', () => {
  const table = require('../panel/monitor/table');
  const gauge = require('../panel/monitor/gauge');
  it('table._fmt === gauge._fmt === fmt', () => {
    eq(table._fmt === fmt, true, 'table re-exports the shared fmt');
    eq(gauge._fmt === fmt, true, 'gauge re-exports the shared fmt');
  });
});

report();
