/**
 * metrics/extract — the pure metrics extractor + scalar coercion
 * (docs/metrics-producer.md §6). Pins regex + columns modes, coercion by
 * schema column type, and the never-throw degradation (bad pattern / mis-parse
 * → NaN, which the stats panel renders as '—'). No spawning — pure over the
 * captured-stdout string.
 *
 * Run: node js/test/test-metrics-extract.js
 */
'use strict';

const { describe, it, eq, assert, report } = require('./test-runner');
const { extract, coerce, parseBytes, parsePercent, parseNumber } = require('../leaves/metrics/extract');

const isNaNv = (x) => typeof x === 'number' && Number.isNaN(x);

describe('[extract] coerce — by schema column type', () => {
  it('percent strips % and parses', () => { eq(coerce('47.2%', 'percent'), 47.2); eq(coerce('12', 'percent'), 12); });
  it('bytes parses human sizes (binary for *iB and bare K/M/G)', () => {
    eq(coerce('1.2GiB', 'bytes'), 1.2 * 1024 ** 3);
    eq(coerce('512MiB', 'bytes'), 512 * 1024 ** 2);
    eq(coerce('1024', 'bytes'), 1024);           // bare number = bytes
    eq(coerce('2G', 'bytes'), 2 * 1024 ** 3);    // docker MemUsage style → binary
    eq(coerce('500MB', 'bytes'), 500 * 1e6);     // explicit decimal
  });
  it('number parses a float', () => { eq(coerce('128', 'number'), 128); eq(coerce('3.14', 'number'), 3.14); });
  it('string passes through trimmed', () => { eq(coerce('  postgres ', 'string'), 'postgres'); });
  it('unknown/advisory type (rate) falls through to numeric', () => { eq(coerce('42', 'rate'), 42); });
  it('mis-parse yields NaN, never throws', () => {
    assert(isNaNv(coerce('n/a', 'percent')));
    assert(isNaNv(coerce('lots', 'bytes')));
    assert(isNaNv(coerce(null, 'number')));
  });
});

describe('[extract] parseBytes edge cases', () => {
  it('handles unit case-insensitively + whitespace', () => { eq(parseBytes('1.5 GiB'), 1.5 * 1024 ** 3); eq(parseBytes('10kib'), 10 * 1024); });
  it('bare value is bytes', () => { eq(parseBytes('4096'), 4096); });
  it('garbage → NaN', () => { assert(isNaNv(parseBytes('—'))); assert(isNaNv(parseBytes(null))); });
});

describe('[extract] regex mode — single stream', () => {
  const cols = { cpu: { type: 'percent' }, load: { type: 'number' } };
  it('captures group 1 and keys the row "_"', () => {
    const out = extract('%Cpu(s): 47.2 us,  2.0 sy', { mode: 'regex', fields: { cpu: '([0-9.]+)\\s+us' } }, cols);
    eq(out.length, 1);
    eq(out[0].rowKey, '_');
    eq(out[0].sample.cpu, 47.2);
  });
  it('mode defaults to regex when omitted', () => {
    const out = extract('load 0.83', { fields: { load: 'load ([0-9.]+)' } }, cols);
    eq(out[0].sample.load, 0.83);
  });
  it('multiple fields, each its own pattern', () => {
    const out = extract('cpu=91 mem=57', { mode: 'regex', fields: { cpu: 'cpu=([0-9]+)', mem: 'mem=([0-9]+)' } }, { cpu: { type: 'percent' }, mem: { type: 'percent' } });
    eq(out[0].sample.cpu, 91); eq(out[0].sample.mem, 57);
  });
  it('^ anchors per-line (multiline default)', () => {
    const out = extract('header\nMemTotal:  16384 kB', { fields: { mt: '^MemTotal:\\s+([0-9]+)' } }, { mt: { type: 'number' } });
    eq(out[0].sample.mt, 16384);
  });
  it('no match → NaN (renders as —), never throws', () => {
    const out = extract('nothing here', { fields: { cpu: 'cpu=([0-9]+)' } }, cols);
    assert(isNaNv(out[0].sample.cpu));
  });
  it('invalid regex → NaN, never throws', () => {
    const out = extract('x', { fields: { cpu: '([0-9' } }, cols);
    assert(isNaNv(out[0].sample.cpu));
  });
});

