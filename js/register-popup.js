/**
 * Register history popup — opened with `"` from normal mode.
 *
 * Modal overlay that lists every entry currently held in the yank
 * register's history (model.register.history), from newest at top to
 * oldest. Used to recall an older yank: highlighting it and pressing Enter
 * promotes that entry to the top (and re-emits OSC52 so the OS
 * clipboard tracks the choice). `d` drops the highlighted entry.
 *
 * This module is RENDER-ONLY (+ the viewport-height helper the caller
 * needs to build nav Msgs). The cursor/scroll buffer + the key handling
 * folded into update (runtime: register_popup_* Msgs → model.modal.
 * registerPopup); the history mutations + OSC52 stay effects driven by the
 * register_* Cmds the effects layer interprets.
 *
 * Bindings (dispatch.handleRegisterPopupKey → register_popup_* Msgs):
 *   j / down   — move selection down
 *   k / up     — move selection up
 *   g          — jump to top
 *   G          — jump to bottom
 *   d          — drop highlighted entry (history adjusts; selection
 *                stays on the same row index, clamped to new length)
 *   Enter      — promote + emit OSC52 + close
 *   Esc        — close without changes
 *
 * Scrolling: the popup renders a fixed-height viewport (12 rows by
 * default, capped by terminal height); `model.modal.registerPopup.scroll`
 * tracks the topmost visible row so cap=100 stays usable.
 */
'use strict';

const { getModel } = require('./runtime');
const { esc, visibleLen } = require('./ansi');
const { renderOverlay } = require('./panel');
const register = require('./register');

const VIEWPORT = 12;

// Fixed-height viewport row count, capped by terminal height. Exported so
// the dispatch key handler can fold it into the nav/drop Msgs — the reducer
// stays free of the terminal-size read (view-derived, caller-resolved).
function viewportRows() {
  const { rows } = require('./term');
  // Leave breathing room for popup borders + count footer + screen edges.
  return Math.max(3, Math.min(VIEWPORT, rows() - 6));
}

function _previewOf(text) {
  // Replace newlines + tabs with visible glyphs so each row stays a
  // single line. Truncation is per-row in renderOverlay's width budget.
  return String(text).replace(/\n/g, '↵').replace(/\t/g, ' ');
}

function render() {
  if (!getModel().modes.registerPopupMode) return;
  const { idx: _idx, scroll: _scroll } = getModel().modal.registerPopup;
  const n = register.historyLen();
  const vh = viewportRows();
  // Index column width sized for `cap` so the gutter doesn't jitter
  // as entries are added/dropped.
  const idxWidth = String(Math.max(n, 1)).length;
  const overlayMaxW = 80;

  const lines = [];
  if (n === 0) {
    lines.push(`[dim]  (empty register — yank text in detail panel first)[/]`);
  } else {
    const end = Math.min(n, _scroll + vh);
    for (let i = _scroll; i < end; i++) {
      const indexStr = String(i + 1).padStart(idxWidth, ' ');
      const preview = _previewOf(register.at(i));
      // Budget = overlayMaxW - borders(2) - gutter for index + 2 spaces
      const budget = Math.max(8, overlayMaxW - 2 - idxWidth - 3);
      let text = preview;
      if (visibleLen(text) > budget) text = text.slice(0, budget - 1) + '…';
      const row = `  ${indexStr}  ${esc(text)}`;
      if (i === _idx) lines.push(`[reverse]${row}`);
      else            lines.push(row);
    }
  }

  // Footer hint row (added to lines so it sits inside the popup body,
  // visually separated from entries by a blank).
  lines.push('');
  lines.push(`[dim]j/k move · g/G ends · d drop · Enter promote · Esc close[/]`);

  renderOverlay({
    lines,
    title: `Register history (${n})`,
    count: n > 0 ? [_idx + 1, n] : null,
    maxWidth: overlayMaxW,
  });
}

module.exports = { render, viewportRows };
