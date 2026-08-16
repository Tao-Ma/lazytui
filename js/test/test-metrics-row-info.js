/**
 * Metrics row detail (js/leaves/metrics/row-info.js) — the pure "expand one row"
 * projection the `table`/`gauge` panels' getInfo hands to the viewer's Info tab.
 * Pins the card shape: header from the row_key field, every non-meta schema
 * column formatted by type (shared fmt), meta columns skipped, markup escaped,
 * and a missing sample degrading to em-dash / empty (never throwing).
 *
 * Run: node js/test/test-metrics-row-info.js
 */
'use strict';

const { describe, it, eq, report } = require('./test-runner');
const { rowInfo } = require('../leaves/metrics/row-info');

// A process-like topic: percent / bytes / number / string columns + one meta col.
function metric(sample) {
  return {
    schema: {
      row_key: 'pid',
      columns: {
        cpu: { type: 'percent' },
        rss: { type: 'bytes' },
        threads: { type: 'number' },
        user: { type: 'string' },
        hidden: { type: 'number', meta: true },   // meta → never shown
      },
    },
    series: sample ? { '240': [sample] } : { '240': [] },
  };
}

describe('[metrics/row-info] rowInfo(metric, rowKey)', () => {
  it('header = row_key field + value, bold', () => {
    const lines = rowInfo(metric({ cpu: 50, rss: 1048576, threads: 9, user: 'root' }), '240');
    eq(lines[0], '[bold]pid 240[/]');
    eq(lines[1], '');   // blank spacer under the header
  });

  it('one line per NON-meta schema column, in definition order, formatted by type', () => {
    const lines = rowInfo(metric({ cpu: 50, rss: 1048576, threads: 9, user: 'root' }), '240').slice(2);
    // Labels padded to the widest key ('threads' = 7) INSIDE the dim span.
    eq(lines[0], '[dim]cpu    [/]  50.0%');
    eq(lines[1], '[dim]rss    [/]  1.0M');
    eq(lines[2], '[dim]threads[/]  9');
    eq(lines[3], '[dim]user   [/]  root');
    eq(lines.length, 4, 'the meta column is skipped');
  });

  it('missing sample → numeric em-dash, string empty (no throw)', () => {
    const lines = rowInfo(metric(null), '240').slice(2);
    eq(lines[0], '[dim]cpu    [/]  —');
    eq(lines[1], '[dim]rss    [/]  —');
    eq(lines[2], '[dim]threads[/]  —');
    eq(lines[3], '[dim]user   [/]  ');
  });

  it('escapes markup metachars in a string value', () => {
    const lines = rowInfo(metric({ cpu: 1, rss: 0, threads: 1, user: 'a[b]c' }), '240').slice(2);
    eq(lines[3], '[dim]user   [/]  a\\[b]c');
  });

  it('no schema columns → header only', () => {
    const m = { schema: { row_key: 'iface' }, series: { eth0: [{}] } };
    eq(rowInfo(m, 'eth0'), ['[bold]iface eth0[/]']);
  });

  it('no row_key field (single-stream) → bare bold key', () => {
    const m = { schema: { columns: { cpu: { type: 'percent' } } }, series: { _: [{ cpu: 12 }] } };
    const lines = rowInfo(m, '_');
    eq(lines[0], '[bold]_[/]');
    eq(lines[2], '[dim]cpu[/]  12.0%');
  });
});

report();
