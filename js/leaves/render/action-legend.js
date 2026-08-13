/**
 * action-legend — the ITEM-ACTION BAR border-control kind: a clickable row of
 * per-item action hints on a pane's BOTTOM border (btop-style), e.g.
 *
 *   ╰─ inspect logs shell stop restart kill ────────── 1 of 3 ─╯
 *
 * A pane REGISTERS its item-actions (`{id, label, key?}`); the bar renders the
 * labels and, on a click, dispatches that action against the pane's selected
 * item. The SAME action list the keyboard handler reads, so a click and the
 * keybind can't drift. Shown on the FOCUSED pane only (the actions apply to the
 * pane you're working in), suppressed in free-config.
 *
 * Owns DATA + GEOMETRY only (no state, no I/O): the label row + its width, and
 * the per-action click regions. Placement (bottom-left, count-independent) lives
 * in border-controls.js; both the painter (draw.js) and the hit-test
 * (panel/chrome-hittest) derive positions from HERE so they can't drift.
 */
'use strict';

const { visibleLen } = require('../text/ansi');

const SEP = ' ';   // one space between adjacent action labels (a hit-test gap)

/** The label row + its visible width. Plain text — the bottom border paints it
 *  in the border color (so it reads as part of the focused pane's chrome). */
function actionLegendText(actions) {
  const label = actions.map(a => a.label).join(SEP);
  return { text: label, visibleW: visibleLen(label) };
}

/** One click region per action label given the row's leftmost cell (x0) + row
 *  (y); the separators between labels are gaps (misses). Each region is tagged
 *  with the action's `id`. */
function actionLegendRegions(x0, y, actions) {
  const regions = [];
  let cx = x0;
  for (const a of actions) {
    const w = visibleLen(a.label);
    regions.push({ x0: cx, x1: cx + w - 1, y, action: a.id });
    cx += w + SEP.length;
  }
  return regions;
}

/**
 * A BORDER-CONTROL SPEC for the item-action bar — the action-legend KIND
 * packaged for the generic strip, on the BOTTOM slot. A pane registers this in
 * `panelTypes[type].borderControls`; the framework renders + hit-tests it.
 *
 * @param {{id:string,label:string,key?:string}[]} actions - the pane's item-actions
 * @param {(paneId:string)=>*} itemAt - the pane's currently-selected item (cursor row)
 * @returns {{ id, slot:'bottom', render, regions, dispatch }}
 *   - render(model, pane) → { text, visibleW } | null   (null unless focused, non-free-config)
 *   - regions(x0, y) → [{ x0, x1, y, action:id }]
 *   - dispatch(actionId, pane) → { owner, msg } | null   (null when the pane has no selection)
 */
function actionLegendSpec({ actions, itemAt }) {
  return {
    id: 'actions',
    slot: 'bottom',
    render(model, pane) {
      if (model && model.modes && model.modes.freeConfigMode) return null;
      if (!pane || !pane.focused) return null;
      return actionLegendText(actions);
    },
    regions(x0, y) {
      return actionLegendRegions(x0, y, actions);
    },
    dispatch(actionId, pane) {
      const item = itemAt(pane.paneId);
      if (item == null) return null;   // nothing selected → no-op
      return { owner: pane.paneId, msg: { type: 'item_action', action: actionId, item } };
    },
  };
}

module.exports = { actionLegendText, actionLegendRegions, actionLegendSpec, SEP };
