/**
 * Tab-reorder gesture (free-config mouse drag on the detail tab bar).
 *
 * Source: a content tab in the detail panel's tab bar (identified by its
 * `closeKey`, which viewer.js#detailTitle stamps onto tabBounds entries
 * along with a `contentIdx`). Drop: another content-tab slot.
 *
 * Live reorder — each motion that crosses into a different content-tab idx
 * emits a `viewer_reorder_content_tab` Cmd; the drag state's fromIdx
 * advances to the source's new position so the next crossing fires a
 * single-position swap. Visual feedback comes for free: the tab bar is
 * already rendered in the new order on the next frame.
 *
 * Outside the tab bar (cursor not on the title row, or off the detail
 * panel) the drag stays armed but no reorder fires. Release clears the
 * drag in both cases.
 *
 * Pure leaf — no imports. Reads `slice.panelBounds.detail.tabs` (the
 * view-output hit-test cache populated by viewer.js#detailTitle), writes
 * the drag state on `slice.design.drag` (tagged union by `kind`, shares
 * the field with pool / panel / resize drags).
 */
'use strict';

function tabDragStart(slice, sourceKey, fromIdx, mx, my) {
  const drag = { kind: 'tab-armed', sourceKey, fromIdx, startX: mx, startY: my, curX: mx, curY: my };
  return { ...slice, design: { ...slice.design, drag } };
}

function _findContentIdxAt(panelBoundsDetail, mx, my) {
  if (!panelBoundsDetail || !panelBoundsDetail.tabs) return -1;
  if (my !== panelBoundsDetail.y) return -1;
  const localX = mx - panelBoundsDetail.x;
  let contentIdx = 0;
  for (const t of panelBoundsDetail.tabs) {
    if (t.closeKey == null) continue;  // not a content tab
    if (localX >= t.x && localX < t.x + t.w) return contentIdx;
    contentIdx++;
  }
  return -1;
}

function tabDragMotion(slice, mx, my, panelBoundsDetail, currentGroup) {
  const drag = slice.design && slice.design.drag;
  if (!drag || (drag.kind !== 'tab-armed' && drag.kind !== 'tab-dragging')) return [slice, []];

  let nextKind = drag.kind;
  if (drag.kind === 'tab-armed') {
    if (mx === drag.startX && my === drag.startY) {
      return [{ ...slice, design: { ...slice.design, drag: { ...drag, curX: mx, curY: my } } }, []];
    }
    nextKind = 'tab-dragging';
  }

  const toIdx = _findContentIdxAt(panelBoundsDetail, mx, my);
  const cursorOnly = {
    ...slice,
    design: { ...slice.design, drag: { ...drag, kind: nextKind, curX: mx, curY: my } },
  };
  if (toIdx < 0 || toIdx === drag.fromIdx) return [cursorOnly, []];

  // Crossed into a new content-tab slot — emit a single-step reorder Cmd
  // and advance drag.fromIdx so the next crossing reorders from the
  // newly-moved position.
  const advanced = {
    ...cursorOnly,
    design: { ...cursorOnly.design, drag: { ...cursorOnly.design.drag, fromIdx: toIdx } },
  };
  const cmd = {
    type: 'dispatch_msg',
    msg: { kind: 'detail', msg: { type: 'viewer_reorder_content_tab', groupName: currentGroup, fromIdx: drag.fromIdx, toIdx } },
  };
  return [advanced, [cmd]];
}

function tabDragRelease(slice) {
  const drag = slice.design && slice.design.drag;
  if (!drag || (drag.kind !== 'tab-armed' && drag.kind !== 'tab-dragging')) return [slice, []];
  return [
    { ...slice, design: { ...slice.design, drag: null } },
    [{ type: 'force_full_repaint' }],
  ];
}

module.exports = { tabDragStart, tabDragMotion, tabDragRelease };
