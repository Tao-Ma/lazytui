/**
 * Proportional scrollbar indicator for TUI panels.
 * Zero dependencies.
 */
'use strict';

/**
 * Compute scrollbar thumb positions.
 * @param {number} trackHeight - rows available
 * @param {number} totalItems - total items in list
 * @param {number} visibleItems - items visible in viewport
 * @param {number} scrollOffset - index of first visible item
 * @returns {boolean[]} - true = show thumb, false = show track
 */
function scrollbar(trackHeight, totalItems, visibleItems, scrollOffset) {
  if (totalItems <= visibleItems || trackHeight <= 0) {
    return new Array(trackHeight).fill(false);
  }
  const thumbSize = Math.max(1, Math.round(trackHeight * visibleItems / totalItems));
  const maxOffset = totalItems - visibleItems;
  if (maxOffset <= 0) return new Array(trackHeight).fill(false);
  const scrollableRange = trackHeight - thumbSize;
  let thumbPos = Math.round(scrollOffset / maxOffset * scrollableRange);
  thumbPos = Math.max(0, Math.min(thumbPos, trackHeight - thumbSize));
  return Array.from({ length: trackHeight }, (_, i) =>
    i >= thumbPos && i < thumbPos + thumbSize
  );
}

module.exports = { scrollbar };
