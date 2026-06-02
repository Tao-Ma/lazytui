/**
 * Pure derivations over the panel pool.
 *
 * `arrange.pool` is the v0.6 pool of configured panels (id → entry).
 * `arrange.columns[i].panels` are the placed cells — the grid the user
 * actually sees, ordered left-to-right by column index. Pool entries
 * with no corresponding placement are *hidden* (still configured, not
 * currently in the grid; the free-config overlay shows them so users
 * can summon them back).
 *
 * Everything here takes a layout `arrange` struct as input and returns
 * fresh values. No model access, no side effects — same shape as the
 * `leaves/free-config` leaf next door. Tests drive these directly.
 */
'use strict';

const mpane = require('./pane');

// --- columns[] structural helpers -------------------------------------

function columnCount(arrange) {
  return (arrange && arrange.columns && arrange.columns.length) || 0;
}

function lastColumnIndex(arrange) {
  return columnCount(arrange) - 1;
}

function getColumn(arrange, columnIndex) {
  if (!arrange || !arrange.columns) return null;
  return arrange.columns[columnIndex] || null;
}

function columnPanels(arrange, columnIndex) {
  const c = getColumn(arrange, columnIndex);
  return c ? (c.panels || []) : [];
}

function lastColumnPanels(arrange) {
  return columnPanels(arrange, lastColumnIndex(arrange));
}

function allPanesInColumns(arrange) {
  if (!arrange || !arrange.columns) return [];
  const out = [];
  for (const c of arrange.columns) {
    if (c && Array.isArray(c.panels)) {
      for (const p of c.panels) out.push(p);
    }
  }
  return out;
}

/** Find the location of a pane matching `predicate(pane, columnIndex,
 *  paneIndex)`. Returns `{ columnIndex, paneIndex, pane }` or null. */
function findPaneLocation(arrange, predicate) {
  if (!arrange || !arrange.columns) return null;
  for (let ci = 0; ci < arrange.columns.length; ci++) {
    const panels = (arrange.columns[ci] && arrange.columns[ci].panels) || [];
    for (let pi = 0; pi < panels.length; pi++) {
      if (predicate(panels[pi], ci, pi)) {
        return { columnIndex: ci, paneIndex: pi, pane: panels[pi] };
      }
    }
  }
  return null;
}

/** Return a new arrange with column `columnIndex`'s panels replaced by
 *  `panelsFn(oldPanels)`. The column's other fields (width) survive. */
function updateColumn(arrange, columnIndex, panelsFn) {
  const cs = arrange.columns;
  const next = cs.slice();
  next[columnIndex] = { ...cs[columnIndex], panels: panelsFn(cs[columnIndex].panels || []) };
  return { ...arrange, columns: next };
}

// --- placement / hidden state ----------------------------------------

// "Placed" = mounted as a tab in some pane. For multi-tab panes
// (v0.6.1) every tab's pool id counts, not just the active one — so
// non-active tabs don't drift into `hiddenIds` (which would let
// `:show` mount the same pool entry as a duplicate pane). Defensive
// fallback to `p.id` for fixtures that bypass wrapAsPane and ship no
// `tabs[]` array.
function placedIds(arrange) {
  if (!arrange) return [];
  const out = [];
  for (const p of allPanesInColumns(arrange)) {
    if (!p) continue;
    if (Array.isArray(p.tabs) && p.tabs.length > 0) {
      for (const t of p.tabs) if (t && t.poolId) out.push(t.poolId);
    } else if (p.id) {
      out.push(p.id);
    }
  }
  return out;
}

// Pool ids of active tabs only — the "pane identity" ids. Drives
// :hide cmdline completion ("which pane to remove") since the
// pool_hide handler still locates panes by their active tab's id.
function activePaneIds(arrange) {
  if (!arrange) return [];
  const out = [];
  for (const p of allPanesInColumns(arrange)) if (p && p.id) out.push(p.id);
  return out;
}

function placedIdSet(arrange) {
  return new Set(placedIds(arrange));
}

function hiddenIds(arrange) {
  if (!arrange || !arrange.pool) return [];
  const placed = placedIdSet(arrange);
  return Object.keys(arrange.pool).filter(id => !placed.has(id));
}

function isPlaced(arrange, id) {
  return placedIdSet(arrange).has(id);
}

function isHidden(arrange, id) {
  if (!arrange || !arrange.pool) return false;
  if (!(id in arrange.pool)) return false;
  return !placedIdSet(arrange).has(id);
}

function getPoolEntry(arrange, id) {
  if (!arrange || !arrange.pool) return null;
  return arrange.pool[id] || null;
}

/**
 * The pool/grid invariant: every placed cell's id resolves in the pool.
 * Returns an array of placed ids that DON'T have a pool entry — empty
 * array means the invariant holds. Pure check; callers decide how to
 * react (throw, log, repair). Phase 1 doesn't enforce, just exposes.
 */
function orphanPlacements(arrange) {
  if (!arrange) return [];
  if (!arrange.pool) return placedIds(arrange);  // no pool → everything orphan
  const out = [];
  for (const id of placedIds(arrange)) {
    if (!(id in arrange.pool)) out.push(id);
  }
  return out;
}

