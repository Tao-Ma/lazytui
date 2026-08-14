/**
 * text-view — a scrollable text buffer as a first-class pane type (U2b/U2c,
 * docs/one-tab-system.md). Minted into a slot's `tabs[]` at runtime (the
 * mint-into-slot primitive); its content is a line buffer seeded from the pool
 * entry's `config.lines`. Rendering delegates to the pure `leaves/text-view`
 * render primitive (window → decorate → renderPanel args).
 *
 * U2c P0 — full interaction: scroll / search / select / cursor now flow through
 * the SHARED reducer `leaves/text/text-view-update` (the same one the viewer
 * uses), so a text-view instance is per-instance-stateful (its slice owns its
 * scroll/search/select/cursor — the partial D4 collapse). `innerH` is stamped by
 * `augmentMsg` via the shared `paneInnerH` helper so scroll clamps correctly even
 * when this tab is not the active tab of its slot (background streaming — U2c P1).
 * U2c P1 will add the `tv_*` streamed-content arms + hint-keyed reuse.
 */
'use strict';

const { renderPanel } = require('../api');
const { buildTextView } = require('../../leaves/text-view/render');
const tvu = require('../../leaves/text/text-view-update');
const ms = require('../../leaves/text/search');
const astatus = require('../../leaves/text/action-status');
const { visibleLen } = require('../../leaves/text/ansi');
const { paneInnerH, paneInnerW } = require('../pane-viewport');
const { getModel } = require('../../model/store');

function init(paneId, seed) {
  const cfg = (seed && seed.paneDef && seed.paneDef.config) || {};
  return {
    // Self-identity: the COLUMN paneId (for geometry), threaded by the mint loop.
    paneId: paneId || null,
    lines: Array.isArray(cfg.lines) ? cfg.lines : [],
    scroll: 0,
    // Viewport rows, stamped by augmentMsg (mirror viewer FIX-2); 0 pre-first-
    // dispatch → the shared reducer's _innerH falls back to 1.
    innerH: 0,
    // Full interaction state (U2c P0) — same shapes the shared reducer + the
    // viewer use, per-instance (each text-view tab owns its own view state).
    search: { active: false, term: '', idx: 0, typing: '' },
    select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
    cursor: { line: 0, col: 0 },
    // Indices of buffer lines that are action-status stamps (the permanent
    // `✓ · dur · time` completion line). The display transform (_contentLines)
    // right-aligns these to the current pane width for BOTH render and the
    // interaction reducer — the alignment is a display concern, so the stored
    // text stays width-agnostic and resizes cleanly. Appends never shift existing
    // indices (append-only tail); tv_stream_start (re-run reseed) clears them.
    statusRows: [],
  };
}

// Push streamed lines onto the buffer + bottom-stick scroll. The instance owns
// its own scroll, so no active-tab bundle is needed (unlike the viewer): if the
// user has scrolled up (not at bottom) new output accumulates without yanking
// them down; at the bottom, the view follows the tail. Uncapped, like the action
// buffer it replaces (action output is retained, not a ring like the Transcript).
function _appendLines(slice, incoming) {
  const innerH = slice.innerH > 0 ? slice.innerH : 1;
  const cur = slice.lines || [];
  const wasAtBottom = (slice.scroll || 0) >= Math.max(0, cur.length - innerH);
  const lines = cur.concat(incoming);
  const scroll = wasAtBottom ? Math.max(0, lines.length - innerH) : (slice.scroll || 0);
  return { ...slice, lines, scroll };
}

