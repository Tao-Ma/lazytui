/**
 * Proportional scrollbar indicator for TUI panels.
 * Zero dependencies.
 */
'use strict';

/**
 * Compute scrollbar thumb extent.
 * Returns `null` when there's no thumb to draw (content fits in the
 * viewport); otherwise returns `{ pos, size }` — thumb occupies rows
 * [pos, pos+size). Callers check `pos <= i < pos+size` per row,
 * which avoids the per-row boolean array allocation the previous
 * shape required (P5.3).
 */
function scrollbar(trackHeight, totalItems, visibleItems, scrollOffset) {
  if (totalItems <= visibleItems || trackHeight <= 0) return null;
  const size = Math.max(1, Math.round(trackHeight * visibleItems / totalItems));
  const maxOffset = totalItems - visibleItems;
  if (maxOffset <= 0) return null;
  const scrollableRange = trackHeight - size;
  let pos = Math.round(scrollOffset / maxOffset * scrollableRange);
  pos = Math.max(0, Math.min(pos, trackHeight - size));
  return { pos, size };
}

module.exports = { scrollbar };
