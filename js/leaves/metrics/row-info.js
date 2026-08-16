/**
 * Metrics row detail — the pure "expand one row" projection for the viewer's
 * Info tab (docs/metrics-producer.md §9). The row-detail sibling of the compact
 * cell `fmt` (format.js): where the `table`/`gauge` panels show a few columns
 * per row in a tight grid, this shows EVERY non-meta schema column of ONE row,
 * labelled and formatted by type — btop's process-detail popup, generic over any
 * `metrics:` topic.
 *
 *   rowInfo(metric, rowKey) -> string[]   (theme-markup lines)
 *
 * A `table`/`gauge` panel's `getInfo(rowKey, paneId)` resolves the topic's metric
 * (an impure model read in the panel shell) and hands it here; the projection
 * itself is PURE (metric + rowKey in, lines out) — no IO, no clock, no state.
 * The lines carry `[bold]`/`[dim]` markup and `esc()` every value, so a command
 * name containing `[` can't corrupt the render.
 */
'use strict';

const { fmt } = require('./format');
const { esc } = require('../text/ansi');

function _latest(metric, rowKey) {
  const s = metric && metric.series && metric.series[rowKey];
  return (s && s.length) ? s[s.length - 1] : null;
}

// Non-meta schema columns, in definition order (mirror of table/gauge `_columns`
// with no config subset — the detail card is deliberately the "everything" view).
function _cols(metric) {
  const cols = (metric && metric.schema && metric.schema.columns) || {};
  return Object.entries(cols).filter(([, c]) => c && !c.meta);
}

function rowInfo(metric, rowKey) {
  const keyField = (metric && metric.schema && metric.schema.row_key) || null;
  const head = keyField
    ? `[bold]${esc(keyField)} ${esc(String(rowKey))}[/]`
    : `[bold]${esc(String(rowKey))}[/]`;
  const cols = _cols(metric);
  if (!cols.length) return [head];
  const sample = _latest(metric, rowKey);
  // Left-align labels to the widest key so the values form a clean column. The
  // padding rides INSIDE the `[dim]` span (trailing spaces are invisible), so
  // visible width — and thus alignment — is unaffected by the markup.
  const w = Math.max(...cols.map(([k]) => k.length));
  const lines = [head, ''];
  for (const [k, c] of cols) {
    const v = sample ? sample[k] : undefined;
    lines.push(`[dim]${esc(k.padEnd(w))}[/]  ${esc(fmt(v, (c && c.type) || 'number'))}`);
  }
  return lines;
}

module.exports = { rowInfo };
