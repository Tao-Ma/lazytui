/**
 * v0.6.2 Phase 4.2 — Running overlay.
 *
 * Centered modal listing every live child lazytui spawned, read from
 * feature/jobs.list() at frame time (no item snapshot — overlay
 * reflects mid-overlay arrivals + status flips). Cursor + scroll live
 * in model.modal.jobs.
 *
 * Row format:
 *   ●  make-check       running   12s   [tab]
 *   ✓  docker logs ngx  exited 0  3m    [active]
 *   ↗  bg-rsync         running   45s   [bg]
 *   ▢  shell            running   2m    [pty]
 *   ⊞  worker tmux      running   5m    [tmux]
 *
 * Enter is a no-op in Phase 4.2; kind-specific jump lands in 4.3.
 */
'use strict';

const { esc, visibleLen } = require('../io/ansi');
const { cols, rows } = require('../io/term');
const { renderOverlay } = require('../render/panel');
const { getModel } = require('../app/runtime');
const jobs = require('../feature/jobs');

const MAX_W = 80;
const FOOTER_ROWS = 2;   // blank + hint
const HEADER_ROWS = 1;
const STATUS_PAD = 12;
const AGE_PAD = 5;
const TAG_PAD = 7;

const KIND_GLYPH = {
  'stream-routed':   '●',
  'stream-unrouted': '●',
  'pty':             '▢',
  'background':      '↗',
  'tmux':            '⊞',
};
const KIND_TAG = {
  'stream-routed':   '[tab]',
  'stream-unrouted': '[viewer]',
  'pty':             '[pty]',
  'background':      '[bg]',
  'tmux':            '[tmux]',
};

function _fmtAge(startedAt, now) {
  const s = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function _fmtStatus(j) {
  if (j.status === 'running') return '[yellow]running[/]';
  if (j.status === 'killed')  return '[red]killed[/]';
  if (j.exitCode === 0)        return '[green]exited 0[/]';
  return `[red]exit ${j.exitCode == null ? '?' : j.exitCode}[/]`;
}

function _fmtRow(j, w, now) {
  const glyph = KIND_GLYPH[j.kind] || '?';
  const tag   = KIND_TAG[j.kind] || '';
  const status = _fmtStatus(j);
  const age = _fmtAge(j.startedAt, now);
  // Label width = total - (glyph + spaces + status + age + tag + paddings)
  const leftMinus = 1 /* glyph */ + 2 /* sp */ + STATUS_PAD + 1 + AGE_PAD + 1 + TAG_PAD;
  const labelW = Math.max(8, w - leftMinus);
  const label = esc(j.label).slice(0, labelW).padEnd(labelW);
  // pad status to STATUS_PAD visible cells; markup adds zero-vis chars.
  const statusVis = visibleLen(status);
  const statusPad = ' '.repeat(Math.max(1, STATUS_PAD - statusVis));
  return `${glyph}  ${label} ${status}${statusPad}${age.padEnd(AGE_PAD)} [dim]${tag}[/]`;
}

/** Visible rows in the overlay body (used by the dispatch jobs_nav
 *  clamp). Re-derived each call from current term size + jobs count. */
function viewportRows() {
  const list = jobs.list();
  const ROWS = rows();
  const wantH = list.length + 2 /* borders */ + HEADER_ROWS + FOOTER_ROWS;
  const h = Math.min(wantH, ROWS - 2);
  return Math.max(1, h - 2 - HEADER_ROWS - FOOTER_ROWS);
}

function renderJobsOverlay() {
  if (!getModel().modes.jobsMode) return;
  const list = jobs.list();
  const j = getModel().modal.jobs || { cursor: 0, scroll: 0 };
  const now = Date.now();
  const COLS = cols();
  const wantW = Math.min(MAX_W, COLS - 4);
  const innerW = Math.max(20, wantW - 4);
  const vh = viewportRows();

  const cursor = Math.max(0, Math.min(j.cursor | 0, Math.max(0, list.length - 1)));
  const scroll = Math.max(0, Math.min(j.scroll | 0, Math.max(0, list.length - vh)));

  const lines = [];
  if (list.length === 0) {
    lines.push('[dim]  (no live jobs)[/]');
  } else {
    // Header
    lines.push('[dim]   label' + ' '.repeat(Math.max(1, innerW - 5 - 9 - AGE_PAD - 1 - TAG_PAD - 1)) +
               'status      age   tag[/]');
    for (let i = 0; i < vh; i++) {
      const idx = scroll + i;
      const job = list[idx];
      if (!job) { lines.push(''); continue; }
      const row = _fmtRow(job, innerW, now);
      lines.push(idx === cursor ? `[reverse]${row}[/]` : row);
    }
  }
  lines.push('');
  lines.push('[dim]\\[↑/↓] nav   \\[g/G] top/bottom   \\[Esc / J] close[/]');

  renderOverlay({
    lines, title: 'Running',
    maxWidth: wantW,
    count: list.length ? [cursor + 1, list.length] : undefined,
  });
}

module.exports = { renderJobsOverlay, viewportRows };
