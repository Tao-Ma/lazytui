/**
 * visibleTerminalSurfaces — the single source of "which terminal grids are on
 * screen this frame", shared by the terminal OVERLAY (render/paint.js) and the
 * #D15 overlay-repaint poll gate (app/state.js#_termTabOnScreen) so the two can
 * never disagree about whether a terminal is visible (U2d P0b).
 *
 * A surface = { id (PTY session id == the terminal tab-instance id), bounds (the
 * pane's rect), focused (holds keyboard focus → gets the hardware cursor) }.
 * Every visible `terminal`-kind pane instance is a surface, derived PURELY from
 * the arrange (a pane whose ACTIVE tab's pool entry type === 'terminal'); the
 * ptyId === the tab-instance id (`pane-<poolId>`), matching the finalizer's PTY
 * reconcile and the orphan-dispose destroySession.
 *
 * (U2d P2b — the legacy viewer-content-tab terminal source is GONE: terminals
 * are their own panes now, so there is exactly one producer.)
 *
 * `arrangeOverride` (render's free-config drag preview) shifts the bounds to the
 * would-be-after-release layout; the poll gate omits it.
 *
 * Pure leaves (geometry/pool/pane) are required at top; the panel siblings
 * (route/api) are required lazily to stay clear of load cycles — this module is
 * called at render/dispatch time, never at load.
 */
'use strict';

const geo = require('../leaves/wm/geometry');
const mpool = require('../leaves/wm/pool');
const mpane = require('../leaves/wm/pane');

function visibleTerminalSurfaces(model, arrangeOverride) {
  const route = require('./route');
  const api = require('./api');
  const layoutSlice = api.getInstanceSlice('layout');
  if (!layoutSlice || !layoutSlice.arrange) return [];
  const boundsSlice = arrangeOverride ? { ...layoutSlice, arrange: arrangeOverride } : layoutSlice;
  const viewerPaneId = route.resolveViewerPaneId();
  const terminalMode = !!(model && model.modes && model.modes.terminalMode);
  const out = [];

  // `terminal`-kind pane instances — walk the arrange, keep panes whose ACTIVE
  // tab is a terminal (a backgrounded terminal tab isn't visible, so isn't painted;
  // its PTY still runs). visibleBoundsFor null → off-screen in half/full → skip.
  const focus = route.getFocus();
  const pool = layoutSlice.arrange.pool || {};
  for (const p of mpool.allPanesInColumns(layoutSlice.arrange)) {
    if (!p.paneId) continue;
    const poolId = p.activeTabId;
    const entry = poolId && pool[poolId];
    if (!entry || entry.type !== 'terminal') continue;
    const b = geo.visibleBoundsFor(boundsSlice, p.paneId, viewerPaneId);
    if (!b) continue;
    out.push({ id: mpane.newPaneId(poolId), bounds: b, focused: terminalMode && focus === p.paneId });
  }
  return out;
}

// The PTY session id for the FOCUSED pane's terminal — a minted `terminal` pane
// (id == its tab-instance id), or null when the focused pane isn't a terminal.
// The single resolver for "which PTY receives input" (dispatch/control/input.js)
// + "which terminal does Enter activate" (dispatch/control/actions.js).
function focusedTerminalId() {
  const route = require('./route');
  const focus = route.getFocus();
  if (focus != null && route.instanceKind(focus) === 'terminal') return route.activeInstanceOf(focus);
  return null;
}

// The FOCUSED terminal pane's label (its `{cmd,label}` config), for the
// terminalMode footer. null when the focused pane isn't a terminal.
function focusedTerminalLabel() {
  const route = require('./route');
  const focus = route.getFocus();
  if (focus == null || route.instanceKind(focus) !== 'terminal') return null;
  const id = route.activeInstanceOf(focus);
  if (!id) return null;
  const slice = require('./api').getInstanceSlice(id);
  return (slice && slice.label) || null;
}

module.exports = { visibleTerminalSurfaces, focusedTerminalId, focusedTerminalLabel };
