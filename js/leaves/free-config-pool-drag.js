/**
 * Pool drag — gesture from the panel-list overlay onto the layout grid.
 *
 * A separate gesture from the existing panel-reorder drag in leaves/free-config,
 * but with the SAME 3-zone-per-cell hit-test (top/mid/bottom thirds), so the
 * user learns one rule for both:
 *
 *   top third    → insert before this cell
 *   middle third → REPLACE occupant (occupant returns to pool, source lands
 *                   in occupant's slot)
 *   bottom third → insert after this cell  (bottom-of-last-cell = append)
 *
 * Outside any cell but inside a column → append at the column's tail.
 *
 * `pool-armed` → `pool-dragging` promotion on any motion (matches the
 * in-grid drag pattern). Release returns [next slice, cmds] — cmds are dispatch_msg
 * wrappers that re-emit pool_hide/pool_show Msgs back into layout.update so
 * the existing handlers do the actual mutation.
 *
 * Imports the cell-zone helper from leaves/free-config (the 3-zone rule the two
 * drags share) and placementFromPoolEntry from leaves/pool (so the preview
 * builds the same placement object panel/layout.js's pool_show reducer
 * commits on release). Both are pure leaves with no back-edges, so no
 * cycle. Reads slice.panelBounds, slice.arrange, slice.panelList; writes
 * slice.panelList, slice.freeConfig.drag (the same field the in-grid mouse drag
 * uses; tagged union by `kind`).
 */
'use strict';

const mfc = require('./free-config');
const { pointToCellZone, _columnRanges, _newColumnZoneAt, EDGE_W } = mfc;
const mpool = require('./pool');
const { placementFromPoolEntry } = mpool;

/** Compute the drop target for a pool drag at (mx, my). Returns
 *  `{ kind:'insert', columnIndex, index, valid }` or
 *  `{ kind:'replace', columnIndex, occupantId, valid }`, or null when
 *  outside the layout. Uses slice.panelBounds (view-derived, written by
 *  the render pass) for cell hit-tests, mirroring the in-grid drag's
 *  approach. The dragged pool entry's type (looked up via
 *  slice.freeConfig.drag.sourceId) is threaded into the validators so
 *  they can refuse detail/actions outside the last column — same
 *  invariant the in-grid drag's validateTarget enforces. */
function pointToPoolDropTarget(slice, mx, my, COLS) {
  const arrange = slice.arrange;
  if (mx < 0 || my < 0) return null;
  const drag = slice.freeConfig && slice.freeConfig.drag;
  const sourceEntry = drag && drag.sourceId ? (arrange.pool || {})[drag.sourceId] : null;

  // Edge/gap zones first — same precedence as the in-grid drag. A pool
  // entry dropped at the screen edge or in a column gap spawns a new
  // column instead of going into an existing one.
  const ncz = _newColumnZoneAt(arrange, mx, COLS);
  if (ncz) return validatePoolNewColumn(arrange, ncz.position, sourceEntry);

  // Per-column scan: find a cell whose x-range contains mx, classify zone.
  const scan = (columnIndex, panels) => {
    if (panels.length === 0) return null;
    for (let i = 0; i < panels.length; i++) {
      const b = slice.panelBounds[panels[i].type];
      if (!b) continue;
      if (mx < b.x || mx >= b.x + b.w) continue;
      const zone = pointToCellZone(b, my);
      if (!zone) {
        // Above the cell (only possible at the top of the column) → insert at 0.
        if (my < b.y) return validateInsert(arrange, columnIndex, 0, sourceEntry);
        continue;
      }
      if (zone === 'top')    return validateInsert(arrange, columnIndex, i, sourceEntry);
      if (zone === 'middle') return validateReplace(arrange, panels[i], columnIndex, sourceEntry);
      return validateInsert(arrange, columnIndex, i + 1, sourceEntry);  // bottom
    }
    // Inside the column's x-range but below the last cell → append.
    const last = panels[panels.length - 1];
    const lb = slice.panelBounds[last.type];
    if (lb && mx >= lb.x && mx < lb.x + lb.w && my >= lb.y + lb.h) {
      return validateInsert(arrange, columnIndex, panels.length, sourceEntry);
    }
    return null;
  };
  for (const r of _columnRanges(arrange, COLS)) {
    const panels = mpool.columnPanels(arrange, r.columnIndex);
    const hit = scan(r.columnIndex, panels);
    if (hit) return hit;
  }
  // Cursor in a column's x-range but no cells matched (empty column or
  // dead-zone outside any cell). Fall back to append at column tail.
  for (const r of _columnRanges(arrange, COLS)) {
    if (mx >= r.x && mx < r.x + r.w) {
      const panels = mpool.columnPanels(arrange, r.columnIndex);
      return validateInsert(arrange, r.columnIndex, panels.length, sourceEntry);
    }
  }
  return null;
}

/** Insert validity: detail-at-end clamp for last column + detail/
 *  actions can't live outside the last column (same rule the in-grid
 *  drag's validateTarget enforces). Column-cap caps are SOFT —
 *  drag-insert allows exceeding them; only the parser warns at load
 *  time. When the detail-at-end clamp fires the returned target carries
 *  a `clamp` reason so the footer can show "(clamped — …)". */
