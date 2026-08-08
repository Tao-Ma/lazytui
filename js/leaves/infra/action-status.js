/**
 * action-status — pure derivation of the powerline-style action-status line: a
 * right-aligned "command status" stamp shown at the end of a text-view output
 * pane. Two forms, one formatter:
 *
 *   - while running — a LIVE line derived at render (spinner + ticking
 *     duration), floated at the end of the output and pushed down by new
 *     output. Ephemeral (not stored); re-derived each frame from the frame
 *     clock (`model.now`, ticked while a stream job runs — see app/state.js).
 *   - on completion — a PERMANENT line appended to the buffer by
 *     dispatch/runtime/stream.js (`✓ Done` / `✗ Exit N` / `⊗ Killed` + duration
 *     + finish time), one per command, so a newer run never overwrites an
 *     older one. It replaces the classic plain `Done.`/`Exit N` footer.
 *
 * PURE: `(outcome, now, cfg, tags) → Rich-markup string`. The caller resolves
 * the outcome (from the feature/jobs mirror while running, or the exit
 * code/signal + history record on completion), the frame clock, the config
 * (`model.config.action_status`) and the theme color tags. No model / io /
 * theme reads here, so it is trivially testable and replay-safe. Right-
 * alignment is the caller's job (it depends on the live pane width).
 *
 * Config (global `action_status:`, docs/global-config.md):
 *   enabled   master on/off (default true; `action_status: false` also disables)
 *   segments  which fields + their left→right order; subset of
 *             ['status','duration','time'] (default = all three). The status
 *             glyph is always shown regardless (see statusLine); `segments`
 *             chooses the extras (duration/time) and the order.
 *   live      arm the 1s frame clock so the running line ticks (default true)
 */
'use strict';

const VALID_SEGMENTS = new Set(['status', 'duration', 'time']);
const DEFAULT_SEGMENTS = ['status', 'duration', 'time'];
// Braille spinner — the running indicator. Advances by wall-elapsed so it
// animates smoothly under streaming renders and still visibly turns on the 1s
// frame-clock cadence when a run produces no output.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Normalize the raw config value into a resolved shape with defaults applied.
 *  Tolerant: a missing / non-object value → default-on; `false` → disabled;
 *  unknown segment tokens are dropped (the schema validator already warns). */
function resolveConfig(cfg) {
  if (cfg === false) return { enabled: false, segments: [], live: false };
  if (cfg === true || cfg == null || typeof cfg !== 'object') {
    return { enabled: true, segments: DEFAULT_SEGMENTS.slice(), live: true };
  }
  const enabled = cfg.enabled !== false;
  const segments = Array.isArray(cfg.segments)
    ? cfg.segments.filter((s) => VALID_SEGMENTS.has(s))
    : DEFAULT_SEGMENTS.slice();
  const live = cfg.live !== false;
  return { enabled, segments, live };
}

/** The most-recent job whose output this text-view instance holds, or null.
 *  Routed action tabs match on `owner.tabInstId`; the Transcript (the singleton
 *  unrouted sink) matches the most-recent `stream-unrouted` job. `jobs` is the
 *  feature/jobs snapshot (newest-first), so the first match is the latest. */
function jobForPane(jobs, instId, isTranscript) {
  if (!Array.isArray(jobs)) return null;
  for (const j of jobs) {
    if (isTranscript) {
      if (j.kind === 'stream-unrouted') return j;
    } else if (instId && j.owner && j.owner.tabInstId === instId) {
      return j;
    }
  }
  return null;
}

/** `ref - startedAt` → `840ms` / `2.3s` / `3m04s`. `ref` is endedAt for a
 *  finished job, else the frame clock (`now`), else startedAt (0). */
function fmtDuration(startedAt, endedAt, now) {
  const ref = endedAt != null ? endedAt : (now != null ? now : startedAt);
  const ms = Math.max(0, ref - startedAt);
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}s`;
  return `${Math.floor(ms / 3600000)}h${String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')}m`;
}

/** epoch-ms → `14:32:07` (local clock, mirror of history.js fmtTime). */
function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function _spinner(now, startedAt) {
  const elapsed = Math.max(0, (now != null ? now : startedAt) - startedAt);
  return SPINNER[Math.floor(elapsed / 125) % SPINNER.length];
}

/** The status chip: spinner (running) · ✓ (exit 0) · ✗ N (non-zero, with the
 *  code) · ⊗ SIG (killed, with the signal). `o` = { status, exitCode, signal,
 *  startedAt }. */
function _statusChip(o, now, tags) {
  if (o.status === 'running') return `[${tags.warning}]${_spinner(now, o.startedAt)}[/]`;
  if (o.status === 'killed') return `[${tags.warning}]⊗${o.signal ? ` ${o.signal}` : ''}[/]`;
  if (o.exitCode === 0) return `[${tags.success}]✓[/]`;
  return `[${tags.error}]✗ ${o.exitCode == null ? '?' : o.exitCode}[/]`;
}

/** Compose the status line for `outcome` as Rich markup, or '' when disabled /
 *  no segments. `outcome` = { status: 'running'|'exited'|'killed', exitCode?,
 *  signal?, startedAt, endedAt? }. Segments render in config order, joined by
 *  ` · `; `time` is omitted while running (no finish time yet). The caller
 *  right-aligns the result to the pane width. */
function statusLine(outcome, now, cfg, tags) {
  if (!outcome) return '';
  const conf = resolveConfig(cfg);
  if (!conf.enabled) return '';
  const running = outcome.status === 'running';
  // The status glyph is the identity of the line — ALWAYS shown, so a failed
  // command is never silent and a running action always has a live cue, even
  // when the user's `segments` omits 'status' (or is empty). `segments`
  // otherwise controls which extra fields (duration, time) appear and in what
  // order relative to the glyph.
  const segs = conf.segments.includes('status') ? conf.segments : ['status', ...conf.segments];
  const parts = [];
  for (const seg of segs) {
    if (seg === 'status') {
      parts.push(_statusChip(outcome, now, tags));
    } else if (seg === 'duration') {
      parts.push(`[dim]${fmtDuration(outcome.startedAt, running ? null : outcome.endedAt, now)}[/]`);
    } else if (seg === 'time') {
      if (!running && outcome.endedAt != null) parts.push(`[dim]${fmtClock(outcome.endedAt)}[/]`);
    }
  }
  return parts.join(' · ');
}

module.exports = { resolveConfig, jobForPane, statusLine };