function update(msg, slice) {
  // Project the stamped viewport height onto the slice so the shared reducer's
  // clamps read it through _innerH (mirror viewer.js FIX-2). The `!==` guard
  // preserves slice ref-identity when innerH is unchanged.
  if (msg && msg.innerH > 0 && slice.innerH !== msg.innerH) slice = { ...slice, innerH: msg.innerH };
  // Streamed-content arms (U2c P1) — an action's output routes here by paneId.
  switch (msg.type) {
    case 'tv_stream_start': {
      // Append mode (per-action `output: append`, docs/DATAFLOW.md): keep the
      // accumulated buffer and add this run BELOW the previous one (a blank
      // separator + optional preamble + header), jumping to the tail so the new
      // run is visible. Prior statusRows indices stay valid — the buffer only
      // grows at the tail. First run (empty buffer) falls through to the reseed,
      // which also yields just [header], so there's no leading blank line.
      if (msg.append && (slice.lines || []).length) {
        const add = msg.preamble ? ['', msg.preamble, msg.header] : ['', msg.header];
        const lines = (slice.lines || []).concat(add);
        const innerH = slice.innerH > 0 ? slice.innerH : 1;
        return { ...slice, lines, scroll: Math.max(0, lines.length - innerH) };
      }
      // Re-run reseed (default 'replace'): clear to the header + reset view state
      // (the per-instance analog of the viewer's routed stream_start R4 reset). An
      // optional `preamble` line is seeded AHEAD of the header — the unrouted
      // preempt uses it to carry a "⊗ killed previous: X" notice that SURVIVES
      // this reset (killJob's own footer/chip would otherwise be wiped by the
      // reseed). Truthiness guard: a '' preamble (preempted job already gone)
      // seeds no line.
      return {
        ...slice,
        lines: msg.preamble ? [msg.preamble, msg.header] : [msg.header],
        scroll: 0,
        search: { active: false, term: '', idx: 0, typing: '' },
        select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
        cursor: { line: 0, col: 0 },
        statusRows: [],
      };
    }
    case 'tv_append':
      return _appendLines(slice, [msg.line]);
    case 'tv_append_lines':
      return (Array.isArray(msg.lines) && msg.lines.length) ? _appendLines(slice, msg.lines) : slice;
    case 'tv_status': {
      // Append the permanent completion-status line + record its index AND the
      // outcome (docs/global-config.md §action_status). render() right-aligns it
      // and re-derives its color from the outcome under the current theme (so a
      // past ✓/✗/⊗ tracks :theme). `msg.line` is the stored coordinate/fallback.
      const s = _appendLines(slice, [msg.line]);
      return { ...s, statusRows: (slice.statusRows || []).concat([{ index: s.lines.length - 1, outcome: msg.outcome || null }]) };
    }
    case 'tv_set_lines':
      // U2e P1b — REPLACE the buffer wholesale (open-file/docker: the `Loading…`
      // placeholder is swapped for the resolved content). Resets scroll to the top
      // of the new content; keeps search/select (a fresh open has none anyway).
      // Also clears statusRows: the indices point into the OLD buffer, so a
      // wholesale replace must drop them (mirrors tv_stream_start's reset).
      return { ...slice, lines: Array.isArray(msg.lines) ? msg.lines : [], scroll: 0, statusRows: [] };
    default: break;
  }
  // Interaction (U2c P0) — a text-view's content IS its own line buffer. The
  // reducer runs over the DISPLAY-space buffer (status rows right-aligned to
  // msg.innerW — the SAME contentLines render decorates + windows), so keyboard
  // selection/search coordinates match what the user sees. Mouse already reports
  // display columns; unifying the reducer here puts both in one coordinate
  // system. innerW absent (pre-boot / no status rows) → contentLines === slice.lines.
  const r = tvu.reduce(msg, slice, _contentLines(slice, msg.innerW), 'text-view');
  return r === null ? slice : r;
}

// Framework (loop._augment) stamps the viewport geometry so update() stays pure
// of layout reads. Idempotent: a pre-attached innerH/innerW wins. Reuses the
// shared paneInnerH/paneInnerW (keyed on this instance's column paneId) so a
// background-streaming off-tab text-view still clamps against its container slot.
// innerW is consumed ONLY to right-align status rows for the interaction reducer,
// so it's stamped ONLY for the fall-through interaction Msgs on a pane that HAS
// status rows: the streaming arms (tv_*) are served in update()'s switch before
// the reducer and never read it, so the hot append path — including the Transcript,
// which keeps appending after an action's status row lands — pays no geometry read.
const _TV_STREAM_ARMS = new Set(['tv_stream_start', 'tv_append', 'tv_append_lines', 'tv_status', 'tv_set_lines']);
function augmentMsg(msg, model, slice) {
  let out = msg;
  if (!(out.innerH > 0)) {
    const ih = paneInnerH(slice);
    if (ih > 0) out = { ...out, innerH: ih };
  }
  if (!(out.innerW > 0) && !_TV_STREAM_ARMS.has(msg.type)
      && slice.statusRows && slice.statusRows.length) {
    const iw = paneInnerW(slice);
    if (iw > 0) out = { ...out, innerW: iw };
  }
  return out;
}

// Search decoration for THIS instance's slice (mirror of panel/content/search.js
// decorationFor, resolved against the own slice + focus). Render is impure shell,
// so the getModel() read of the global detailSearchMode flag is fine. Selection
// wins over search (same precedence as the viewer).
function _searchDecoration(slice, lines, focused) {
  const search = slice.search;
  if (!search) return null;
  const typingPhase = focused && getModel().modes.detailSearchMode;
  const term = typingPhase ? (search.typing || '') : (search.active ? (search.term || '') : '');
  const matches = ms.matchesFor(lines, term);
  if (!matches.length) return null;
  const activeIdx = Math.min(search.idx || 0, matches.length - 1);
  return { matches, activeIdx };
}