describe('[extract] columns mode — multi-row', () => {
  const psCols = { pid: { type: 'number' }, cpu: { type: 'percent' }, rss: { type: 'bytes' }, comm: { type: 'string' } };
  const spec = { mode: 'columns', row_key: 'pid', fields: { pid: 0, cpu: 1, rss: 2, comm: 3 } };
  const out = '811 22.0 1258291 postgres\n902 4.5 65536 redis\n';
  it('one row per line, keyed by row_key column (raw string)', () => {
    const rows = extract(out, spec, psCols);
    eq(rows.length, 2);
    eq(rows[0].rowKey, '811');
    eq(rows[1].rowKey, '902');
  });
  it('coerces each field by its schema type', () => {
    const rows = extract(out, spec, psCols);
    eq(rows[0].sample.cpu, 22.0);
    eq(rows[0].sample.rss, 1258291);       // bare number = bytes
    eq(rows[0].sample.comm, 'postgres');   // string passthrough
    eq(rows[1].sample.comm, 'redis');
  });
  it('whitespace split collapses runs of spaces', () => {
    const rows = extract('  811     22.0   1258291   pg  ', spec, psCols);
    eq(rows[0].rowKey, '811'); eq(rows[0].sample.cpu, 22.0);
  });
  it('skip drops leading header lines', () => {
    const withHeader = 'PID CPU RSS COMM\n' + out;
    const rows = extract(withHeader, { ...spec, skip: 1 }, psCols);
    eq(rows.length, 2); eq(rows[0].rowKey, '811');
  });
  it('tab delimiter', () => {
    const rows = extract('a\t10\nb\t20\n', { mode: 'columns', delimiter: 'tab', row_key: 'k', fields: { k: 0, v: 1 } }, { v: { type: 'number' } });
    eq(rows.length, 2); eq(rows[0].rowKey, 'a'); eq(rows[1].sample.v, 20);
  });
  it('literal delimiter (comma)', () => {
    const rows = extract('x,5\ny,6\n', { mode: 'columns', delimiter: ',', row_key: 'k', fields: { k: 0, v: 1 } }, { v: { type: 'number' } });
    eq(rows[0].rowKey, 'x'); eq(rows[1].sample.v, 6);
  });
  it('line with an empty row_key column is skipped', () => {
    const rows = extract('811 22.0 100 pg\n  4.5 200 redis\n', spec, psCols);
    // second line: leading spaces collapse so col0 is '4.5' (a valid key) — build an explicit empty-key case instead:
    const rows2 = extract('a,1\n,2\nb,3\n', { mode: 'columns', delimiter: ',', row_key: 'k', fields: { k: 0, v: 1 } }, { v: { type: 'number' } });
    eq(rows2.map(r => r.rowKey), ['a', 'b']);   // the ',2' line (empty key) dropped
    assert(rows.length === 2);
  });
  it('no row_key → single stream (all rows keyed "_")', () => {
    const rows = extract('42\n', { mode: 'columns', fields: { v: 0 } }, { v: { type: 'number' } });
    eq(rows[0].rowKey, '_'); eq(rows[0].sample.v, 42);
  });
});

describe('[extract] empty / guard inputs', () => {
  it('empty stdout → []', () => { eq(extract('', { mode: 'regex', fields: { a: 'x' } }, {}), []); });
  it('null stdout → []', () => { eq(extract(null, { mode: 'regex', fields: { a: 'x' } }, {}), []); });
  it('no spec → []', () => { eq(extract('data', null, {}), []); });
  it('missing schema columns default field type to number', () => {
    const out = extract('v=7', { fields: { v: 'v=([0-9]+)' } }, undefined);
    eq(out[0].sample.v, 7);
  });
});

// Review 2026-08-15 — hardening against silent-wrong-number + delimiter trim.
describe('[extract] hardening', () => {
  it('grouped/space-separated numbers yield NaN, not a truncated value', () => {
    assert(isNaNv(coerce('1,258,291', 'bytes')), 'bytes: 1,258,291 → NaN (was silently 1)');
    assert(isNaNv(coerce('1,024', 'number')), 'number: 1,024 → NaN (was silently 1)');
    assert(isNaNv(parseNumber('1 234')), 'space-separated → NaN');
    assert(isNaNv(parseBytes('1,258,291')));
  });
  it('clean values still parse after the end-anchor', () => {
    eq(parseBytes('1258291'), 1258291);
    eq(parseBytes('1.2GiB'), 1.2 * 1024 ** 3);
    eq(parseNumber('47.2'), 47.2);
    eq(parseNumber('-5'), -5);
    eq(parseNumber('.5'), 0.5);
  });
  it('tab-delimited leading empty column is not eaten by a whole-line trim', () => {
    // "\t20": col0 is empty. As the row_key → the row is skipped (no identity).
    const asKey = extract('\t20\n', { mode: 'columns', delimiter: 'tab', row_key: 'k', fields: { k: 0, v: 1 } }, { v: { type: 'number' } });
    eq(asKey.length, 0, 'empty row_key column → row skipped, not left-shifted');
    // Not the row_key → col0 stays '', col1 stays 20 (no column shift).
    const notKey = extract('\t20\n', { mode: 'columns', delimiter: 'tab', fields: { a: 0, b: 1 } }, { a: { type: 'string' }, b: { type: 'number' } });
    eq(notKey[0].sample.a, '');
    eq(notKey[0].sample.b, 20);
  });
  it('CRLF line endings tolerated (trailing \\r stripped)', () => {
    const rows = extract('a,5\r\nb,6\r\n', { mode: 'columns', delimiter: ',', row_key: 'k', fields: { k: 0, v: 1 } }, { v: { type: 'number' } });
    eq(rows.map(r => r.rowKey), ['a', 'b']);
    eq(rows[1].sample.v, 6);
  });
});

report();
