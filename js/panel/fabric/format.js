/**
 * Shared display formatting for the fabric panes (component-ports + wire-list).
 * Pure, dependency-free — value → a compact one-line cell, and an input's
 * resolution source → its annotation. See docs/ports-and-wires.md P1.5.
 */
'use strict';

/** A port/wire value → a compact one-line display string. Arrays render as
 *  "N lines" (a lines producer), objects as "{N fields}", a multi-line string as
 *  its first line + …, everything else as-is. undefined/null → '' (the caller
 *  shows a placeholder). */
function fmtValue(v) {
  if (v === undefined || v === null) return '';
  if (Array.isArray(v)) return `${v.length.toLocaleString()} line${v.length === 1 ? '' : 's'}`;
  if (typeof v === 'object') { const n = Object.keys(v).length; return `{${n} field${n === 1 ? '' : 's'}}`; }
  const s = String(v);
  const nl = s.indexOf('\n');
  return nl >= 0 ? `${s.slice(0, nl)} …` : s;
}

/** An input row's resolution source → its annotation (wire shows the producer). */
function sourceLabel(row) {
  switch (row.source) {
    case 'inject':  return '(inject)';
    case 'wire':    return row.wireFrom ? `← ${row.wireFrom}` : '← wire';
    case 'default': return 'default';
    default:        return '(unset)';
  }
}

module.exports = { fmtValue, sourceLabel };
