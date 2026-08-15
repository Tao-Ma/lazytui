/**
 * Metrics value formatter — the pure display half of the `metrics:` consumers
 * (docs/metrics-producer.md §9). The COMPACT, width-constrained style used by
 * the `table` and `gauge` panels for cells / bar labels:
 *
 *   fmt(value, schemaType) -> string
 *
 * The inverse of the extractor's `coerce(raw, type)` (extract.js) — same schema
 * column types (`percent` / `bytes` / `rate` / `number` / `string`), one shared
 * home so the two panels can't drift. PURE: no IO, no clock, no state.
 *
 * NOTE the compact `K`/`M`/`G` (0–1 decimals) is deliberately DISTINCT from the
 * stats panel's IEC `KiB`/`MiB`/`GiB` axis-label style (`stats._fmtBytes`): a
 * tight table cell / bar label vs. a graph axis annotation. Keep them separate.
 */
'use strict';

// `rate` is a per-second byte rate (a producer's `counter` derivation); `bytes`
// is an absolute size. Both use the same compact ladder, `rate` adds `/s`.
function fmt(v, type) {
  if (type === 'string') return v == null ? '' : String(v);
  if (!Number.isFinite(v)) return '—';
  if (type === 'percent') return `${v.toFixed(1)}%`;
  if (type === 'bytes' || type === 'rate') {
    const suf = type === 'rate' ? '/s' : '';
    if (v < 1024) return `${Math.round(v)}B${suf}`;
    if (v < 1024 ** 2) return `${(v / 1024).toFixed(0)}K${suf}`;
    if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)}M${suf}`;
    return `${(v / 1024 ** 3).toFixed(1)}G${suf}`;
  }
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

module.exports = { fmt };
