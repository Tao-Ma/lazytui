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
 * Pure leaf — no imports. Reads bounds + tabBounds via parameters
 * (v0.6.3 P4.1: tabBounds moved off layoutSlice.paneBounds.detail.tabs
 * onto the viewer's own slice; the caller resolves and passes them in
 * so the leaf stays slice-arg-pure). Writes the drag state on
 * `slice.freeConfig.drag` (tagged union by `kind`, shares the field
 * with pool / panel / resize drags).
 */
'use strict';

function tabDragStart(slice, sourceKey, fromIdx, mx, my) {
  // AR4 — single 'tab-dragging' kind; the prior 'tab-armed' variant
  // was indistinguishable from 'tab-dragging' to render + release
  // (no user-visible state, no different output). Movement-free
  // motion is detected by (mx, my) === (startX, startY).
  const drag = { kind: 'tab-dragging', sourceKey, fromIdx, startX: mx, startY: my, curX: mx, curY: my };
  return { ...slice, freeConfig: { ...slice.freeConfig, drag } };
}

function _findContentIdxAt(detailBounds, tabBounds, mx, my) {
  if (!detailBounds || !Array.isArray(tabBounds)) return -1;
  if (my !== detailBounds.y) return -1;
  const localX = mx - detailBounds.x;
  let contentIdx = 0;
  for (const t of tabBounds) {
    if (t.closeKey == null) continue;  // not a content tab
    if (localX >= t.x && localX < t.x + t.w) return contentIdx;
    contentIdx++;
  }
  return -1;
}

function tabDragMotion(slice, mx, my, detailBounds, tabBounds, modelBundle, targetKind) {
  const drag = slice.freeConfig && slice.freeConfig.drag;
  if (!drag || drag.kind !== 'tab-dragging') return [slice, []];
  if (mx === drag.startX && my === drag.startY) {
    // No movement — keep the cursor record without recomputing target.
    return [{ ...slice, freeConfig: { ...slice.freeConfig, drag: { ...drag, curX: mx, curY: my } } }, []];
  }
  const toIdx = _findContentIdxAt(detailBounds, tabBounds, mx, my);
  const cursorOnly = {
    ...slice,
    freeConfig: { ...slice.freeConfig, drag: { ...drag, curX: mx, curY: my } },
  };
  if (toIdx < 0 || toIdx === drag.fromIdx) return [cursorOnly, []];

  // Crossed into a new content-tab slot — emit a single-step reorder Cmd
  // and advance drag.fromIdx so the next crossing reorders from the
  // newly-moved position. `targetKind` identifies the viewer instance
  // that owns these tabs; today it's the singleton 'detail' but v0.7
  // multi-viewer will pass a per-pane id resolved by the caller via
  // `route.resolveTarget('viewer')`. The leaf takes it as an arg so it
  // stays pure (no `route` import).
  //
  // modelBundle (v0.6.3 TEA Phase 3c) is the precomputed
  // {currentGroup, groupExists, yamlTerminals, actionCount} that the
  // downstream reorderContent leaf needs. Spread into the emitted
  // Cmd's Msg so it threads through to the pane-tabs reducer arm.
  const advanced = {
    ...cursorOnly,
    freeConfig: { ...cursorOnly.freeConfig, drag: { ...cursorOnly.freeConfig.drag, fromIdx: toIdx } },
  };
  const cmd = {
    type: 'msg',
    msg: { kind: targetKind, msg: {
      type: 'viewer_reorder_content_tab',
      groupName: modelBundle ? modelBundle.currentGroup : '',
      fromIdx: drag.fromIdx, toIdx,
      ...(modelBundle || {}),
    } },
  };
  return [advanced, [cmd]];
}

function tabDragRelease(slice) {
  const drag = slice.freeConfig && slice.freeConfig.drag;
  if (!drag || drag.kind !== 'tab-dragging') return [slice, []];
  return [
    { ...slice, freeConfig: { ...slice.freeConfig, drag: null } },
    [{ type: 'force_full_repaint' }],
  ];
}

module.exports = { tabDragStart, tabDragMotion, tabDragRelease };
