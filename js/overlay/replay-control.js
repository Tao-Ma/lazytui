/**
 * Replay-control float pane — the scrubber UI for interactive replay.
 *
 * PURE of dispatch: `render(data)` takes the controller's `renderData()` snapshot
 * (passed in by render/paint via the injected seam) and draws a centered box via
 * the shared overlay helpers (leaves/render/draw — the jobs/Running overlay is the
 * template). It reads no module state, so overlay/ stays free of a dispatch edge.
 *
 * Lists checkpoints ↔ timestamps with the cursor highlighted; a status line shows
 * play state / speed / position; the panels underneath show the reconstructed
 * recorded frame at the current position. v0.6.6 replay arc.
 */
'use strict';

const { renderOverlay, viewportDims } = require('../leaves/render/draw');

const MAX_W = 56;
const VH = 10;   // visible checkpoint rows

function _fmtTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function render(data) {
  if (!data || !data.paneOpen) return;
  const cps = data.checkpoints || [];
  const total = cps.length;
  const COLS = viewportDims().cols;
  const maxWidth = Math.min(MAX_W, COLS - 4);

  const sym = data.playing === 'fwd' ? '▶' : data.playing === 'rev' ? '◀' : '⏸';
  const dt = ((data.t - data.firstT) / 1000).toFixed(1);
  const lines = [
    `[bold]${sym}[/]  ${data.ratio}×   seq ${data.pos}/${data.total}   +${dt}s`,
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
  lines.push('[dim]j/k seek  space play  b rev  +/- speed  \\[ \\] step  p hide  q exit[/]');

  renderOverlay({
    lines, title: 'Replay',
    maxWidth,
    count: total ? [data.cursor + 1, total] : undefined,
  });
}

module.exports = { render };
