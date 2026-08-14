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
 *     dispatch/runtime/stream.js (`✓ · dur · time` / `✗ N` / `⊗ SIG`), one per
 *     command, so a newer run never overwrites an older one. It replaces the
 *     classic plain `Done.`/`Exit N` footer (which is the DISABLED-chip fallback
 *     — the "Done"/"Exit N"/"Killed" words live there, never in the chip).
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

// Shared pure formatters (a sibling leaf — no model/io/theme, so purity holds).
// The clock + duration ladder are shared with the history navigator so the two
// panels never drift (they once rendered `1m5s` vs `1m05s` for the same run).
const { fmtClock, fmtDurationMs } = require('./time');
const { visibleLen } = require('./ansi');

const VALID_SEGMENTS = new Set(['status', 'duration', 'time']);
const DEFAULT_SEGMENTS = ['status', 'duration', 'time'];
// Braille spinner — the running indicator. Indexed by elapsed since startedAt
// (`now - startedAt`, in 125ms steps). `now` is the frame clock (model.now),
// which advances on the 1s clock tick while a run is live — so the spinner turns
// about once per second, NOT per output chunk (a render driven by streamed
// output reuses the same model.now; a per-render wall-clock read would break
// purity/replay).
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Normalize the raw config value into a resolved shape with defaults applied.
 *  Tolerant: a missing / non-object value → default-on; `false` → disabled;
 *  unknown segment tokens are dropped here as a defensive belt-and-suspenders —
 *  the schema validator already REJECTS them at load (throwing, which degrades
 *  the global config to project-only), so a validated value never reaches this. */
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

/** Elapsed → `840ms` / `2.3s` / `3m04s` (shared ladder). `ref` is endedAt for a
 *  finished job, else the frame clock (`now`), else startedAt (0). */
function fmtDuration(startedAt, endedAt, now) {
  const ref = endedAt != null ? endedAt : (now != null ? now : startedAt);
  return fmtDurationMs(Math.max(0, ref - startedAt));
}

function _spinner(now, startedAt) {
  const elapsed = Math.max(0, (now != null ? now : startedAt) - startedAt);
  return SPINNER[Math.floor(elapsed / 125) % SPINNER.length];
}

/** The status chip: spinner (running) · ✓ 0 (exit 0) · ✗ N (non-zero, with the
 *  code) · ⊗ SIG (killed, with the signal). `o` = { status, exitCode, signal,
 *  startedAt }. Uses SEMANTIC theme tokens ([warning]/[success]/[error]) so a
 *  STORED chip line tracks :theme at paint (ansi._expandThemeKeys) — no baked
 *  color, no caller-passed palette. */
function _statusChip(o, now) {
  if (o.status === 'running') return `[warning]${_spinner(now, o.startedAt)}[/]`;
  if (o.status === 'killed') return `[warning]⊗${o.signal ? ` ${o.signal}` : ''}[/]`;
  if (o.exitCode === 0) return '[success]✓ 0[/]';   // exit value shown for success too
  return `[error]✗ ${o.exitCode == null ? '?' : o.exitCode}[/]`;
}

/** Compose the status line for `outcome` as Rich markup, or '' when disabled /
 *  no segments. `outcome` = { status: 'running'|'exited'|'killed', exitCode?,
 *  signal?, startedAt, endedAt? }. Segments render in config order, joined by
 *  ` · `; `time` is omitted while running (no finish time yet). The caller
 *  right-aligns the result to the pane width. */
function statusLine(outcome, now, cfg) {
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
      parts.push(_statusChip(outcome, now));
    } else if (seg === 'duration') {
      parts.push(`[dim]${fmtDuration(outcome.startedAt, running ? null : outcome.endedAt, now)}[/]`);
    } else if (seg === 'time') {
      if (!running && outcome.endedAt != null) parts.push(`[dim]${fmtClock(outcome.endedAt)}[/]`);
    }
  }
  return parts.join(' · ');
}

// The clickable cancel affordance on the LIVE running chip: `✗ cancel` (the ✗
// red, `cancel` dim). Its visible width; the hit-test (chrome-hittest.js) maps a
// click on the rightmost CANCEL_W content cols of the chip's row to killJob. The
// ` · ` separator is drawn but is NOT part of the clickable span.
const CANCEL_W = 8;   // visibleLen('✗ cancel') = ✗(1) + ' '(1) + 'cancel'(6)

/**
 * Compose the LIVE running chip WITH the trailing clickable cancel affordance,
 * right-aligned to `innerW`. Returns `{ line, cancelX0, cancelX1 }` — the display
 * string plus the cancel span in pane-local content columns [0..innerW) — or null
 * when there's no live chip. `cancelX0 === -1` means the ✗ cancel didn't fit, so
 * the chip is shown WITHOUT it (too-narrow pane) and there is nothing to click.
 *
 * This is the SINGLE source both the renderer (uses `.line`) and the hit-test
 * (uses `.cancelX0/.cancelX1`) read, so a click can never land where the
 * affordance didn't draw (the border-controls `regions()` discipline). Pure.
 */
function runningChip(outcome, now, cfg, innerW) {
  if (!outcome || outcome.status !== 'running') return null;   // cancel affordance is running-only
  const seg = statusLine(outcome, now, cfg);
  if (!seg) return null;
  const withCancel = `${seg} · [error]✗[/] [dim]cancel[/]`;
  const wcw = visibleLen(withCancel);
  if (wcw <= innerW) {
    return { line: ' '.repeat(innerW - wcw) + withCancel, cancelX0: innerW - CANCEL_W, cancelX1: innerW - 1 };
  }
  // The affordance doesn't fit — draw the status alone (no cancel), never truncate
  // the ✗ cancel to a dead half-target.
  const sv = visibleLen(seg);
  return { line: sv >= innerW ? seg : ' '.repeat(innerW - sv) + seg, cancelX0: -1, cancelX1: -1 };
}

module.exports = { resolveConfig, jobForPane, statusLine, runningChip };
