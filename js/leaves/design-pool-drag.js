/**
 * Pool drag — gesture from the panel-list overlay onto the layout grid.
 *
 * A separate gesture from the existing panel-reorder drag in leaves/design.
 * Source: an item in the panel-list overlay (identified by sourceId, not
 * sourceType, since the pool can hold multiple panels of the same type).
 * Drop:
 *
 *   - on an existing cell → REPLACE: occupant returns to pool, source lands
 *     in occupant's column at the same position
 *   - in a column area but not on any cell → APPEND to that column's tail
 *   - outside the layout → cancel
 *
 * `pool-armed` → `pool-dragging` promotion on any motion (matches the design
 * drag pattern). Release returns [next slice, cmds] — cmds are dispatch_msg
 * wrappers that re-emit pool_hide/pool_show Msgs back into layout.update so
 * the existing handlers (Phase 2) do the actual mutation.
 *
 * Pure leaf — no imports. Reads slice.panelBounds, slice.arrange,
 * slice.panelList; writes slice.panelList, slice.design.drag (the same
 * field design's mouse drag uses; tagged union by `kind`).
 */
'use strict';

// Bottom-of-column zone reserved for "append" drops. Each column's last
// cell is normally full-height, so without carving out a dedicated zone
// the user can never hit the "not on any cell" branch below. The zone
// is the bottom N rows of the last cell — wide enough to be reachable
// with the mouse, narrow enough that "drop on this cell" (replace) is
// still the dominant gesture on the upper portion.
const APPEND_ZONE_ROWS = 2;

/** Compute the drop target for a pool drag at (mx, my). Returns
 *  `{ kind, column, occupantId?, valid }` or `null` when outside the
 *  layout area. Uses slice.panelBounds (view-derived, written by the
 *  render pass) for cell hit-tests, mirroring the design-drag approach. */
function pointToPoolDropTarget(slice, mx, my) {
  const arrange = slice.arrange;
  if (mx < 0 || my < 0) return null;

  // 1. Append zone. Position differs by column because right column
  //    keeps detail at the end (pool_show inserts before detail), so
  //    the affordance for "add to right column" sits at the TOP of
  //    detail — the seam where the new panel will actually land.
  //
  //    Left column: bottom APPEND_ZONE_ROWS of the last cell.
  //    Right column: top APPEND_ZONE_ROWS of detail (visually = the
  //                   seam above detail; semantically = the slot
  //                   pool_show will insert into).
  const checkAppend = (column, panels) => {
    if (panels.length === 0) return null;
    const cap = column === 'left' ? 6 : 3;
    const valid = panels.length < cap;
    if (column === 'left') {
      const last = panels[panels.length - 1];
      const b = slice.panelBounds[last.type];
      if (!b) return null;
      if (mx < b.x || mx >= b.x + b.w) return null;
      const zoneTop = b.y + b.h - APPEND_ZONE_ROWS;
      if (my < zoneTop || my >= b.y + b.h) return null;
      return { kind: 'append', column, valid };
    }
    // right column
    const detail = panels.find(p => p.type === 'detail');
    const b = detail ? slice.panelBounds[detail.type] : null;
    if (!b) {
      // No detail (shouldn't happen — layout invariant) — fall back to
      // the v0.5-style bottom-of-last zone.
      const last = panels[panels.length - 1];
      const lb = slice.panelBounds[last.type];
      if (!lb) return null;
      if (mx < lb.x || mx >= lb.x + lb.w) return null;
      const zt = lb.y + lb.h - APPEND_ZONE_ROWS;
      if (my < zt || my >= lb.y + lb.h) return null;
      return { kind: 'append', column, valid };
    }
    if (mx < b.x || mx >= b.x + b.w) return null;
    if (my < b.y || my >= b.y + APPEND_ZONE_ROWS) return null;
    return { kind: 'append', column, valid };
  };
  const leftAppend  = checkAppend('left',  arrange.leftPanels  || []);
  if (leftAppend)  return leftAppend;
  const rightAppend = checkAppend('right', arrange.rightPanels || []);
  if (rightAppend) return rightAppend;

  // 2. Replace zone — cell hit-test on whatever sits at the cursor.
  for (const p of arrange.leftPanels  || []) {
    const b = slice.panelBounds[p.type];
    if (b && mx >= b.x && mx < b.x + b.w && my >= b.y && my < b.y + b.h) {
      const valid = p.type !== 'detail';
      return { kind: 'replace', column: 'left', occupantId: p.id, valid };
    }
  }
  for (const p of arrange.rightPanels || []) {
    const b = slice.panelBounds[p.type];
    if (b && mx >= b.x && mx < b.x + b.w && my >= b.y && my < b.y + b.h) {
      const valid = p.type !== 'detail';
      return { kind: 'replace', column: 'right', occupantId: p.id, valid };
    }
  }

  // 3. Outside everything (cursor in dead zone, e.g. the footer row or
  //    outside terminal bounds). Append to the column under the cursor.
  const leftWidth = arrange.leftWidth || 30;
  const column = mx < leftWidth ? 'left' : 'right';
  return { kind: 'append', column, valid: true };
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
 *  back into layout.update so the existing Phase 2 handlers do the work
 *  (single source of truth for the mutation). On a valid drop the overlay
 *  stays closed; on cancel (no valid target) the overlay reopens if it
 *  was open at drag-start (drag.resumeOnCancel), so the user can try
 *  again without re-pressing `w`. The drag is cleared in both cases —
 *  the resumeOnCancel flag dies with it. */
function poolDragRelease(slice) {
  const d = slice.design;
  const ds = d && d.drag;
  if (!ds || (ds.kind !== 'pool-armed' && ds.kind !== 'pool-dragging')) return [slice, []];
  const resumeOnCancel = !!ds.resumeOnCancel;
  const repaint = { type: 'force_full_repaint' };
  const isValid = ds.kind === 'pool-dragging' && ds.target && ds.target.valid;
  if (!isValid) {
    // Cancel — reopen overlay (if it was open at drag-start) so the user
    // can retry. The repaint covers the drag-state pixel churn.
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
  const showCmd = { kind: 'layout', msg: { type: 'pool_show', id: sourceId, column: t.column } };
  if (t.kind === 'replace') {
    const cmds = [
      { type: 'dispatch_msg', msg: { kind: 'layout', msg: { type: 'pool_hide', id: t.occupantId } } },
      { type: 'dispatch_msg', msg: showCmd },
      repaint,
    ];
    return [closeOverlay, cmds];
  }
  // append
  return [closeOverlay, [{ type: 'dispatch_msg', msg: showCmd }, repaint]];
}

module.exports = {
  pointToPoolDropTarget,
  poolDragStart, poolDragMotion, poolDragRelease,
};
