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

function placedIds(arrange) {
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

module.exports = {
  placedIds,
  placedIdSet,
  hiddenIds,
  isPlaced,
  isHidden,
  getPoolEntry,
  orphanPlacements,
};
