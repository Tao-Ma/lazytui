/**
 * Diagnostics window — opened with `leader e`.
 *
 * Centered modal listing every WARNING / ERROR in io/diag-log.js,
 * newest at top. Read at frame time (no snapshot pinned at open) so a
 * diagnostic that arrives while the window is open shows up live.
 * Cursor + scroll live in model.modal.diagLog.
 *
 * RENDER-ONLY (+ the viewport-height helper dispatch needs to clamp
 * nav Msgs). Key handling folds into update via diag_log_* Msgs; clear
 * / save are effect-driven Cmds (they mutate the imperative buffer / do
 * I/O, which the pure reducer can't).
 *
 * Cursor-row gotcha (same as jobs.js / panel-list.js): richToAnsi's
 * `[/]` is a single hard reset, so an inner close inside the cursor's
 * outer `[reverse]…[/]` would end the reverse early. The cursor row is
 * therefore plain text with NO inner markup; non-cursor rows colorize.
 *
 * Bindings (dispatch.handleDiagLogKey → diag_log_* Msgs):
 *   j / down   — move down        k / up     — move up
 *   g / G      — top / bottom     , / .      — page up / down
 *   y          — yank highlighted entry to register + clipboard
 *   c          — clear the buffer
 *   s          — save to lazytui-diagnostics.json (cwd)
 *   Esc        — close
 */
'use strict';

const { esc } = require('../io/ansi');
const { renderOverlay, viewportDims } = require('../render/panel');
const { getModel } = require('../model/store');
const diag = require('../io/diag-log');

const MAX_W = 90;
const FOOTER_ROWS = 2;   // blank + hint
const TIME_W = 5;        // visible width reserved for the age column
const CODE_W = 16;       // visible width reserved for the code column

const LEVEL_GLYPH = { warn: '⚠', error: '✕' };
const LEVEL_COLOR = { warn: 'yellow', error: 'red' };

function _fmtAge(t, now) {
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function _msg(text, w) {
  return esc(text).replace(/\n/g, '↵').replace(/\t/g, ' ').slice(0, w);
}

/** Visible body rows (used by the dispatch diag_log_nav clamp).
 *  Re-derived each call from current term size + diagnostic count. */
function viewportRows() {
  const n = diag.size();
  const ROWS = viewportDims().rows;
  const wantH = n + 2 /* borders */ + FOOTER_ROWS;
  const h = Math.min(wantH, ROWS - 2);
  return Math.max(1, h - 2 - FOOTER_ROWS);
}

// `now` is threaded from the paint frame (the single frame-clock read) so
// this render is a pure function of (diag ring buffer, model, now) — Finding A.
function renderDiagLog(now = Date.now()) {
  if (!getModel().modes.diagLogMode) return;
  const list = diag.snapshot();              // newest-first
  const d = getModel().modal.diagLog || { cursor: 0, scroll: 0 };
  const COLS = viewportDims().cols;
  const wantW = Math.min(MAX_W, COLS - 4);
  const innerW = Math.max(20, wantW - 4);
  // total = glyph(1) + " "(1) + TIME_W + " "(1) + CODE_W + " "(1) + msgW
  const msgW = Math.max(8, innerW - (1 + 1 + TIME_W + 1 + CODE_W + 1));
  const vh = viewportRows();

  const cursor = Math.max(0, Math.min(d.cursor | 0, Math.max(0, list.length - 1)));
  const scroll = Math.max(0, Math.min(d.scroll | 0, Math.max(0, list.length - vh)));

  const lines = [];
  if (list.length === 0) {
    lines.push('[dim]  (no warnings or errors)[/]');
  } else {
    for (let i = 0; i < vh; i++) {
      const idx = scroll + i;
      const ev = list[idx];
      if (!ev) { lines.push(''); continue; }
      const glyph = LEVEL_GLYPH[ev.level] || '⚠';
      const color = LEVEL_COLOR[ev.level] || 'yellow';
      const age = _fmtAge(ev.t, now).padStart(TIME_W);
      const code = esc(ev.code).slice(0, CODE_W).padEnd(CODE_W);
      const message = _msg(ev.message, msgW);
      lines.push(idx === cursor
        ? `[reverse]${glyph} ${age} ${code} ${message}[/]`
        : `[${color}]${glyph}[/] [dim]${age}[/] [dim]${code}[/] ${message}`);
    }
  }
  lines.push('');
  lines.push('[dim]\\[↑/↓] nav   \\[g/G] top/bottom   \\[y] copy   \\[c] clear   \\[s] save   \\[Esc] close[/]');

  renderOverlay({
    lines, title: 'Diagnostics',
    maxWidth: wantW,
    count: list.length ? [cursor + 1, list.length] : undefined,
  });
}

module.exports = { renderDiagLog, viewportRows };
