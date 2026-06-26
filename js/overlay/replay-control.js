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

// Compact bottom bar — play state / speed / seq / checkpoint cursor / elapsed /
// progress. Anchored bottom-left, width hugs the content. The progress fill
// shows position; pressing j/k/up/down jumps the fill to the target checkpoint
// and `cp X/N` gives its index (no per-checkpoint tick glyphs — they buried the
// fill once checkpoints got dense and added a glyph dependency for no real gain).
function renderMini(data) {
  const { cols: COLS, rows: ROWS } = viewportDims();
  const dt = ((data.t - data.firstT) / 1000).toFixed(1);
  const cpN = (data.checkpoints || []).length;
  const cpLabel = cpN ? `  cp ${data.cursor + 1}/${cpN}` : '';
  const total = data.total;
  const frac = total > 1 ? data.idx / (total - 1) : 1;
  const fill = Math.max(0, Math.min(MINI_BAR, Math.round(frac * MINI_BAR)));
  const bar = `[bold]${'█'.repeat(fill)}[/][dim]${'░'.repeat(MINI_BAR - fill)}[/]`;
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