function validateInsert(arrange, columnIndex, index, sourceEntry) {
  const lastIdx = mpool.lastColumnIndex(arrange);
  const panels = mpool.columnPanels(arrange, columnIndex);
  // detail/actions are last-column-only by convention. The in-grid drag's
  // validateTarget blocks moving them outside; pool-drag must too or the
  // user can land a hidden actions panel in a non-last column via the
  // panel-list overlay.
  if (sourceEntry && columnIndex !== lastIdx && mpool.isReservedPane(sourceEntry)) {
    return { kind: 'insert', columnIndex, index, valid: false, reason: `${sourceEntry.type} must stay in the last column` };
  }
  const valid = true;
  let idx = index;
  let clamp = null;
  if (columnIndex === lastIdx) {
    const detailIdx = panels.findIndex(mpool.isDetailPane);
    if (detailIdx >= 0 && idx > detailIdx) {
      idx = detailIdx;
      clamp = 'detail stays at end';
    }
  }
  const t = { kind: 'insert', columnIndex, index: idx, valid };
  if (clamp) t.clamp = clamp;
  return t;
}

/** Validity for a new-column drop from the pool. Phase 2 rules mirror
 *  the in-grid drag: detail/actions sources refuse, AND spawning at
 *  position == N (right edge) refuses (it would push the current last
 *  column off "last" and break detail's invariant). */
function validatePoolNewColumn(arrange, position, sourceEntry) {
  if (sourceEntry && mpool.isReservedPane(sourceEntry)) {
    return { kind: 'new_column', position, valid: false, reason: `${sourceEntry.type} must stay in the last column` };
  }
  const N = mpool.columnCount(arrange);
  if (position === N) {
    return { kind: 'new_column', position, valid: false, reason: `can't push detail off the last column` };
  }
  return { kind: 'new_column', position, valid: true };
}

/** Replace validity: detail can't be replaced (essential to the layout);
 *  detail/actions can't be the replacement panel outside the last
 *  column. */
function validateReplace(arrange, occupant, columnIndex, sourceEntry) {
  const lastIdx = mpool.lastColumnIndex(arrange);
  if (mpool.isDetailPane(occupant)) {
    return { kind: 'replace', columnIndex, occupantId: occupant.id, valid: false };
  }
  if (sourceEntry && columnIndex !== lastIdx && mpool.isReservedPane(sourceEntry)) {
    return { kind: 'replace', columnIndex, occupantId: occupant.id, valid: false, reason: `${sourceEntry.type} must stay in the last column` };
  }
  return { kind: 'replace', columnIndex, occupantId: occupant.id, valid: true };
}

function poolDragStart(slice, sourceId, mx, my) {
  // Close the overlay while dragging so the layout drop targets are
  // visible. The user can still see what they're dragging via the
  // free-config footer ("dragging <title> → <target>"). If the drag
  // is cancelled (drop outside layout), poolDragRelease reopens the
  // overlay so they can try again without pressing `w`. The
  // resume-on-cancel flag rides on the drag object (its natural
  // lifecycle) rather than being stuffed into panelList, which the
  // rest of the code treats as a clean `{open, cursor}` shape.
  const wasOpen = !!(slice.panelList && slice.panelList.open);
  const drag = { kind: 'pool-armed', sourceId, startX: mx, startY: my, curX: mx, curY: my, target: null, resumeOnCancel: wasOpen };
  return {
    ...slice,
    panelList: { ...slice.panelList, open: false },
    freeConfig: { ...slice.freeConfig, drag },
  };
}

function poolDragMotion(slice, mx, my, COLS) {
  const d = slice.freeConfig;
  const ds = d && d.drag;
  if (!ds || (ds.kind !== 'pool-armed' && ds.kind !== 'pool-dragging')) return slice;
  let nextKind = ds.kind;
  if (ds.kind === 'pool-armed') {
    if (mx === ds.startX && my === ds.startY) {
      return { ...slice, freeConfig: { ...d, drag: { ...ds, curX: mx, curY: my } } };
    }
    nextKind = 'pool-dragging';
  }
  const target = pointToPoolDropTarget(slice, mx, my, COLS);
  return { ...slice, freeConfig: { ...d, drag: { ...ds, kind: nextKind, curX: mx, curY: my, target } } };
}

/** Release: returns [next slice, cmds]. Cmds re-emit pool_hide/show Msgs
 *  back into layout.update so the existing handlers do the work (single
 *  source of truth for the mutation). On a valid drop the overlay stays
 *  closed; on cancel (no valid target) the overlay reopens if it was open
 *  at drag-start (drag.resumeOnCancel), so the user can try again without
 *  re-pressing `w`. The drag is cleared in both cases — the resumeOnCancel
 *  flag dies with it. */
