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

// --- column width distribution ---------------------------------------
//
// Single source of truth for "what's each column's x-range given the
// terminal width". Both the renderer (paints columns) and the mouse
// hit-tester (routes clicks/drags to a column) call this — they MUST
// agree, otherwise a click lands in the wrong column on narrow
// terminals where the squeeze kicks in. Returns
// `[{columnIndex, x, w}, ...]` in order.
//
// Explicit widths come from `columns[i].width` (default 30) for cols
// 0..N-2. The last column is implicit — takes the remainder.
// Narrow-terminal adaptive: if the remainder would be < MIN_LAST_COL_W,
// the explicit columns are squeezed proportionally so the last column
// still gets MIN_LAST_COL_W; each donor stays >= MIN_COL_W.

const MIN_LAST_COL_W = 20;
const MIN_COL_W = 10;
const DEFAULT_COL_W = 30;

function distributeColumnWidths(arrange, COLS) {
  const columns = (arrange && arrange.columns) || [];
  const N = columns.length;
  if (N === 0) return [];
  const explicit = [];
  for (let i = 0; i < N - 1; i++) {
    const w = columns[i].width != null ? columns[i].width : DEFAULT_COL_W;
    explicit.push(w);
  }
  const sumExplicit = explicit.reduce((s, w) => s + w, 0);
  let lastW = COLS - sumExplicit;
  if (lastW < MIN_LAST_COL_W) {
    const target = Math.max(0, COLS - MIN_LAST_COL_W);
    const scale = sumExplicit > 0 ? target / sumExplicit : 0;
    for (let i = 0; i < explicit.length; i++) {
      explicit[i] = Math.max(MIN_COL_W, Math.floor(explicit[i] * scale));
    }
    lastW = Math.max(MIN_LAST_COL_W, COLS - explicit.reduce((s, w) => s + w, 0));
  }
  const out = [];
  let x = 0;
  for (let i = 0; i < N; i++) {
    const w = (i === N - 1) ? Math.max(1, lastW) : explicit[i];
    out.push({ columnIndex: i, x, w });
    x += w;
  }
  return out;
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
  // v0.6.4 multi-viewer — a detail pane is 'essential' (unhideable) ONLY
  // when it's the last remaining viewer; with ≥2 viewers each is an
  // ordinary 'placed' (hideable) entry, since hiding one still leaves a
  // viewer to route to.
  const soleDetail = detailPaneCount(arrange) <= 1;
  for (const p of allPanesInColumns(arrange)) {
    if (!p || !p.id) continue;
    const entry = arrange.pool[p.id];
    if (!entry) continue;
    const status = (isDetailPane(entry) && soleDetail) ? 'essential' : 'placed';
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
// across the renderer, free-config rules, layout reducer, serializer, parser,
// and viewer Component. Today the answer is `pane.type === 'detail'` —
// the legacy Panel field that mirrors the active tab's kind. Routing
// every reader through these helpers lets the multi-instance / per-tab
// kind lookup (v0.7) change the implementation here without touching
// consumers. Same for actions (the second reserved-kind invariant).

function isDetailPane(pane) {
  return !!(pane && pane.type === 'detail');
}

function isActionsPane(pane) {
  return !!(pane && pane.type === 'actions');
}

/** All detail panes in arrange order (last column first, then earlier).
 *  v0.6.4 multi-viewer — the count/position-agnostic accessor used
 *  wherever "every viewer" is meant. */
function findAllDetailPanes(arrange) {
  if (!arrange || !arrange.columns) return [];
  const out = [];
  for (const p of lastColumnPanels(arrange)) if (isDetailPane(p)) out.push(p);
  for (let ci = 0; ci < arrange.columns.length - 1; ci++) {
    const panels = (arrange.columns[ci] && arrange.columns[ci].panels) || [];
    for (const p of panels) if (isDetailPane(p)) out.push(p);
  }
  return out;
}

/** Number of placed detail panes. */
function detailPaneCount(arrange) {
  return findAllDetailPanes(arrange).length;
}

/** True if `arrange` already hosts an actions pane. */
function hasActionsPane(arrange) {
  if (!arrange) return false;
  return allPanesInColumns(arrange).some(isActionsPane);
}

/**
 * Build the ordered item list for the pane-select overlay (v0.6.3 D2).
 * Lists every non-detail pool entry tagged by status relative to the
 * target paneId's current occupant:
 *
 *   here       — the target slot's current occupant (pick = close
 *                no-op).
 *   placed     — placed elsewhere; carries `columnIndex` for the
 *                overlay label "[in col N]". Pick = SWAP (D3).
 *   hidden     — in pool but not placed. Pick = REPLACE (D3, the
 *                target's old occupant goes to pool).
 *
 * Items returned in stable order: placed entries first in column-major
 * grid order, hidden entries after in pool insertion order. The 'here'
 * entry lives wherever it lands in that order — it's just a placed
 * entry with a different status string.
 *
 * Detail is excluded entirely (the spec invariant: detail can't be
 * picked anywhere). Actions is INCLUDED so the user sees it as
 * 'placed [in col N]'; the D3 validity guard refuses any pick that
 * would land actions in a non-last column.
 */
function paneSelectItems(arrange, targetPaneId) {
  if (!arrange || !arrange.pool) return [];
  const items = [];
  // `allPlaced` covers EVERY tab poolId, not just the active tab —
  // non-active tabs of a multi-tab pane are "placed" too (they live
  // inside a placed pane) and must NOT drift into the hidden bucket.
  const allPlaced = placedIdSet(arrange);
  // Walk placed panes in column-major order, skipping detail. One
  // item per pane (keyed by the active tab's pool id) — non-active
  // tabs are managed via tab-list on the detail pane, not here.
  for (let ci = 0; ci < (arrange.columns || []).length; ci++) {
    const panels = (arrange.columns[ci] && arrange.columns[ci].panels) || [];
    for (const p of panels) {
      if (!p || !p.id) continue;
      if (isDetailPane(p)) continue;
      const entry = arrange.pool[p.id];
      if (!entry) continue;
      const status = (p.paneId === targetPaneId) ? 'here' : 'placed';
      items.push({
        id: entry.id, type: entry.type, title: entry.title,
        status, columnIndex: ci,
      });
    }
  }
  // Hidden entries in pool insertion order. `allPlaced` excludes
  // non-active multi-tab tabs from this bucket (else picking one
  // would route through REPLACE and double-place the id).
  for (const id of Object.keys(arrange.pool)) {
    if (allPlaced.has(id)) continue;
    const entry = arrange.pool[id];
    if (isDetailPane(entry)) continue;
    items.push({
      id: entry.id, type: entry.type, title: entry.title,
      status: 'hidden', columnIndex: null,
    });
  }
  return items;
}

/** v0.6.4 #1 Step 2 — the Panes section for the unified `[≡]` pane-menu.
 *  Like paneSelectItems but:
 *    - INCLUDES viewers (no detail exclusion) — so two viewers can be
 *      placed side-by-side in half view;
 *    - carries each placed entry's `paneId` (view_place_pane / focus_set
 *      address panes by paneId, not pool id);
 *    - `mode` gates the hidden bucket: 'normal' lists placed + hidden
 *      (pool_swap can place a hidden entry); 'half'/'full' list PLACED
 *      ONLY (a projection can only show / focus an already-placed pane).
 *  Each item: { id, paneId|null, type, title, status:'here'|'placed'|
 *  'hidden', columnIndex|null }. */
function paneMenuPanes(arrange, targetPaneId, mode) {
  if (!arrange || !arrange.pool) return [];
  const includeHidden = mode === 'normal' || mode == null;
  const items = [];
  for (let ci = 0; ci < (arrange.columns || []).length; ci++) {
    const panels = (arrange.columns[ci] && arrange.columns[ci].panels) || [];
    for (const p of panels) {
      if (!p || !p.id) continue;
      const entry = arrange.pool[p.id];
      if (!entry) continue;
      const status = (p.paneId === targetPaneId) ? 'here' : 'placed';
      items.push({
        id: entry.id, paneId: p.paneId || null, type: entry.type,
        title: entry.title, status, columnIndex: ci,
      });
    }
  }
  if (includeHidden) {
    const allPlaced = placedIdSet(arrange);
    for (const id of Object.keys(arrange.pool)) {
      if (allPlaced.has(id)) continue;
      const entry = arrange.pool[id];
      items.push({
        id: entry.id, paneId: null, type: entry.type, title: entry.title,
        status: 'hidden', columnIndex: null,
      });
    }
  }
  return items;
}

module.exports = {
  columnCount, lastColumnIndex, getColumn,
  columnPanels, lastColumnPanels,
  allPanesInColumns, findPaneLocation, updateColumn,
  distributeColumnWidths,
  placedIds,
  placedIdSet,
  activePaneIds,
  hiddenIds,
  isPlaced,
  isHidden,
  getPoolEntry,
  orphanPlacements,
  panelListItems,
  paneSelectItems,
  paneMenuPanes,
  placementFromPoolEntry,
  isDetailPane, isActionsPane,
  findAllDetailPanes, detailPaneCount,
  hasActionsPane,
};
