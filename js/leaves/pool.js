/**
 * Pure derivations over the panel pool.
 *
 * `arrange.pool` is the v0.6 pool of configured panels (id → entry).
 * `arrange.leftPanels` / `arrange.rightPanels` are the placed cells —
 * the grid the user actually sees. Pool entries with no corresponding
 * placement are *hidden* (still configured, not currently in the grid;
 * the free-config overlay shows them so users can summon them back).
 *
 * Everything here takes a layout `arrange` struct as input and returns
 * fresh values. No model access, no side effects — same shape as the
 * `leaves/design` leaf next door. Tests drive these directly.
 */
'use strict';

const mpane = require('./pane');

// "Placed" = mounted as a tab in some pane. For multi-tab panes
// (v0.6.1) every tab's pool id counts, not just the active one — so
// non-active tabs don't drift into `hiddenIds` (which would let
// `:show` mount the same pool entry as a duplicate pane). Defensive
// fallback to `p.id` for fixtures that bypass wrapAsPane and ship no
// `tabs[]` array.
function placedIds(arrange) {
  if (!arrange) return [];
  const left  = arrange.leftPanels  || [];
  const right = arrange.rightPanels || [];
  const out = [];
  const collect = (p) => {
    if (!p) return;
    if (Array.isArray(p.tabs) && p.tabs.length > 0) {
      for (const t of p.tabs) if (t && t.poolId) out.push(t.poolId);
    } else if (p.id) {
      out.push(p.id);
    }
  };
  for (const p of left)  collect(p);
  for (const p of right) collect(p);
  return out;
}

// Pool ids of active tabs only — the "pane identity" ids. Drives
// :hide cmdline completion ("which pane to remove") since the
// pool_hide handler still locates panes by their active tab's id.
function activePaneIds(arrange) {
  if (!arrange) return [];
  const left  = arrange.leftPanels  || [];
  const right = arrange.rightPanels || [];
  const out = [];
  for (const p of left)  if (p && p.id) out.push(p.id);
  for (const p of right) if (p && p.id) out.push(p.id);
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
 * Placed entries come first (in left-then-right grid order), hidden
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
  const pushPlacement = (p) => {
    const entry = arrange.pool[p.id];
    if (!entry) return;
    const status = entry.type === 'detail' ? 'essential' : 'placed';
    items.push({ id: entry.id, type: entry.type, title: entry.title, status });
    seen.add(entry.id);
  };
  for (const p of arrange.leftPanels  || []) if (p && p.id) pushPlacement(p);
  for (const p of arrange.rightPanels || []) if (p && p.id) pushPlacement(p);
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
 *  `leaves/design-pool-drag.js#computePoolDragPreviewArrange` so both
 *  produce identical placements. */
function placementFromPoolEntry(entry, column) {
  return mpane.wrapAsPane({
    ...(entry.config || {}),
    id: entry.id,
    type: entry.type,
    title: entry.title,
    hotkey: '',
    column,
  }, mpane.newPaneId(entry.id));
}

module.exports = {
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
};
