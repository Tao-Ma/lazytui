/**
 * Search/filter — press / to filter any list panel.
 * Filters actions by label, file-manager by path, plugin panels by item.
 * Zero dependencies (uses local modules).
 */
'use strict';

const { getModel } = require('./runtime');

// Filter mode lives in the reducer (runtime.update: filter_enter /
// filter_key / filter_exit). The live editing draft is model.modal.filter
// {text, panel}; the COMMITTED per-panel filter text is `slice.nav[panel]
// .filter` (Phase 4c — same per-Navigator nav slice as cursor/scroll/
// multiSel). This module is the read-side FACADE — getFilter/matches are
// re-exported through the Component API so getItems can filter rows.

/**
 * Get the active filter text for a panel. While in filter mode, the live
 * (uncommitted) draft is returned for the panel being edited; other panels
 * see their committed value from `slice.nav[panel].filter`.
 */
function getFilter(panelType) {
  const m = getModel();
  if (m.modes.filterMode && m.modal.filter.panel === panelType) return m.modal.filter.text;
  const api = require('./components/api');
  const compName = api.getComponentOwningPanel(panelType);
  if (!compName) return '';
  const slice = api.getComponentSlice(compName);
  const entry = slice && slice.nav && slice.nav[panelType];
  return (entry && entry.filter) || '';
}

/**
 * Live filter text for the currently-active filter session — used by
 * renderFooter to paint the `/text │` prompt without needing to know
 * which panel is being filtered.
 */
function currentText() { return getModel().modal.filter.text; }

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
  getFilter, currentText, hasFilter, matches,
};
