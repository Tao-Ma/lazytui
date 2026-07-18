/**
 * Per-pane selection ENABLEMENT (docs/pane-selection.md). Resolves whether text
 * selection is on for a given pane:
 *
 *   - GLOBAL default: top-level `selection:` in YAML (default ON).
 *   - PER-PANE override: `select:` on the panel's pool entry, which the arrange
 *     spreads onto the placed panel object (leaves/wm/pool.placementFromPoolEntry).
 *
 * Panel-layer module — reads the parsed config (model) + the placed panels.
 */
'use strict';

const { getModel } = require('../model/store');

/** True iff text selection is enabled for `paneId` (per-pane override, else the
 *  global default). A null/unknown pane resolves to the global default. */
function selectionEnabledFor(paneId) {
  const m = getModel();
  const globalOn = !(m && m.config && m.config.selection === false);   // default true
  if (!paneId) return globalOn;
  const p = require('./nav-state').allPanels().find((x) => x && x.paneId === paneId);
  if (p && typeof p.select === 'boolean') return p.select;             // per-pane wins
  return globalOn;
}

module.exports = { selectionEnabledFor };
