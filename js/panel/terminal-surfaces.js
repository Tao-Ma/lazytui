/**
 * visibleTerminalSurfaces — the single source of "which terminal grids are on
 * screen this frame", shared by the terminal OVERLAY (render/paint.js) and the
 * #D15 overlay-repaint poll gate (app/state.js#_termTabOnScreen) so the two can
 * never disagree about whether a terminal is visible (U2d P0b).
 *
 * A surface = { id (PTY session id == the terminal tab-instance id), poolId,
 * bounds (the pane's rect), cols/rows (its interior — the PTY's size), focused
 * (holds keyboard focus → gets the hardware cursor), closable (`x` can close the
 * tab — not a slot's last) }.
 * Every visible `terminal`-kind pane instance WITH AN INTERIOR (terminalInterior
 * below) is a surface, derived PURELY from the arrange (a pane whose ACTIVE tab's
 * pool entry type === 'terminal'); the ptyId === the tab-instance id
 * (`pane-<poolId>`), matching the orphan-dispose destroySession. The finalizer's
 * PTY reconcile (dispatch/runtime/finalize.js) and Enter's activate
 * (dispatch/control/actions.js) read this selector too — one rule for "on
 * screen", so sizing, painting and typing can't disagree.
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

// The grid a pane rect can show inside its border, or null when there is none:
// a minimized pane is a 1-row bar, and a pane squeezed below 3 rows / 3 columns
// has no inner cell. A terminal with no interior is NOT a surface — the PTY is
// not sized to it (a 1-row bar gave `rows = -1`: resizeSession threw on every
// dispatch while the pane stayed minimized), the overlay does not paint it (the
// vanish reclaim then clears the grid it last painted), and Enter does not type
// into it. Field report 2026-11-14 (an nvim pane, minimized).
function terminalInterior(bounds) {
  if (!bounds) return null;
  const cols = bounds.w - 2, rows = bounds.h - 2;
  return (cols >= 1 && rows >= 1) ? { cols, rows } : null;
}

// Can `x` close this terminal tab? remove_tab (leaves/wm/pane removeTab)
// refuses a slot's last tab, so a terminal alone in its slot (a configured
// `type: terminal` pane) stays put — `x` is the menu there, and nothing may
// offer `x close` for it (field report 2026-11-14: the exit banner did).
function _closable(pane) { return ((pane && pane.tabs) || []).length > 1; }

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
    const inner = terminalInterior(b);
    if (!inner) continue;
    out.push({ id: mpane.newPaneId(poolId), poolId, bounds: b,
               cols: inner.cols, rows: inner.rows,
               focused: terminalMode && focus === p.paneId,
               closable: _closable(p) });
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

// What the FOCUSED terminal pane's keys do right now, for the footer and `x`:
// null when the focus isn't a terminal; else { id, dead (the child exited —
// Enter restarts), closable (`x` closes the tab; else `x` is the menu),
// onScreen (a surface — has an interior; Enter types into it / restarts it) }.
function focusedTerminalState(model) {
  const id = focusedTerminalId();
  if (!id) return null;
  const route = require('./route');
  const api = require('./api');
  const layoutSlice = api.getInstanceSlice('layout');
  const focus = route.getFocus();
  const pane = layoutSlice && layoutSlice.arrange &&
    mpool.allPanesInColumns(layoutSlice.arrange).find(p => p.paneId === focus);
  return {
    id,
    dead: require('../io/terminal').isSessionDead(id),
    closable: _closable(pane),
    onScreen: visibleTerminalSurfaces(model).some(s => s.id === id),
  };
}

module.exports = { visibleTerminalSurfaces, focusedTerminalId, focusedTerminalLabel, focusedTerminalState };
