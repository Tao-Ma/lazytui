/**
 * Search/filter — press / to filter any list panel.
 * Filters actions by label, file-manager by path, plugin panels by item.
 * Zero dependencies (uses local modules).
 */
'use strict';

const { S, setSel, setScroll } = require('./state');

// Module-private mode state. S.filterMode (the flag) stays on S so
// the render conductor / footer / dispatch modeChain can detect
// overlay-active. The buffers (live text, panel target) are
// transient per-session and live here.
//
// `getPanelDef` is required lazily inside enterFilter() because
// `plugins/api` imports `./filter` (to re-export getFilter as part of
// the plugin facade — see PLUGINS.md). Top-level require here would
// be a partial-object read at module-load time.
let _text = '';
let _panel = '';

/**
 * Enter filter mode for the focused panel.
 * Filterable panels declare `filterable: true` on their plugin panelDef.
 * Returns false if the focused panel is not filterable.
 */
function enterFilter() {
  const { getPanelDef } = require('./plugins/api');
  const def = getPanelDef(S.focus);
  if (!def || !def.filterable) return false;
  S.filterMode = true;
  _text = S.filters[S.focus] || '';
  _panel = S.focus;
  return true;
}

/**
 * Exit filter mode.
 * @param {boolean} keep - true to keep the filter, false to clear it
 */
function exitFilter(keep) {
  if (keep && _text) {
    S.filters[_panel] = _text;
  } else {
    delete S.filters[_panel];
  }
  S.filterMode = false;
  const wasPanel = _panel;
  _text = '';
  _panel = '';
  if (wasPanel) {
    setSel(wasPanel, 0);
    setScroll(wasPanel, 0);
  }
}

/**
 * Handle a single keystroke during filter mode. Returns true if state
 * changed (caller should re-render); false if the key was ignored.
 *
 * Backspace (\x7f) shortens the buffer; printable chars (>= 0x20)
 * append. Navigation/return/escape are dispatched in dispatch.js
 * (filter mode shares ↑↓ with normal navigation, and Esc/Enter exit).
 */
function keystroke(seq) {
  if (seq === '\x7f') {
    if (_text.length === 0) return false;
    _text = _text.slice(0, -1);
    setSel(_panel, 0);
    return true;
  }
  if (seq && seq.length === 1 && seq.charCodeAt(0) >= 32) {
    _text += seq;
    setSel(_panel, 0);
    return true;
  }
  return false;
}

/**
 * Get the active filter text for a panel. While in filter mode, the
 * live (uncommitted) buffer is returned for the active panel; other
 * panels see their committed value from `S.filters`.
 */
function getFilter(panelType) {
  if (S.filterMode && _panel === panelType) return _text;
  return S.filters[panelType] || '';
}

/**
 * Live filter text for the currently-active filter session — used by
 * renderFooter to paint the `/text │` prompt without needing to know
 * which panel is being filtered.
 */
function currentText() { return _text; }

/**
 * Check if a panel has an active filter.
 */
function hasFilter(panelType) {
  return !!getFilter(panelType);
}

/**
 * Test if text matches a panel's filter (case-insensitive substring).
 */
function matches(text, panelType) {
  const f = getFilter(panelType);
  if (!f) return true;
  return text.toLowerCase().includes(f.toLowerCase());
}

module.exports = {
  enterFilter, exitFilter, keystroke,
  getFilter, currentText, hasFilter, matches,
};
