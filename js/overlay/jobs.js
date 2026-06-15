/**
 * v0.6.2 Phase 4.2 — Running overlay.
 *
 * Centered modal listing every live child lazytui spawned, read from
 * feature/jobs.list() at frame time (no item snapshot — overlay
 * reflects mid-overlay arrivals + status flips). Cursor + scroll live
 * in model.modal.jobs.
 *
 * Cells are PADDED TO FIXED VISIBLE WIDTHS so header + non-cursor +
 * cursor rows line up. Cursor rows must NOT contain an inner `[/]` —
 * richToAnsi's `[/]` is a single hard reset, so an inner close would
 * end the outer `[reverse]` early (the same gotcha overlay/panel-list.js
 * documents). Two render paths: colored markup for non-cursor rows, a
 * plain-text row wrapped in one outer `[reverse]…[/]` for the cursor.
 */
'use strict';

const { esc } = require('../io/ansi');
const { renderOverlay, viewportDims } = require('../render/panel');
const { getModel } = require('../app/runtime');
const jobs = require('../feature/jobs');

const MAX_W = 80;
const FOOTER_ROWS = 2;   // blank + hint
const HEADER_ROWS = 1;
const STATUS_W = 12;     // visible width reserved for status column
const AGE_W = 5;         // visible width reserved for age column
const TAG_W = 8;         // visible width reserved for tag column

const KIND_GLYPH = {
  'stream-routed':   '●',
  'stream-unrouted': '●',
  'pty':             '▢',
  'background':      '↗',
  'tmux':            '⊞',
};
const KIND_TAG = {
  'stream-routed':   'tab',
  'stream-unrouted': 'viewer',
  'pty':             'pty',
  'background':      'bg',
  'tmux':            'tmux',
};

function _fmtAge(startedAt, endedAt, now) {
  const ref = endedAt || now;
  const s = Math.max(0, Math.floor((ref - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function _statusText(j) {
  if (j.status === 'running') return 'running';
  if (j.status === 'killed')  return 'killed';
  return `exit ${j.exitCode == null ? '?' : j.exitCode}`;
}

function _statusColor(j) {
  if (j.status === 'running') return 'yellow';
  if (j.status === 'killed')  return 'red';
  if (j.exitCode === 0)        return 'green';
  return 'red';
}

/** Per-row cells, all pre-padded to fixed visible widths. */
function _rowCells(j, labelW, now) {
  return {
    glyph:  KIND_GLYPH[j.kind] || '?',
    label:  esc(j.label).slice(0, labelW).padEnd(labelW),
    status: _statusText(j).padEnd(STATUS_W),
    color:  _statusColor(j),
    age:    _fmtAge(j.startedAt, j.endedAt, now).padEnd(AGE_W),
    tag:    (KIND_TAG[j.kind] || '').padEnd(TAG_W),
  };
}

function _fmtRowColored(c) {
  return `${c.glyph}  ${c.label} [${c.color}]${c.status}[/]${c.age} [dim]${c.tag}[/]`;
}

function _fmtRowPlain(c) {
  return `${c.glyph}  ${c.label} ${c.status}${c.age} ${c.tag}`;
}

function _fmtHeader(labelW) {
  return '   '
    + 'label'.padEnd(labelW + 1)
    + 'status'.padEnd(STATUS_W)
    + 'age'.padEnd(AGE_W + 1)
    + 'tag';
}

/** Visible rows in the overlay body (used by the dispatch jobs_nav
 *  clamp). Re-derived each call from current term size + jobs count. */
function viewportRows() {
  const list = jobs.list();
  const ROWS = viewportDims().rows;
  const wantH = list.length + 2 /* borders */ + HEADER_ROWS + FOOTER_ROWS;
  const h = Math.min(wantH, ROWS - 2);
  return Math.max(1, h - 2 - HEADER_ROWS - FOOTER_ROWS);
}

// `now` is threaded from the paint frame (the single frame-clock read) so
// this render is a pure function of (jobs registry, model, now) — Finding A.
function renderJobsOverlay(now = Date.now()) {
  if (!getModel().modes.jobsMode) return;
  const list = jobs.list();
  const j = getModel().modal.jobs || { cursor: 0, scroll: 0 };
  const COLS = viewportDims().cols;
  const wantW = Math.min(MAX_W, COLS - 4);
  const innerW = Math.max(20, wantW - 4);
  // labelW absorbs the slack: total = glyph(1) + "  "(2) + labelW + " "(1)
  //                                  + STATUS_W + AGE_W + " "(1) + TAG_W.
  const labelW = Math.max(8, innerW - (3 + 1 + STATUS_W + AGE_W + 1 + TAG_W));
  const vh = viewportRows();

  const cursor = Math.max(0, Math.min(j.cursor | 0, Math.max(0, list.length - 1)));
  const scroll = Math.max(0, Math.min(j.scroll | 0, Math.max(0, list.length - vh)));

  const lines = [];
  if (list.length === 0) {
    lines.push('[dim]  (no live jobs)[/]');
  } else {
    lines.push(`[dim]${_fmtHeader(labelW)}[/]`);
    for (let i = 0; i < vh; i++) {
      const idx = scroll + i;
      const job = list[idx];
      if (!job) { lines.push(''); continue; }
      const cells = _rowCells(job, labelW, now);
      lines.push(idx === cursor
        ? `[reverse]${_fmtRowPlain(cells)}[/]`
        : _fmtRowColored(cells));
    }
  }
  lines.push('');
  lines.push('[dim]\\[↑/↓] nav   \\[g/G] top/bottom   \\[Esc] close[/]');

  renderOverlay({
    lines, title: 'Running',
    maxWidth: wantW,
    count: list.length ? [cursor + 1, list.length] : undefined,
  });
}

module.exports = { renderJobsOverlay, viewportRows };
