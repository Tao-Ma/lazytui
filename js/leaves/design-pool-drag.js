/**
 * Pool drag — gesture from the panel-list overlay onto the layout grid.
 *
 * A separate gesture from the existing panel-reorder drag in leaves/design,
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
 * `pool-armed` → `pool-dragging` promotion on any motion (matches the design
 * drag pattern). Release returns [next slice, cmds] — cmds are dispatch_msg
 * wrappers that re-emit pool_hide/pool_show Msgs back into layout.update so
 * the existing handlers do the actual mutation.
 *
 * Imports the cell-zone helper from leaves/design — the only cross-leaf dep
 * here, kept narrow so the two drags share one notion of "where the cursor
 * is in this cell." Reads slice.panelBounds, slice.arrange, slice.panelList;
 * writes slice.panelList, slice.design.drag (the same field design's mouse
 * drag uses; tagged union by `kind`).
 */
'use strict';

const { pointToCellZone } = require('./design');

/** Compute the drop target for a pool drag at (mx, my). Returns
 *  `{ kind:'insert', column, index, valid }` or
 *  `{ kind:'replace', column, occupantId, valid }`, or null when outside the
 *  layout. Uses slice.panelBounds (view-derived, written by the render pass)
 *  for cell hit-tests, mirroring the in-grid drag's approach. */
function pointToPoolDropTarget(slice, mx, my) {
  const arrange = slice.arrange;
  if (mx < 0 || my < 0) return null;

  // Per-column scan: find a cell whose x-range contains mx, classify zone.
  const scan = (column, panels) => {
    if (panels.length === 0) return null;
    for (let i = 0; i < panels.length; i++) {
      const b = slice.panelBounds[panels[i].type];
      if (!b) continue;
      if (mx < b.x || mx >= b.x + b.w) continue;
      const zone = pointToCellZone(b, my);
      if (!zone) {
        // Above the cell (only possible at the top of the column) → insert at 0.
        if (my < b.y) return validateInsert(arrange, column, 0);
        continue;
      }
      if (zone === 'top')    return validateInsert(arrange, column, i);
      if (zone === 'middle') return validateReplace(panels[i], column);
      return validateInsert(arrange, column, i + 1);  // bottom
    }
    // Inside the column's x-range but below the last cell → append.
    const last = panels[panels.length - 1];
    const lb = slice.panelBounds[last.type];
    if (lb && mx >= lb.x && mx < lb.x + lb.w && my >= lb.y + lb.h) {
      return validateInsert(arrange, column, panels.length);
    }
    return null;
  };
  const leftHit  = scan('left',  arrange.leftPanels  || []);
  if (leftHit)  return leftHit;
  const rightHit = scan('right', arrange.rightPanels || []);
  if (rightHit) return rightHit;

  // Cursor in the column's x-range but no cells matched (empty column or
  // dead-zone outside any cell). Fall back to append at column tail.
  const leftWidth = arrange.leftWidth || 30;
  const column = mx < leftWidth ? 'left' : 'right';
  const panels = column === 'left' ? (arrange.leftPanels || []) : (arrange.rightPanels || []);
  return validateInsert(arrange, column, panels.length);
}

/** Insert validity: column-cap + detail-at-end clamp for right column. */
function validateInsert(arrange, column, index) {
  const panels = column === 'left' ? (arrange.leftPanels || []) : (arrange.rightPanels || []);
  const cap = column === 'left' ? 6 : 3;
  const valid = panels.length < cap;
  // Right column: detail stays at the end. Clamp any insert past detail's
  // position so the preview matches what pool_show will actually do.
  let idx = index;
  if (column === 'right') {
    const detailIdx = panels.findIndex(p => p.type === 'detail');
    if (detailIdx >= 0 && idx > detailIdx) idx = detailIdx;
  }
  return { kind: 'insert', column, index: idx, valid };
}

/** Replace validity: detail can't be replaced (essential to the layout). */
function validateReplace(occupant, column) {
  const valid = occupant.type !== 'detail';
  return { kind: 'replace', column, occupantId: occupant.id, valid };
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
    design: { ...slice.design, drag },
  };
}