// U2e stopgap — when this text-view lives in a MULTI-tab slot, its title becomes
// the slot's UNIFIED tab strip (`Info ─ Transcript ─ [primary]`) so the siblings
// (the viewer's Info/Transcript, other action outputs) stay VISIBLE + clickable
// as ONE consistent strip — running an action ADDS a tab rather than swapping the
// strip to a different level. Single-tab slots keep the plain title.
function _slotTitle(panel) {
  const strip = require('../slot-strip').unifiedSlotStrip(panel);
  return strip ? strip.title : (panel && panel.title);
}

// Flush `line` to the right edge of a `width`-wide content area (leading pad),
// markup-aware. Too-wide lines are left untouched (the pane truncates them).
function _rightAlign(line, width) {
  const vl = visibleLen(line);
  return vl >= width ? line : ' '.repeat(width - vl) + line;
}

// The DISPLAY-space content buffer: slice.lines with the recorded status rows
// flushed right to `innerW`. This is the ONE buffer both render (highlight +
// window source) AND the interaction reducer (selection/search coordinates)
// consume, so keyboard/mouse coords and the painted highlight can't drift.
// Right-aligning here (not in the stored buffer) keeps the text width-agnostic
// across resizes. Ref-preserving: returns slice.lines untouched on the common
// path (no status rows, or width unavailable) so the no-copy fast path holds.
//
// `statusCtx` ({cfg, tags}) is passed ONLY by render: it re-derives each status
// row's chip COLOR from the stored outcome under the CURRENT theme, so a past
// ✓/✗/⊗ tracks a :theme change instead of freezing the completion-time palette.
// The reducer omits it and uses the stored line — same TEXT/width (only color
// tags differ), so selection/search coordinates still match render's.
function _contentLines(slice, innerW, statusCtx) {
  const lines = slice.lines || [];
  const statusRows = slice.statusRows;
  if (!statusRows || !statusRows.length || !(innerW > 0)) return lines;
  const out = lines.slice();
  for (const r of statusRows) {
    const i = r.index;
    if (i < 0 || i >= out.length) continue;
    let line = out[i];
    if (statusCtx && r.outcome) {
      const chip = astatus.statusLine(r.outcome, null, statusCtx.cfg, statusCtx.tags);
      if (chip) line = chip;
    }
    out[i] = _rightAlign(line, innerW);
  }
  return out;
}

// The LIVE action-status line for this pane while its action is still running:
// a right-aligned spinner + ticking duration, floated at the end of the output
// (docs/global-config.md §action_status). '' when disabled, when this pane
// holds no running action (completed / open-file / docker-log views), or on the
// pre-reconcile boot frame. On completion this vanishes and stream.js's stored
// `tv_status` line takes over. The Transcript (unrouted sink) matches by kind.
function _chipFor(paneId, t, innerW) {
  const model = getModel();
  // Cheap early-out for the steady state (no action running): skip the config
  // resolve + transcript-identity resolve + per-pane job scan entirely. This
  // runs per text-view pane per frame — and the frame clock now repaints 1x/s
  // while an action runs — so the common no-op path must stay trivial.
  const jobs = model.jobs;
  if (!Array.isArray(jobs) || !jobs.some((j) => j.status === 'running'
      && (j.kind === 'stream-routed' || j.kind === 'stream-unrouted'))) return null;
  const cfg = astatus.resolveConfig((model.config || {}).action_status);
  if (!cfg.enabled) return null;
  const route = require('../route');
  const instId = paneId ? route.activeInstanceOf(paneId) : null;
  if (!instId) return null;
  const isTranscript = instId === route.resolveTarget('viewer_transcript');
  const job = astatus.jobForPane(jobs, instId, isTranscript);
  if (!job || job.status !== 'running') return null;
  const chip = astatus.runningChip(
    { status: 'running', startedAt: job.startedAt },
    model.now, cfg,
    { success: t.success, warning: t.warning, error: t.error }, innerW,
  );
  return chip ? { job, instId, line: chip.line, cancelX0: chip.cancelX0, cancelX1: chip.cancelX1 } : null;
}

// The LIVE action-status line string for render (floated at the tail). '' when
// this pane holds no running action. Thin wrapper over the shared _chipFor.
function _runningLine(panel, t, innerW) {
  const info = _chipFor(panel && panel.paneId, t, innerW);
  return info ? info.line : '';
}

