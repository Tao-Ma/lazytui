/**
 * Replay scrubber — the float-pane UI for interactive replay. This is the
 * VIEW half; the controller engine (session state, playback, checkpoints) is
 * dispatch/runtime/replay-control.js. (Renamed from overlay/replay-control.js
 * in the v0.6.6 pre-tag review to end the shared-basename confusion.)
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
const { theme } = require('../leaves/infra/themes');

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

// Overlay-compositor migration (Release 2 Phase 2.d — closes Phase 2.d).
// When `newRows` + `cols` are threaded in by paint.js, both the mini bar
// AND the full box composite into the main-frame row buffer through
// `renderOverlay`'s `targetRows` path. The three paneView transitions
// (`full ↔ mini ↔ hidden`) each change which cells carry the overlay —
// cell-diff emits per-cell writes for every differing cell, so a
// `full → mini` switch clears the full box's vacated rect AND paints
// the mini bar's cells in one diff. This commit also deletes paint.js's
// `prevReplayView` sig tracker — the view-mode-transition forceFull that
// was the Class-A workaround for the overlay bypassing newRows.
function render(data, newRows, cols) {
  if (!data || data.paneView === 'hidden') return;
  if (data.paneView === 'mini') return renderMini(data, newRows, cols);
  return renderFull(data, newRows, cols);
}

// The mini line's text pieces — shared by the renderer AND the click hit-test so
// the bar's column position can't drift between paint and click (the same
// discipline overlayBox enforces for the box itself).
function _miniParts(data) {
  const dt = ((data.t - data.firstT) / 1000).toFixed(1);
  const cpN = (data.checkpoints || []).length;
  const cpLabel = cpN ? `  cp ${data.cursor + 1}/${cpN}` : '';
  const diffLabel = data.diffMode && data.diffMode !== 'off' ? `  d:${data.diffMode}` : '';
  // Plain text only (no markup) — `plain.length` drives the click hit-test, so
  // it must equal the rendered width. B6 lock badge follows the same rule.
  const lockLabel = data.locked ? '  LOCK' : '';
  const head = `${_sym(data)} ${data.ratio}×`;            // bolded in render
  const tail = ` ${data.pos}/${data.total}${cpLabel}${diffLabel}${lockLabel}  +${dt}s  `;
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
function renderMini(data, newRows, cols) {
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
    targetRows: newRows || null, targetCols: cols || 0,
  });
}

// Full pane — status + checkpoint list + key legend.
function renderFull(data, newRows, cols) {
  const t = theme();
  const cps = data.checkpoints || [];
  const total = cps.length;
  const COLS = viewportDims().cols;
  const maxWidth = Math.min(MAX_W, COLS - 4);

  const dt = ((data.t - data.firstT) / 1000).toFixed(1);
  const mode = data.mode === 'even'
    ? 'even'
    : `realtime ${data.idleCap === Infinity ? '∞' : (data.idleCap / 1000) + 's'}`;
  const diffLabel = data.diffMode && data.diffMode !== 'off' ? `  diff:${data.diffMode}` : '';
  const lockLabel = data.locked ? `  [${t.warning}]LOCK[/]` : '';   // B6 — distinct from ⏸ (pause)
  const lines = [
    `[bold]${_sym(data)}[/] ${data.ratio}×  ${mode}   seq ${data.pos}/${data.total}  +${dt}s${diffLabel}${lockLabel}`,
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
      lines.push(idx === data.cursor ? `[${t.selected}] ${row} [/]` : `  ${row}`);
    }
  }

  // B6 — per-Msg model-diff panel (D). Lists what the Msg at the current
  // position changed in the replayable state; null when the panel is hidden.
  if (data.diff) {
    const DH = 8;   // visible change rows
    lines.push('');
    lines.push(`[dim]──── changes @ seq ${data.pos} ────[/]`);
    if (!data.diff.changes.length) {
      lines.push(`[dim](${data.diff.initial ? 'initial frame' : 'no model change'})[/]`);
    } else {
      for (const c of data.diff.changes.slice(0, DH)) {
        const mark = c.kind === 'add' ? `[${t.success}]+[/]` : c.kind === 'remove' ? `[${t.error}]-[/]` : `[${t.warning}]~[/]`;
        const val = c.kind === 'add' ? c.after : c.kind === 'remove' ? c.before : `${c.before} → ${c.after}`;
        lines.push(`${mark} ${c.path}  ${val}`);
      }
      const extra = data.diff.changes.length - Math.min(DH, data.diff.changes.length);
      if (extra > 0 || data.diff.truncated) lines.push(`[dim](… +${extra}${data.diff.truncated ? '+' : ''} more)[/]`);
    }
  }

  lines.push('');
  lines.push('[dim]j/k seek  space play  b rev  +/- speed  \\[ \\] step[/]');
  lines.push('[dim]n/N next-change  l lock  D diff-panel[/]');
  lines.push('[dim]m mode  i cap  d diff  g/G ends  p view  q exit[/]');

  renderOverlay({
    lines, title: 'Replay',
    maxWidth,
    count: total ? [data.cursor + 1, total] : undefined,
    targetRows: newRows || null, targetCols: cols || 0,
  });
}

// Overlay-compositor R3 descriptor. zIndex=140 preserves replay-scrubber's
// historical position (fourteenth in the retired paint.js if-chain).
// Non-modal — scrubber coexists with normal panel renders beneath.
//
// The overlay's PURE-of-dispatch invariant (render(data) takes a
// controller snapshot, no module-local state read) is preserved via
// an INJECTED data source: paint.js already injects
// `_replaySource = replay-control.renderData` at boot for its OWN
// diffMode read. We inject the same source into THIS module via
// `setDataSource(fn)` — tui.js wires it next to the paint-side injection.
// `isActive` / registered render fn read `_dataSource()` and gate the
// paint on the same `paneView !== 'hidden'` condition the retired
// if-chain tested.
let _dataSource = null;
function setDataSource(fn) { _dataSource = fn; }

function registerSelf(compositor) {
  compositor.register({
    id: 'replay-scrubber',
    isActive: () => {
      const d = _dataSource ? _dataSource() : null;
      return !!(d && d.paneView !== 'hidden');
    },
    render: (_m, newRows, cols) => {
      const d = _dataSource ? _dataSource() : null;
      if (d && d.paneView !== 'hidden') render(d, newRows, cols);
    },
    modal: false,
    zIndex: 140,
  });
}

module.exports = { render, hitTestSeek, _miniGeom, setDataSource, registerSelf };
