/**
 * Replay-control float pane — the scrubber UI for interactive replay.
 *
 * PURE of dispatch: `render(data)` takes the controller's `renderData()` snapshot
 * (passed in by render/paint via the injected seam) and draws a centered box via
 * the shared overlay helpers (leaves/render/draw — the jobs/Running overlay is the
 * template). It reads no module state, so overlay/ stays free of a dispatch edge.
 *
 * Three view states (`data.paneView`, cycled with `p`):
 *   - 'full'   — status + checkpoint list + key legend (checkpoint navigation);
 *   - 'mini'   — a compact bottom bar (play state / seq / timestamp / progress)
 *                so playback stays watchable without the box covering the view;
 *   - 'hidden' — nothing.
 * The panels underneath show the reconstructed recorded frame. v0.6.6 replay arc.
 */
'use strict';

const { renderOverlay, viewportDims } = require('../leaves/render/draw');

const MAX_W = 56;       // full pane width cap
const MINI_BAR = 16;    // mini progress-bar inner width
const VH = 10;          // visible checkpoint rows (full)

function _fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function _sym(data) {
  return data.playing === 'fwd' ? '▶' : data.playing === 'rev' ? '◀' : '⏸';
}

function render(data) {
  if (!data || data.paneView === 'hidden') return;
  if (data.paneView === 'mini') return renderMini(data);
  return renderFull(data);
}

// A progress bar `w` cells wide: filled to the current position, with checkpoint
// positions marked by ticks (so checkpoint nav — j/k / up/down — is visible in
// mini even without the list). Filled span is bold, the rest dim.
//
// Ticks are drawn ONLY when checkpoints are sparse enough to stay distinct
// (≤ w/2). With more, every cell would become a tick and bury the position fill
// (which is the bar's primary job) — so the ticks are dropped and the `cp X/N`
// label carries the checkpoint position instead.
function _miniBar(data, w) {
  const total = data.total;
  const frac = total > 1 ? data.idx / (total - 1) : 1;
  const fill = Math.max(0, Math.min(w, Math.round(frac * w)));
  const cells = [];
  for (let i = 0; i < w; i++) cells.push(i < fill ? '█' : '░');
  const cps = data.checkpoints || [];
  if (cps.length && cps.length <= w / 2) {
    for (const cp of cps) {
      const p = total > 1 ? Math.round((cp.idx / (total - 1)) * (w - 1)) : 0;
      if (p >= 0 && p < w) cells[p] = '┃';
    }
  }
  return `[bold]${cells.slice(0, fill).join('')}[/][dim]${cells.slice(fill).join('')}[/]`;
}

// Compact bottom bar — play state / speed / seq / checkpoint cursor / elapsed /
// progress only. Anchored bottom-left, width hugs the content.
function renderMini(data) {
  const { cols: COLS, rows: ROWS } = viewportDims();
  const dt = ((data.t - data.firstT) / 1000).toFixed(1);
  const cpN = (data.checkpoints || []).length;
  const cpLabel = cpN ? `  cp ${data.cursor + 1}/${cpN}` : '';
  const bar = _miniBar(data, MINI_BAR);
  const line = `[bold]${_sym(data)} ${data.ratio}×[/] ${data.pos}/${data.total}${cpLabel}  +${dt}s  ${bar}`;
  const plainLen = line.replace(/\[[^\]]*\]/g, '').length;   // strip markup to size the box
  renderOverlay({
    lines: [line], title: '',
    maxWidth: Math.min(MAX_W, COLS - 4, Math.max(24, plainLen + 2)),
    anchor: { x: 1, y: ROWS },   // clamps to bottom-left
  });
}

// Full pane — status + checkpoint list + key legend.
function renderFull(data) {
  const cps = data.checkpoints || [];
  const total = cps.length;
  const COLS = viewportDims().cols;
  const maxWidth = Math.min(MAX_W, COLS - 4);

  const dt = ((data.t - data.firstT) / 1000).toFixed(1);
  const mode = data.mode === 'even'
    ? 'even'
    : `realtime ${data.idleCap === Infinity ? '∞' : (data.idleCap / 1000) + 's'}`;
  const lines = [
    `[bold]${_sym(data)}[/] ${data.ratio}×  ${mode}   seq ${data.pos}/${data.total}  +${dt}s`,
    '[dim]────────────────────────────[/]',
  ];

  if (!total) {
    lines.push('[dim](no checkpoints — step / play to navigate)[/]');
  } else {
    let scroll = 0;
    if (total > VH) scroll = Math.max(0, Math.min(data.cursor - (VH >> 1), total - VH));
    for (let i = 0; i < Math.min(VH, total); i++) {
      const idx = scroll + i;
      const cp = cps[idx];
      if (!cp) { lines.push(''); continue; }
      const d = ((cp.t - data.firstT) / 1000).toFixed(1);
      const row = `${_fmtTime(cp.t)}  +${d}s  seq ${cp.seq}`;
      lines.push(idx === data.cursor ? `[reverse] ${row} [/]` : `  ${row}`);
    }
  }

  lines.push('');
  lines.push('[dim]j/k seek  space play  b rev  +/- speed  \\[ \\] step[/]');
  lines.push('[dim]m mode  i cap  g/G ends  p view  q exit[/]');

  renderOverlay({
    lines, title: 'Replay',
    maxWidth,
    count: total ? [data.cursor + 1, total] : undefined,
  });
}

module.exports = { render };