// Shell hook for the click hit-test (chrome-hittest.hitTestActionCancel): the
// pane-local `✗ cancel` span + owning jobId for a pane's live chip, or null.
// Non-null ONLY when the affordance actually drew (cancelX0 >= 0) AND the chip is
// on-screen — the tail line renders only while bottom-stuck (render's `wasBottom`
// below); scrolled up it's off-screen and not clickable, by design. `innerW`/
// `innerH` are the pane's content dims (b.w-2 / b.h-2). Impure-shell theme read.
function cancelHitInfo(paneId, innerW, innerH) {
  const t = require('../../leaves/infra/themes').theme();
  const info = _chipFor(paneId, t, innerW);
  if (!info || info.cancelX0 < 0) return null;
  const slice = require('../route').getInstanceSlice(info.instId);
  if (!slice) return null;
  const linesLen = (slice.lines || []).length;
  const atBottom = (slice.scroll || 0) >= Math.max(0, linesLen - innerH);
  if (!atBottom) return null;
  // The chip is the tail of (contentLines + chip). With bottom-stick (render's
  // `wasBottom` branch), its row within the inner window is min(linesLen, innerH-1)
  // — right after short output, or the last inner row once output fills the pane.
  const row = Math.min(linesLen, Math.max(0, innerH - 1));
  return { jobId: info.job.id, cancelX0: info.cancelX0, cancelX1: info.cancelX1, row };
}

function render(panel, w, h, slice, opts) {
  const focused = !!(opts && opts.focused);
  const t = require('../../leaves/infra/themes').theme();
  const innerW = w - 2;
  const innerH = h - 2;

  // Effective lines for THIS frame (frame = f(model)). Two derived forms, kept
  // distinct so the display transform never corrupts selection/search:
  //   • contentLines — the stored buffer with status rows flushed right to the
  //     current width. This is the SELECTION + SEARCH buffer. Right-aligning
  //     here (not in the stored buffer) keeps the text width-agnostic across
  //     resizes, and it holds real, copyable content at the columns actually
  //     displayed — so a yank of a right-aligned status row reads the shifted
  //     text the user saw, not the stored left-aligned bytes at the wrong
  //     columns.
  //   • displayLines — contentLines PLUS the ephemeral live running line floated
  //     at the tail. RENDER-ONLY: the running line is not in slice.lines, so it
  //     must not be searched (its ticking duration would paint a phantom,
  //     un-navigable highlight the reducer never counts) nor
  //     yielded by a yank; it lives in the display window, not the select set.
  // No copy for the common case (no status rows, not running) — most text-views
  // hit this and contentLines === slice.lines by reference. `statusCtx` re-derives
  // each stored status row's chip color from its outcome under the CURRENT theme,
  // so past ✓/✗/⊗ chips track :theme (the reducer's _contentLines omits it — same
  // TEXT/width, so its selection/search coords still match this buffer).
  let contentLines = _contentLines(slice, innerW, {
    cfg: astatus.resolveConfig((getModel().config || {}).action_status),
    tags: { success: t.success, warning: t.warning, error: t.error },
  });

  // Search decoration over contentLines (excludes the running line) so render's
  // match set stays in lockstep with the reducer, which now runs matchesFor over
  // the SAME contentLines (built by _contentLines at the reduce call, same
  // innerW). Selection wins over search (same precedence as the viewer).
  const sel = (slice.select && slice.select.active) ? slice.select : null;
  const searchDecoration = sel ? null : _searchDecoration(slice, contentLines, focused);

  // Float the live running line at the tail for display only. Bottom-stick: keep
  // it visible only when already at the tail; don't yank a user who has scrolled
  // up into history.
  let displayLines = contentLines;
  let scroll = slice.scroll;
  const running = _runningLine(panel, t, innerW);
  if (running) {
    displayLines = contentLines.slice();
    const wasBottom = (slice.scroll || 0) >= Math.max(0, (slice.lines || []).length - innerH);
    displayLines.push(running);
    if (wasBottom) scroll = Math.max(0, displayLines.length - innerH);
  }

  const args = buildTextView({
    // `lines` is the display window source; `selectLines` (caller intent) is
    // the copyable content buffer — forwarded downstream as `fullLines`
    // (pipeline role) and recorded for the mouse-selection pipeline. It excludes
    // the running line and includes the right-aligned status rows.
    lines: displayLines, selectLines: contentLines, scroll, innerH,
    select: sel, searchDecoration,
    // 3b — thread the theme's selection/search tags into the pure leaf.
    selectedTag: t.selected, searchTags: { match: t.match, current: t.match_current },
    width: w, height: h,
    title: _slotTitle(panel), hotkey: panel.hotkey,
    panelType: 'text-view', focused,
    chrome: opts && opts.chrome,
  });
  return renderPanel(args);
}

module.exports = {
  name: 'text-view',
  init,
  update,
  augmentMsg,
  cancelHitInfo,
  panelTypes: { 'text-view': { render } },
};
