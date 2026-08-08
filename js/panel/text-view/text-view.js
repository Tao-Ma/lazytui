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
const astatus = require('../../leaves/infra/action-status');
const { visibleLen } = require('../../leaves/text/ansi');
const { paneInnerH } = require('../pane-viewport');
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
    // `✓ Done · …` completion line). render() right-aligns these to the current
    // pane width — the alignment is a display concern, so the stored text stays
    // width-agnostic and resizes cleanly. Appends never shift existing indices
    // (append-only tail); tv_stream_start (re-run reseed) clears them.
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
    case 'tv_stream_start':
      // Re-run reseed: clear to the header + reset view state (the per-instance
      // analog of the viewer's routed stream_start R4 reset).
      return {
        ...slice,
        lines: [msg.header],
        scroll: 0,
        search: { active: false, term: '', idx: 0, typing: '' },
        select: { active: false, kind: 'char', anchor: { line: 0, col: 0 }, cursor: { line: 0, col: 0 } },
        cursor: { line: 0, col: 0 },
        statusRows: [],
      };
    case 'tv_append':
      return _appendLines(slice, [msg.line]);
    case 'tv_append_lines':
      return (Array.isArray(msg.lines) && msg.lines.length) ? _appendLines(slice, msg.lines) : slice;
    case 'tv_status': {
      // Append the permanent completion-status line + record its index so
      // render() right-aligns it (docs/global-config.md §action_status).
      const s = _appendLines(slice, [msg.line]);
      return { ...s, statusRows: (slice.statusRows || []).concat([s.lines.length - 1]) };
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
  // Interaction (U2c P0) — a text-view's content IS its own line buffer.
  const r = tvu.reduce(msg, slice, slice.lines || [], 'text-view');
  return r === null ? slice : r;
}

// Framework (loop._augment) stamps the viewport height so update() stays pure of
// layout geometry. Idempotent: a pre-attached innerH wins. Reuses the shared
// paneInnerH (keyed on this instance's column paneId) so a background-streaming
// off-tab text-view still clamps against its container slot's height.
function augmentMsg(msg, model, slice) {
  if (msg.innerH > 0) return msg;
  const ih = paneInnerH(slice);
  return ih > 0 ? { ...msg, innerH: ih } : msg;
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

// The LIVE action-status line for this pane while its action is still running:
// a right-aligned spinner + ticking duration, floated at the end of the output
// (docs/global-config.md §action_status). '' when disabled, when this pane
// holds no running action (completed / open-file / docker-log views), or on the
// pre-reconcile boot frame. On completion this vanishes and stream.js's stored
// `tv_status` line takes over. The Transcript (unrouted sink) matches by kind.
function _runningLine(panel, t, innerW) {
  const model = getModel();
  // Cheap early-out for the steady state (no action running): skip the config
  // resolve + transcript-identity resolve + per-pane job scan entirely. This
  // runs per text-view pane per frame — and the frame clock now repaints 1x/s
  // while an action runs — so the common no-op path must stay trivial.
  const jobs = model.jobs;
  if (!Array.isArray(jobs) || !jobs.some((j) => j.status === 'running'
      && (j.kind === 'stream-routed' || j.kind === 'stream-unrouted'))) return '';
  const cfg = astatus.resolveConfig((model.config || {}).action_status);
  if (!cfg.enabled) return '';
  const route = require('../route');
  const instId = panel && panel.paneId ? route.activeInstanceOf(panel.paneId) : null;
  if (!instId) return '';
  const isTranscript = instId === route.resolveTarget('viewer_transcript');
  const job = astatus.jobForPane(jobs, instId, isTranscript);
  if (!job || job.status !== 'running') return '';
  const seg = astatus.statusLine(
    { status: 'running', startedAt: job.startedAt },
    model.now, cfg,
    { success: t.success, warning: t.warning, error: t.error },
  );
  return seg ? _rightAlign(seg, innerW) : '';
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
  //     columns (review [6]).
  //   • displayLines — contentLines PLUS the ephemeral live running line floated
  //     at the tail. RENDER-ONLY: the running line is not in slice.lines, so it
  //     must not be searched (its ticking duration would paint a phantom,
  //     un-navigable highlight the reducer never counts — review [3]) nor
  //     yielded by a yank; it lives in the display window, not the select set.
  // No copy for the common case (no status rows, not running) — most text-views
  // hit this and contentLines === slice.lines by reference.
  let contentLines = slice.lines || [];
  const statusRows = slice.statusRows;
  if (statusRows && statusRows.length) {
    contentLines = contentLines.slice();
    for (const i of statusRows) {
      if (i >= 0 && i < contentLines.length) contentLines[i] = _rightAlign(contentLines[i], innerW);
    }
  }

  // Search decoration over contentLines (excludes the running line) so render's
  // match set stays in lockstep with the reducer, which runs matchesFor over
  // slice.lines. Selection wins over search (same precedence as the viewer).
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
    // `lines` is the display window source; `selectLines` is the copyable
    // content buffer recorded for the mouse-selection pipeline (excludes the
    // running line, includes the right-aligned status rows).
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
  panelTypes: { 'text-view': { render } },
};
