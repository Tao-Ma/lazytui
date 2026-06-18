/**
 * Hotkey pools for layout panels — single source of truth.
 *
 * Used by the parser (auto-assignment at config load), the layout
 * reducer (rekey-on-mutate after pool_hide / pool_show), and the
 * runtime synthesis path in app/state.js (legacy default layout).
 * Pre-v0.6.x these arrays were redeclared in three places, drifting
 * the next time someone touched one of them. v0.6.2 promotes the
 * per-column pool selection (`hotkeyPoolForColumn`) into this leaf
 * for the same reason — every column-rekey site picks from the same
 * dispatcher so the answer is consistent across drag-/reorder vs
 * pool_hide / pool_show paths.
 *
 * Zero deps — pure data.
 */
'use strict';

const LEFT_HOTKEY_POOL  = ['1', '2', '3', '4', '5', '6'];
const RIGHT_HOTKEY_POOL = ['7', '8', '9'];

/** Hotkey pool for the column at index `ci` in an `N`-column layout.
 *  First column → LEFT_HOTKEY_POOL, last → RIGHT_HOTKEY_POOL, middle
 *  columns get an empty pool — auto-assignment yields '' and the user
 *  must specify `hotkey:` on each cell explicitly. */
function hotkeyPoolForColumn(ci, N) {
  if (ci === 0) return LEFT_HOTKEY_POOL;
  if (ci === N - 1) return RIGHT_HOTKEY_POOL;
  return [];
}

module.exports = { LEFT_HOTKEY_POOL, RIGHT_HOTKEY_POOL, hotkeyPoolForColumn };
