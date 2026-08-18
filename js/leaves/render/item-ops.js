/**
 * Pure leaf — the per-pane ITEM-OPERATION contract.
 *
 * A generic, extensible surface for "operations on the selected row" that any
 * list/table Component can declare ONCE and have rendered across every input
 * surface from a single source (so keyboard / bottom-bar click / right-click
 * can't drift):
 *
 *   panelType.itemOps(slice) → [ { id, label, key?, surfaces? } ]
 *
 * - Pure over the pane's slice; `[]` = no operations (self-suppresses everywhere).
 * - `surfaces` — subset of ['bottom','menu']; DEFAULT = both. Per-operation choice
 *   of where it appears: the bottom item-action bar, the right-click context menu,
 *   or both.
 * - `key` — optional keyboard binding; the bottom-bar affordance highlights
 *   `label[0]` (so `label[0] === key` by convention, as in docker/table).
 *
 * Execution is uniform: every surface dispatches `item_action{action:id, item}`
 * to the owning Component, whose `update` folds it into Cmds. The bottom bar
 * (leaves/render/action-legend `itemOpsBarSpec`) and the keyboard arm emit it
 * directly; the right-click menu routes a `[label,'pane_item_action',{paneId,id,
 * item}]` row through the `pane_item_action` verb, which re-dispatches the same
 * `item_action` to the pane. One declaration, three surfaces, one execution.
 *
 * Dependency-free leaf — pure, no requires.
 */
'use strict';

const BOTTOM = 'bottom';
const MENU = 'menu';
const BOTH = [BOTTOM, MENU];

/** The surfaces an op appears on (default: both). */
function surfacesOf(op) {
  return (op && Array.isArray(op.surfaces) && op.surfaces.length) ? op.surfaces : BOTH;
}
function hasSurface(op, surface) { return surfacesOf(op).includes(surface); }

/** Ops that opt into the bottom item-action bar. */
function bottomOps(ops) { return (ops || []).filter(o => hasSurface(o, BOTTOM)); }
/** Ops that opt into the right-click context menu. */
function menuOps(ops) { return (ops || []).filter(o => hasSurface(o, MENU)); }

/**
 * Ready right-click-menu rows for a pointed item: `[label, 'pane_item_action',
 * {paneId, id, item}]` per menu-surface op (menu_open items shape). Empty when
 * there's no item under the pointer. `item` is the raw selected row (the rowKey /
 * idOf), frozen at right-click time — the verb re-dispatches it as `item_action`.
 */
function contextOpRows(paneId, item, ops) {
  if (item == null) return [];
  return menuOps(ops).map(o => [o.label, 'pane_item_action', { paneId, id: o.id, item }]);
}

module.exports = { BOTTOM, MENU, surfacesOf, hasSurface, bottomOps, menuOps, contextOpRows };