/**
 * Build the ordered item list for the panel-list overlay (v0.6 Phase 4).
 * Placed entries come first (in column-major grid order), hidden
 * entries after (in pool insertion order). Each item carries a status
 * marker the overlay uses to style + decide pick semantics:
 *
 *   placed     — currently in the grid; pick = hide (unplaces it)
 *   essential  — placed AND type === 'detail'; pick = no-op (the
 *                layout invariant requires exactly one detail panel,
 *                so the overlay surfaces it as essential rather than
 *                offering a hide that would refuse)
 *   hidden     — in pool but not placed; pick = show
 */
function panelListItems(arrange) {
  if (!arrange || !arrange.pool) return [];
  const items = [];
  const seen = new Set();
  for (const p of allPanesInColumns(arrange)) {
    if (!p || !p.id) continue;
    const entry = arrange.pool[p.id];
    if (!entry) continue;
    const status = isDetailPane(entry) ? 'essential' : 'placed';
    items.push({ id: entry.id, type: entry.type, title: entry.title, status });
    seen.add(entry.id);
  }
  for (const id of Object.keys(arrange.pool)) {
    if (seen.has(id)) continue;
    const entry = arrange.pool[id];
    items.push({ id: entry.id, type: entry.type, title: entry.title, status: 'hidden' });
  }
  return items;
}

/** Build a runtime placement object from a pool entry. Mirrors the
 *  flattening that `leaves/arrange.rebuildLayoutFromConfig` does on initial load —
 *  plugin-specific config spread first, framework fields override.
 *  Shared between `panel/layout.js#pool_show` (the actual commit on
 *  release / cmdline `:show`) and the drag-preview path in
 *  `leaves/free-config-pool-drag.js#computePoolDragPreviewArrange` so both
 *  produce identical placements. */
function placementFromPoolEntry(entry, columnIndex) {
  return mpane.wrapAsPane({
    ...(entry.config || {}),
    id: entry.id,
    type: entry.type,
    title: entry.title,
    hotkey: '',
    columnIndex,
  }, mpane.newPaneId(entry.id));
}

// --- Detail / actions accessors ------------------------------------------
//
// The "is this THE detail pane?" question is asked in ~30 sites scattered
// across the renderer, design rules, layout reducer, serializer, parser,
// and viewer Component. Today the answer is `pane.type === 'detail'` —
// the legacy Panel field that mirrors the active tab's kind. Routing
// every reader through these helpers lets the multi-instance / per-tab
// kind lookup (v0.7) change the implementation here without touching
// consumers. Same for actions (the second reserved-kind invariant).
//
// `isReservedPane` is the combined "detail OR actions" check that
// appears in column-placement and design-rule guards.

function isDetailPane(pane) {
  return !!(pane && pane.type === 'detail');
}

function isActionsPane(pane) {
  return !!(pane && pane.type === 'actions');
}

function isReservedPane(pane) {
  return isDetailPane(pane) || isActionsPane(pane);
}

/** Find the detail pane in an arrange struct. Defensively scans every
 *  column even though the layout invariant places it in the last
 *  column's last cell — keeps consumers honest under in-flight
 *  migrations (drag, swap) where transient state can violate the
 *  invariant. Returns the pane object or null. */
function findDetailPane(arrange) {
  if (!arrange) return null;
  // Last column first — the canonical home.
  const last = lastColumnPanels(arrange);
  for (const p of last) if (isDetailPane(p)) return p;
  // Then scan earlier columns (transient-state defense).
  if (!arrange.columns) return null;
  for (let ci = 0; ci < arrange.columns.length - 1; ci++) {
    const panels = (arrange.columns[ci] && arrange.columns[ci].panels) || [];
    for (const p of panels) if (isDetailPane(p)) return p;
  }
  return null;
}

/** Index of the detail pane within the LAST column, or -1. The last
 *  column is the canonical home; callers wanting "detail anywhere" use
 *  `findDetailPane`. */
function detailPaneIndex(arrange) {
  if (!arrange) return -1;
  return lastColumnPanels(arrange).findIndex(isDetailPane);
}

/** True if `arrange` (or its placed panes) already hosts a detail pane.
 *  Used by pool_show / drag-insert to refuse adding a second. */
function hasDetailPane(arrange) {
  return findDetailPane(arrange) !== null;
}

/** True if `arrange` already hosts an actions pane. */
function hasActionsPane(arrange) {
  if (!arrange) return false;
  return allPanesInColumns(arrange).some(isActionsPane);
}

module.exports = {
  columnCount, lastColumnIndex, getColumn,
  columnPanels, lastColumnPanels,
  allPanesInColumns, findPaneLocation, updateColumn,
  placedIds,
  placedIdSet,
  activePaneIds,
  hiddenIds,
  isPlaced,
  isHidden,
  getPoolEntry,
  orphanPlacements,
  panelListItems,
  placementFromPoolEntry,
  isDetailPane, isActionsPane, isReservedPane,
  findDetailPane, detailPaneIndex,
  hasDetailPane, hasActionsPane,
};