function poolDragMotion(slice, mx, my) {
  const d = slice.design;
  const ds = d && d.drag;
  if (!ds || (ds.kind !== 'pool-armed' && ds.kind !== 'pool-dragging')) return slice;
  let nextKind = ds.kind;
  if (ds.kind === 'pool-armed') {
    if (mx === ds.startX && my === ds.startY) {
      return { ...slice, design: { ...d, drag: { ...ds, curX: mx, curY: my } } };
    }
    nextKind = 'pool-dragging';
  }
  const target = pointToPoolDropTarget(slice, mx, my);
  return { ...slice, design: { ...d, drag: { ...ds, kind: nextKind, curX: mx, curY: my, target } } };
}

/** Release: returns [next slice, cmds]. Cmds re-emit pool_hide/show Msgs
 *  back into layout.update so the existing handlers do the work (single
 *  source of truth for the mutation). On a valid drop the overlay stays
 *  closed; on cancel (no valid target) the overlay reopens if it was open
 *  at drag-start (drag.resumeOnCancel), so the user can try again without
 *  re-pressing `w`. The drag is cleared in both cases — the resumeOnCancel
 *  flag dies with it. */
function poolDragRelease(slice) {
  const d = slice.design;
  const ds = d && d.drag;
  if (!ds || (ds.kind !== 'pool-armed' && ds.kind !== 'pool-dragging')) return [slice, []];
  const resumeOnCancel = !!ds.resumeOnCancel;
  const repaint = { type: 'force_full_repaint' };
  const isValid = ds.kind === 'pool-dragging' && ds.target && ds.target.valid;
  if (!isValid) {
    const cleared = {
      ...slice,
      panelList: { ...slice.panelList, open: resumeOnCancel },
      design: { ...d, drag: null },
    };
    return [cleared, [repaint]];
  }
  const sourceId = ds.sourceId;
  const t = ds.target;
  const closeOverlay = {
    ...slice,
    panelList: { ...slice.panelList, open: false },
    design: { ...d, drag: null },
  };
  if (t.kind === 'replace') {
    const cmds = [
      { type: 'dispatch_msg', msg: { kind: 'layout', msg: { type: 'pool_hide', id: t.occupantId } } },
      { type: 'dispatch_msg', msg: { kind: 'layout', msg: { type: 'pool_show', id: sourceId, column: t.column } } },
      repaint,
    ];
    return [closeOverlay, cmds];
  }
  // insert
  const showCmd = {
    type: 'dispatch_msg',
    msg: { kind: 'layout', msg: { type: 'pool_show', id: sourceId, column: t.column, index: t.index } },
  };
  return [closeOverlay, [showCmd, repaint]];
}

/** Build a runtime placement object from a pool entry — the same shape
 *  panel/layout.js#placementFromPoolEntry produces, inlined here to keep
 *  the leaf dependency-light (avoids a cycle through panel/layout which
 *  imports this file). */
function _placement(entry, column) {
  return {
    ...(entry.config || {}),
    id: entry.id, type: entry.type, title: entry.title,
    hotkey: '', column,
  };
}

/** Compute the preview arrange for a pool drag at the current target — what
 *  the layout would look like on release. Mirrors what pool_show / pool_hide
 *  in panel/layout.js will do, but as a pure transform on arrange (no Cmd
 *  dispatch). Returns null when no preview should be painted. Like the
 *  in-grid variant, the render path swaps + restores panelBounds so the
 *  hit-test reference frame stays the original layout. */
function computePoolDragPreviewArrange(slice) {
  const drag = slice.design && slice.design.drag;
  if (!drag || drag.kind !== 'pool-dragging') return null;
  const t = drag.target;
  if (!t || !t.valid) return null;
  const entry = (slice.arrange.pool || {})[drag.sourceId];
  if (!entry) return null;
  const arrange = slice.arrange;
  const placement = _placement(entry, t.column);
  if (t.kind === 'replace') {
    const apply = (panels) => panels.map(p => p.id === t.occupantId ? placement : p);
    return t.column === 'left'
      ? { ...arrange, leftPanels: apply(arrange.leftPanels) }
      : { ...arrange, rightPanels: apply(arrange.rightPanels) };
  }
  // insert
  const target = t.column === 'left' ? arrange.leftPanels : arrange.rightPanels;
  const idx = Math.max(0, Math.min(t.index, target.length));
  const inserted = target.slice(0, idx).concat([placement], target.slice(idx));
  return t.column === 'left'
    ? { ...arrange, leftPanels: inserted }
    : { ...arrange, rightPanels: inserted };
}

module.exports = {
  pointToPoolDropTarget,
  poolDragStart, poolDragMotion, poolDragRelease,
  computePoolDragPreviewArrange,
};