function poolDragRelease(slice) {
  const d = slice.freeConfig;
  const ds = d && d.drag;
  if (!ds || (ds.kind !== 'pool-armed' && ds.kind !== 'pool-dragging')) return [slice, []];
  const resumeOnCancel = !!ds.resumeOnCancel;
  const repaint = { type: 'force_full_repaint' };
  const isValid = ds.kind === 'pool-dragging' && ds.target && ds.target.valid;
  if (!isValid) {
    const cleared = {
      ...slice,
      panelList: { ...slice.panelList, open: resumeOnCancel },
      freeConfig: { ...d, drag: null },
    };
    return [cleared, [repaint]];
  }
  const sourceId = ds.sourceId;
  const t = ds.target;
  const closeOverlay = {
    ...slice,
    panelList: { ...slice.panelList, open: false },
    freeConfig: { ...d, drag: null },
  };
  if (t.kind === 'replace') {
    const cmds = [
      { type: 'dispatch_msg', msg: { kind: 'layout', msg: { type: 'pool_hide', id: t.occupantId } } },
      { type: 'dispatch_msg', msg: { kind: 'layout', msg: { type: 'pool_show', id: sourceId, columnIndex: t.columnIndex } } },
      repaint,
    ];
    return [closeOverlay, cmds];
  }
  if (t.kind === 'new_column') {
    const cmds = [
      { type: 'dispatch_msg', msg: { kind: 'layout', msg: { type: 'pool_show_new_column', id: sourceId, position: t.position } } },
      repaint,
    ];
    return [closeOverlay, cmds];
  }
  // insert
  const showCmd = {
    type: 'dispatch_msg',
    msg: { kind: 'layout', msg: { type: 'pool_show', id: sourceId, columnIndex: t.columnIndex, index: t.index } },
  };
  return [closeOverlay, [showCmd, repaint]];
}

/** Compute the preview arrange for a pool drag at the current target — what
 *  the layout would look like on release. Mirrors what pool_show / pool_hide
 *  in panel/layout.js will do, but as a pure transform on arrange (no Cmd
 *  dispatch). Returns null when no preview should be painted. Like the
 *  in-grid variant, the render path swaps + restores panelBounds so the
 *  hit-test reference frame stays the original layout. */
function computePoolDragPreviewArrange(slice) {
  const drag = slice.freeConfig && slice.freeConfig.drag;
  if (!drag || drag.kind !== 'pool-dragging') return null;
  const t = drag.target;
  if (!t || !t.valid) return null;
  const entry = (slice.arrange.pool || {})[drag.sourceId];
  if (!entry) return null;
  const arrange = slice.arrange;
  if (t.kind === 'new_column') {
    const spawned = spawnNewColumnArrange(arrange, t.position, placementFromPoolEntry(entry, -1));
    return mfc.reassignHotkeys(spawned);
  }
  const placement = placementFromPoolEntry(entry, t.columnIndex);
  if (t.kind === 'replace') {
    return mpool.updateColumn(arrange, t.columnIndex, panels =>
      panels.map(p => p.id === t.occupantId ? placement : p));
  }
  // insert
  return mpool.updateColumn(arrange, t.columnIndex, panels => {
    const idx = Math.max(0, Math.min(t.index, panels.length));
    return panels.slice(0, idx).concat([placement], panels.slice(idx));
  });
}

/** Build a new arrange with a freshly-spawned column at `position`
 *  containing the single `placement` pane. Pure transform — used by
 *  the live preview AND the reducer's pool_show_new_column arm. Width
 *  allocation: edge spawns at the END produce an implicit-width new
 *  last column (old last gets promoted to explicit); everything else
 *  gets an explicit width stolen from adjacent columns. Width math
 *  mirrors leaves/free-config.js#applyNewColumn so the preview
 *  matches what release will commit. */
function spawnNewColumnArrange(arrange, position, placement) {
  const NEW_COL_DEFAULT_W = 24;
  const columns = (arrange.columns || []).slice();
  const willBeNewLast = position === columns.length;
  const newCol = { panels: [placement] };
  if (!willBeNewLast) {
    let donated = 0;
    if (position > 0) {
      const left = columns[position - 1];
      if (left.width != null) {
        const take = Math.max(8, Math.floor(left.width / 3));
        const newW = Math.max(10, left.width - take);
        columns[position - 1] = { ...left, width: newW };
        donated += (left.width - newW);
      }
    }
    if (position < columns.length) {
      const right = columns[position];
      if (right.width != null) {
        const take = Math.max(8, Math.floor(right.width / 3));
        const newW = Math.max(10, right.width - take);
        columns[position] = { ...right, width: newW };
        donated += (right.width - newW);
      }
    }
    newCol.width = donated > 0 ? donated : NEW_COL_DEFAULT_W;
  } else {
    const oldLastIdx = columns.length - 1;
    const oldLast = columns[oldLastIdx];
    if (oldLast && oldLast.width == null) {
      columns[oldLastIdx] = { ...oldLast, width: NEW_COL_DEFAULT_W * 2 };
    }
  }
  columns.splice(position, 0, newCol);
  return { ...arrange, columns };
}

module.exports = {
  pointToPoolDropTarget,
  poolDragStart, poolDragMotion, poolDragRelease,
  computePoolDragPreviewArrange,
  spawnNewColumnArrange,
  validatePoolNewColumn,
};
