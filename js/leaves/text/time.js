'use strict';

/**
 * time — shared, pure time/duration formatters.
 *
 * Extracted so the history navigator (js/panel/navigator/history.js) and the
 * action-status stamp (js/leaves/infra/action-status.js) format clocks and
 * durations IDENTICALLY. They previously hand-rolled the two: a byte-identical
 * `HH:MM:SS` clock, and a minutes/seconds ladder that had DRIFTED — history
 * rendered `1m5s` (no zero-pad, no hour tier) while the status chip rendered
 * `1m05s`, so the same command read two different ways across the two panels.
 * A pure leaf both import keeps them in lockstep.
 *
 * PURE (modulo the wall-clock `new Date(ms)` in fmtClock, which is a formatting
 * concern, not I/O). Callers own their own sentinels (running / detached) and
 * clamp negatives before calling.
 */

/** epoch-ms → `14:32:07` (local wall clock). */
function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

/** A non-negative elapsed span in ms → `840ms` / `2.3s` / `3m04s` / `1h04m`.
 *  Sub-tiers are zero-padded so widths stay stable in a list column. */
function fmtDurationMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}s`;
  return `${Math.floor(ms / 3600000)}h${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}m`;
}

module.exports = { fmtClock, fmtDurationMs };
