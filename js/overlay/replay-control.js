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

const { renderOverlay, overlayBox, viewportDims } = require('../leaves/render/draw');

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

// The mini line's text pieces — shared by the renderer AND the click hit-test so
// the bar's column position can't drift between paint and click (the same
// discipline overlayBox enforces for the box itself).
function _miniParts(data) {
  const dt = ((data.t - data.firstT) / 1000).toFixed(1);
  const cpN = (data.checkpoints || []).length;
  const cpLabel = cpN ? `  cp ${data.cursor + 1}/${cpN}` : '';
  const head = `${_sym(data)} ${data.ratio}×`;            // bolded in render
  const tail = ` ${data.pos}/${data.total}${cpLabel}  +${dt}s  `;
  return { head, tail, plain: head + tail };               // `plain` = visible width before the bar
}

// The mini box geometry — same anchor/width the renderer uses — plus the
// screen-cell range the progress bar occupies, for click-to-seek.
function _miniGeom(data) {
  const { cols: COLS, rows: ROWS } = viewportDims();
  const plainLen = _miniParts(data).plain.length + MINI_BAR;
  const maxWidth = Math.min(MAX_W, COLS - 4, Math.max(24, plainLen + 2));
  const box = overlayBox({ linesLen: 1, anchor: { x: 1, y: ROWS }, maxWidth });
  return { box, maxWidth };
}

// Click hit-test for the mini progress bar → a fraction in [0,1], or null if the
// click isn't on the bar (or the pane isn't in mini). mx,my are 0-based.
function hitTestSeek(mx, my, data) {
  if (!data || data.paneView !== 'mini') return null;
  const { box } = _miniGeom(data);
  if (my !== box.offY + 1) return null;                    // the single content row
  const start = box.offX + 1 + _miniParts(data).plain.length;
  const end = Math.min(start + MINI_BAR - 1, box.offX + box.menuW - 2);
  if (mx < start || mx > end) return null;
  return Math.max(0, Math.min(1, (mx - start) / (MINI_BAR - 1)));
}

// Compact bottom bar — play state / speed / seq / checkpoint cursor / elapsed /
// progress. Anchored bottom-left, width hugs the content. The progress fill
// shows position; pressing j/k/up/down (or clicking the bar) jumps to that
// position and `cp X/N` gives the checkpoint index (no per-checkpoint tick
// glyphs — they buried the fill when dense and added a glyph dependency).
function renderMini(data) {
  const { rows: ROWS } = viewportDims();
  const { head, tail } = _miniParts(data);
  const total = data.total;
  const frac = total > 1 ? data.idx / (total - 1) : 1;
  const fill = Math.max(0, Math.min(MINI_BAR, Math.round(frac * MINI_BAR)));
  const bar = `[bold]${'█'.repeat(fill)}[/][dim]${'░'.repeat(MINI_BAR - fill)}[/]`;
  renderOverlay({
    lines: [`[bold]${head}[/]${tail}${bar}`], title: '',
    maxWidth: _miniGeom(data).maxWidth,
    anchor: { x: 1, y: ROWS },   // same inputs _miniGeom feeds overlayBox → same box
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

module.exports = { render, hitTestSeek, _miniGeom };
