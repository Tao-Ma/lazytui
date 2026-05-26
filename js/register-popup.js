/**
 * Register history popup — opened with `"` from normal mode.
 *
 * Modal overlay that lists every entry currently held in the yank
 * register's history (S.register.history), from newest at top to oldest.
 * Used to recall an older yank: highlighting it and pressing Enter
 * promotes that entry to the top (and re-emits OSC52 so the OS
 * clipboard tracks the choice). `d` drops the highlighted entry.
 *
 * Bindings (modeChain handler):
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
 * default, capped by terminal height); `_scroll` tracks the topmost
 * visible row so cap=100 stays usable.
 */
'use strict';

const { S } = require('./state');
const { esc, visibleLen } = require('./ansi');
const { renderOverlay } = require('./panel');
const register = require('./register');

// Per-popup transient state. Lives module-private so toggling the
// popup off and on starts fresh.
let _idx = 0;
let _scroll = 0;
const VIEWPORT = 12;

function _viewportRows() {
  const { rows } = require('./term');
  // Leave breathing room for popup borders + count footer + screen edges.
  return Math.max(3, Math.min(VIEWPORT, rows() - 6));
}

function _clamp() {
  const n = register.historyLen();
  if (n === 0) { _idx = 0; _scroll = 0; return; }
  if (_idx < 0) _idx = 0;
  if (_idx >= n) _idx = n - 1;
  const vh = _viewportRows();
  if (_idx < _scroll) _scroll = _idx;
  if (_idx >= _scroll + vh) _scroll = _idx - vh + 1;
  if (_scroll < 0) _scroll = 0;
}

function enter() {
  _idx = 0;
  _scroll = 0;
  S.registerPopupMode = true;
}

function exit() {
  S.registerPopupMode = false;
}

function _previewOf(text) {
  // Replace newlines + tabs with visible glyphs so each row stays a
  // single line. Truncation is per-row in renderOverlay's width budget.
  return String(text).replace(/\n/g, '↵').replace(/\t/g, ' ');
}

function handleKey(key, seq) {
  if (key === 'escape') { exit(); return; }
  if (key === 'return') {
    if (register.historyLen() > 0 && _idx > 0) register.promote(_idx);
    // If _idx is 0, "promote" is a no-op — the entry is already top,
    // but we still want OSC52 to refresh the OS clipboard so a user
    // who opened the popup just to copy the current top gets that.
    else if (register.historyLen() > 0 && _idx === 0) {
      // Re-emit via register.push (dedup-on-top will skip the prepend
      // but still calls emitOSC52).
      register.push(register.top());
    }
    exit();
    return;
  }
  if (key === 'down' || seq === 'j') { _idx++; _clamp(); return; }
  if (key === 'up'   || seq === 'k') { _idx--; _clamp(); return; }
  if (seq === 'g')                   { _idx = 0; _clamp(); return; }
  if (seq === 'G')                   { _idx = register.historyLen() - 1; _clamp(); return; }
  if (seq === 'd') {
    if (register.historyLen() === 0) return;
    register.drop(_idx);
    // _idx stays on the row that the next-older entry just slid into;
    // _clamp brings it back inside bounds if we dropped the last entry.
    _clamp();
    // Drop can shrink the popup by 1 row (when historyLen falls below
    // the viewport). The main-paint diff doesn't see the overlay's
    // geometry — the now-uncovered row keeps the old popup's bottom
    // border sitting on screen below the new one. Force a full
    // repaint so the underlying panels reclaim that row. Required
    // require to dodge the module cycle (layout already imports us).
    require('./layout').forceFullRepaint();
    // If history is now empty, close — nothing to do.
    if (register.historyLen() === 0) exit();
    return;
  }
}

function render() {
  if (!S.registerPopupMode) return;
  const n = register.historyLen();
  const vh = _viewportRows();
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

module.exports = { enter, exit, handleKey, render };
